import fs from 'fs/promises';
import path from 'path';
import { getConfig, getLanguageConfigFromPath } from './config';
import { convertSrtFileToLrc } from './converter';
import { translateWithOpenRouter } from './translator';
import { batchSyncFiles } from './sync';
import { getCurrentYearMonth, findExistingBilingualLrc, buildOutputDir } from './utils';
import {
    generateLrcFromAudioWhisper,
    releaseWhisperVram,
    getWhisperInvocationCount,
    WhisperError
} from './whisper-stt';

const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.wma'];

/**
 * 核心任务处理:SRT 优先 → Whisper 兜底 → 翻译
 *
 * 错误策略:
 *   - WhisperError(服务端不可用/出错):向上抛,中止整个 main
 *   - 其他错误(单文件解析、翻译 API 抖动):log 后返回 null,继续下一个
 */
async function processTask(
    dirName: string,
    baseName: string,
    audioPath?: string,
    srtPath?: string
): Promise<{
    lrcPath: string;
    audioBasePath: string;
    languageFolder: string;
    relativePath: string;
} | null> {
    const referencePath = audioPath || srtPath;
    if (!referencePath) return null;

    const langInfo = getLanguageConfigFromPath(referencePath);
    if (!langInfo) return null;

    const { config: languageConfig, languageRoot } = langInfo;
    const outputBaseDir = path.join(languageRoot, 'output');

    const existingLrc = await findExistingBilingualLrc(outputBaseDir, '', baseName);
    if (existingLrc) {
        const displayPath = path.relative(languageRoot, existingLrc);
        console.log(`⏭️  跳过: ${displayPath} (双语字幕已存在)`);
        return null;
    }

    const yearMonth = getCurrentYearMonth();
    const outputDir = buildOutputDir(outputBaseDir, yearMonth, '');
    const monoLrcPath = path.join(dirName, `${baseName}.lrc`);
    const bilingualLrcPath = path.join(outputDir, `${baseName}.lrc`);

    try {
        await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
        console.error(`创建 output 文件夹失败: ${error}`);
        return null;
    }

    const displayPath = path.relative(languageRoot, referencePath);
    console.log(`\n📝 处理任务: ${languageConfig.folderName}/${displayPath}`);

    let lrcContent: string;

    // ---------------- 阶段 1: 获取单语 LRC ----------------
    try {
        await fs.access(monoLrcPath);
        console.log('📖 阶段 1/3: 单语 LRC 已存在,跳过生成');
        lrcContent = await fs.readFile(monoLrcPath, 'utf-8');
    } catch {
        if (srtPath) {
            // 策略 A: 本地 SRT → 单语 LRC
            try {
                console.log('🔄 阶段 1/3: 检测到本地 SRT,正在转换为单语 LRC...');
                lrcContent = await convertSrtFileToLrc(srtPath);
                await fs.writeFile(monoLrcPath, lrcContent, 'utf-8');
                console.log(`💾 已保存本地单语 LRC: ${baseName}.lrc`);
            } catch (e) {
                console.error(`❌ SRT 转换失败,跳过本文件: ${e}`);
                return null;
            }
        } else {
            // 策略 B: 没有 SRT → Whisper 兜底
            const appConfig = getConfig();
            if (!appConfig.enableWhisperStt || !audioPath) {
                console.log(`⚠️  跳过: 没有字幕文件,且 Whisper STT 未启用或缺少音频`);
                return null;
            }
            console.log('🎙️  阶段 1/3: 未检测到本地字幕,启动 Whisper 转录...');
            // ⚠️ 这里抛出的 WhisperError 会向上传播,中止整个流水线
            lrcContent = await generateLrcFromAudioWhisper(
                audioPath,
                languageConfig.sttLanguageCode,
                appConfig.whisperServerUrl,
                appConfig.whisperModel
            );
            await fs.writeFile(monoLrcPath, lrcContent, 'utf-8');
            console.log(`💾 已保存 Whisper 转录结果: ${baseName}.lrc`);
        }
    }

    if (!lrcContent.trim()) {
        console.log('⚠️  警告: 单语文本为空,终止本文件翻译');
        return null;
    }

    // ---------------- 阶段 2 & 3: 翻译与保存 ----------------
    try {
        console.log('🌐 阶段 2/3: 调用大模型进行翻译...');
        const translatedContent = await translateWithOpenRouter(
            lrcContent,
            languageConfig.translationPrompt
        );

        console.log('💾 阶段 3/3: 保存双语 LRC 文件...');
        await fs.writeFile(bilingualLrcPath, translatedContent, 'utf-8');

        const outputDisplayPath = path.relative(languageRoot, bilingualLrcPath);
        console.log(`✅ 翻译完成: ${languageConfig.folderName}/${outputDisplayPath}`);

        return {
            lrcPath: bilingualLrcPath,
            audioBasePath: dirName,
            languageFolder: languageConfig.folderName,
            relativePath: ''
        };
    } catch (error) {
        console.error(`❌ 翻译/保存失败,跳过本文件: ${error}`);
        return null;
    }
}

async function scanAndProcess(dirPath: string): Promise<Array<any>> {
    const processedFiles: Array<any> = [];

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const itemMap = new Map<string, { audioPath?: string; srtPath?: string }>();

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'output') continue;
            const subResults = await scanAndProcess(fullPath);
            processedFiles.push(...subResults);
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
        // WhisperError 会向上抛,中止本目录及后续扫描
        const result = await processTask(dirPath, baseName, item.audioPath, item.srtPath);
        if (result) processedFiles.push(result);
    }

    return processedFiles;
}

async function main() {
    const originalLog = console.log;
    const originalError = console.error;
    const getTimestamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
    console.log = (...args: any[]) => originalLog(`[${getTimestamp()}]`, ...args);
    console.error = (...args: any[]) => originalError(`[${getTimestamp()}]`, ...args);

    console.log('🎬 字幕自动翻译工具 - 混合调度模式 (SRT 优先 / Whisper 兜底)\n');

    let appConfig: ReturnType<typeof getConfig> | null = null;

    try {
        appConfig = getConfig();
        console.log(`📂 根目录: ${appConfig.rootDir}`);
        console.log(`🤖 翻译模型: ${appConfig.translationProvider}/${appConfig.currentModel}`);
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
            }`
        );
        if (appConfig.syncDir) console.log(`📦 同步目录: ${appConfig.syncDir}`);
        console.log('\n开始扫描文件夹...');

        const processedFiles = await scanAndProcess(appConfig.rootDir);

        console.log('\n🎉 所有任务处理完成!');

        if (processedFiles.length > 0 && appConfig.syncDir) {
            await batchSyncFiles(processedFiles);
        }
    } catch (error) {
        if (error instanceof WhisperError) {
            console.error(`\n❌ Whisper 服务异常,流水线已中止: ${error.message}`);
        } else {
            console.error(`\n❌ 致命错误,流水线已中止: ${error}`);
        }
        process.exitCode = 1;
    } finally {
        // 仅在本轮真的用过 Whisper 时才发 release
        if (
            appConfig?.enableWhisperStt &&
            appConfig?.whisperAutoRelease &&
            getWhisperInvocationCount() > 0
        ) {
            await releaseWhisperVram(appConfig.whisperServerUrl);
        }
    }
}

main();
