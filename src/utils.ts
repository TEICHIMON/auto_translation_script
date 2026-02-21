import fs from 'fs/promises';
import path from 'path';

/**
 * 获取当前年月，格式: YYYY-MM
 */
export function getCurrentYearMonth(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

/**
 * 在 output 目录下递归查找已存在的双语 LRC 文件
 *
 * 搜索策略（按优先级）：
 * 1. 旧结构：output/[relativePath/]baseName.lrc
 * 2. 新结构：output/YYYY-MM/[relativePath/]baseName.lrc
 * 3. 兜底：递归搜索整个 output 目录，查找同名文件
 *
 * 第3步可以防止因路径计算错误导致的重复翻译
 *
 * @param outputBaseDir output 目录路径（如 /root/English/output）
 * @param relativePath 相对路径（如 podcast），空字符串表示根目录
 * @param baseName 文件基础名（如 ep01）
 * @returns 找到的文件路径，或 null
 */
export async function findExistingBilingualLrc(
    outputBaseDir: string,
    relativePath: string,
    baseName: string
): Promise<string | null> {
    const targetFileName = `${baseName}.lrc`;

    // 1. 先检查旧结构：直接在 output/ 或 output/relativePath/ 下
    const oldStructureDir = relativePath
        ? path.join(outputBaseDir, relativePath)
        : outputBaseDir;
    const oldStructurePath = path.join(oldStructureDir, targetFileName);

    try {
        await fs.access(oldStructurePath);
        return oldStructurePath;
    } catch {
        // 旧结构不存在，继续检查
    }

    // 2. 检查新结构：output/YYYY-MM/[relativePath/]baseName.lrc
    try {
        const entries = await fs.readdir(outputBaseDir, { withFileTypes: true });
        for (const entry of entries) {
            // 只检查 YYYY-MM 格式的文件夹
            if (entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name)) {
                const monthDir = path.join(outputBaseDir, entry.name);
                const targetDir = relativePath ? path.join(monthDir, relativePath) : monthDir;
                const lrcPath = path.join(targetDir, targetFileName);
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

    // 3. 兜底：递归搜索整个 output 目录查找同名文件
    //    这可以捕获因路径嵌套等 bug 产生的文件，避免重复翻译
    try {
        const found = await recursiveFindFile(outputBaseDir, targetFileName);
        if (found) {
            return found;
        }
    } catch {
        // 搜索失败，忽略
    }

    return null;
}

/**
 * 递归搜索目录查找指定文件名
 * @param dirPath 搜索起始目录
 * @param fileName 要查找的文件名
 * @returns 找到的文件完整路径，或 null
 */
async function recursiveFindFile(dirPath: string, fileName: string): Promise<string | null> {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isFile() && entry.name === fileName) {
                return fullPath;
            }

            if (entry.isDirectory()) {
                const found = await recursiveFindFile(fullPath, fileName);
                if (found) {
                    return found;
                }
            }
        }
    } catch {
        // 目录不存在或无权限
    }

    return null;
}

/**
 * 计算输出目录路径，避免 YYYY-MM 嵌套问题
 *
 * 问题场景：如果源文件在 English/2026-02/file.srt
 * relativeDirClean 就是 "2026-02"，会导致 output/2026-02/2026-02/
 *
 * 修复策略：如果 relativeDirClean 本身就是 YYYY-MM 格式且与当前年月相同，
 * 则不再添加额外的年月层级
 *
 * @param outputBaseDir output 基础目录
 * @param yearMonth 当前年月 (YYYY-MM)
 * @param relativeDirClean 相对路径（可能为空）
 * @returns 最终的输出目录路径
 */
export function buildOutputDir(
    outputBaseDir: string,
    yearMonth: string,
    relativeDirClean: string
): string {
    // 检查 relativeDirClean 的第一层目录是否就是 YYYY-MM 格式
    const firstSegment = relativeDirClean.split(path.sep)[0];
    const isDateDir = /^\d{4}-\d{2}$/.test(firstSegment);

    if (isDateDir) {
        // 如果子目录本身是日期格式，直接使用，不再嵌套年月
        // 例如：relativeDirClean = "2026-02" → output/2026-02/
        // 例如：relativeDirClean = "2026-02/subdir" → output/2026-02/subdir/
        return path.join(outputBaseDir, relativeDirClean);
    }

    // 正常情况：添加年月层级
    if (relativeDirClean) {
        return path.join(outputBaseDir, yearMonth, relativeDirClean);
    }
    return path.join(outputBaseDir, yearMonth);
}