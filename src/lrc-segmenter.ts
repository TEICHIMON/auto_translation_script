import axios from 'axios';
import path from 'path';
import { SubtitleConfig, WhisperSegment, WhisperTranscriptionResult, WhisperWord } from './types';
import { writeTraceJson, writeTraceText } from './temp-trace';

interface OpenAICompatibleResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
            reasoning_content?: string | null;
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

interface BoundaryIssue {
    lineIndex: number;
    type: 'weak_end' | 'too_long' | 'too_short';
    message: string;
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
const MAX_DEEPSEEK_OUTPUT_TOKENS = 200000;

// Quality thresholds used by analyzeBoundaryIssues + the mechanical shifter.
// These are intentionally LOOSE — they represent "obviously bad", not the prompt's
// preferred range. The prompt asks for 5–14 words; we only flag 18+ here.
const HARD_MAX_WORDS_PER_LINE_EN = 18;
const HARD_MAX_CHARS_PER_LINE_JA = 50;
const HARD_MIN_WORDS_PER_LINE_EN = 3;
const HARD_MIN_CHARS_PER_LINE_JA = 5;

// =====================================================================
// Weak-word lists — used both to detect issues and to shift boundaries
// Ported from server_general_lrc.py to keep the two paths consistent.
// =====================================================================

const EN_WEAK_END_WORDS = new Set<string>([
    // Articles / determiners
    'the', 'a', 'an', 'this', 'these', 'those',
    // Prepositions
    'to', 'of', 'in', 'on', 'at', 'for', 'with',
    'as', 'from', 'by', 'about', 'towards', 'toward',
    'onto', 'into', 'beneath', 'inside', 'outside',
    'through', 'throughout', 'around', 'between', 'under', 'over',
    // Conjunctions / clause connectors
    'and', 'or', 'but', 'if', 'that', 'because', 'although', 'while',
    'when', 'where', 'which', 'who', 'whom', 'whose',
    // Be verbs / auxiliaries / modals
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'do', 'does', 'did',
    'have', 'has', 'had',
    'can', 'could', 'would', 'should', 'will', 'may', 'might', 'must',
    // Possessives / pronouns that often need a noun or complement
    'his', 'her', 'their', 'our', 'your', 'my', 'its',
    // Degree words / modifiers
    'very', 'really', 'quite', 'fairly', 'slightly', 'much', 'more', 'most',
]);

const JA_WEAK_END_PARTICLES = [
    // multi-char (compound particles / clause connectors)
    'から', 'まで', 'より', 'けど', 'けれど', 'ので', 'のに', 'たり',
    'だけ', 'しか', 'ばかり', 'でも', 'こそ',
    // single-char (case / topic / adverbial)
    'は', 'が', 'を', 'に', 'で', 'と', 'へ', 'の', 'や', 'か',
    'も', 'し', 'て',
];

const JA_TE_DE_FORM_RE = /[っん]?[てで]$/;

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
function wouldSplitJaCompound(words: WhisperWord[], lastIndex: number): boolean {
    if (lastIndex < 0 || lastIndex >= words.length - 1) return false;
    const a = words[lastIndex].word.trim();
    const b = words[lastIndex + 1].word.trim();
    if (!a || !b) return false;

    const lastChar = a.slice(-1);
    const firstChar = b.charAt(0);

    if (isKatakana(lastChar) && isKatakana(firstChar)) return true;
    if (isKanji(lastChar) && isKanji(firstChar)) return true;
    if (isSmallKana(firstChar)) return true;
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
    if (lang === 'ja') return /[。!?]["」』）)]?$/.test(trimmed);
    return /[.!?]["']?$/.test(trimmed);
}

function gapAfter(words: WhisperWord[], index: number): number {
    if (index < 0 || index >= words.length - 1) return 0;
    return Math.max(words[index + 1].start - words[index].end, 0);
}

// Strip punctuation off a single word and lowercase it. Used by the shifter
// and the issue analyzer to compare against EN_WEAK_END_WORDS.
function cleanWordForLookup(rawWord: string): string {
    return rawWord
        .trim()
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, '');
}

function endsWithJaWeakParticle(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    for (const particle of JA_WEAK_END_PARTICLES) {
        if (trimmed.endsWith(particle)) return true;
    }
    if (JA_TE_DE_FORM_RE.test(trimmed)) return true;
    return false;
}

// =====================================================================
// Chunking — JA-aware
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
// Initial-pass prompt
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

9. STRONGLY prefer breaking right after 。 ! ? when present in the chunk.`
        : `Language: English.

CRITICAL English subtitle rules:

1. HARD LIMIT: no line may exceed ${HARD_MAX_WORDS_PER_LINE_EN} English words.

2. Prefer 5–14 English words per line when possible, but readability is more important than mechanically short captions.

3. Prefer complete sentences, complete clauses, or natural spoken chunks.

4. Use punctuation and meaningful pauses as boundary signals, but do not break grammar just because of a tiny timestamp gap.

5. NEVER end a line on a function word. Forbidden line endings include:
   the, a, an, and, but, or, of, to, in, on, at, for, with, as, when, that,
   is, are, was, were, be, have, has, had, can, will, would, should,
   his, her, their, my, your, this, these, those, very, more.

   If a candidate line ends on one of these, move that word to the start of the next line
   or choose a nearby natural boundary.

6. Avoid starting a line with continuation words:
   to, of, with, into, onto, through.

   However, do not force an unnatural break just to avoid this. Use this as a strong preference,
   not as a reason to damage grammar or create a tiny fragment.

7. NEVER create tiny fragment lines unless they are truly standalone speech or reactions.
   ✗ BAD: "The" / "good old solo first"
   ✓ GOOD: "The good old solo first blood"
   ✗ BAD: "with some other things But" / "the Exhaust..."
   ✓ GOOD: "with some other things" / "But the Exhaust..."
   ✗ BAD: "no, no, no The" / "blind spaces follow,"
   ✓ GOOD: "no, no, no" / "The blind spaces follow,"
   ✗ BAD: "his Raptors You" / "can really feel it"
   ✓ GOOD: "his Raptors" / "You can really feel it"`;

    const targetBlock = isJa
        ? `- Target 2.0-6.0 seconds per line. Aim for 18-42 Japanese characters.
- Prefer fewer complete, readable Japanese subtitle lines over many tiny lines.
- Avoid lines under 1.2 seconds or under 6 Japanese characters unless the speech itself is a complete short reaction like 「はい」 or 「え？」.
- If choosing between a slightly long line and a tiny fragment, choose the slightly long readable line.
- HARD limit: never exceed ${HARD_MAX_CHARS_PER_LINE_JA} Japanese characters in one line.`
        : `- Target 2.0–6.8 seconds per line; shorter is okay for quick reactions.
- Prefer 5–14 English words per line when possible.
- Avoid lines under 1.2 seconds or under 3 English words unless the speech itself is a complete short reaction like "Yeah", "No", "What?", or "Okay".
- If choosing between a slightly long readable line and a tiny fragment, choose the slightly long readable line.
- HARD limit: never exceed ${HARD_MAX_WORDS_PER_LINE_EN} words per line. If a line would exceed this, split at a period, comma, or natural clause boundary.`;

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
${isJa ? '- For Japanese, prioritize readable phrase boundaries over tiny timestamp gaps.' : ''}
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

function lineWordCount(boundary: Boundary): number {
    return boundary.end - boundary.start + 1;
}

// =====================================================================
// Validation (structural — same as before)
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

// =====================================================================
// Quality analysis (semantic — only used to decide whether to critique)
//
// IMPORTANT: this NEVER throws, it only describes. The structural validator
// above stays the only thing that can reject DeepSeek output. Quality issues
// just feed the critique pass.
// =====================================================================

function analyzeBoundaryIssues(
    boundaries: Boundary[],
    words: WhisperWord[],
    lang: string
): BoundaryIssue[] {
    const issues: BoundaryIssue[] = [];

    for (let i = 0; i < boundaries.length; i++) {
        const b = boundaries[i];
        const text = textForBoundary(words, b);
        const lastWord = words[b.end]?.word ?? '';

        if (lang === 'en') {
            const wc = lineWordCount(b);

            // 1. Weak ending — but a sentence-end punctuation rescues it.
            const lastClean = cleanWordForLookup(lastWord);
            const trailingHasPunct = /[.!?]["']?$/.test(lastWord.trim());
            if (lastClean && EN_WEAK_END_WORDS.has(lastClean) && !trailingHasPunct) {
                issues.push({
                    lineIndex: i,
                    type: 'weak_end',
                    message: `line ${i + 1} ends on weak word "${lastClean}"`,
                });
            }

            // 2. Too long.
            if (wc > HARD_MAX_WORDS_PER_LINE_EN) {
                issues.push({
                    lineIndex: i,
                    type: 'too_long',
                    message: `line ${i + 1} has ${wc} words (limit ${HARD_MAX_WORDS_PER_LINE_EN})`,
                });
            }

            // 3. Tiny fragment with no sentence-end punctuation.
            if (wc < HARD_MIN_WORDS_PER_LINE_EN && !hasSentenceEnd(text, 'en')) {
                issues.push({
                    lineIndex: i,
                    type: 'too_short',
                    message: `line ${i + 1} is too short (${wc} words, no sentence end)`,
                });
            }
        } else {
            const charCount = text.length;
            const trimmedLast = lastWord.trim();

            if (endsWithJaWeakParticle(trimmedLast) && !hasSentenceEnd(trimmedLast, 'ja')) {
                issues.push({
                    lineIndex: i,
                    type: 'weak_end',
                    message: `line ${i + 1} ends on weak particle / te-form`,
                });
            }
            if (charCount > HARD_MAX_CHARS_PER_LINE_JA) {
                issues.push({
                    lineIndex: i,
                    type: 'too_long',
                    message: `line ${i + 1} has ${charCount} chars (limit ${HARD_MAX_CHARS_PER_LINE_JA})`,
                });
            }
            if (charCount < HARD_MIN_CHARS_PER_LINE_JA && !hasSentenceEnd(text, 'ja')) {
                issues.push({
                    lineIndex: i,
                    type: 'too_short',
                    message: `line ${i + 1} is too short (${charCount} chars)`,
                });
            }
        }
    }

    return issues;
}

// =====================================================================
// Build LRC lines
// =====================================================================

function buildLrcLines(words: WhisperWord[], boundaries: Boundary[]): string[] {
    return boundaries.map(boundary => {
        const startWord = words[boundary.start];
        const text = textForBoundary(words, boundary);
        return `${formatLrcTimestamp(startWord.start)}${text}`;
    });
}

// =====================================================================
// DeepSeek call — now thinking-mode aware
// =====================================================================

async function callDeepSeek(
    prompt: string,
    config: SubtitleConfig,
    maxTokens: number,
    useThinking: boolean
): Promise<string> {
    const body: Record<string, unknown> = {
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
        thinking: { type: useThinking ? 'enabled' : 'disabled' }
    };

    const response = await axios.post<OpenAICompatibleResponse>(
        config.deepSeekApiUrl,
        body,
        {
            headers: {
                'Authorization': `Bearer ${config.deepSeekApiKey}`,
                'Content-Type': 'application/json'
            },
            // Thinking mode can take noticeably longer than flash mode. Give it
            // headroom (5 min) so we don't kill a request mid-reasoning.
            timeout: useThinking ? 5 * 60 * 1000 : 2 * 60 * 1000,
        }
    );

    const content = response.data.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
        throw new LrcSegmentationError('DeepSeek 返回空分句结果');
    }
    return content;
}

// =====================================================================
// Critique-pass prompt
//
// Shows DeepSeek its own output, line-by-line, with mechanically-flagged
// issues so it can revise specifically those lines. It returns the FULL
// boundaries array (not just changes), keeping parse logic identical.
// =====================================================================

function buildCritiquePrompt(
    words: WhisperWord[],
    boundaries: Boundary[],
    issues: BoundaryIssue[],
    lang: string
): string {
    const issueByLine = new Map<number, string[]>();
    for (const issue of issues) {
        const arr = issueByLine.get(issue.lineIndex) ?? [];
        arr.push(issue.message);
        issueByLine.set(issue.lineIndex, arr);
    }

    const lineRows = boundaries
        .map((b, i) => {
            const text = textForBoundary(words, b);
            const tags = issueByLine.get(i);
            const flag = tags && tags.length > 0
                ? `  ⚠️  ${tags.join('; ')}`
                : '';
            return `${i + 1} | [${b.start}-${b.end}] | ${JSON.stringify(text)}${flag}`;
        })
        .join('\n');

    const wordRows = words
        .map((word, index) => {
            const text = JSON.stringify(word.word);
            return `${index}|${word.start.toFixed(2)}|${word.end.toFixed(2)}|${text}`;
        })
        .join('\n');

    const isJa = lang === 'ja';
    const langSpecificRules = isJa
        ? `- Never end a line on a single particle: は が を に で と へ の や か も し て.
- Never end a line on a multi-char particle: から まで より けど ので のに たり だけ しか ばかり でも.
- Never end a line on a te/de verb form (...って, ...んで, ...けて, ...せて).
- Never break inside a katakana run, kanji compound, or Latin/digit run.
- Never start a line with a small kana (ャ ュ ョ ッ ぁ ぃ ぅ ぇ ぉ ゃ ゅ ょ っ) or chōonpu (ー).
- Hard limit: ${HARD_MAX_CHARS_PER_LINE_JA} Japanese characters per line.`
        : `- Hard limit: ${HARD_MAX_WORDS_PER_LINE_EN} words per line.
- Prefer 5–14 words per line when possible.
- Never end a line on: the, a, an, and, but, or, of, to, in, on, at, for, with, as, when, that, is, are, was, were, be, have, has, had, can, will, would, should, my, your, his, her, their, this, these, those, very, more.
- Avoid starting a line with: to, of, with, into, onto, through, unless needed for grammar.
- Lines flagged "too_long" must be split at the most natural internal break — usually after a period, question mark, exclamation mark, comma, or clause boundary.
- Lines flagged "weak_end" must be fixed by moving the weak word to the start of the next line, or by choosing a nearby natural boundary.
- Lines flagged "too_short" must be merged into the adjacent line that gives the most natural reading.
- Do not create tiny fragments just to satisfy timing.`;

    return `You previously segmented a transcript into subtitle lines. Some of those lines have problems.

Below is your previous output. Lines marked with ⚠️ have mechanically-detected issues. Lines without ⚠️ are good as-is — DO NOT change those.

Your previous segmentation:
line | [word_range] | text  ${'⚠️  issues (if any)'}
─────────────────────────────────────────────────────────
${lineRows}

OBJECTIVE
Re-emit the COMPLETE boundaries array for all ${words.length} words. For lines marked ⚠️, propose a better segmentation that fixes the issue. For lines that are not marked, keep their boundaries identical to what you had before.

RULES
${langSpecificRules}
- Every word index 0..${words.length - 1} must be covered exactly once, in order, with no gaps and no overlaps.
- Output ONLY the JSON object, no commentary.

Return JSON in this exact shape:
{"boundaries":[{"start":0,"end":8},{"start":9,"end":17}]}

Original words (for reference):
index|start|end|word
${wordRows}`;
}

// =====================================================================
// One round of "send prompt → parse → validate → retry on structural errors"
// =====================================================================

async function callAndValidateBoundaries(
    promptBuilder: (previousErrors: string[]) => string,
    words: WhisperWord[],
    config: SubtitleConfig,
    useThinking: boolean,
    chunkDir: string | null,
    attemptLabel: string,
    maxTokens: number
): Promise<Boundary[]> {
    let previousErrors: string[] = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.log(
                `  🔁 ${attemptLabel} 重试 ${attempt}/${MAX_RETRIES} ` +
                `(上一次有 ${previousErrors.length} 个结构问题)`
            );
        }

        let boundaries: Boundary[] = [];
        let errors: string[] = [];
        const attemptPrefix = `${attemptLabel}-attempt-${attempt}`;

        try {
            const prompt = promptBuilder(previousErrors);
            await writeTraceText(chunkDir, `${attemptPrefix}.prompt.txt`, prompt);
            const content = await callDeepSeek(prompt, config, maxTokens, useThinking);
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
            return boundaries;
        }

        previousErrors = errors.slice(0, 12);

        if (attempt === MAX_RETRIES) {
            throw new LrcSegmentationError(
                `${attemptLabel} 重试 ${MAX_RETRIES} 次后仍有结构问题:\n` +
                errors.slice(0, 5).join('\n')
            );
        }
    }

    throw new LrcSegmentationError(`${attemptLabel} 意外失败`);
}

// =====================================================================
// Mechanical boundary shifter (Layer 3)
//
// Three idempotent operations applied in order:
//   1. Sentence-end split — if a line is too long AND has an internal
//      "." / "!" / "?" boundary, split there (English only).
//   2. Weak-end shift — if a line ends on a function word, move that
//      single word into the start of the next line.
//   3. Tiny tail merge — if a line is < min and lacks sentence-end
//      punctuation, merge it with whichever neighbour gives a shorter
//      resulting line.
//
// Every operation preserves: (a) coverage of all words, (b) continuity,
// (c) no empty boundaries. So it can never produce structurally invalid
// output.
// =====================================================================

function splitOnInternalSentenceEnd(
    boundaries: Boundary[],
    words: WhisperWord[],
    lang: string
): Boundary[] {
    if (lang !== 'en') return boundaries;

    const result: Boundary[] = [];

    for (const b of boundaries) {
        if (lineWordCount(b) <= HARD_MAX_WORDS_PER_LINE_EN) {
            result.push(b);
            continue;
        }

        // Find an internal word that ends with .!? — but not the last word
        // of the boundary (that's not "internal"). Also leave at least 3
        // words on each side so we don't carve off a fragment.
        let splitAt = -1;
        for (let i = b.start + 2; i <= b.end - 3; i++) {
            const w = words[i].word.trim();
            if (/[.!?]["']?$/.test(w)) {
                splitAt = i;
                break;
            }
        }

        if (splitAt === -1) {
            result.push(b);
            continue;
        }

        result.push({ start: b.start, end: splitAt });
        result.push({ start: splitAt + 1, end: b.end });
    }

    return result;
}

function shiftWeakEnds(
    boundaries: Boundary[],
    words: WhisperWord[],
    lang: string
): Boundary[] {
    if (boundaries.length < 2) return boundaries;
    if (lang !== 'en') return boundaries;  // JA shifter would need different rules.

    // Work on a copy.
    const result = boundaries.map(b => ({ ...b }));

    for (let i = 0; i < result.length - 1; i++) {
        const b = result[i];
        const next = result[i + 1];

        // Only shift if both boundaries can absorb the change.
        if (lineWordCount(b) <= HARD_MIN_WORDS_PER_LINE_EN) continue;
        if (lineWordCount(next) >= HARD_MAX_WORDS_PER_LINE_EN) continue;

        const lastWord = words[b.end]?.word ?? '';
        if (/[.!?]["']?$/.test(lastWord.trim())) continue;  // Sentence end rescues it.

        const cleaned = cleanWordForLookup(lastWord);
        if (!cleaned || !EN_WEAK_END_WORDS.has(cleaned)) continue;

        // Shift one word from end of b into start of next.
        b.end -= 1;
        next.start -= 1;
    }

    return result;
}

function mergeTinyTails(
    boundaries: Boundary[],
    words: WhisperWord[],
    lang: string
): Boundary[] {
    if (boundaries.length < 2) return boundaries;

    const minSize = lang === 'en' ? HARD_MIN_WORDS_PER_LINE_EN : HARD_MIN_CHARS_PER_LINE_JA;

    const sizeOf = (b: Boundary): number => {
        if (lang === 'en') return lineWordCount(b);
        return textForBoundary(words, b).length;
    };

    const result: Boundary[] = boundaries.map(b => ({ ...b }));
    let i = 0;

    while (i < result.length) {
        const b = result[i];
        const text = textForBoundary(words, b);

        if (sizeOf(b) >= minSize || hasSentenceEnd(text, lang)) {
            i += 1;
            continue;
        }

        // Merge with whichever neighbour is shorter (keeps lines balanced).
        const prev = i > 0 ? result[i - 1] : null;
        const next = i < result.length - 1 ? result[i + 1] : null;

        if (!prev && !next) {
            // Lone tiny fragment — leave it.
            i += 1;
            continue;
        }

        const mergePrev = prev && (!next || sizeOf(prev) <= sizeOf(next));

        if (mergePrev && prev) {
            prev.end = b.end;
            result.splice(i, 1);
            // Don't advance — re-check the merged previous against minSize next loop.
        } else if (next) {
            next.start = b.start;
            result.splice(i, 1);
        } else {
            i += 1;
        }
    }

    return result;
}

function shiftBoundariesMechanically(
    boundaries: Boundary[],
    words: WhisperWord[],
    lang: string
): Boundary[] {
    let working = boundaries;
    working = splitOnInternalSentenceEnd(working, words, lang);
    working = shiftWeakEnds(working, words, lang);
    working = mergeTinyTails(working, words, lang);
    return working;
}

// =====================================================================
// Top-level: initial pass → optional critique → mechanical shifter
// =====================================================================

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
    const chunkDir = traceDir && chunkIndex !== undefined
        ? path.join(traceDir, `chunk-${String(chunkIndex).padStart(3, '0')}`)
        : null;

    await writeTraceJson(chunkDir, 'meta.json', {
        lang,
        wordCount: words.length,
        maxTokens,
        thinking: config.lrcSegmentationThinking,
        critique: config.lrcSegmentationCritique,
    });

    // ---- Layer 1: initial pass (with thinking, if enabled) ----
    const initialBoundaries = await callAndValidateBoundaries(
        prevErrors => buildPrompt(words, lang, prevErrors),
        words,
        config,
        config.lrcSegmentationThinking,
        chunkDir,
        'initial',
        maxTokens
    );
    await writeTraceJson(chunkDir, 'boundaries.initial.json', initialBoundaries);

    const initialIssues = analyzeBoundaryIssues(initialBoundaries, words, lang);
    await writeTraceJson(chunkDir, 'issues.initial.json', initialIssues);
    if (initialIssues.length > 0) {
        console.log(`  🔍 初次分句质量问题: ${initialIssues.length} 个`);
    } else {
        console.log(`  ✅ 初次分句无质量问题`);
    }

    // ---- Layer 2: critique pass (only if needed and enabled) ----
    let workingBoundaries = initialBoundaries;
    if (config.lrcSegmentationCritique && initialIssues.length > 0) {
        try {
            console.log(`  💭 启动 critique 复审 (issues=${initialIssues.length})`);
            const critiqueBoundaries = await callAndValidateBoundaries(
                () => buildCritiquePrompt(words, initialBoundaries, initialIssues, lang),
                words,
                config,
                config.lrcSegmentationThinking,
                chunkDir,
                'critique',
                maxTokens
            );
            const critiqueIssues = analyzeBoundaryIssues(critiqueBoundaries, words, lang);
            await writeTraceJson(chunkDir, 'boundaries.critique.json', critiqueBoundaries);
            await writeTraceJson(chunkDir, 'issues.critique.json', critiqueIssues);

            // Only accept the critique if it actually reduced the issue count.
            // A regression would mean the model "fixed" things by creating new
            // problems — keep the original boundaries in that case.
            if (critiqueIssues.length < initialIssues.length) {
                console.log(`  ✨ critique 改善: ${initialIssues.length} → ${critiqueIssues.length} 个问题`);
                workingBoundaries = critiqueBoundaries;
            } else {
                console.log(
                    `  ⚖️  critique 未改善 (${initialIssues.length} → ${critiqueIssues.length}), 保留初次结果`
                );
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.log(`  ⚠️  critique 失败,沿用初次分句: ${msg}`);
            await writeTraceText(chunkDir, 'critique.error.txt', msg);
        }
    }

    // ---- Layer 3: mechanical shifter (always on, free, can't make things worse) ----
    let finalBoundaries = workingBoundaries;
    try {
        finalBoundaries = shiftBoundariesMechanically(workingBoundaries, words, lang);
        const shiftValidationErrors = validateBoundaries(finalBoundaries, words);
        if (shiftValidationErrors.length > 0) {
            // Defensive: if the shifter somehow produced invalid output, revert.
            console.log(`  ⚠️  shifter 输出结构非法,回退: ${shiftValidationErrors[0]}`);
            finalBoundaries = workingBoundaries;
        } else {
            const finalIssues = analyzeBoundaryIssues(finalBoundaries, words, lang);
            const shiftedDiff = finalBoundaries.length - workingBoundaries.length;
            console.log(
                `  🔧 shifter 完成: ${workingBoundaries.length} → ${finalBoundaries.length} 行 ` +
                `(${shiftedDiff >= 0 ? '+' : ''}${shiftedDiff}), 残余问题 ${finalIssues.length} 个`
            );
            await writeTraceJson(chunkDir, 'issues.final.json', finalIssues);
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  ⚠️  shifter 异常,回退: ${msg}`);
        await writeTraceText(chunkDir, 'shifter.error.txt', msg);
    }

    await writeTraceJson(chunkDir, 'boundaries.final.json', finalBoundaries);
    return finalBoundaries;
}

// =====================================================================
// Public entry point — unchanged shape, new internals
// =====================================================================

export async function segmentWhisperResultWithDeepSeek(
    result: WhisperTranscriptionResult,
    lang: string,
    config: SubtitleConfig,
    traceOptions: SegmentationTraceOptions = {}
): Promise<string> {
    const traceDir = traceOptions.traceDir || null;

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

    // Single-request mode preserves global context, but only works while the
    // model can actually keep its attention on the full word list. Past ~800
    // words we see thinking-mode degenerate into mechanical fixed-width chunks,
    // so cap single-request by word count, not just duration.
    const SINGLE_REQUEST_MAX_WORDS = config.lrcSegmentationThinking ? 800 : 2500;

    const useSingleRequest =
        Number.isFinite(result.duration) &&
        result.duration <= SINGLE_REQUEST_MAX_DURATION_SECONDS &&
        words.length <= SINGLE_REQUEST_MAX_WORDS;
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
        useSingleRequest,
        thinking: config.lrcSegmentationThinking,
        critique: config.lrcSegmentationCritique,
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
        (useSingleRequest ? ', single-request<=10min' : '') +
        `, thinking=${config.lrcSegmentationThinking ? 'on' : 'off'}` +
        `, critique=${config.lrcSegmentationCritique ? 'on' : 'off'}`
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