import fs from 'fs/promises';
import path from 'path';
import { getConfig, getLanguageConfigFromPath, getRelativePathFromLanguageRoot } from './config';
import { convertSrtFileToLrc } from './converter';
import { translateWithOpenRouter } from './translator';
import { batchSyncFiles } from './sync';

/**
 * 获取当前年月，格式: YYYY-MM
 */
function getCurrentYearMonth(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

/**
 * 在 output 目录下查找已存在的双语 LRC 文件
 * 同时检查旧结构和新结构：
 * - 旧结构：output/xxx.lrc 或 output/subfolder/xxx.lrc
 * - 新结构：output/YYYY-MM/xxx.lrc 或 output/YYYY-MM/subfolder/xxx.lrc
 *
 * @param outputBaseDir output 目录路径（如 /root/English/output）
 * @param relativePath 相对路径（如 podcast），空字符串表示根目录
 * @param baseName 文件基础名（如 ep01）
 * @returns 找到的文件路径，或 null
 */
async function findExistingBilingualLrc(
    outputBaseDir: string,
    relativePath: string,
    baseName: string
): Promise<string | null> {
    // 1. 先检查旧结构：直接在 output/ 或 output/relativePath/ 下
    const oldStructureDir = relativePath
        ? path.join(outputBaseDir, relativePath)
        : outputBaseDir;
    const oldStructurePath = path.join(oldStructureDir, `${baseName}.lrc`);

    try {
        await fs.access(oldStructurePath);
        return oldStructurePath;
    } catch {
        // 旧结构不存在，继续检查新结构
    }

    // 2. 检查新结构：output/YYYY-MM/ 或 output/YYYY-MM/relativePath/
    try {
        const entries = await fs.readdir(outputBaseDir, { withFileTypes: true });
        for (const entry of entries) {
            // 只检查 YYYY-MM 格式的文件夹
            if (entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name)) {
                const monthDir = path.join(outputBaseDir, entry.name);
                const targetDir = relativePath ? path.join(monthDir, relativePath) : monthDir;
                const lrcPath = path.join(targetDir, `${baseName}.lrc`);
                try {
                    await fs.access(lrcPath);
                    return lrcPath;
                } catch {
                    // 继续检查下一个月份
                }
            }
        }
    } catch {
        // output 目录不存在
    }

    return null;
}

/**
 * 处理单个 SRT 文件
 * @returns 成功则返回 { lrcPath, audioBasePath, languageFolder, relativePath }，失败则返回 null
 */
async function processSrtFile(srtFilePath: string): Promise<{
    lrcPath: string;
    audioBasePath: string;
    languageFolder: string;
    relativePath: string;
} | null> {
    const fileName = path.basename(srtFilePath);
    const baseName = fileName.replace(/\.srt$/i, '');
    const dirName = path.dirname(srtFilePath);

    // 获取语言配置（支持子文件夹）
    const langInfo = getLanguageConfigFromPath(srtFilePath);

    if (!langInfo) {
        console.log(`⚠️  跳过: ${srtFilePath} 不在已配置的语言文件夹中`);
        return null;
    }

    const { config: languageConfig, languageRoot } = langInfo;

    // 计算相对于语言文件夹的路径
    const relativeFilePath = getRelativePathFromLanguageRoot(srtFilePath, languageRoot);
    const relativeDir = path.dirname(relativeFilePath);
    const relativeDirClean = relativeDir === '.' ? '' : relativeDir;

    // output 基础目录
    const outputBaseDir = path.join(languageRoot, 'output');

    // 检查是否已存在双语 LRC（同时检查旧结构和新结构）
    const existingLrc = await findExistingBilingualLrc(outputBaseDir, relativeDirClean, baseName);
    if (existingLrc) {
        const displayPath = path.relative(languageRoot, existingLrc);
        console.log(`⏭️  跳过: ${displayPath} 已存在`);
        return null;
    }

    // 获取当前年月
    const yearMonth = getCurrentYearMonth();

    // 输出目录：语言文件夹/output/YYYY-MM/子路径
    const outputDir = relativeDirClean
        ? path.join(outputBaseDir, yearMonth, relativeDirClean)
        : path.join(outputBaseDir, yearMonth);

    // 单语 LRC 路径（与 SRT 同级）
    const monoLrcPath = path.join(dirName, `${baseName}.lrc`);
    // 双语 LRC 路径（在 output/YYYY-MM/ 文件夹中）
    const bilingualLrcPath = path.join(outputDir, `${baseName}.lrc`);

    // 确保 output 文件夹存在
    try {
        await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
        console.error(`创建 output 文件夹失败: ${error}`);
        return null;
    }

    // 显示相对路径，更清晰
    const displayPath = path.relative(languageRoot, srtFilePath);
    console.log(`\n📝 处理: ${languageConfig.folderName}/${displayPath}`);

    try {
        let lrcContent: string;

        // 步骤 1: SRT -> 单语 LRC
        try {
            await fs.access(monoLrcPath);
            console.log('📖 步骤 1/3: 单语 LRC 已存在，跳过转换');
            lrcContent = await fs.readFile(monoLrcPath, 'utf-8');
        } catch {
            console.log('🔄 步骤 1/3: 转换 SRT 到单语 LRC 格式...');
            lrcContent = await convertSrtFileToLrc(srtFilePath);

            if (!lrcContent.trim()) {
                console.log('⚠️  警告: 转换后内容为空，跳过翻译');
                return null;
            }

            // 保存单语 LRC
            await fs.writeFile(monoLrcPath, lrcContent, 'utf-8');
            console.log(`💾 已保存单语 LRC: ${baseName}.lrc`);
        }

        // 步骤 2: 调用 API 翻译
        console.log('🌐 步骤 2/3: 调用 AI 翻译...');
        const translatedContent = await translateWithOpenRouter(
            lrcContent,
            languageConfig.translationPrompt
        );

        // 步骤 3: 保存双语 LRC
        console.log('💾 步骤 3/3: 保存双语 LRC 文件...');
        await fs.writeFile(bilingualLrcPath, translatedContent, 'utf-8');

        const outputDisplayPath = path.relative(languageRoot, bilingualLrcPath);
        console.log(`✅ 完成: ${languageConfig.folderName}/${outputDisplayPath}`);

        // 返回文件信息用于同步
        return {
            lrcPath: bilingualLrcPath,
            audioBasePath: dirName,
            languageFolder: languageConfig.folderName,
            relativePath: relativeDirClean
        };
    } catch (error) {
        console.error(`❌ 错误: ${error}`);
        return null;
    }
}

/**
 * 扫描文件夹并处理所有 SRT 文件
 * @returns 成功处理的文件列表
 */
async function scanAndProcess(dirPath: string): Promise<Array<{
    lrcPath: string;
    audioBasePath: string;
    languageFolder: string;
    relativePath: string;
}>> {
    const processedFiles: Array<{
        lrcPath: string;
        audioBasePath: string;
        languageFolder: string;
        relativePath: string;
    }> = [];

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
                const subResults = await scanAndProcess(fullPath);
                processedFiles.push(...subResults);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.srt')) {
                // 处理 SRT 文件
                const result = await processSrtFile(fullPath);
                if (result) {
                    processedFiles.push(result);
                }
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
    // ============ 时间戳设置 - 必须在第一行! ============
    const originalLog = console.log;
    const originalError = console.error;

    function getTimestamp(): string {
        return new Date().toLocaleString('zh-CN', { hour12: false });
    }

    console.log = (...args: any[]) => {
        originalLog(`[${getTimestamp()}]`, ...args);
    };

    console.error = (...args: any[]) => {
        originalError(`[${getTimestamp()}]`, ...args);
    };
    // ===================================================
    console.log('🎬 字幕自动翻译工具 - 手动模式\n');
    try {
        const config = getConfig();
        console.log(`📂 根目录: ${config.rootDir}`);
        console.log(`🤖 模型: ${config.currentModel}`);
        if (config.syncDir) {
            console.log(`📦 同步目录: ${config.syncDir}`);
        }
        console.log('\n开始扫描文件夹...\n');

        const processedFiles = await scanAndProcess(config.rootDir);

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