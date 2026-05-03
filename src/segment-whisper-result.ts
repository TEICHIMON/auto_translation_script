import fs from 'fs/promises';
import path from 'path';
import { getConfig } from './config';
import { segmentWhisperResultWithDeepSeek } from './lrc-segmenter';
import { WhisperTranscriptionResult } from './types';
import {
    readLatestRunDir,
    readLatestTaskDir,
    traceTimestamp,
    writeTraceJson
} from './temp-trace';

interface ReplayTarget {
    inputPath: string;
    traceDir: string;
    outputPath: string;
}

function usage(): string {
    return [
        '用法:',
        '  npm run dev:segment',
        '  npm run dev:segment -- .tmp/runs/<run>/tasks/<task>',
        '  npm run dev:segment -- .tmp/runs/<run>/tasks/<task>/01-whisper/result.json',
        '',
        '默认读取 .tmp/runs/latest-run.txt 指向的最新 run/latest task。',
        '输出写入该 task 的 02-segmentation/replay-<timestamp>/final.lrc。'
    ].join('\n');
}

function isSupportedLang(value: unknown): value is 'en' | 'ja' {
    return value === 'en' || value === 'ja';
}

async function readWhisperResult(inputPath: string): Promise<WhisperTranscriptionResult> {
    const raw = await fs.readFile(inputPath, 'utf-8');
    return JSON.parse(raw) as WhisperTranscriptionResult;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function replayDirForTask(taskDir: string): string {
    return path.join(taskDir, '02-segmentation', `replay-${traceTimestamp()}`);
}

function targetFromTaskDir(taskDir: string): ReplayTarget {
    const inputPath = path.join(taskDir, '01-whisper', 'result.json');
    const traceDir = replayDirForTask(taskDir);
    return {
        inputPath,
        traceDir,
        outputPath: path.join(traceDir, 'final.lrc')
    };
}

async function resolveReplayTarget(inputArg?: string): Promise<ReplayTarget> {
    if (!inputArg) {
        const runDir = await readLatestRunDir();
        const taskDir = await readLatestTaskDir(runDir);
        return targetFromTaskDir(taskDir);
    }

    const resolved = path.resolve(inputArg);
    const stat = await fs.stat(resolved);

    if (stat.isDirectory()) {
        const taskResultPath = path.join(resolved, '01-whisper', 'result.json');
        if (await fileExists(taskResultPath)) {
            return targetFromTaskDir(resolved);
        }

        const latestTaskPath = path.join(resolved, 'latest-task.txt');
        if (await fileExists(latestTaskPath)) {
            const taskDir = await readLatestTaskDir(resolved);
            return targetFromTaskDir(taskDir);
        }

        const directResultPath = path.join(resolved, 'result.json');
        if (await fileExists(directResultPath)) {
            const traceDir = path.join(resolved, `replay-${traceTimestamp()}`);
            return {
                inputPath: directResultPath,
                traceDir,
                outputPath: path.join(traceDir, 'final.lrc')
            };
        }
    }

    const traceDir = path.join(
        path.dirname(resolved),
        `${path.parse(resolved).name}-replay-${traceTimestamp()}`
    );

    return {
        inputPath: resolved,
        traceDir,
        outputPath: path.join(traceDir, 'final.lrc')
    };
}

async function main() {
    const inputArg = process.argv[2];
    if (inputArg === '-h' || inputArg === '--help') {
        console.log(usage());
        return;
    }

    const target = await resolveReplayTarget(inputArg);
    const inputPath = target.inputPath;
    const result = await readWhisperResult(inputPath);
    const lang = isSupportedLang(result.lang) ? result.lang : null;

    if (!lang) {
        throw new Error('Whisper result 缺少 lang 字段,无法判断 en/ja');
    }

    const config = getConfig();

    console.log(`📖 读取 Whisper result: ${inputPath}`);
    console.log(`🧾 replay trace: ${target.traceDir}`);
    console.log(`✂️  使用当前 prompt 重新分句: lang=${lang}, model=${config.lrcSegmentationModel}`);

    await writeTraceJson(target.traceDir, '00-replay-meta.json', {
        createdAt: new Date().toISOString(),
        inputPath,
        lang,
        model: config.lrcSegmentationModel
    });

    await segmentWhisperResultWithDeepSeek(result, lang, config, {
        traceDir: target.traceDir
    });

    console.log(`✅ 已输出 LRC: ${target.outputPath}`);
}

main().catch(error => {
    console.error(`❌ 分句 replay 失败: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(1);
});
