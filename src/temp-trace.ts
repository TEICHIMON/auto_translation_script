import fs from 'fs/promises';
import path from 'path';

const TRACE_ROOT = path.join(process.cwd(), '.tmp', 'runs');
const LATEST_RUN_FILE = path.join(TRACE_ROOT, 'latest-run.txt');

let activeRunDir: string | null = null;
let activeTaskDir: string | null = null;

export function traceTimestamp(date: Date = new Date()): string {
    return date.toISOString().replace(/[:.]/g, '-');
}

export function safeTraceName(input: string): string {
    const safe = input.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return (safe || 'item').slice(0, 120);
}

async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}

export async function writeTraceText(
    baseDir: string | null | undefined,
    relativePath: string,
    content: string
): Promise<void> {
    if (!baseDir) return;

    try {
        const filePath = path.join(baseDir, relativePath);
        await ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, content, 'utf-8');
    } catch (error) {
        console.log(`  ⚠️  写入临时 trace 失败 (${relativePath}): ${error}`);
    }
}

export async function writeTraceJson(
    baseDir: string | null | undefined,
    relativePath: string,
    data: unknown
): Promise<void> {
    await writeTraceText(baseDir, relativePath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function startPipelineTrace(label: string, metadata: unknown): Promise<string> {
    const runDir = path.join(TRACE_ROOT, `${traceTimestamp()}-${safeTraceName(label)}`);
    await ensureDir(runDir);
    await ensureDir(TRACE_ROOT);
    await fs.writeFile(LATEST_RUN_FILE, runDir, 'utf-8');

    activeRunDir = runDir;
    activeTaskDir = null;

    await writeTraceJson(runDir, '00-meta.json', {
        createdAt: new Date().toISOString(),
        label,
        metadata
    });

    return runDir;
}

export async function startTaskTrace(label: string, metadata: unknown): Promise<string | null> {
    if (!activeRunDir) return null;

    const taskDir = path.join(activeRunDir, 'tasks', `${traceTimestamp()}-${safeTraceName(label)}`);
    activeTaskDir = taskDir;

    await ensureDir(taskDir);
    await fs.writeFile(path.join(activeRunDir, 'latest-task.txt'), taskDir, 'utf-8');
    await writeTraceJson(taskDir, '00-meta.json', {
        createdAt: new Date().toISOString(),
        label,
        metadata
    });

    return taskDir;
}

export function getActiveRunDir(): string | null {
    return activeRunDir;
}

export function getActiveTaskDir(): string | null {
    return activeTaskDir;
}

export async function readLatestRunDir(): Promise<string> {
    return (await fs.readFile(LATEST_RUN_FILE, 'utf-8')).trim();
}

export async function readLatestTaskDir(runDir: string): Promise<string> {
    return (await fs.readFile(path.join(runDir, 'latest-task.txt'), 'utf-8')).trim();
}
