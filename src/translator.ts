import axios from 'axios';
import { DELIMITER, getConfig } from './config';
import { writeTraceJson, writeTraceText } from './temp-trace';

interface OpenAICompatibleResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
        };
        finish_reason?: string | null;
    }>;
}

interface ClaudeResponse {
    content?: Array<{ text?: string }>;
    stop_reason?: string | null;
}

/** One model reply plus the reason the model stopped, when the API reports it. */
interface ModelReply {
    text: string;
    truncated: boolean;
}

/** A timestamped LRC line, e.g. `[01:23.45]…` or `[01:23.456]…`. */
const LRC_LINE_RE = /^\s*\[\d{1,3}:\d{2}[.:]\d{1,3}\]/;

/** How many times a chunk is re-sent before the whole file is failed. */
const CHUNK_ATTEMPTS = 3;

function isLrcLine(line: string): boolean {
    return LRC_LINE_RE.test(line);
}

function countLrcLines(text: string): number {
    return text.split('\n').filter(isLrcLine).length;
}

/**
 * Drop a ```lrc / ``` wrapper if the model added one.
 *
 * A truncated reply keeps its opening fence and loses the closing one, so this
 * strips fences wherever they appear rather than requiring a matched pair.
 */
function stripCodeFences(text: string): string {
    return text
        .split('\n')
        .filter((line) => !/^\s*```/.test(line))
        .join('\n')
        .trim();
}

/**
 * Split an LRC file into chunks of at most `maxLines` timestamped lines.
 *
 * Non-timestamped lines (headers, blanks) ride along with the chunk they were
 * found in, so nothing is lost and the chunks concatenate back to the original.
 */
export function splitLrcIntoChunks(lrcContent: string, maxLines: number): string[] {
    const chunks: string[] = [];
    let current: string[] = [];
    let lrcLinesInCurrent = 0;

    for (const line of lrcContent.split('\n')) {
        if (isLrcLine(line) && lrcLinesInCurrent >= maxLines) {
            chunks.push(current.join('\n').trim());
            current = [];
            lrcLinesInCurrent = 0;
        }
        current.push(line);
        if (isLrcLine(line)) lrcLinesInCurrent += 1;
    }

    const tail = current.join('\n').trim();
    if (tail) chunks.push(tail);

    return chunks.filter((chunk) => countLrcLines(chunk) > 0);
}

/**
 * Reject a reply that lost or mangled lines.
 *
 * The failure this exists to catch is a silent one: the model hits its output
 * limit part-way through and returns a well-formed but incomplete file, which
 * then flows all the way to the audio pipeline as "the translation".
 */
export function validateChunkReply(chunkIndex: number, source: string, reply: string): void {
    const expected = countLrcLines(source);
    const actual = countLrcLines(reply);

    if (actual !== expected) {
        throw new Error(
            `第 ${chunkIndex + 1} 块译文行数不符: 输入 ${expected} 行,返回 ${actual} 行` +
            (actual < expected ? ' (疑似输出被截断)' : '')
        );
    }

    const missingDelimiter = reply
        .split('\n')
        .filter((line) => isLrcLine(line) && !line.includes(DELIMITER));
    if (missingDelimiter.length > 0) {
        throw new Error(
            `第 ${chunkIndex + 1} 块有 ${missingDelimiter.length} 行缺少分隔符 "${DELIMITER}": ` +
            `${missingDelimiter[0].slice(0, 60)}`
        );
    }
}

/**
 * Rebuild a translated chunk as `<source timestamp><source text>|||<translation>`.
 *
 * Only the translation is actually wanted from the model, but it also retypes
 * the timestamp and the original text, and it does not always do so faithfully:
 * observed drifts include a stamp moving 28:59.16 -> 29:00.16 (which in audio
 * mode shifts a cut point), half-width punctuation being "corrected", and a
 * stray character inserted into the original sentence. Taking the timestamp and
 * the source text from the input makes that whole class of damage impossible.
 *
 * Call only after the line counts match, so line i of the reply really is the
 * translation of line i of the source.
 */
export function restoreSourceColumns(source: string, reply: string): string {
    const sourceLines = source.split('\n').filter(isLrcLine).map((line) => line.trim());

    let i = 0;
    return reply
        .split('\n')
        .map((line) => {
            if (!isLrcLine(line)) return line;
            const original = sourceLines[i++];
            if (!original) return line;
            const translation = line.slice(line.indexOf(DELIMITER) + DELIMITER.length).trim();
            return `${original}${DELIMITER}${translation}`;
        })
        .join('\n');
}

/**
 * 调用 OpenAI 兼容的 Chat Completions API
 */
async function callOpenAICompatible(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    maxTokens: number,
    extraBody: Record<string, unknown> = {}
): Promise<ModelReply> {
    const response = await axios.post<OpenAICompatibleResponse>(
        apiUrl,
        {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: maxTokens,
            ...extraBody
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    const choice = response.data.choices?.[0];
    const content = choice?.message?.content;
    if (!content || !content.trim()) {
        throw new Error('API 返回空翻译结果');
    }

    return { text: content.trim(), truncated: choice?.finish_reason === 'length' };
}

/**
 * 调用 OpenAI API
 */
async function callOpenAI(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    maxTokens: number
): Promise<ModelReply> {
    return callOpenAICompatible(apiUrl, apiKey, model, prompt, maxTokens);
}

/**
 * 调用 Claude API
 */
async function callClaude(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    maxTokens: number
): Promise<ModelReply> {
    const response = await axios.post<ClaudeResponse>(
        apiUrl,
        {
            model: model,
            max_tokens: maxTokens,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
        },
        {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            }
        }
    );

    const text = response.data.content?.[0]?.text;
    if (!text || !text.trim()) {
        throw new Error('API 返回空翻译结果');
    }

    return { text: text.trim(), truncated: response.data.stop_reason === 'max_tokens' };
}

/**
 * 调用 OpenRouter API（兼容 OpenAI 格式）
 */
async function callOpenRouter(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    maxTokens: number
): Promise<ModelReply> {
    return callOpenAICompatible(apiUrl, apiKey, model, prompt, maxTokens);
}

/**
 * 调用 DeepSeek API（兼容 OpenAI 格式）
 */
async function callDeepSeek(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    maxTokens: number
): Promise<ModelReply> {
    return callOpenAICompatible(apiUrl, apiKey, model, prompt, maxTokens, {
        thinking: { type: 'disabled' }
    });
}

async function callProvider(fullPrompt: string): Promise<ModelReply> {
    const config = getConfig();
    const maxTokens = config.translationMaxTokens;

    switch (config.translationProvider) {
        case 'claude':
            return callClaude(
                config.claudeApiUrl, config.claudeApiKey, config.currentModel, fullPrompt, maxTokens
            );
        case 'openrouter':
            return callOpenRouter(
                config.openRouterApiUrl, config.openRouterApiKey, config.currentModel, fullPrompt, maxTokens
            );
        case 'deepseek':
            return callDeepSeek(
                config.deepSeekApiUrl, config.deepSeekApiKey, config.currentModel, fullPrompt, maxTokens
            );
        case 'openai':
        default:
            return callOpenAI(
                config.openaiApiUrl, config.openaiApiKey, config.currentModel, fullPrompt, maxTokens
            );
    }
}

/**
 * Translate one chunk, retrying on a truncated or malformed reply.
 *
 * Retries are worth it because truncation is usually a near-miss on the output
 * limit; if every attempt fails, the error propagates so the caller aborts the
 * file rather than writing a partial translation.
 */
async function translateChunk(
    chunkIndex: number,
    chunkCount: number,
    chunk: string,
    prompt: string,
    traceDir: string | null | undefined
): Promise<string> {
    const fullPrompt = `${prompt}\n\n${chunk}`;
    const traceName = `chunk-${String(chunkIndex).padStart(3, '0')}`;
    await writeTraceText(traceDir, `chunks/${traceName}/input.lrc`, chunk);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
        try {
            const reply = await callProvider(fullPrompt);
            const cleaned = stripCodeFences(reply.text);
            await writeTraceText(
                traceDir, `chunks/${traceName}/response.attempt-${attempt}.lrc`, cleaned
            );

            if (reply.truncated) {
                throw new Error(
                    `第 ${chunkIndex + 1} 块被模型输出上限截断 (finish_reason=length),` +
                    `请调小 TRANSLATION_CHUNK_LINES 或调大 TRANSLATION_MAX_TOKENS`
                );
            }
            validateChunkReply(chunkIndex, chunk, cleaned);
            const aligned = restoreSourceColumns(chunk, cleaned);

            console.log(`  ✅ 翻译分块 ${chunkIndex + 1}/${chunkCount} (${countLrcLines(aligned)} 行)`);
            return aligned;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < CHUNK_ATTEMPTS) {
                console.log(`  ⚠️  分块 ${chunkIndex + 1}/${chunkCount} 第 ${attempt} 次失败,重试: ${lastError.message}`);
            }
        }
    }

    throw new Error(`分块 ${chunkIndex + 1}/${chunkCount} 连续 ${CHUNK_ATTEMPTS} 次失败: ${lastError?.message}`);
}

/**
 * 统一的翻译接口 - 优先使用 TRANSLATION_PROVIDER,否则根据 CURRENT_MODEL 推断 API
 *
 * The file is translated in chunks and every chunk is checked against its input
 * before being accepted, so a partial translation fails the run instead of
 * being written out as if it were complete.
 */
export async function translateWithOpenRouter(
    lrcContent: string,
    prompt: string,
    traceDir?: string | null
): Promise<string> {
    const config = getConfig();
    const provider = config.translationProvider;
    const chunks = splitLrcIntoChunks(lrcContent, config.translationChunkLines);
    const expectedLines = countLrcLines(lrcContent);

    console.log(
        `正在调用 ${provider.toUpperCase()} API (${config.currentModel}) 翻译... ` +
        `${expectedLines} 行 / ${chunks.length} 块`
    );

    await writeTraceJson(traceDir, 'meta.json', {
        provider,
        model: config.currentModel,
        inputLrcLength: lrcContent.length,
        promptLength: prompt.length,
        inputLrcLines: expectedLines,
        chunkCount: chunks.length,
        chunkLines: config.translationChunkLines,
        maxTokens: config.translationMaxTokens
    });
    await writeTraceText(traceDir, 'input.lrc', lrcContent);
    await writeTraceText(traceDir, 'prompt.txt', prompt);

    try {
        const translated: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
            translated.push(await translateChunk(i, chunks.length, chunks[i], prompt, traceDir));
        }

        const result = translated.join('\n');
        const actualLines = countLrcLines(result);
        if (actualLines !== expectedLines) {
            throw new Error(`译文总行数不符: 输入 ${expectedLines} 行,输出 ${actualLines} 行`);
        }

        console.log(`翻译完成！${actualLines} 行`);
        await writeTraceText(traceDir, 'response.lrc', result);
        return result;

    } catch (error) {
        await writeTraceJson(traceDir, 'error.json', {
            message: error instanceof Error ? error.message : String(error)
        });

        if (axios.isAxiosError(error)) {
            const status = error.response?.status ?? 'NO_RESPONSE';
            const detail = error.response?.data
                ? JSON.stringify(error.response.data)
                : error.message;
            throw new Error(
                `${provider.toUpperCase()} API 调用失败: ${status} - ${detail}`
            );
        }
        throw error;
    }
}
