import fs from 'fs/promises';
import path from 'path';
import { getConfig, getLanguageConfig } from './config';
import { translateWithOpenRouter } from './translator';
import { syncFilesToTarget } from './sync';

/**
 * 处理单个 LRC 文件 - 直接翻译模式
 */
async function translateLrcFile(lrcFilePath: string): Promise<void> {
    const fileName = path.basename(lrcFilePath);
    const baseName = fileName.replace(/\.lrc$/i, '');
    const dirName = path.dirname(lrcFilePath);
    const outputDir = path.join(dirName, 'output');
    const translatedLrcPath = path.join(outputDir, `${baseName}.lrc`);

    // 确保 output 文件夹存在
    try {
        await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
        console.error(`创建 output 文件夹失败: ${error}`);
        return;
    }

    // 检查翻译文件是否已存在
    try {
        await fs.access(translatedLrcPath);
        console.log(`⏭️  跳过: ${path.basename(translatedLrcPath)} 已存在`);
        return;
    } catch {
        // 文件不存在，继续处理
    }

    console.log(`\n📝 处理: ${fileName}`);

    // 获取语言配置
    const languageConfig = getLanguageConfig(dirName);

    if (!languageConfig) {
        console.log(`⚠️  跳过: 未找到 ${path.basename(dirName)} 的语言配置`);
        return;
    }

    try {
        // 1. 读取 LRC 内容
        console.log('📖 步骤 1/2: 读取 LRC 文件...');
        const lrcContent = await fs.readFile(lrcFilePath, 'utf-8');

        if (!lrcContent.trim()) {
            console.log('⚠️  警告: LRC 文件内容为空，跳过翻译');
            return;
        }

        // 2. 调用 API 翻译
        console.log('🌐 步骤 2/2: 调用 AI 翻译...');
        const translatedContent = await translateWithOpenRouter(
            lrcContent,
            languageConfig.translationPrompt
        );

        // 3. 保存翻译后的 LRC
        console.log('💾 保存翻译后的 LRC 文件...');
        await fs.writeFile(translatedLrcPath, translatedContent, 'utf-8');

        console.log(`✅ 完成: ${path.basename(translatedLrcPath)}`);

        // 4. 同步文件到目标文件夹
        await syncFilesToTarget(translatedLrcPath, dirName);
    } catch (error) {
        console.error(`❌ 错误: ${error}`);
    }
}

/**
 * 扫描文件夹并翻译所有 LRC 文件
 */
async function scanAndTranslate(dirPath: string): Promise<void> {
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
                await scanAndTranslate(fullPath);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lrc')) {
                // 翻译 LRC 文件
                await translateLrcFile(fullPath);
            }
        }
    } catch (error) {
        console.error(`扫描文件夹失败 ${dirPath}: ${error}`);
    }
}

/**
 * 主函数
 */
async function main() {
    console.log('🎬 字幕翻译工具 - LRC 直接翻译模式\n');

    try {
        const config = getConfig();
        console.log(`📂 根目录: ${config.rootDir}`);
        console.log(`🤖 模型: ${config.openRouterModel}\n`);
        console.log('开始扫描 LRC 文件...\n');

        await scanAndTranslate(config.rootDir);

        console.log('\n🎉 所有翻译任务完成！');
    } catch (error) {
        console.error(`\n❌ 错误: ${error}`);
        process.exit(1);
    }
}

main();