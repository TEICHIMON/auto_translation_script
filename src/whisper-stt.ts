import fs from 'fs/promises';
import path from 'path';
import { getConfig } from './config';
import { segmentWhisperResultWithDeepSeek } from './lrc-segmenter';
import { WhisperTranscriptionResult } from './types';
import { writeTraceJson, writeTraceText } from './temp-trace';

/**
 * Whisper 调用相关错误。捕获到此异常应中止整个流水线。
 */
export class WhisperError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WhisperError';
    }
}

interface JobSubmitResponse {
    job_id: string;
    duration: number;
}

// 本轮是否实际调用过 Whisper(用于决定是否 auto-release)
let invocationCount = 0;
export function getWhisperInvocationCount(): number {
    return invocationCount;
}

const WHISPER_RESULT_TMP_DIR = path.join(process.cwd(), '.tmp', 'whisper-results');

function safeFileStem(filePath: string): string {
    const parsed = path.parse(filePath);
    const stem = parsed.name || parsed.base || 'audio';
    const safe = stem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return (safe || 'audio').slice(0, 80);
}

function cacheTimestamp(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
}

async function saveWhisperResultSnapshot(
    result: WhisperTranscriptionResult,
    audioPath: string,
    taskTraceDir?: string | null
): Promise<string | null> {
    try {
        if (taskTraceDir) {
            const whisperDir = path.join(taskTraceDir, '01-whisper');
            await writeTraceJson(whisperDir, 'meta.json', {
                audioPath,
                duration: result.duration,
                lang: result.lang,
                modelKey: result.model_key,
                segmentCount: result.segments?.length || 0
            });
            await writeTraceJson(whisperDir, 'result.json', result);
            await writeTraceText(whisperDir, 'server.lrc', result.lrc || '');
            return path.join(whisperDir, 'result.json');
        }

        await fs.mkdir(WHISPER_RESULT_TMP_DIR, { recursive: true });
        const json = JSON.stringify(result, null, 2);
        const fileName = `${cacheTimestamp(new Date())}-${safeFileStem(audioPath)}.json`;
        const snapshotPath = path.join(WHISPER_RESULT_TMP_DIR, fileName);
        const latestPath = path.join(WHISPER_RESULT_TMP_DIR, 'latest.json');

        await fs.writeFile(snapshotPath, json, 'utf-8');
        await fs.writeFile(latestPath, json, 'utf-8');
        return snapshotPath;
    } catch (error) {
        console.log(`  ⚠️  保存 Whisper result 临时文件失败: ${error}`);
        return null;
    }
}

/**
 * 提交转录任务
 */
async function submitJob(
    audioPath: string,
    lang: string,
    model: string,
    serverUrl: string
): Promise<JobSubmitResponse> {
    const audioBuffer = await fs.readFile(audioPath);
    const fileName = path.basename(audioPath);

    const form = new FormData();
    form.append(
        'audio',
        new Blob([audioBuffer], { type: 'application/octet-stream' }),
        fileName
    );
    form.append('lang', lang);
    form.append('model', model);

    let res: Response;
    try {
        res = await fetch(`${serverUrl}/jobs`, { method: 'POST', body: form });
    } catch (e) {
        throw new WhisperError(`无法连接 Whisper 服务器 (${serverUrl}): ${e}`);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new WhisperError(`提交任务失败 (HTTP ${res.status}): ${text}`);
    }

    return (await res.json()) as JobSubmitResponse;
}

/**
 * 订阅 SSE,按 10% 阶梯打印进度,直到 done/error
 */
async function streamProgress(jobId: string, serverUrl: string): Promise<void> {
    let res: Response;
    try {
        res = await fetch(`${serverUrl}/jobs/${jobId}/events`, {
            headers: { Accept: 'text/event-stream' }
        });
    } catch (e) {
        throw new WhisperError(`无法订阅进度流: ${e}`);
    }

    if (!res.ok || !res.body) {
        throw new WhisperError(`订阅 SSE 失败 (HTTP ${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastReportedTier = -1; // 已上报的最后一档 (0=0%, 1=10%, ...)

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // 累积并规范换行
            buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

            let sepIdx: number;
            while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
                const rawEvent = buffer.slice(0, sepIdx);
                buffer = buffer.slice(sepIdx + 2);
                if (!rawEvent.trim()) continue;

                let eventName = 'message';
                let data = '';
                for (const line of rawEvent.split('\n')) {
                    if (line.startsWith('event:')) {
                        eventName = line.slice(6).trim();
                    } else if (line.startsWith('data:')) {
                        // 多个 data: 行按换行拼接(SSE 规范)
                        data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
                    }
                }

                if (eventName === 'status') {
                    if (data === 'loading_model') {
                        console.log('  ⏳ 服务端加载模型中...');
                    } else if (data === 'processing') {
                        console.log('  🎙️  开始转录');
                    }
                } else if (eventName === 'progress') {
                    const parts = data.split('|');
                    if (parts.length >= 2) {
                        const cur = parseFloat(parts[0]);
                        const total = parseFloat(parts[1]);
                        if (total > 0 && Number.isFinite(cur) && Number.isFinite(total)) {
                            const pct = Math.min((cur / total) * 100, 100);
                            const tier = Math.floor(pct / 10);
                            if (tier > lastReportedTier) {
                                console.log(`  📊 进度: ${tier * 10}%`);
                                lastReportedTier = tier;
                            }
                        }
                    }
                } else if (eventName === 'done') {
                    console.log('  ✅ 转录完成 (100%)');
                    return;
                } else if (eventName === 'error') {
                    throw new WhisperError(`服务端转录错误: ${data}`);
                }
                // ping 等其他事件忽略
            }
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            /* ignore */
        }
    }

    throw new WhisperError('SSE 连接意外结束,未收到 done 事件');
}

/**
 * 取回最终 LRC
 */
async function fetchResult(jobId: string, serverUrl: string): Promise<WhisperTranscriptionResult> {
    let res: Response;
    try {
        res = await fetch(`${serverUrl}/jobs/${jobId}/result`);
    } catch (e) {
        throw new WhisperError(`获取结果失败: ${e}`);
    }
    if (!res.ok) {
        throw new WhisperError(`获取结果失败 (HTTP ${res.status})`);
    }
    const body = (await res.json()) as WhisperTranscriptionResult;
    const hasWordTimestamps = Boolean(
        body.segments?.some(segment => segment.words && segment.words.length > 0)
    );
    if ((!body.lrc || !body.lrc.trim()) && !hasWordTimestamps) {
        throw new WhisperError('Whisper 返回空 LRC 且缺少 word timestamps');
    }
    return body;
}

/**
 * 对外主入口:从音频生成单语 LRC
 *
 * @param audioPath  本地音频路径
 * @param sttLang    语言代码,接受 'en'/'ja' 或 'en-US'/'ja-JP'(自动取前两位)
 * @param serverUrl  Whisper 服务器地址 (e.g. http://192.168.31.50:8000)
 * @param model      模型变体 ('default' | 'large-v3')
 * @param taskTraceDir 当前处理任务的 trace 目录;必须显式传入以避免并发任务串目录
 */
export async function generateLrcFromAudioWhisper(
    audioPath: string,
    sttLang: string,
    serverUrl: string,
    model: string = 'default',
    taskTraceDir?: string | null
): Promise<string> {
    invocationCount++;
    const lang = sttLang.slice(0, 2).toLowerCase();

    console.log(`🚀 步骤 1/3: 上传音频到 ${serverUrl} (lang=${lang}, model=${model})...`);
    const { job_id, duration } = await submitJob(audioPath, lang, model, serverUrl);
    console.log(`📦 任务已提交 (job_id=${job_id}, 音频时长=${duration.toFixed(1)}s)`);

    console.log(`⏱️  步骤 2/3: 监听转录进度...`);
    await streamProgress(job_id, serverUrl);

    console.log(`📥 步骤 3/3: 取回 LRC 结果...`);
    const result = await fetchResult(job_id, serverUrl);
    const snapshotPath = await saveWhisperResultSnapshot(result, audioPath, taskTraceDir);
    if (snapshotPath) {
        console.log(`  💾 Whisper result 已保存: ${snapshotPath}`);
    }
    const config = getConfig();

    if (config.lrcSegmentationMode === 'llm' || config.lrcSegmentationMode === 'manual') {
        try {
            return await segmentWhisperResultWithDeepSeek(result, lang, config, {
                traceDir: taskTraceDir ? path.join(taskTraceDir, '02-segmentation') : null
            });
        } catch (error) {
            // In manual mode, do NOT silently fall back to server LRC — the user
            // explicitly opted in to manual control. Re-throw so the pipeline
            // surfaces the failure (e.g. Ctrl-C during a wait).
            if (config.lrcSegmentationMode === 'manual') {
                throw error;
            }
            console.log(`  ⚠️  DeepSeek 分句失败,回退服务端 LRC: ${error}`);
        }
    }

    if (!result.lrc || !result.lrc.trim()) {
        throw new WhisperError('DeepSeek 分句失败且服务端 LRC 为空');
    }

    return result.lrc;
}

/**
 * 通知服务器释放显存。失败不抛(收尾用)
 */
export async function releaseWhisperVram(serverUrl: string): Promise<void> {
    try {
        const res = await fetch(`${serverUrl}/release`, { method: 'POST' });
        if (res.ok) {
            console.log(`🧹 已通知 Whisper 服务器释放显存`);
        } else {
            console.log(`⚠️  释放显存请求返回 ${res.status},忽略`);
        }
    } catch (e) {
        console.log(`⚠️  无法连接 Whisper 服务器释放显存: ${e}`);
    }
}
