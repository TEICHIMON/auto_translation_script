import fs from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import { getConfig, getLanguageConfigFromPath } from './config';
import { translateWithOpenRouter } from './translator';
import { batchSyncFiles } from './sync';
import { getCurrentYearMonth, findExistingBilingualLrc, buildOutputDir } from './utils';

interface ProcessedFile {
    lrcPath: string;
    audioBasePath: string;
    languageFolder: string;
    relativePath: string;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 处理单个 LRC 文件 - 直接翻译模式
 * @returns 成功则返回 { lrcPath, audioBasePath, languageFolder, relativePath }，失败则返回 null
 */
async function translateLrcFile(lrcFilePath: string): Promise<ProcessedFile | null> {
    const fileName = path.basename(lrcFilePath);
    const baseName = fileName.replace(/\.lrc$/i, '');
    const dirName = path.dirname(lrcFilePath);
    const log = (msg: string) => console.log(`[${baseName}] ${msg}`);
    const logErr = (msg: string) => console.error(`[${baseName}] ${msg}`);

    // 获取语言配置（支持子文件夹）
    const langInfo = getLanguageConfigFromPath(lrcFilePath);

    if (!langInfo) {
        log(`⚠️  跳过: ${lrcFilePath} 不在已配置的语言文件夹中`);
        return null;
    }

    const { config: languageConfig, languageRoot } = langInfo;

    // output 基础目录
    const outputBaseDir = path.join(languageRoot, 'output');

    // 检查是否已存在双语 LRC（扁平化搜索，不传 relativePath）
    const existingLrc = await findExistingBilingualLrc(outputBaseDir, '', baseName);
    if (existingLrc) {
        const displayPath = path.relative(languageRoot, existingLrc);
        log(`⏭️  跳过: ${displayPath} 已存在`);
        return null;
    }

    // 获取当前年月
    const yearMonth = getCurrentYearMonth();

    // 输出目录（扁平化，不保留子文件夹层级）
    const outputDir = buildOutputDir(outputBaseDir, yearMonth, '');

    const translatedLrcPath = path.join(outputDir, `${baseName}.lrc`);

    // 确保 output 文件夹存在
    try {
        await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
        logErr(`创建 output 文件夹失败: ${error}`);
        return null;
    }

    // 显示相对路径，更清晰
    const displayPath = path.relative(languageRoot, lrcFilePath);
    log(`📝 处理: ${languageConfig.folderName}/${displayPath}`);

    try {
        // 1. 读取 LRC 内容
        log('📖 步骤 1/2: 读取 LRC 文件...');
        const lrcContent = await fs.readFile(lrcFilePath, 'utf-8');

        if (!lrcContent.trim()) {
            log('⚠️  警告: LRC 文件内容为空，跳过翻译');
            return null;
        }

        // 2. 调用 API 翻译
        log('🌐 步骤 2/2: 调用 AI 翻译...');
        const translatedContent = await translateWithOpenRouter(
            lrcContent,
            languageConfig.translationPrompt
        );

        // 3. 保存翻译后的 LRC
        log('💾 保存翻译后的 LRC 文件...');
        await fs.writeFile(translatedLrcPath, translatedContent, 'utf-8');

        const outputDisplayPath = path.relative(languageRoot, translatedLrcPath);
        log(`✅ 完成: ${languageConfig.folderName}/${outputDisplayPath}`);

        // 返回文件信息用于批量同步（音频路径仍指向原始目录）
        return {
            lrcPath: translatedLrcPath,
            audioBasePath: dirName,
            languageFolder: languageConfig.folderName,
            relativePath: ''
        };
    } catch (error) {
        logErr(`❌ 错误: ${error}`);
        return null;
    }
}

/**
 * 扫描文件夹并收集所有 LRC 文件
 */
async function scanAndTranslate(dirPath: string): Promise<string[]> {
    const lrcFiles: string[] = [];

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                // 跳过 output 文件夹
                if (entry.name === 'output') {
                    continue;
                }
                // 递归处理子文件夹
                const subFiles = await scanAndTranslate(fullPath);
                lrcFiles.push(...subFiles);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lrc')) {
                lrcFiles.push(fullPath);
            }
        }
    } catch (error) {
        console.error(`扫描文件夹失败 ${dirPath}: ${error}`);
    }

    return lrcFiles;
}

/**
 * 主函数
 */
async function main() {
    // --- 添加日志时间戳功能 ---
    const originalLog = console.log;
    const originalError = console.error;

    function getTimestamp() {
        return new Date().toLocaleString('zh-CN', { hour12: false });
    }

    console.log = (...args: any[]) => {
        originalLog(`[${getTimestamp()}]`, ...args);
    };

    console.error = (...args: any[]) => {
        originalError(`[${getTimestamp()}]`, ...args);
    };
    // -----------------------
    console.log('🎬 字幕翻译工具 - LRC 直接翻译模式\n');

    try {
        const config = getConfig();
        console.log(`📂 根目录: ${config.rootDir}`);
        console.log(`🤖 模型: ${config.translationProvider}/${config.currentModel}`);
        console.log(`🚦 最大并发任务数: ${config.maxConcurrentTasks}`);
        console.log(
            `✂️  LRC 分句: ${
                config.lrcSegmentationMode === 'llm'
                    ? `DeepSeek/${config.lrcSegmentationModel}`
                    : '服务端启发式'
            }, critique=${config.lrcSegmentationCritique ? 'on' : 'off'}\n`
        );
        console.log('开始扫描 LRC 文件...\n');

        const lrcFiles = await scanAndTranslate(config.rootDir);
        console.log(`🔎 发现 LRC 文件: ${lrcFiles.length}`);

        const limit = pLimit(config.maxConcurrentTasks);
        const settledResults = await Promise.allSettled(
            lrcFiles.map((lrcFilePath) => limit(() => translateLrcFile(lrcFilePath)))
        );

        const processedFiles: ProcessedFile[] = [];
        settledResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                if (result.value) processedFiles.push(result.value);
                return;
            }

            const baseName = path.basename(lrcFiles[index], path.extname(lrcFiles[index]));
            console.error(`[${baseName}] ❌ 翻译任务失败,跳过本文件: ${formatError(result.reason)}`);
        });

        console.log('\n🎉 所有翻译任务完成！');

        // 批量同步文件
        if (processedFiles.length > 0 && config.syncDir) {
            await batchSyncFiles(processedFiles);
        }
    } catch (error) {
        console.error(`\n❌ 错误: ${error}`);
        process.exit(1);
    }
}

main();
