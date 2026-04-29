import dotenv from 'dotenv';
import path from 'path';
import { SubtitleConfig, LanguageConfig, ApiProvider } from './types';

dotenv.config();

// 双语字幕分隔符（原文与译文之间的分隔符）
export const DELIMITER = '|||';

// 语言配置
const LANGUAGE_CONFIGS: LanguageConfig[] = [
    {
        folderName: 'English',
        sourceLanguage: 'English',
        targetLanguage: 'Chinese',
        translationPrompt: `请为这个字幕添加中文翻译，生成lrc格式的英中字幕\n\n格式要求：\n[时间戳]英文原文${DELIMITER}中文翻译\n\n注意事项：\n1. 英文原文保持原样，包括单词之间的空格\n2. 分隔符"${DELIMITER}"两侧不要有任何空格\n3. 尽可能做到直译，不要意译，保持原文的风格和表达方式\n\n示例：\n[00:20.00]Hello world${DELIMITER}你好世界\n[00:24.40]How are you?${DELIMITER}你好吗？\n[00:28.15]I'm fine, thank you${DELIMITER}我很好，谢谢`,
        sttLanguageCode: 'en-US'
    },
    {
        folderName: 'Japanese',
        sourceLanguage: 'Japanese',
        targetLanguage: 'Chinese',
        translationPrompt: `请为这个字幕添加中文翻译，生成lrc格式的日中字幕\n\n格式要求：\n[时间戳]日文原文${DELIMITER}中文翻译\n\n注意事项：\n1. 日文原文保持原样\n2. 分隔符"${DELIMITER}"两侧不要有任何空格\n3. 尽可能做到直译，不要意译，保持原文的风格和表达方式\n\n示例：\n[00:20.00]こんにちは${DELIMITER}你好\n[00:24.40]元気ですか？${DELIMITER}你好吗？\n[00:28.15]ありがとう${DELIMITER}谢谢`,
        sttLanguageCode: 'ja-JP'
    }
];

/**
 * 根据模型名称判断 API 提供商
 */
export function getApiProvider(modelName: string): ApiProvider {
    const lowerModel = modelName.toLowerCase();
    if (lowerModel.includes('claude')) return 'claude';
    if (lowerModel.includes('/') ||
        lowerModel.includes('google') ||
        lowerModel.includes('gemini') ||
        lowerModel.includes('mistral') ||
        lowerModel.includes('gpt-oss') ||
        lowerModel.includes('llama')) {
        return 'openrouter';
    }
    return 'openai';
}

export function getConfig(): SubtitleConfig {
    const rootDir = process.env.ROOT_DIR || '';
    const syncDir = process.env.SYNC_DIR || '';
    const currentModel = process.env.CURRENT_MODEL || 'gpt-4o-mini';
    const openaiApiKey = process.env.OPENAI_API_KEY || '';
    const openaiApiUrl = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
    const claudeApiKey = process.env.CLAUDE_API_KEY || '';
    const claudeApiUrl = process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages';
    const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
    const openRouterApiUrl = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';

    // STT 配置
    const enableGoogleStt = process.env.ENABLE_GOOGLE_STT === 'true';
    const gcsBucketName = process.env.GCS_BUCKET_NAME || '';

    if (!rootDir) throw new Error('请在 .env 文件中设置 ROOT_DIR（音频根目录路径）');

    const provider = getApiProvider(currentModel);
    if (provider === 'openai' && !openaiApiKey) throw new Error(`当前模型 ${currentModel} 需要 OPENAI_API_KEY`);
    if (provider === 'claude' && !claudeApiKey) throw new Error(`当前模型 ${currentModel} 需要 CLAUDE_API_KEY`);
    if (provider === 'openrouter' && !openRouterApiKey) throw new Error(`当前模型 ${currentModel} 需要 OPENROUTER_API_KEY`);

    if (enableGoogleStt && !gcsBucketName) throw new Error('开启了 STT 功能，但未在 .env 中配置 GCS_BUCKET_NAME');

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
        openRouterApiUrl,
        enableGoogleStt,
        gcsBucketName
    };
}

export function getLanguageConfigFromPath(filePath: string): { config: LanguageConfig; languageRoot: string } | null {
    const normalizedPath = filePath.replace(/\\/g, '/');
    for (const langConfig of LANGUAGE_CONFIGS) {
        const pattern = new RegExp(`(.*[/])?(${langConfig.folderName})(/|$)`);
        const match = normalizedPath.match(pattern);
        if (match) {
            const prefix = match[1] || '';
            const languageRoot = path.join(prefix, langConfig.folderName).replace(/\/$/, '');
            return { config: langConfig, languageRoot: languageRoot };
        }
    }
    return null;
}

export function getRelativePathFromLanguageRoot(filePath: string, languageRoot: string): string {
    return path.relative(path.normalize(languageRoot), path.normalize(filePath));
}