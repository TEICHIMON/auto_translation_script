import fs from 'fs/promises';
import path from 'path';
import { getConfig } from './config';

/**
 * 生成时间戳文件夹名称
 * 格式: YYYY-MM-DD_HH-MM-SS
 */
export function generateTimestampFolder(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

/**
 * 查找音频文件（支持多种格式）
 */
async function findAudioFile(basePath: string, baseName: string): Promise<string | null> {
    const audioExtensions = ['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.wma'];

    for (const ext of audioExtensions) {
        const audioPath = path.join(basePath, `${baseName}${ext}`);
        try {
            await fs.access(audioPath);
            return audioPath;
        } catch {
            // 文件不存在，继续尝试下一个扩展名
        }
    }

    return null;
}

/**
 * 同步文件到目标文件夹
 * 注意: 此函数不再单独创建时间戳文件夹，而是使用批量同步时创建的统一文件夹
 * @param lrcFilePath 双语 LRC 文件路径
 * @param audioBasePath 音频文件所在目录（语言文件夹，不是 output）
 */
export async function syncFilesToTarget(lrcFilePath: string, audioBasePath: string): Promise<void> {
    // 这个函数在 watcher 模式下会被单独调用
    // 为了保持兼容性，我们在这里也创建时间戳文件夹
    const config = getConfig();

    // 如果未配置同步目录，跳过同步
    if (!config.syncDir) {
        return;
    }

    try {
        // 获取文件信息
        const lrcFileName = path.basename(lrcFilePath);
        const baseName = lrcFileName.replace(/\.lrc$/i, '');

        // 查找对应的音频文件
        const audioFilePath = await findAudioFile(audioBasePath, baseName);

        if (!audioFilePath) {
            console.log(`⚠️  未找到音频文件: ${baseName}.*，跳过同步`);
            return;
        }

        // 生成时间戳文件夹
        const timestampFolder = generateTimestampFolder();
        const targetDir = path.join(config.syncDir, timestampFolder);

        // 创建目标文件夹
        await fs.mkdir(targetDir, { recursive: true });

        // 复制文件
        const audioFileName = path.basename(audioFilePath);
        const targetAudioPath = path.join(targetDir, audioFileName);
        const targetLrcPath = path.join(targetDir, lrcFileName);

        console.log(`📦 同步文件到: ${timestampFolder}/`);

        // 复制音频文件
        await fs.copyFile(audioFilePath, targetAudioPath);
        console.log(`  ✅ ${audioFileName}`);

        // 复制 LRC 文件
        await fs.copyFile(lrcFilePath, targetLrcPath);
        console.log(`  ✅ ${lrcFileName}`);

    } catch (error) {
        console.error(`❌ 同步文件失败: ${error}`);
    }
}

/**
 * 批量同步多个文件到同一个时间戳文件夹
 */
export async function batchSyncFiles(files: Array<{ lrcPath: string; audioBasePath: string }>): Promise<void> {
    const config = getConfig();

    if (!config.syncDir || files.length === 0) {
        return;
    }

    console.log(`\n📦 开始批量同步 ${files.length} 个文件...`);

    // 生成统一的时间戳文件夹（整个批次使用同一个文件夹）
    const timestampFolder = generateTimestampFolder();
    const targetDir = path.join(config.syncDir, timestampFolder);

    try {
        // 创建目标文件夹
        await fs.mkdir(targetDir, { recursive: true });
        console.log(`📁 创建同步目录: ${timestampFolder}/`);

        let successCount = 0;
        let failCount = 0;

        for (const file of files) {
            try {
                const lrcFileName = path.basename(file.lrcPath);
                const baseName = lrcFileName.replace(/\.lrc$/i, '');

                // 查找音频文件
                const audioFilePath = await findAudioFile(file.audioBasePath, baseName);

                if (!audioFilePath) {
                    console.log(`  ⚠️  跳过: ${baseName}.* (未找到音频)`);
                    failCount++;
                    continue;
                }

                // 复制文件到统一的时间戳文件夹
                const audioFileName = path.basename(audioFilePath);
                const targetAudioPath = path.join(targetDir, audioFileName);
                const targetLrcPath = path.join(targetDir, lrcFileName);

                await fs.copyFile(audioFilePath, targetAudioPath);
                await fs.copyFile(file.lrcPath, targetLrcPath);

                console.log(`  ✅ ${baseName}`);
                successCount++;

            } catch (error) {
                console.error(`  ❌ 失败: ${path.basename(file.lrcPath)} - ${error}`);
                failCount++;
            }
        }

        console.log(`\n🎉 同步完成: ${successCount} 成功, ${failCount} 失败`);
        console.log(`📂 同步位置: ${targetDir}`);

    } catch (error) {
        console.error(`❌ 批量同步失败: ${error}`);
    }
}