import axios from 'axios';
import { getConfig } from './config';

/**
 * 调用 OpenAI ChatGPT API 进行翻译
 */
export async function translateWithOpenRouter(
    lrcContent: string,
    prompt: string
): Promise<string> {
    const config = getConfig();

    const fullPrompt = `${prompt}\n\n${lrcContent}`;

    try {
        console.log('正在调用 OpenAI ChatGPT API 翻译...');

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: config.openaiModel,
                messages: [
                    {
                        role: 'user',
                        content: fullPrompt
                    }
                ],
            },
            {
                headers: {
                    'Authorization': `Bearer ${config.openaiApiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const translatedContent = response.data.choices[0].message.content;
        console.log('翻译完成！');

        return translatedContent.trim();
    } catch (error) {
        if (axios.isAxiosError(error)) {
            throw new Error(
                `OpenAI API 调用失败: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`
            );
        }
        throw error;
    }
}