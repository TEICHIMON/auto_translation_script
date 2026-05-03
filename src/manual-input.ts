import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

// =====================================================================
// Manual input mode for LRC segmentation
//
// Instead of calling DeepSeek, write the prompt to disk, open the response file
// in the user's editor, copy prompt to clipboard, and watch for the user
// to paste a response and save. Supports concurrent waits (one per chunk
// across N parallel files) via a shared status banner.
// =====================================================================

const BANNER_INTERVAL_MS = 5000;
const FS_DEBOUNCE_MS = 500;

interface PendingEntry {
    id: number;
    label: string;
    chunkInfo: string;       // e.g. "0/1"
    promptPath: string;
    responsePath: string;
    startedAt: number;
}

let nextPendingId = 1;
const pending = new Map<number, PendingEntry>();
let bannerTimer: NodeJS.Timeout | null = null;

function formatElapsed(ms: number): string {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function printBanner(): void {
    if (pending.size === 0) return;
    const now = Date.now();
    const lines = ['⏳ Waiting on manual input:'];
    for (const entry of pending.values()) {
        const elapsed = formatElapsed(now - entry.startedAt);
        lines.push(`   [${entry.label}] chunk ${entry.chunkInfo} — ${elapsed} elapsed`);
    }
    console.log(lines.join('\n'));
}

function ensureBannerLoop(): void {
    if (bannerTimer !== null) return;
    bannerTimer = setInterval(printBanner, BANNER_INTERVAL_MS);
    // Don't keep the event loop alive just for the banner.
    bannerTimer.unref?.();
}

function maybeStopBannerLoop(): void {
    if (pending.size > 0 || bannerTimer === null) return;
    clearInterval(bannerTimer);
    bannerTimer = null;
}

function safeFilePart(value: string): string {
    const cleaned = value
        .trim()
        .replace(/[\/\\:\0]/g, '_')
        .replace(/\s+/g, '_');
    return cleaned || 'task';
}

function stripLeadingManualComments(raw: string): string {
    return raw.replace(/^(?:[ \t]*#.*(?:\r?\n|$)|[ \t]*(?:\r?\n|$))+/, '').trim();
}

// =====================================================================
// macOS helpers — best-effort, never throw on failure
// =====================================================================

function copyToClipboard(text: string): void {
    try {
        const proc = spawn('pbcopy');
        proc.on('error', () => { /* ignore */ });
        proc.stdin.write(text);
        proc.stdin.end();
    } catch {
        // Non-macOS or pbcopy missing — quietly skip.
    }
}

function openInEditor(filePath: string): void {
    try {
        const proc = spawn('open', ['-e', filePath], { stdio: 'ignore' });
        proc.on('error', () => { /* ignore */ });
    } catch {
        // Non-macOS — skip.
    }
}

function notify(title: string, message: string): void {
    try {
        const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
        const proc = spawn('osascript', ['-e', script], { stdio: 'ignore' });
        proc.on('error', () => { /* ignore */ });
    } catch {
        // Non-macOS — skip.
    }
}

// =====================================================================
// File watching with debounce
// =====================================================================

async function waitForFileWithContent<T>(
    responsePath: string,
    parser: (raw: string) => T,
    onParseFail: (message: string) => void,
    placeholderText: string = ''
): Promise<T> {
    return new Promise<T>((resolve) => {
        let debounceTimer: NodeJS.Timeout | null = null;
        let resolved = false;

        const watchDir = path.dirname(responsePath);
        const watchedBase = path.basename(responsePath);

        let watcher: fs.FSWatcher;

        const tryParse = async () => {
            if (resolved) return;
            try {
                const raw = await fsp.readFile(responsePath, 'utf-8');
                if (!raw.trim()) return; // still empty, keep waiting
                if (placeholderText && raw.trim() === placeholderText.trim()) return;

                let result: T;
                try {
                    result = parser(stripLeadingManualComments(raw));
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    onParseFail(msg);
                    return;
                }

                resolved = true;
                try { watcher.close(); } catch { /* ignore */ }
                if (debounceTimer) clearTimeout(debounceTimer);
                resolve(result);
            } catch {
                // File may have been temporarily unavailable during atomic save —
                // ignore, the next watch event will retry.
            }
        };

        const onEvent = (_eventType: string, fileName: string | Buffer | null) => {
            // Atomic-save editors may rename, so trigger on any event for our file.
            const name = typeof fileName === 'string' ? fileName : fileName?.toString();
            if (name && name !== watchedBase) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                void tryParse();
            }, FS_DEBOUNCE_MS);
        };

        watcher = fs.watch(watchDir, { persistent: true }, onEvent);
        watcher.on('error', () => {
            // FS watcher dropped — fall back to polling so we don't block forever.
            const poll = setInterval(() => {
                if (resolved) {
                    clearInterval(poll);
                    return;
                }
                void tryParse();
            }, 1000);
            poll.unref?.();
        });

        // First check in case the file was somehow already non-empty.
        void tryParse();
    });
}

// =====================================================================
// Public entry: write prompt, wait for human-pasted response, parse it.
// =====================================================================

export interface ManualInputOptions<T> {
    /** Directory to write prompt/response files under (subdir 'manual' is created). */
    chunkDir: string;
    /** Human-readable label for status banner & notification (e.g. task name). */
    label: string;
    /** "0/1" style position info for the banner. */
    chunkInfo: string;
    /** Prompt body — what the human will paste into the LLM web UI. */
    prompt: string;
    /** Parses raw response text into the desired result. Throw on failure. */
    parser: (raw: string) => T;
}

export async function awaitManualInput<T>(
    options: ManualInputOptions<T>
): Promise<T> {
    const { chunkDir, label, chunkInfo, prompt, parser } = options;
    const manualDir = path.join(chunkDir, 'manual');
    const fileStem = `${safeFilePart(label)}.${safeFilePart(`chunk-${chunkInfo}`)}`;
    const promptPath = path.join(manualDir, `prompt.${fileStem}.txt`);
    const responsePath = path.join(manualDir, `response.${fileStem}.txt`);

    await fsp.mkdir(manualDir, { recursive: true });

    const promptForFile = prompt;
    const promptForClipboard = prompt;

    await fsp.writeFile(promptPath, promptForFile, 'utf-8');
    await fsp.writeFile(responsePath, '', 'utf-8');

    copyToClipboard(promptForClipboard);
    openInEditor(responsePath);
    openInEditor(promptPath);
    notify(`Manual segmentation: ${label}`, `chunk ${chunkInfo} — prompt copied and opened`);

    const id = nextPendingId++;
    const entry: PendingEntry = {
        id,
        label,
        chunkInfo,
        promptPath,
        responsePath,
        startedAt: Date.now(),
    };
    pending.set(id, entry);
    ensureBannerLoop();

    console.log(`  📋 [${label}] chunk ${chunkInfo} — prompt copied and opened: ${promptPath}`);
    console.log(`  ✍️  [${label}] chunk ${chunkInfo} — paste JSON into: ${responsePath}`);

    try {
        const result = await waitForFileWithContent<T>(
            responsePath,
            parser,
            (msg) => {
                console.log(`  ❌ [${label}] chunk ${chunkInfo} parse failed: ${msg}`);
                console.log(`     Re-edit ${responsePath} and save again.`);
            }
        );
        const elapsed = formatElapsed(Date.now() - entry.startedAt);
        console.log(`  ✅ [${label}] chunk ${chunkInfo} — got valid response after ${elapsed}`);
        return result;
    } finally {
        pending.delete(id);
        maybeStopBannerLoop();
    }
}

// =====================================================================
// Path helper — derive a readable label from a chunk dir.
// chunkDir paths look like:
//   <runDir>/tasks/<task>/02-segmentation/chunk-NNN
//   <runDir>/tasks/<task>/02-segmentation/replay-<ts>/chunk-NNN
// We walk up looking for the parent named 'tasks' and use the dir below it.
// =====================================================================

export function deriveTaskLabelFromChunkDir(chunkDir: string): string {
    let current = path.resolve(chunkDir);
    while (path.dirname(current) !== current) {
        const parent = path.dirname(current);
        if (path.basename(parent) === 'tasks') {
            return path.basename(current);
        }
        current = parent;
    }
    return path.basename(chunkDir);
}
