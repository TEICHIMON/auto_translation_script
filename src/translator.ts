import axios from 'axios';
import { getConfig, getApiProvider } from './config';

/**
 * 调用 OpenAI API
 */
async function callOpenAI(
    apiUrl: string,
    apiKey: string,
    model: string,
    prompt: string
): Promise<string> {
    const response = await axios.post(
        apiUrl,
        {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    return response.data.choices[0].message.content.trim();
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
    const response = await axios.post(
        apiUrl,
        {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    return response.data.choices[0].message.content.trim();
}

/**
 * 统一的翻译接口 - 根据 CURRENT_MODEL 自动选择 API
 */
export async function translateWithOpenRouter(
    lrcContent: string,
    prompt: string
): Promise<string> {
    const config = getConfig();
    const provider = getApiProvider(config.currentModel);
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
            throw new Error(
                `${provider.toUpperCase()} API 调用失败: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`
            );
        }
        throw error;
    }
}