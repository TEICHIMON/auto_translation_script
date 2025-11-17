import axios from 'axios';
import { getConfig } from './config';

/**
 * 调用 OpenRouter API 进行翻译
 */
export async function translateWithOpenRouter(
  lrcContent: string,
  prompt: string
): Promise<string> {
  const config = getConfig();
  
  const fullPrompt = `${prompt}\n\n${lrcContent}`;
  
  try {
    console.log('正在调用 OpenRouter API 翻译...');
    
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: config.openRouterModel,
        messages: [
          {
            role: 'user',
            content: fullPrompt
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${config.openRouterApiKey}`,
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
        `OpenRouter API 调用失败: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`
      );
    }
    throw error;
  }
}
