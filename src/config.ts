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

export function getConfig(): SubtitleConfig {
    const rootDir = process.env.ROOT_DIR || '';
    const openaiApiKey = process.env.OPENAI_API_KEY || '';
    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
    const openRouterModel = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
    const syncDir = process.env.SYNC_DIR || '';

    if (!rootDir) {
        throw new Error('请在 .env 文件中设置 ROOT_DIR（音频根目录路径）');
    }

    if (!openaiApiKey) {
        throw new Error('请在 .env 文件中设置 OPENAI_API_KEY');
    }

    return {
        rootDir,
        languageFolders: LANGUAGE_CONFIGS,
        openaiApiKey,
        openaiModel,
        openRouterApiKey,
        openRouterModel,
        syncDir
    };
}

export function getLanguageConfig(folderPath: string): LanguageConfig | null {
    const folderName = path.basename(folderPath);
    return LANGUAGE_CONFIGS.find(config => config.folderName === folderName) || null;
}