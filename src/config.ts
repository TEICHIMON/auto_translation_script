import dotenv from 'dotenv';
import path from 'path';
import { SubtitleConfig, LanguageConfig } from './types';

dotenv.config();

// 语言配置
const LANGUAGE_CONFIGS: LanguageConfig[] = [
    {
        folderName: 'English',
        sourceLanguage: 'English',
        targetLanguage: 'Chinese',
        translationPrompt: `请为这个字幕添加中文翻译，生成lrc格式的英中字幕
格式为
时间戳 英-中
要求：严格按照格式要求 不要有空格 同时如果觉得字幕有拼写或者内容错误，可以自行修改，使句子通顺，逻辑正确，符合上下文内容。`
    },
    {
        folderName: 'Japanese',
        sourceLanguage: 'Japanese',
        targetLanguage: 'Chinese',
        translationPrompt: `请为这个字幕添加中文翻译，生成lrc格式的日中字幕
格式为
时间戳 日-中
要求：严格按照格式要求 不要有空格 同时如果觉得日本的字幕有拼写或者内容错误，可以自行修改，使句子通顺，逻辑正确，符合上下文内容。`
    }
];

export function getConfig(): SubtitleConfig {
    const rootDir = process.env.ROOT_DIR || '';
    const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
    const openRouterModel = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
    const syncDir = process.env.SYNC_DIR || '';

    if (!rootDir) {
        throw new Error('请在 .env 文件中设置 ROOT_DIR（音频根目录路径）');
    }

    if (!openRouterApiKey) {
        throw new Error('请在 .env 文件中设置 OPENROUTER_API_KEY');
    }

    return {
        rootDir,
        languageFolders: LANGUAGE_CONFIGS,
        openRouterApiKey,
        openRouterModel,
        syncDir
    };
}

export function getLanguageConfig(folderPath: string): LanguageConfig | null {
    const folderName = path.basename(folderPath);
    return LANGUAGE_CONFIGS.find(config => config.folderName === folderName) || null;
}