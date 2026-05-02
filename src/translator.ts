import axios from 'axios';
import { getConfig } from './config';

interface OpenAICompatibleResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
        };
    }>;
}

/**
 * 调用 OpenAI 兼容的 Chat Completions API
 */
async function callOpenAICompatible(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    extraBody: Record<string, unknown> = {}
): Promise<string> {
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
            ...extraBody
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    const content = response.data.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
        throw new Error('API 返回空翻译结果');
    }

    return content.trim();
}

/**
 * 调用 OpenAI API
 */
async function callOpenAI(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string
): Promise<string> {
    return callOpenAICompatible(apiUrl, apiKey, model, prompt);
}

/**
 * 调用 Claude API
 */
async function callClaude(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string
): Promise<string> {
    const response = await axios.post(
        apiUrl,
        {
            model: model,
            max_tokens: 50000,
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

    return response.data.content[0].text.trim();
}

/**
 * 调用 OpenRouter API（兼容 OpenAI 格式）
 */
async function callOpenRouter(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string
): Promise<string> {
    return callOpenAICompatible(apiUrl, apiKey, model, prompt);
}

/**
 * 调用 DeepSeek API（兼容 OpenAI 格式）
 */
async function callDeepSeek(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string
): Promise<string> {
    return callOpenAICompatible(apiUrl, apiKey, model, prompt, {
        thinking: { type: 'disabled' }
    });
}

/**
 * 统一的翻译接口 - 优先使用 TRANSLATION_PROVIDER,否则根据 CURRENT_MODEL 推断 API
 */
export async function translateWithOpenRouter(
    lrcContent: string,
    prompt: string
): Promise<string> {
    const config = getConfig();
    const provider = config.translationProvider;
    const fullPrompt = `${prompt}\n\n${lrcContent}`;

    console.log(`正在调用 ${provider.toUpperCase()} API (${config.currentModel}) 翻译...`);

    try {
        let result: string;

        switch (provider) {
            case 'claude':
                result = await callClaude(
                    config.claudeApiUrl,
                    config.claudeApiKey,
                    config.currentModel,
                    fullPrompt
                );
                break;

            case 'openrouter':
                result = await callOpenRouter(
                    config.openRouterApiUrl,
                    config.openRouterApiKey,
                    config.currentModel,
                    fullPrompt
                );
                break;

            case 'deepseek':
                result = await callDeepSeek(
                    config.deepSeekApiUrl,
                    config.deepSeekApiKey,
                    config.currentModel,
                    fullPrompt
                );
                break;

            case 'openai':
            default:
                result = await callOpenAI(
                    config.openaiApiUrl,
                    config.openaiApiKey,
                    config.currentModel,
                    fullPrompt
                );
                break;
        }

        console.log('翻译完成！');
        return result;

    } catch (error) {
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
