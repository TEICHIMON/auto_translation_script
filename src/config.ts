import dotenv from 'dotenv';
import path from 'path';
import { SubtitleConfig, LanguageConfig, ApiProvider } from './types';

dotenv.config();

// 语言配置
const LANGUAGE_CONFIGS: LanguageConfig[] = [
    {
        folderName: 'English',
        sourceLanguage: 'English',
        targetLanguage: 'Chinese',
        translationPrompt: `请为这个字幕添加中文翻译，生成lrc格式的英中字幕

格式要求：
[时间戳]英文原文-中文翻译

注意事项：
1. 英文原文保持原样，包括单词之间的空格
2. 连字符"-"两侧不要有任何空格
3. 如果原文有拼写或语法错误，可以修正使其通顺、符合上下文

示例：
[00:20.00]Hello world-你好世界
[00:24.40]How are you?-你好吗？
[00:28.15]I'm fine, thank you-我很好，谢谢`
    },
    {
        folderName: 'Japanese',
        sourceLanguage: 'Japanese',
        targetLanguage: 'Chinese',
        translationPrompt: `请为这个字幕添加中文翻译，生成lrc格式的日中字幕

格式要求：
[时间戳]日文原文-中文翻译

注意事项：
1. 日文原文保持原样
2. 连字符"-"两侧不要有任何空格
3. 如果原文有错误，可以修正使其通顺、符合上下文

示例：
[00:20.00]こんにちは-你好
[00:24.40]元気ですか？-你好吗？
[00:28.15]ありがとう-谢谢`
    }
];

/**
 * 根据模型名称判断 API 提供商
 */
export function getApiProvider(modelName: string): ApiProvider {
    const lowerModel = modelName.toLowerCase();

    // Claude 模型
    if (lowerModel.includes('claude')) {
        return 'claude';
    }

    // OpenRouter 模型（通常包含 / 或特定前缀）
    if (lowerModel.includes('/') ||
        lowerModel.includes('google') ||
        lowerModel.includes('gemini') ||
        lowerModel.includes('mistral') ||
        lowerModel.includes('llama')) {
        return 'openrouter';
    }

    // 默认使用 OpenAI（gpt-* 等）
    return 'openai';
}

export function getConfig(): SubtitleConfig {
    const rootDir = process.env.ROOT_DIR || '';
    const syncDir = process.env.SYNC_DIR || '';

    // 当前模型
    const currentModel = process.env.CURRENT_MODEL || 'gpt-4o-mini';

    // OpenAI 配置
    const openaiApiKey = process.env.OPENAI_API_KEY || '';
    const openaiApiUrl = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';

    // Claude 配置
    const claudeApiKey = process.env.CLAUDE_API_KEY || '';
    const claudeApiUrl = process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages';

    // OpenRouter 配置
    const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
    const openRouterApiUrl = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';

    if (!rootDir) {
        throw new Error('请在 .env 文件中设置 ROOT_DIR（音频根目录路径）');
    }

    // 检查当前模型对应的 API Key 是否已配置
    const provider = getApiProvider(currentModel);
    if (provider === 'openai' && !openaiApiKey) {
        throw new Error(`当前模型 ${currentModel} 需要 OPENAI_API_KEY`);
    }
    if (provider === 'claude' && !claudeApiKey) {
        throw new Error(`当前模型 ${currentModel} 需要 CLAUDE_API_KEY`);
    }
    if (provider === 'openrouter' && !openRouterApiKey) {
        throw new Error(`当前模型 ${currentModel} 需要 OPENROUTER_API_KEY`);
    }

    return {
        rootDir,
        languageFolders: LANGUAGE_CONFIGS,
        syncDir,
        currentModel,
        openaiApiKey,
        openaiApiUrl,
        claudeApiKey,
        claudeApiUrl,
        openRouterApiKey,
        openRouterApiUrl
    };
}

export function getLanguageConfig(folderPath: string): LanguageConfig | null {
    const folderName = path.basename(folderPath);
    return LANGUAGE_CONFIGS.find(config => config.folderName === folderName) || null;
}
