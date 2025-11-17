import fs from 'fs/promises';
import { LRCLine } from './types';

/**
 * 将 SRT 时间格式 (HH:MM:SS,mmm) 转换为 LRC 时间格式 ([mm:ss.xx])
 */
function srtTimeToLrcTime(srtTime: string): string {
  const match = srtTime.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  
  if (!match) {
    return '[00:00.00]';
  }

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const milliseconds = parseInt(match[4], 10);

  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  const lrcMinutes = Math.floor(totalSeconds / 60);
  const lrcSeconds = totalSeconds % 60;
  const lrcCentiseconds = Math.floor(milliseconds / 10);

  const mm = String(lrcMinutes).padStart(2, '0');
  const ss = String(lrcSeconds).padStart(2, '0');
  const xx = String(lrcCentiseconds).padStart(2, '0');

  return `[${mm}:${ss}.${xx}]`;
}

/**
 * 解析 SRT 内容并转换为 LRC 格式
 */
export function convertSrtToLrc(srtContent: string): LRCLine[] {
  const lrcLines: LRCLine[] = [];
  
  // SRT 格式匹配：序号 + 时间码 + 文本
  const srtBlockPattern = /\d+\s*\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\s*\n(.+?)(?=\n\n|\n\d+\n|$)/gs;
  
  let match;
  while ((match = srtBlockPattern.exec(srtContent)) !== null) {
    const startTime = match[1];
    const textBlock = match[3].trim();
    
    // 提取第一行文本
    const textLines = textBlock.split('\n');
    const firstLine = textLines[0].trim();
    
    if (firstLine) {
      const lrcTime = srtTimeToLrcTime(startTime);
      lrcLines.push({
        timestamp: lrcTime,
        text: firstLine
      });
    }
  }
  
  return lrcLines;
}

/**
 * 将 LRC 行数组转换为 LRC 文本格式
 */
export function lrcLinesToString(lines: LRCLine[]): string {
  return lines.map(line => `${line.timestamp}${line.text}`).join('\n');
}

/**
 * 读取 SRT 文件并转换为 LRC 文本
 */
export async function convertSrtFileToLrc(srtFilePath: string): Promise<string> {
  try {
    const srtContent = await fs.readFile(srtFilePath, 'utf-8');
    const lrcLines = convertSrtToLrc(srtContent);
    return lrcLinesToString(lrcLines);
  } catch (error) {
    throw new Error(`转换 SRT 文件失败: ${error}`);
  }
}
