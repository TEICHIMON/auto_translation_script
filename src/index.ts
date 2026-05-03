import fs from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import { getConfig, getLanguageConfigFromPath } from './config';
import { convertSrtFileToLrc } from './converter';
import { translateWithOpenRouter } from './translator';
import { batchSyncFiles } from './sync';
import { getCurrentYearMonth, findExistingBilingualLrc, buildOutputDir } from './utils';
import {
    startPipelineTrace,
    startTaskTrace,
    writeTraceJson,
    writeTraceText
} from './temp-trace';
import {
    generateLrcFromAudioWhisper,
    releaseWhisperVram,
    getWhisperInvocationCount,
    WhisperError
} from './whisper-stt';

const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.wma'];

interface ProcessTaskItem {
    dirPath: string;
    baseName: string;
    audioPath?: string;
    srtPath?: string;
}

interface ProcessedFile {
    lrcPath: string;
    audioBasePath: string;
    languageFolder: string;
    relativePath: string;
}

interface WhisperTaskFailure {
    baseName: string;
    error: WhisperError;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 核心任务处理:SRT 优先 → Whisper 兜底 → 翻译
 *
 * 错误策略:
 *   - WhisperError(服务端不可用/出错):向上抛,由 main 聚合后统一处理
 *   - 其他错误(单文件解析、翻译 API 抖动):log 后返回 null,继续下一个
 */
async function processTask(
    dirName: string,
    baseName: string,
    audioPath?: string,
    srtPath?: string
): Promise<ProcessedFile | null> {
    const log = (msg: string) => console.log(`[${baseName}] ${msg}`);
    const logErr = (msg: string) => console.error(`[${baseName}] ${msg}`);

    const referencePath = audioPath || srtPath;
    if (!referencePath) return null;

    const langInfo = getLanguageConfigFromPath(referencePath);
    if (!langInfo) return null;

    const { config: languageConfig, languageRoot } = langInfo;
    const outputBaseDir = path.join(languageRoot, 'output');

    const existingLrc = await findExistingBilingualLrc(outputBaseDir, '', baseName);
    if (existingLrc) {
        const displayPath = path.relative(languageRoot, existingLrc);
        log(`⏭️  跳过: ${displayPath} (双语字幕已存在)`);
        return null;
    }

    const yearMonth = getCurrentYearMonth();
    const outputDir = buildOutputDir(outputBaseDir, yearMonth, '');
    const monoLrcPath = path.join(dirName, `${baseName}.lrc`);
    const bilingualLrcPath = path.join(outputDir, `${baseName}.lrc`);

    try {
        await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
        logErr(`创建 output 文件夹失败: ${error}`);
        return null;
    }

    const displayPath = path.relative(languageRoot, referencePath);
    log(`📝 处理任务: ${languageConfig.folderName}/${displayPath}`);
    const taskTraceDir = await startTaskTrace(`${languageConfig.folderName}-${baseName}`, {
        baseName,
        languageFolder: languageConfig.folderName,
        sourceLanguage: languageConfig.sourceLanguage,
        targetLanguage: languageConfig.targetLanguage,
        referencePath,
        audioPath,
        srtPath,
        monoLrcPath,
        bilingualLrcPath
    });
    if (taskTraceDir) {
        log(`🧾 临时 trace: ${taskTraceDir}`);
    }

    let lrcContent: string;

    // ---------------- 阶段 1: 获取单语 LRC ----------------
    try {
        await fs.access(monoLrcPath);
        log('📖 阶段 1/3: 单语 LRC 已存在,跳过生成');
        lrcContent = await fs.readFile(monoLrcPath, 'utf-8');
        await writeTraceJson(taskTraceDir, '01-source-lrc/meta.json', {
            source: 'existing-lrc',
            path: monoLrcPath
        });
        await writeTraceText(taskTraceDir, '01-source-lrc/input.lrc', lrcContent);
        await writeTraceText(taskTraceDir, '01-source-lrc/output.lrc', lrcContent);
    } catch {
        if (srtPath) {
            // 策略 A: 本地 SRT → 单语 LRC
            try {
                log('🔄 阶段 1/3: 检测到本地 SRT,正在转换为单语 LRC...');
                const srtContent = await fs.readFile(srtPath, 'utf-8');
                await writeTraceJson(taskTraceDir, '01-source-lrc/meta.json', {
                    source: 'srt',
                    path: srtPath
                });
                await writeTraceText(taskTraceDir, '01-source-lrc/input.srt', srtContent);
                lrcContent = await convertSrtFileToLrc(srtPath);
                await writeTraceText(taskTraceDir, '01-source-lrc/output.lrc', lrcContent);
                await fs.writeFile(monoLrcPath, lrcContent, 'utf-8');
                log(`💾 已保存本地单语 LRC: ${baseName}.lrc`);
            } catch (e) {
                logErr(`❌ SRT 转换失败,跳过本文件: ${e}`);
                return null;
            }
        } else {
            // 策略 B: 没有 SRT → Whisper 兜底
            const appConfig = getConfig();
            if (!appConfig.enableWhisperStt || !audioPath) {
                log(`⚠️  跳过: 没有字幕文件,且 Whisper STT 未启用或缺少音频`);
                return null;
            }
            log('🎙️  阶段 1/3: 未检测到本地字幕,启动 Whisper 转录...');
            // WhisperError 保持向上传播,由 main 在 allSettled 后聚合。
            lrcContent = await generateLrcFromAudioWhisper(
                audioPath,
                languageConfig.sttLanguageCode,
                appConfig.whisperServerUrl,
                appConfig.whisperModel
            );
            await writeTraceJson(taskTraceDir, '01-source-lrc/meta.json', {
                source: 'whisper',
                audioPath,
                model: appConfig.whisperModel,
                lang: languageConfig.sttLanguageCode
            });
            await writeTraceText(taskTraceDir, '01-source-lrc/output.lrc', lrcContent);
            await fs.writeFile(monoLrcPath, lrcContent, 'utf-8');
            log(`💾 已保存 Whisper 转录结果: ${baseName}.lrc`);
        }
    }

    if (!lrcContent.trim()) {
        log('⚠️  警告: 单语文本为空,终止本文件翻译');
        return null;
    }

    // ---------------- 阶段 2 & 3: 翻译与保存 ----------------
    try {
        log('🌐 阶段 2/3: 调用大模型进行翻译...');
        const translatedContent = await translateWithOpenRouter(
            lrcContent,
            languageConfig.translationPrompt,
            taskTraceDir ? path.join(taskTraceDir, '03-translation') : null
        );

        log('💾 阶段 3/3: 保存双语 LRC 文件...');
        await fs.writeFile(bilingualLrcPath, translatedContent, 'utf-8');
        await writeTraceJson(taskTraceDir, '04-output/meta.json', {
            monoLrcPath,
            bilingualLrcPath
        });
        await writeTraceText(taskTraceDir, '04-output/mono.lrc', lrcContent);
        await writeTraceText(taskTraceDir, '04-output/bilingual.lrc', translatedContent);

        const outputDisplayPath = path.relative(languageRoot, bilingualLrcPath);
        log(`✅ 翻译完成: ${languageConfig.folderName}/${outputDisplayPath}`);

        return {
            lrcPath: bilingualLrcPath,
            audioBasePath: dirName,
            languageFolder: languageConfig.folderName,
            relativePath: ''
        };
    } catch (error) {
        logErr(`❌ 翻译/保存失败,跳过本文件: ${error}`);
        return null;
    }
}

async function scanAndProcess(dirPath: string): Promise<ProcessTaskItem[]> {
    const tasks: ProcessTaskItem[] = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const itemMap = new Map<string, { audioPath?: string; srtPath?: string }>();

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'output') continue;
            const subTasks = await scanAndProcess(fullPath);
            tasks.push(...subTasks);
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const baseName = entry.name.slice(0, -ext.length);

            if (AUDIO_EXTS.includes(ext)) {
                if (!itemMap.has(baseName)) itemMap.set(baseName, {});
                itemMap.get(baseName)!.audioPath = fullPath;
            } else if (ext === '.srt') {
                if (!itemMap.has(baseName)) itemMap.set(baseName, {});
                itemMap.get(baseName)!.srtPath = fullPath;
            }
        }
    }

    for (const [baseName, item] of itemMap) {
        tasks.push({
            dirPath,
            baseName,
            audioPath: item.audioPath,
            srtPath: item.srtPath
        });
    }

    return tasks;
}

async function main() {
    const originalLog = console.log;
    const originalError = console.error;
    const getTimestamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
    console.log = (...args: any[]) => originalLog(`[${getTimestamp()}]`, ...args);
    console.error = (...args: any[]) => originalError(`[${getTimestamp()}]`, ...args);

    console.log('🎬 字幕自动翻译工具 - 混合调度模式 (SRT 优先 / Whisper 兜底)\n');

    let appConfig: ReturnType<typeof getConfig> | null = null;
    let exitAfterCleanup = false;

    try {
        appConfig = getConfig();
        const traceDir = await startPipelineTrace('pipeline', {
            rootDir: appConfig.rootDir,
            translationProvider: appConfig.translationProvider,
            currentModel: appConfig.currentModel,
            enableWhisperStt: appConfig.enableWhisperStt,
            whisperServerUrl: appConfig.whisperServerUrl,
            whisperModel: appConfig.whisperModel,
            lrcSegmentationMode: appConfig.lrcSegmentationMode,
            lrcSegmentationModel: appConfig.lrcSegmentationModel,
            lrcSegmentationChunkWords: appConfig.lrcSegmentationChunkWords,
            lrcSegmentationCritique: appConfig.lrcSegmentationCritique,
            maxConcurrentTasks: appConfig.maxConcurrentTasks
        });
        console.log(`📂 根目录: ${appConfig.rootDir}`);
        console.log(`🧾 临时 trace 目录: ${traceDir}`);
        console.log(`🤖 翻译模型: ${appConfig.translationProvider}/${appConfig.currentModel}`);
        console.log(`🚦 最大并发任务数: ${appConfig.maxConcurrentTasks}`);
        console.log(
            `🎙️  Whisper STT: ${
                appConfig.enableWhisperStt
                    ? `已启用 (${appConfig.whisperServerUrl}, model=${appConfig.whisperModel})`
                    : '已关闭'
            }`
        );
        console.log(
            `✂️  LRC 分句: ${
                appConfig.lrcSegmentationMode === 'llm'
                    ? `DeepSeek/${appConfig.lrcSegmentationModel}`
                    : '服务端启发式'
            }, critique=${appConfig.lrcSegmentationCritique ? 'on' : 'off'}`
        );
        if (appConfig.syncDir) console.log(`📦 同步目录: ${appConfig.syncDir}`);
        console.log('\n开始扫描文件夹...');

        const tasks = await scanAndProcess(appConfig.rootDir);
        console.log(`🔎 发现待处理任务: ${tasks.length}`);

        const limit = pLimit(appConfig.maxConcurrentTasks);
        const settledResults = await Promise.allSettled(
            tasks.map((task) =>
                limit(() => processTask(task.dirPath, task.baseName, task.audioPath, task.srtPath))
            )
        );

        const processedFiles: ProcessedFile[] = [];
        const whisperFailures: WhisperTaskFailure[] = [];

        settledResults.forEach((result, index) => {
            const task = tasks[index];
            if (result.status === 'fulfilled') {
                if (result.value) processedFiles.push(result.value);
                return;
            }

            if (result.reason instanceof WhisperError) {
                whisperFailures.push({
                    baseName: task.baseName,
                    error: result.reason
                });
                return;
            }

            console.error(`[${task.baseName}] ❌ 任务失败,跳过本文件: ${formatError(result.reason)}`);
        });

        console.log('\n🎉 所有任务处理完成!');

        if (processedFiles.length > 0 && appConfig.syncDir) {
            await batchSyncFiles(processedFiles);
        }

        if (whisperFailures.length > 0) {
            console.error(`\n❌ Whisper 错误 ${whisperFailures.length} 次,服务端可能不可用`);
            for (const failure of whisperFailures) {
                console.error(`  - ${failure.baseName}: ${formatError(failure.error)}`);
            }
            exitAfterCleanup = true;
        }
    } catch (error) {
        if (error instanceof WhisperError) {
            console.error(`\n❌ Whisper 服务异常,流水线已中止: ${error.message}`);
            exitAfterCleanup = true;
        } else {
            console.error(`\n❌ 致命错误,流水线已中止: ${error}`);
            process.exitCode = 1;
        }
    } finally {
        // 仅在本轮真的用过 Whisper 时才发 release
        if (
            appConfig?.enableWhisperStt &&
            appConfig?.whisperAutoRelease &&
            getWhisperInvocationCount() > 0
        ) {
            await releaseWhisperVram(appConfig.whisperServerUrl);
        }
        if (exitAfterCleanup) {
            process.exit(1);
        }
    }
}

main();
