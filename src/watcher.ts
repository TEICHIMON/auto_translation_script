import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { getConfig, getLanguageConfig } from './config';
import { convertSrtFileToLrc } from './converter';
import { translateWithOpenRouter } from './translator';
import { syncFilesToTarget } from './sync';

/**
 * 处理单个 SRT 文件
 */
async function processSrtFile(srtFilePath: string): Promise<void> {
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
        return;
    }

    // 检查双语 LRC 文件是否已存在
    try {
        await fs.access(bilingualLrcPath);
        console.log(`⏭️  跳过: ${path.basename(bilingualLrcPath)} 已存在`);
        return;
    } catch {
        // 文件不存在，继续处理
    }

    console.log(`\n📝 检测到新文件: ${fileName}`);

    // 获取语言配置
    const folderPath = path.dirname(srtFilePath);
    const languageConfig = getLanguageConfig(folderPath);

    if (!languageConfig) {
        console.log(`⚠️  跳过: 未找到 ${path.basename(folderPath)} 的语言配置`);
        return;
    }

    try {
        // 等待文件写入完成（避免文件还在写入时就开始处理）
        await new Promise(resolve => setTimeout(resolve, 2000));

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
                return;
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

        // 4. 同步文件到目标文件夹
        await syncFilesToTarget(bilingualLrcPath, dirName);
    } catch (error) {
        console.error(`❌ 错误: ${error}`);
    }
}

/**
 * 主函数 - 启动文件监控
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
    console.log('🎬 字幕自动翻译工具 - 监控模式\n');

    try {

        const config = getConfig();
        console.log(`📂 监控目录: ${config.rootDir}`);
        console.log(`🤖 模型: ${config.openRouterModel}`);
        console.log(`👀 监控的语言文件夹: ${config.languageFolders.map(l => l.folderName).join(', ')}\n`);
        console.log('🚀 开始监控文件变化...\n');
        console.log('按 Ctrl+C 退出\n');

        // 构建监控路径
        const watchPaths = config.languageFolders.map(lang =>
            path.join(config.rootDir, lang.folderName, '**/*.srt')
        );

        // 创建文件监控器
        const watcher = chokidar.watch(watchPaths, {
            persistent: true,
            ignoreInitial: false, // 启动时处理已存在的文件
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        // 监听新文件添加
        watcher.on('add', async (filePath) => {
            if (filePath.toLowerCase().endsWith('.srt')) {
                await processSrtFile(filePath);
            }
        });

        // 监听文件变化（可选）
        watcher.on('change', async (filePath) => {
            if (filePath.toLowerCase().endsWith('.srt')) {
                console.log(`\n🔄 文件已更新: ${path.basename(filePath)}`);
                // 如果需要，可以删除旧的 LRC 然后重新处理
                // await processSrtFile(filePath);
            }
        });

        // 错误处理
        watcher.on('error', error => {
            console.error(`❌ 监控错误: ${error}`);
        });

    } catch (error) {
        console.error(`\n❌ 错误: ${error}`);
        process.exit(1);
    }
}

main();