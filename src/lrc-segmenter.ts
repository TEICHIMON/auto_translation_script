import axios from 'axios';
import path from 'path';
import { SubtitleConfig, WhisperSegment, WhisperTranscriptionResult, WhisperWord } from './types';
import { writeTraceJson, writeTraceText } from './temp-trace';

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
    startIndex?: unknown;
    endIndex?: unknown;
    start_word?: unknown;
    end_word?: unknown;
    from?: unknown;
    to?: unknown;
    first?: unknown;
    last?: unknown;
}

interface Boundary {
    start: number;
    end: number;
}

interface WordChunk {
    startIndex: number;
    words: WhisperWord[];
}

interface SegmentationTraceOptions {
    traceDir?: string | null;
}

export class LrcSegmentationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LrcSegmentationError';
    }
}

// 总尝试次数 = 1 (首次) + MAX_RETRIES
const MAX_RETRIES = 2;

// Whisper 段落去重:相邻段文本完全相同且时间间隔小于此值时,丢弃后者
const DEDUP_TIME_GAP_SECONDS = 1.5;

// 用户会把音频控制在 10 分钟内。给 ffprobe/编码尾巴留几秒误差,
// 这个范围内优先让 DeepSeek 看完整上下文,避免 chunk 边界强行切断句子。
const SINGLE_REQUEST_MAX_DURATION_SECONDS = 10 * 60 + 5;

// DeepSeek only needs to return compact boundary JSON. Keeping this bounded
// avoids asking for impossible output sizes when a whole transcript is sent.
const MAX_DEEPSEEK_OUTPUT_TOKENS = 8192;

// =====================================================================
// JA character classification helpers
// =====================================================================

function isKatakana(ch: string): boolean {
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return code >= 0x30A0 && code <= 0x30FF;
}

function isKanji(ch: string): boolean {
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return (
        (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF)
    );
}

function isAsciiOrFullwidthDigit(ch: string): boolean {
    if (!ch) return false;
    return /[0-9０-９]/.test(ch);
}

const SMALL_KANA = new Set([
    'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ゃ', 'ゅ', 'ょ', 'っ', 'ゎ',
    'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ', 'ッ', 'ヮ',
    'ー'
]);

function isSmallKana(ch: string): boolean {
    return SMALL_KANA.has(ch);
}

// 检查在 words[lastIndex] 与 words[lastIndex+1] 之间切断,是否会撕裂日语词。
// 用于 chooseChunkEnd 提前阻止坏的 chunk 边界。
function wouldSplitJaCompound(words: WhisperWord[], lastIndex: number): boolean {
    if (lastIndex < 0 || lastIndex >= words.length - 1) return false;
    const a = words[lastIndex].word.trim();
    const b = words[lastIndex + 1].word.trim();
    if (!a || !b) return false;

    const lastChar = a.slice(-1);
    const firstChar = b.charAt(0);

    // 同种文字相邻 → 大概率是同一个词
    if (isKatakana(lastChar) && isKatakana(firstChar)) return true;
    if (isKanji(lastChar) && isKanji(firstChar)) return true;
    // 小假名 / 长音符不应作为新 chunk 的开头
    if (isSmallKana(firstChar)) return true;
    // 数字 + 助数词(汉字 / 片假名)
    if (isAsciiOrFullwidthDigit(lastChar) && (isKanji(firstChar) || isKatakana(firstChar))) {
        return true;
    }
    return false;
}

// =====================================================================
// Whisper segment dedup — kills repetition hallucinations
// =====================================================================

function normalizeForDedup(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface DedupResult {
    segments: WhisperSegment[];
    removed: number;
}

function dedupSegments(segments: WhisperSegment[]): DedupResult {
    if (segments.length < 2) return { segments, removed: 0 };

    const result: WhisperSegment[] = [segments[0]];
    let removed = 0;

    for (let i = 1; i < segments.length; i++) {
        const last = result[result.length - 1];
        const curr = segments[i];

        const sameText = normalizeForDedup(last.text) === normalizeForDedup(curr.text);
        const closeInTime = curr.start - last.end < DEDUP_TIME_GAP_SECONDS;

        if (sameText && closeInTime) {
            removed++;
            continue;
        }
        result.push(curr);
    }

    return { segments: result, removed };
}

// =====================================================================
// Common helpers
// =====================================================================

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

// =====================================================================
// Chunking — now JA-aware
// =====================================================================

function chooseChunkEnd(
    words: WhisperWord[],
    startIndex: number,
    maxWords: number,
    lang: string
): number {
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

        // CRITICAL JA fix: heavily penalize chunk cuts that would split a compound.
        // Large penalty (not Infinity) so we still pick the least-bad option if every
        // candidate is mid-word.
        if (lang === 'ja' && wouldSplitJaCompound(words, i)) score -= 100;

        if (score > bestScore) {
            bestScore = score;
            bestLast = i;
        }
    }

    return Math.max(bestLast + 1, startIndex + 1);
}

function chunkWords(words: WhisperWord[], maxWords: number, lang: string): WordChunk[] {
    const chunks: WordChunk[] = [];
    let startIndex = 0;

    while (startIndex < words.length) {
        const endIndex = chooseChunkEnd(words, startIndex, maxWords, lang);
        chunks.push({
            startIndex,
            words: words.slice(startIndex, endIndex)
        });
        startIndex = endIndex;
    }

    return chunks;
}

// =====================================================================
// Prompt construction
// =====================================================================

function buildPrompt(
    words: WhisperWord[],
    lang: string,
    previousErrors: string[] = []
): string {
    const wordRows = words
        .map((word, index) => {
            const text = JSON.stringify(word.word);
            return `${index}|${word.start.toFixed(2)}|${word.end.toFixed(2)}|${text}`;
        })
        .join('\n');

    const isJa = lang === 'ja';

    const languageBlock = isJa
        ? `Language: Japanese.

CRITICAL Japanese rules — these are HARD constraints, not preferences:

1. NEVER break inside a katakana run. If word[i] ends with katakana AND word[i+1] starts with katakana, they belong to the same word.
   ✗ BAD:  「...急にスタ」 / 「イルを変えて...」   (broke スタイル)
   ✗ BAD:  「...3Dになったりとかフ」 / 「ルCGに...」   (broke フルCG)
   ✓ GOOD: 「...急に」 / 「スタイルを変えて...」

2. NEVER break inside a kanji run. If both sides of the boundary are kanji, they are likely one compound word.
   ✗ BAD:  「...初購入金額の70%分が楽」 / 「天ポイントで...」   (broke 楽天)
   ✗ BAD:  「...ちょっと過」 / 「激なので...」   (broke 過激)
   ✓ GOOD: 「...という」 / 「広告代理店が...」

3. NEVER break inside a Latin/digit run (CG, 3D, AI, GPT, etc).

4. NEVER split a number from its counter. 1000 / 倍 is wrong; keep 「1000倍」 together. Same for 3 / メートル, 5 / 月, etc.

5. NEVER start a new line with a small kana, sokuon, or chōonpu: ャ ュ ョ ッ ぁ ぃ ぅ ぇ ぉ ゃ ゅ ょ っ ァ ィ ゥ ェ ォ ー
   These are always part of the previous mora.

6. Avoid ending OR starting a line with a particle / connective form when there is a better nearby boundary:
   - Single-char particles: は が を に で と へ の や か も し て
   - Multi-char endings: から まで より けど ので のに たり だけ しか ばかり でも
   - Te-form / de-form verb endings at line end: ...って ...んで ...いで ...けて ...せて
   This is a preference, not a reason to split inside a word. For example, こんにちは is one word even though it ends with は.

7. Japanese Whisper word units can be too small or wrong. Do NOT treat each word row as a subtitle phrase.

8. NEVER create tiny fragment lines unless they are truly standalone speech.
   ✗ BAD: 「人気」 / 「アニメとか」 / 「が」
   ✓ GOOD: 「人気アニメとかが」
   ✗ BAD: 「ある」 / 「時その」 / 「広告代理店で...」
   ✓ GOOD: 「ある時その広告代理店で...」
   ✗ BAD: 「けど」, 「が」, 「そ」, 「大」 as their own line
   ✓ GOOD: attach these fragments to the previous or next meaningful phrase.

9. STRONGLY prefer breaking right after 。 ！ ？ when present in the chunk.`
        : `Language: English.

CRITICAL English subtitle rules:

1. Prefer complete sentences or complete spoken clauses. Do NOT split just because there is a tiny timestamp gap.

2. NEVER leave articles, conjunctions, prepositions, auxiliaries, or pronouns stranded at a line edge when a nearby readable boundary exists.
   Avoid ending a line with: the, a, an, and, but, or, of, to, in, on, at, for, with, as, when, that, is, are, was, were, be, have, has, had, can, will, his, her, their, my, your.
   Avoid starting a line with continuation words like: the, a, an, and, but, of, to, with, as, when, that.

3. NEVER create tiny fragment lines unless they are truly standalone speech or reactions.
   ✗ BAD: "The" / "good old solo first"
   ✓ GOOD: "The good old solo first blood"
   ✗ BAD: "with some other things But" / "the Exhaust..."
   ✓ GOOD: "with some other things" / "But the Exhaust..."
   ✗ BAD: "no, no, no The" / "blind spaces follow,"
   ✓ GOOD: "no, no, no" / "The blind spaces follow,"
   ✗ BAD: "his Raptors You" / "can really feel it"
   ✓ GOOD: "his Raptors" / "You can really feel it"

4. For fast commentary, prefer readable clause chunks over mechanically short captions.`;

    const targetBlock = isJa
        ? `- Target 2.0-6.0 seconds per line. Aim for 18-42 Japanese characters.
- Prefer fewer complete, readable Japanese subtitle lines over many tiny lines.
- Avoid lines under 1.2 seconds or under 6 Japanese characters unless the speech itself is a complete short reaction like 「はい」 or 「え？」.
- If choosing between a slightly long line and a tiny fragment, choose the slightly long readable line.`
        : `- Target 2.0-6.8 seconds per line; shorter is okay for quick reactions.
- Prefer 5-14 English words per line when possible.
- Avoid lines under 1.2 seconds or under 3 English words unless the speech itself is a complete short reaction like "Yeah", "No", "What?", or "Okay".
- If choosing between a slightly long line and a tiny fragment, choose the slightly long readable line.
- Avoid lines longer than about 110 characters.`;

    const feedbackBlock = previousErrors.length > 0
        ? `

⚠️  Your previous attempt was REJECTED. You MUST fix every one of these issues:
${previousErrors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}
`
        : '';

    return `Split this transcript into readable LRC subtitle lines.

${languageBlock}

Return ONLY valid JSON in this exact shape:
{"boundaries":[{"start":0,"end":8},{"start":9,"end":17}]}

Rules:
- Every boundary object MUST contain integer "start" and integer "end".
- start/end are local word indices from the list below, inclusive.
- Do not include subtitle text, timestamps, explanations, labels, or any fields except start/end.
- Cover every word exactly once, in order, from index 0 to index ${words.length - 1}.
- Do not skip, overlap, reorder, rewrite, translate, or invent words.
- Prefer complete sentences or complete spoken clauses.
- Use punctuation and meaningful pauses as boundary signals, but do not break grammar for tiny timestamp gaps.
${targetBlock}
- For Japanese, prioritize readable phrase boundaries over tiny timestamp gaps.
- If the speech is fast, choose readable phrase boundaries rather than making one very long line.
${feedbackBlock}
Words:
index|start|end|word
${wordRows}`;
}

// =====================================================================
// JSON parsing
// =====================================================================

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
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        return Number.parseInt(value.trim(), 10);
    }
    return null;
}

function boundaryStartFromRaw(raw: RawBoundary): number | null {
    return numberFromUnknown(
        raw.start ??
        raw.startWord ??
        raw.startIndex ??
        raw.start_word ??
        raw.from ??
        raw.first
    );
}

function boundaryEndFromRaw(raw: RawBoundary): number | null {
    return numberFromUnknown(
        raw.end ??
        raw.endWord ??
        raw.endIndex ??
        raw.end_word ??
        raw.to ??
        raw.last
    );
}

function parseBoundaries(content: string, totalWords: number): Boundary[] {
    const parsed = extractJson(content);
    const rawBoundaries = Array.isArray(parsed)
        ? parsed
        : (parsed as { boundaries?: unknown }).boundaries;

    if (!Array.isArray(rawBoundaries)) {
        throw new LrcSegmentationError('DeepSeek JSON 缺少 boundaries 数组');
    }

    const boundaries: Boundary[] = [];
    let expectedStart = 0;

    for (let index = 0; index < rawBoundaries.length; index++) {
        const rawBoundary = rawBoundaries[index];
        const boundary = rawBoundary as RawBoundary;
        const nextBoundary = rawBoundaries[index + 1] as RawBoundary | undefined;
        const explicitStart = Array.isArray(rawBoundary)
            ? numberFromUnknown(rawBoundary[0])
            : boundaryStartFromRaw(boundary);
        const explicitEnd = Array.isArray(rawBoundary)
            ? numberFromUnknown(rawBoundary[1])
            : boundaryEndFromRaw(boundary);
        const nextStart = Array.isArray(nextBoundary)
            ? numberFromUnknown(nextBoundary[0])
            : nextBoundary ? boundaryStartFromRaw(nextBoundary) : null;

        const start = explicitStart ?? expectedStart;
        const end = explicitEnd ??
            (nextStart !== null ? nextStart - 1 : index === rawBoundaries.length - 1 ? totalWords - 1 : null);

        if (start === null || end === null) {
            throw new LrcSegmentationError(`boundary[${index}] 缺少整数 start/end`);
        }

        boundaries.push({ start, end });
        expectedStart = end + 1;
    }

    return boundaries;
}

function textForBoundary(words: WhisperWord[], boundary: Boundary): string {
    return normalizeLrcText(
        words.slice(boundary.start, boundary.end + 1).map(word => word.word).join('')
    );
}

// =====================================================================
// Validation
// =====================================================================

function validateBoundaries(
    boundaries: Boundary[],
    words: WhisperWord[]
): string[] {
    if (!boundaries.length) {
        return ['DeepSeek 返回了空 boundaries'];
    }

    let expectedStart = 0;
    for (let i = 0; i < boundaries.length; i++) {
        const b = boundaries[i];
        if (b.start !== expectedStart) {
            return [`boundary[${i}] 不连续: expected start ${expectedStart}, got ${b.start}`];
        }
        if (b.end < b.start || b.end >= words.length) {
            return [`boundary[${i}] 范围非法: start=${b.start}, end=${b.end}, total=${words.length}`];
        }
        expectedStart = b.end + 1;
    }
    if (expectedStart !== words.length) {
        return [`boundaries 未覆盖所有 words: ended at ${expectedStart}, total ${words.length}`];
    }

    return [];
}

function buildLrcLines(words: WhisperWord[], boundaries: Boundary[]): string[] {
    return boundaries.map(boundary => {
        const startWord = words[boundary.start];
        const text = textForBoundary(words, boundary);
        return `${formatLrcTimestamp(startWord.start)}${text}`;
    });
}

// =====================================================================
// DeepSeek call + retry-with-feedback
// =====================================================================

async function callDeepSeek(
    prompt: string,
    config: SubtitleConfig,
    maxTokens: number
): Promise<string> {
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
    return content;
}

async function requestBoundaries(
    words: WhisperWord[],
    lang: string,
    config: SubtitleConfig,
    traceDir?: string | null,
    chunkIndex?: number
): Promise<Boundary[]> {
    const maxTokens = Math.min(
        MAX_DEEPSEEK_OUTPUT_TOKENS,
        Math.max(2048, Math.ceil(words.length * 3))
    );
    let previousErrors: string[] = [];
    const chunkDir = traceDir && chunkIndex !== undefined
        ? path.join(traceDir, `chunk-${String(chunkIndex).padStart(3, '0')}`)
        : null;

    await writeTraceJson(chunkDir, 'meta.json', {
        lang,
        wordCount: words.length,
        maxTokens
    });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.log(
                `  🔁 LRC 分句重试 ${attempt}/${MAX_RETRIES} ` +
                `(上一次有 ${previousErrors.length} 个问题)`
            );
        }

        let boundaries: Boundary[] = [];
        let errors: string[] = [];
        const attemptPrefix = `attempt-${attempt}`;

        try {
            const prompt = buildPrompt(words, lang, previousErrors);
            await writeTraceText(chunkDir, `${attemptPrefix}.prompt.txt`, prompt);
            const content = await callDeepSeek(prompt, config, maxTokens);
            await writeTraceText(chunkDir, `${attemptPrefix}.response.txt`, content);
            boundaries = parseBoundaries(content, words.length);
            await writeTraceJson(chunkDir, `${attemptPrefix}.boundaries.json`, boundaries);
            errors = validateBoundaries(boundaries, words);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors = [`DeepSeek 返回格式无法解析: ${message}`];
        }

        await writeTraceJson(chunkDir, `${attemptPrefix}.errors.json`, errors);

        if (errors.length === 0) {
            await writeTraceJson(chunkDir, 'boundaries.json', boundaries);
            return boundaries;
        }

        previousErrors = errors.slice(0, 12);

        if (attempt === MAX_RETRIES) {
            throw new LrcSegmentationError(
                `DeepSeek 分句重试 ${MAX_RETRIES} 次后仍有问题:\n` +
                errors.slice(0, 5).join('\n')
            );
        }
    }

    throw new LrcSegmentationError('LRC 分句意外失败');
}

export async function segmentWhisperResultWithDeepSeek(
    result: WhisperTranscriptionResult,
    lang: string,
    config: SubtitleConfig,
    traceOptions: SegmentationTraceOptions = {}
): Promise<string> {
    const traceDir = traceOptions.traceDir || null;

    // Pre-pass: dedup Whisper hallucination repetitions before chunking
    const dedup = dedupSegments(result.segments || []);
    if (dedup.removed > 0) {
        console.log(`  🧹 去除重复 Whisper segments: ${dedup.removed} 个`);
    }

    await writeTraceJson(traceDir, 'dedup.json', {
        originalSegments: result.segments?.length || 0,
        dedupedSegments: dedup.segments.length,
        removedSegments: dedup.removed
    });
    await writeTraceJson(traceDir, 'deduped-segments.json', dedup.segments);

    const words = flattenWords(dedup.segments);

    if (!words.length) {
        throw new LrcSegmentationError('Whisper 结果缺少 word timestamps');
    }

    await writeTraceJson(traceDir, 'words.json', words);

    const useSingleRequest = Number.isFinite(result.duration) &&
        result.duration <= SINGLE_REQUEST_MAX_DURATION_SECONDS;
    const effectiveChunkWords = useSingleRequest
        ? words.length
        : config.lrcSegmentationChunkWords;
    const chunks = chunkWords(words, effectiveChunkWords, lang);
    const lines: string[] = [];

    await writeTraceJson(traceDir, 'meta.json', {
        lang,
        model: config.lrcSegmentationModel,
        duration: result.duration,
        wordCount: words.length,
        chunkCount: chunks.length,
        effectiveChunkWords,
        useSingleRequest
    });
    await writeTraceJson(traceDir, 'chunks.json', chunks.map((chunk, index) => ({
        index,
        startIndex: chunk.startIndex,
        endIndex: chunk.startIndex + chunk.words.length - 1,
        wordCount: chunk.words.length,
        startTime: chunk.words[0]?.start,
        endTime: chunk.words[chunk.words.length - 1]?.end,
        words: chunk.words
    })));

    console.log(
        `  🧠 DeepSeek LRC 分句: ${words.length} words, ` +
        `${chunks.length} chunk(s), model=${config.lrcSegmentationModel}` +
        (useSingleRequest ? ', single-request<=10min' : '')
    );

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const boundaries = await requestBoundaries(chunk.words, lang, config, traceDir, i);
        const chunkLines = buildLrcLines(chunk.words, boundaries);
        lines.push(...chunkLines);
        await writeTraceText(
            traceDir ? path.join(traceDir, `chunk-${String(i).padStart(3, '0')}`) : null,
            'lrc.txt',
            `${chunkLines.join('\n')}\n`
        );
        console.log(`  🧩 分句进度: ${i + 1}/${chunks.length}`);
    }

    const finalLrc = lines.join('\n') + '\n';
    await writeTraceText(traceDir, 'final.lrc', finalLrc);
    return finalLrc;
}
