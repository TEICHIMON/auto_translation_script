import axios from 'axios';
import { SubtitleConfig, WhisperSegment, WhisperTranscriptionResult, WhisperWord } from './types';

interface OpenAICompatibleResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
        };
    }>;
}

interface RawBoundary {
    start?: unknown;
    end?: unknown;
    startWord?: unknown;
    endWord?: unknown;
}

interface Boundary {
    start: number;
    end: number;
}

interface WordChunk {
    startIndex: number;
    words: WhisperWord[];
}

export class LrcSegmentationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LrcSegmentationError';
    }
}

function formatLrcTimestamp(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds - minutes * 60;
    return `[${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}]`;
}

function normalizeLrcText(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

function normalizeWord(word: WhisperWord): WhisperWord | null {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) return null;
    if (word.end <= word.start) return null;
    if (!word.word || !word.word.trim()) return null;

    return {
        start: word.start,
        end: word.end,
        word: word.word
    };
}

function flattenWords(segments: WhisperSegment[] = []): WhisperWord[] {
    const words: WhisperWord[] = [];

    for (const segment of segments) {
        for (const rawWord of segment.words || []) {
            const word = normalizeWord(rawWord);
            if (word) words.push(word);
        }
    }

    return words.sort((a, b) => a.start - b.start);
}

function hasSentenceEnd(text: string, lang: string): boolean {
    const trimmed = text.trim();
    if (lang === 'ja') return /[。！？]["」』）)]?$/.test(trimmed);
    return /[.!?]["']?$/.test(trimmed);
}

function gapAfter(words: WhisperWord[], index: number): number {
    if (index < 0 || index >= words.length - 1) return 0;
    return Math.max(words[index + 1].start - words[index].end, 0);
}

function chooseChunkEnd(words: WhisperWord[], startIndex: number, maxWords: number): number {
    const hardEnd = Math.min(startIndex + maxWords, words.length);
    if (hardEnd >= words.length) return words.length;

    const targetLast = hardEnd - 1;
    const searchStart = Math.max(startIndex + Math.floor(maxWords * 0.7), targetLast - 160);
    const searchEnd = Math.min(words.length - 2, targetLast + 160);

    let bestLast = targetLast;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = searchStart; i <= searchEnd; i++) {
        const word = words[i].word.trim();
        const gap = gapAfter(words, i);
        let score = -Math.abs(i - targetLast) / 120;

        if (hasSentenceEnd(word, 'en') || hasSentenceEnd(word, 'ja')) score += 4;
        if (gap >= 1.2) score += 5;
        else if (gap >= 0.7) score += 3;
        else if (gap >= 0.4) score += 1;

        if (score > bestScore) {
            bestScore = score;
            bestLast = i;
        }
    }

    return Math.max(bestLast + 1, startIndex + 1);
}

function chunkWords(words: WhisperWord[], maxWords: number): WordChunk[] {
    const chunks: WordChunk[] = [];
    let startIndex = 0;

    while (startIndex < words.length) {
        const endIndex = chooseChunkEnd(words, startIndex, maxWords);
        chunks.push({
            startIndex,
            words: words.slice(startIndex, endIndex)
        });
        startIndex = endIndex;
    }

    return chunks;
}

function buildPrompt(words: WhisperWord[], lang: string): string {
    const languageHint = lang === 'ja'
        ? 'Japanese. Prefer natural Japanese phrase/sentence boundaries; avoid ending lines on particles or te/de connective forms when possible.'
        : 'English. Prefer natural sentence/clause boundaries; avoid ending lines on articles, prepositions, conjunctions, or auxiliaries when possible.';

    const wordRows = words
        .map((word, index) => {
            const text = JSON.stringify(word.word);
            return `${index}|${word.start.toFixed(2)}|${word.end.toFixed(2)}|${text}`;
        })
        .join('\n');

    return `Split this transcript into readable LRC subtitle lines.

Language: ${languageHint}

Return ONLY valid JSON in this exact shape:
{"boundaries":[{"start":0,"end":8},{"start":9,"end":17}]}

Rules:
- start/end are local word indices from the list below, inclusive.
- Cover every word exactly once, in order, from index 0 to index ${words.length - 1}.
- Do not skip, overlap, reorder, rewrite, translate, or invent words.
- Prefer complete sentences or complete spoken clauses.
- Use punctuation and timestamp gaps as strong boundary signals.
- Target 2.0-6.8 seconds per line; shorter is okay for quick reactions.
- Avoid lines longer than about 95 English characters or 42 Japanese characters.
- If the speech is fast, choose readable phrase boundaries rather than making one very long line.

Words:
index|start|end|word
${wordRows}`;
}

function extractJson(content: string): unknown {
    const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return JSON.parse(trimmed);
    }

    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
        return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    }

    const arrayStart = trimmed.indexOf('[');
    const arrayEnd = trimmed.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
        return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
    }

    throw new LrcSegmentationError('DeepSeek 未返回 JSON');
}

function numberFromUnknown(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    return value;
}

function parseBoundaries(content: string): Boundary[] {
    const parsed = extractJson(content);
    const rawBoundaries = Array.isArray(parsed)
        ? parsed
        : (parsed as { boundaries?: unknown }).boundaries;

    if (!Array.isArray(rawBoundaries)) {
        throw new LrcSegmentationError('DeepSeek JSON 缺少 boundaries 数组');
    }

    return rawBoundaries.map((raw, index) => {
        const boundary = raw as RawBoundary;
        const start = numberFromUnknown(boundary.start ?? boundary.startWord);
        const end = numberFromUnknown(boundary.end ?? boundary.endWord);

        if (start === null || end === null) {
            throw new LrcSegmentationError(`boundary[${index}] 缺少整数 start/end`);
        }

        return { start, end };
    });
}

function textForBoundary(words: WhisperWord[], boundary: Boundary): string {
    return normalizeLrcText(
        words.slice(boundary.start, boundary.end + 1).map(word => word.word).join('')
    );
}

function validateBoundaries(boundaries: Boundary[], words: WhisperWord[], lang: string): void {
    if (!boundaries.length) {
        throw new LrcSegmentationError('DeepSeek 返回了空 boundaries');
    }

    let expectedStart = 0;
    const maxDuration = 14.0;
    const maxChars = lang === 'ja' ? 90 : 180;

    for (let i = 0; i < boundaries.length; i++) {
        const boundary = boundaries[i];

        if (boundary.start !== expectedStart) {
            throw new LrcSegmentationError(
                `boundary[${i}] 不连续: expected start ${expectedStart}, got ${boundary.start}`
            );
        }

        if (boundary.end < boundary.start || boundary.end >= words.length) {
            throw new LrcSegmentationError(`boundary[${i}] 范围非法`);
        }

        const startWord = words[boundary.start];
        const endWord = words[boundary.end];
        const duration = endWord.end - startWord.start;
        const text = textForBoundary(words, boundary);

        if (!text) {
            throw new LrcSegmentationError(`boundary[${i}] 文本为空`);
        }

        if (duration > maxDuration && text.length > 30) {
            throw new LrcSegmentationError(
                `boundary[${i}] 太长: ${duration.toFixed(1)}s`
            );
        }

        if (text.length > maxChars) {
            throw new LrcSegmentationError(
                `boundary[${i}] 字符过长: ${text.length}`
            );
        }

        expectedStart = boundary.end + 1;
    }

    if (expectedStart !== words.length) {
        throw new LrcSegmentationError(
            `boundaries 未覆盖所有 words: ended at ${expectedStart}, total ${words.length}`
        );
    }
}

function buildLrcLines(words: WhisperWord[], boundaries: Boundary[]): string[] {
    return boundaries.map(boundary => {
        const startWord = words[boundary.start];
        const text = textForBoundary(words, boundary);
        return `${formatLrcTimestamp(startWord.start)}${text}`;
    });
}

async function requestBoundaries(
    words: WhisperWord[],
    lang: string,
    config: SubtitleConfig
): Promise<Boundary[]> {
    const prompt = buildPrompt(words, lang);
    const maxTokens = Math.max(2048, Math.ceil(words.length * 16));

    const response = await axios.post<OpenAICompatibleResponse>(
        config.deepSeekApiUrl,
        {
            model: config.lrcSegmentationModel,
            messages: [
                {
                    role: 'system',
                    content: 'You are a precise subtitle segmentation engine. Output JSON only.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            response_format: { type: 'json_object' },
            max_tokens: maxTokens,
            thinking: { type: 'disabled' }
        },
        {
            headers: {
                'Authorization': `Bearer ${config.deepSeekApiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    const content = response.data.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
        throw new LrcSegmentationError('DeepSeek 返回空分句结果');
    }

    const boundaries = parseBoundaries(content);
    validateBoundaries(boundaries, words, lang);
    return boundaries;
}

export async function segmentWhisperResultWithDeepSeek(
    result: WhisperTranscriptionResult,
    lang: string,
    config: SubtitleConfig
): Promise<string> {
    const words = flattenWords(result.segments || []);

    if (!words.length) {
        throw new LrcSegmentationError('Whisper 结果缺少 word timestamps');
    }

    const chunks = chunkWords(words, config.lrcSegmentationChunkWords);
    const lines: string[] = [];

    console.log(
        `  🧠 DeepSeek LRC 分句: ${words.length} words, ` +
        `${chunks.length} chunk(s), model=${config.lrcSegmentationModel}`
    );

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const boundaries = await requestBoundaries(chunk.words, lang, config);
        lines.push(...buildLrcLines(chunk.words, boundaries));
        console.log(`  🧩 分句进度: ${i + 1}/${chunks.length}`);
    }

    return lines.join('\n') + '\n';
}
