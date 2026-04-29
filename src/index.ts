import fs from 'fs/promises';
import path from 'path';
import { getConfig, getLanguageConfigFromPath } from './config';
import { convertSrtFileToLrc } from './converter';
import { translateWithOpenRouter } from './translator';
import { batchSyncFiles } from './sync';
import { getCurrentYearMonth, findExistingBilingualLrc, buildOutputDir } from './utils';
import { generateLrcFromAudio } from './stt';

// 支持的音频格式
const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.wma'];

/**
 * 核心任务处理函数：整合已有字幕与 STT 功能
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

    // 检查是否已存在双语 LRC
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

    try {
        let lrcContent: string;

        // ---------------- 阶段 1: 获取单语 LRC ----------------
        try {
            // 策略 A: 本地已存在单语 LRC，直接读取
            await fs.access(monoLrcPath);
            console.log('📖 阶段 1/3: 单语 LRC 已存在，跳过生成');
            lrcContent = await fs.readFile(monoLrcPath, 'utf-8');
        } catch {
            // 单语 LRC 不存在，查找兜底方案
            if (srtPath) {
                // 策略 B: 优先使用本地 SRT 转换为单语 LRC
                console.log('🔄 阶段 1/3: 检测到本地 SRT 文件，正在转换为单语 LRC 格式...');
                lrcContent = await convertSrtFileToLrc(srtPath);
                await fs.writeFile(monoLrcPath, lrcContent, 'utf-8');
                console.log(`💾 已保存本地单语 LRC: ${baseName}.lrc`);
            } else {
                // 策略 C: 既没 LRC 也没 SRT，触发 Google STT
                const appConfig = getConfig();
                if (appConfig.enableGoogleStt && audioPath) {
                    console.log('🎙️  阶段 1/3: 未检测到本地字幕，启动 Google STT 自动识别...');
                    lrcContent = await generateLrcFromAudio(
                        audioPath,
                        languageConfig.sttLanguageCode,
                        appConfig.gcsBucketName
                    );
                    await fs.writeFile(monoLrcPath, lrcContent, 'utf-8');
                    console.log(`💾 成功保存 STT 识别结果至: ${baseName}.lrc`);
                } else {
                    console.log(`⚠️  跳过: 没有字幕文件，且 STT 未开启或缺少音频`);
                    return null;
                }
            }
        }

        if (!lrcContent.trim()) {
            console.log('⚠️  警告: 提取的单语文本为空，终止翻译');
            return null;
        }

        // ---------------- 阶段 2 & 3: 翻译与保存 (复用现有逻辑) ----------------
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
        console.error(`❌ 处理时发生错误: ${error}`);
        return null;
    }
}

/**
 * 智能扫描：同时检索音频和 SRT，进行配对处理
 */
async function scanAndProcess(dirPath: string): Promise<Array<any>> {
    const processedFiles: Array<any> = [];

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        // 用 Map 把同一基名（如 ep01.mp3 和 ep01.srt）的文件归拢在一起
        const itemMap = new Map<string, { audioPath?: string, srtPath?: string }>();

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

        // 开始分发处理任务
        for (const [baseName, item] of itemMap) {
            // 只要匹配到音频或 srt 中的任何一个，就进入流水线
            const result = await processTask(dirPath, baseName, item.audioPath, item.srtPath);
            if (result) {
                processedFiles.push(result);
            }
        }
    } catch (error) {
        console.error(`扫描文件夹失败 ${dirPath}: ${error}`);
    }

    return processedFiles;
}

/**
 * 主函数
 */
async function main() {
    const originalLog = console.log;
    const originalError = console.error;
    function getTimestamp(): string {
        return new Date().toLocaleString('zh-CN', { hour12: false });
    }
    console.log = (...args: any[]) => originalLog(`[${getTimestamp()}]`, ...args);
    console.error = (...args: any[]) => originalError(`[${getTimestamp()}]`, ...args);

    console.log('🎬 字幕自动翻译工具 - 混合调度模式 (SRT优先 / 智能唤起 STT)\n');
    try {
        const config = getConfig();
        console.log(`📂 根目录: ${config.rootDir}`);
        console.log(`🤖 翻译模型: ${config.currentModel}`);
        console.log(`🎙️  STT 状态: ${config.enableGoogleStt ? '已开启 (自动兜底无字幕音频)' : '已关闭'}`);
        if (config.syncDir) console.log(`📦 同步目录: ${config.syncDir}`);
        console.log('\n开始扫描文件夹...');

        const processedFiles = await scanAndProcess(config.rootDir);

        console.log('\n🎉 所有任务处理完成！');

        if (processedFiles.length > 0 && config.syncDir) {
            await batchSyncFiles(processedFiles);
        }
    } catch (error) {
        console.error(`\n❌ 致命错误: ${error}`);
        process.exit(1);
    }
}

main();