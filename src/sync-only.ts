import fs from 'fs/promises';
import path from 'path';
import { getConfig } from './config';
import { batchSyncFiles } from './sync';

/**
 * 查找已翻译的 LRC 文件和对应的音频文件
 */
async function findTranslatedFiles(dirPath: string): Promise<Array<{ lrcPath: string; audioBasePath: string }>> {
    const files: Array<{ lrcPath: string; audioBasePath: string }> = [];

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                // 检查是否是 output 文件夹
                if (entry.name === 'output') {
                    // 扫描 output 文件夹中的 LRC 文件
                    try {
                        const outputEntries = await fs.readdir(fullPath, { withFileTypes: true });
                        const audioBasePath = path.dirname(fullPath); // 父文件夹（语言文件夹）

                        for (const outputEntry of outputEntries) {
                            if (outputEntry.isFile() && outputEntry.name.toLowerCase().endsWith('.lrc')) {
                                const lrcPath = path.join(fullPath, outputEntry.name);
                                files.push({
                                    lrcPath,
                                    audioBasePath
                                });
                            }
                        }
                    } catch (error) {
                        console.error(`扫描 output 文件夹失败 ${fullPath}: ${error}`);
                    }
                } else {
                    // 递归扫描子文件夹
                    const subFiles = await findTranslatedFiles(fullPath);
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
 * 主函数 - 仅同步已翻译的文件
 */
async function main() {
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