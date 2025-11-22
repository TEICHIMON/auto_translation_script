import fs from 'fs/promises';
import path from 'path';
import { getConfig, getLanguageConfig } from './config';
import { convertSrtFileToLrc } from './converter';
import { translateWithOpenRouter } from './translator';
import {batchSyncFiles, generateTimestampFolder} from './sync';

/**
 * 处理单个 SRT 文件
 * @returns 成功则返回 { lrcPath, audioBasePath }，失败则返回 null
 */
async function processSrtFile(srtFilePath: string): Promise<{ lrcPath: string; audioBasePath: string } | null> {
    const fileName = path.basename(srtFilePath);
    const baseName = fileName.replace(/\.srt$/i, '');
    const dirName = path.dirname(srtFilePath);
    const outputDir = path.join(dirName, 'output');

    // 单语 LRC 路径（与 SRT 同级）
    const monoLrcPath = path.join(dirName, `${baseName}.lrc`);
    // 双语 LRC 路径（在 output 文件夹中）
    const bilingualLrcPath = path.join(outputDir, `${baseName}.lrc`);

    // 确保 output 文件夹存在
    try {
        await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
        console.error(`创建 output 文件夹失败: ${error}`);
        return null;
    }

    // 检查双语 LRC 文件是否已存在
    try {
        await fs.access(bilingualLrcPath);
        console.log(`⏭️  跳过: ${path.basename(bilingualLrcPath)} 已存在`);
        return null;
    } catch {
        // 文件不存在，继续处理
    }

    console.log(`\n📝 处理: ${fileName}`);

    // 获取语言配置
    const folderPath = path.dirname(srtFilePath);
    const languageConfig = getLanguageConfig(folderPath);

    if (!languageConfig) {
        console.log(`⚠️  跳过: 未找到 ${path.basename(folderPath)} 的语言配置`);
        return null;
    }

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
            console.log(`💾 已保存单语 LRC: ${path.basename(monoLrcPath)}`);
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

        console.log(`✅ 完成: ${path.basename(bilingualLrcPath)}`);

        // 返回文件信息用于同步
        return {
            lrcPath: bilingualLrcPath,
            audioBasePath: dirName
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
async function scanAndProcess(dirPath: string): Promise<Array<{ lrcPath: string; audioBasePath: string }>> {
    const processedFiles: Array<{ lrcPath: string; audioBasePath: string }> = [];

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
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
    console.log('🎬 字幕自动翻译工具 - 手动模式\n');
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

    try {
        const config = getConfig();
        console.log(`📂 根目录: ${config.rootDir}`);
        console.log(`🤖 模型: ${config.openRouterModel}`);
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