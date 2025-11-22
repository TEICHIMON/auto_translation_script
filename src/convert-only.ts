import fs from 'fs/promises';
import path from 'path';
import { getConfig } from './config';
import { convertSrtFileToLrc } from './converter';

/**
 * 转换单个 SRT 文件为单语 LRC
 * @returns 成功则返回 true，失败则返回 false
 */
async function convertSrtFile(srtFilePath: string): Promise<boolean> {
    const fileName = path.basename(srtFilePath);
    const baseName = fileName.replace(/\.srt$/i, '');
    const dirName = path.dirname(srtFilePath);

    // 单语 LRC 路径（与 SRT 同级）
    const monoLrcPath = path.join(dirName, `${baseName}.lrc`);

    // 检查单语 LRC 是否已存在
    try {
        await fs.access(monoLrcPath);
        console.log(`⏭️  跳过: ${path.basename(monoLrcPath)} 已存在`);
        return false;
    } catch {
        // 文件不存在，继续处理
    }

    console.log(`\n📝 处理: ${fileName}`);

    try {
        // SRT -> 单语 LRC
        console.log('🔄 转换 SRT 到单语 LRC 格式...');
        const lrcContent = await convertSrtFileToLrc(srtFilePath);

        if (!lrcContent.trim()) {
            console.log('⚠️  警告: 转换后内容为空');
            return false;
        }

        // 保存单语 LRC
        await fs.writeFile(monoLrcPath, lrcContent, 'utf-8');
        console.log(`✅ 完成: ${path.basename(monoLrcPath)}`);

        return true;
    } catch (error) {
        console.error(`❌ 错误: ${error}`);
        return false;
    }
}

/**
 * 扫描文件夹并转换所有 SRT 文件
 * @returns 成功转换的文件数量
 */
async function scanAndConvert(dirPath: string): Promise<number> {
    let convertedCount = 0;

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                // 递归处理子文件夹
                const subCount = await scanAndConvert(fullPath);
                convertedCount += subCount;
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.srt')) {
                // 转换 SRT 文件
                const success = await convertSrtFile(fullPath);
                if (success) {
                    convertedCount++;
                }
            }
        }
    } catch (error) {
        console.error(`扫描文件夹失败 ${dirPath}: ${error}`);
    }

    return convertedCount;
}

/**
 * 主函数
 */
async function main() {
    console.log('🎬 字幕转换工具 - 仅转换模式 (SRT → 单语 LRC)\n');
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
        console.log('\n开始扫描 SRT 文件...\n');

        const convertedCount = await scanAndConvert(config.rootDir);

        console.log(`\n🎉 转换完成！成功转换 ${convertedCount} 个文件`);
    } catch (error) {
        console.error(`\n❌ 错误: ${error}`);
        process.exit(1);
    }
}

main();