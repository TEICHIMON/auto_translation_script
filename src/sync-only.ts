import fs from 'fs/promises';
import path from 'path';
import { getConfig, getLanguageConfigFromPath, getRelativePathFromLanguageRoot } from './config';
import { batchSyncFiles } from './sync';

/**
 * 查找已翻译的 LRC 文件和对应的音频文件
 * 支持子文件夹结构
 */
async function findTranslatedFiles(dirPath: string, languageRoot?: string, languageFolder?: string): Promise<Array<{
    lrcPath: string;
    audioBasePath: string;
    languageFolder: string;
    relativePath: string;
}>> {
    const files: Array<{
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
                // 检查是否是语言文件夹
                const langInfo = getLanguageConfigFromPath(fullPath);

                if (entry.name === 'output' && languageRoot) {
                    // 扫描 output 文件夹中的 LRC 文件（包括子文件夹）
                    const outputFiles = await scanOutputFolder(fullPath, languageRoot, languageFolder || '');
                    files.push(...outputFiles);
                } else if (langInfo && !languageRoot) {
                    // 进入语言文件夹
                    const subFiles = await findTranslatedFiles(fullPath, langInfo.languageRoot, langInfo.config.folderName);
                    files.push(...subFiles);
                } else {
                    // 递归扫描子文件夹
                    const subFiles = await findTranslatedFiles(fullPath, languageRoot, languageFolder);
                    files.push(...subFiles);
                }
            }
        }
    } catch (error) {
        console.error(`扫描文件夹失败 ${dirPath}: ${error}`);
    }

    return files;
}

/**
 * 扫描 output 文件夹，支持子文件夹结构
 */
async function scanOutputFolder(outputPath: string, languageRoot: string, languageFolder: string): Promise<Array<{
    lrcPath: string;
    audioBasePath: string;
    languageFolder: string;
    relativePath: string;
}>> {
    const files: Array<{
        lrcPath: string;
        audioBasePath: string;
        languageFolder: string;
        relativePath: string;
    }> = [];

    try {
        const entries = await fs.readdir(outputPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(outputPath, entry.name);

            if (entry.isDirectory()) {
                // 递归扫描子文件夹
                const subFiles = await scanOutputFolder(fullPath, languageRoot, languageFolder);
                files.push(...subFiles);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lrc')) {
                // 计算相对路径
                // outputPath 类似 /root/English/output 或 /root/English/output/podcast
                // 我们需要得到相对于 output 的路径
                const outputRoot = path.join(languageRoot, 'output');
                const relativeToOutput = path.relative(outputRoot, outputPath);
                const relativePath = relativeToOutput === '.' ? '' : relativeToOutput;

                // 音频文件的基础路径
                const audioBasePath = relativePath
                    ? path.join(languageRoot, relativePath)
                    : languageRoot;

                files.push({
                    lrcPath: fullPath,
                    audioBasePath,
                    languageFolder,
                    relativePath
                });
            }
        }
    } catch (error) {
        console.error(`扫描 output 文件夹失败 ${outputPath}: ${error}`);
    }

    return files;
}

/**
 * 主函数 - 仅同步已翻译的文件
 */
async function main() {
    // --- 添加日志时间戳功能 ---
    const originalLog = console.log;
    const originalError = console.error;

    function getTimestamp() {
        // 获取当前时间，格式如: 2025/11/21 01:00:05
        return new Date().toLocaleString('zh-CN', { hour12: false });
    }

    console.log = (...args: any[]) => {
        originalLog(`[${getTimestamp()}]`, ...args);
    };

    console.error = (...args: any[]) => {
        originalError(`[${getTimestamp()}]`, ...args);
    };
// -----------------------
    console.log('🎬 字幕同步工具 - 仅同步模式\n');


    try {
        const config = getConfig();
        console.log(`📂 根目录: ${config.rootDir}`);

        if (!config.syncDir) {
            console.log('⚠️  未配置 SYNC_DIR，无法同步文件');
            console.log('请在 .env 文件中设置 SYNC_DIR');
            return;
        }

        console.log(`📦 同步目录: ${config.syncDir}`);
        console.log('\n开始扫描已翻译的文件...\n');

        // 查找所有已翻译的文件
        const translatedFiles = await findTranslatedFiles(config.rootDir);

        if (translatedFiles.length === 0) {
            console.log('⚠️  未找到已翻译的文件');
            console.log('请先运行翻译脚本生成 LRC 文件');
            return;
        }

        console.log(`✅ 找到 ${translatedFiles.length} 个已翻译的文件\n`);

        // 批量同步文件
        await batchSyncFiles(translatedFiles);

        console.log('\n🎉 同步完成！');
    } catch (error) {
        console.error(`\n❌ 错误: ${error}`);
        process.exit(1);
    }
}

main();