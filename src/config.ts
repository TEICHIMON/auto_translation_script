import dotenv from 'dotenv';
import path from 'path';
import { SubtitleConfig, LanguageConfig, ApiProvider, LrcSegmentationMode } from './types';

dotenv.config();

export const DELIMITER = '|||';

const LANGUAGE_CONFIGS: LanguageConfig[] = [
    {
        folderName: 'English',
        sourceLanguage: 'English',
        targetLanguage: 'Chinese',
        translationPrompt: `请为这个字幕添加中文翻译,生成lrc格式的英中字幕\n\n格式要求:\n[时间戳]英文原文${DELIMITER}中文翻译\n\n注意事项:\n1. 英文原文保持原样,包括单词之间的空格\n2. 分隔符"${DELIMITER}"两侧不要有任何空格\n3. 尽可能做到直译,不要意译,保持原文的风格和表达方式\n\n示例:\n[00:20.00]Hello world${DELIMITER}你好世界\n[00:24.40]How are you?${DELIMITER}你好吗?\n[00:28.15]I'm fine, thank you${DELIMITER}我很好,谢谢`,
        sttLanguageCode: 'en'
    },
    {
        folderName: 'Japanese',
        sourceLanguage: 'Japanese',
        targetLanguage: 'Chinese',
        translationPrompt: `请为这个字幕添加中文翻译,生成lrc格式的日中字幕\n\n格式要求:\n[时间戳]日文原文${DELIMITER}中文翻译\n\n注意事项:\n1. 日文原文保持原样\n2. 分隔符"${DELIMITER}"两侧不要有任何空格\n3. 尽可能做到直译,不要意译,保持原文的风格和表达方式\n\n示例:\n[00:20.00]こんにちは${DELIMITER}你好\n[00:24.40]元気ですか?${DELIMITER}你好吗?\n[00:28.15]ありがとう${DELIMITER}谢谢`,
        sttLanguageCode: 'ja'
    }
];

function parseApiProvider(providerName: string): ApiProvider {
    const normalized = providerName.trim().toLowerCase();
    if (
        normalized === 'openai' ||
        normalized === 'claude' ||
        normalized === 'openrouter' ||
        normalized === 'deepseek'
    ) {
        return normalized;
    }
    throw new Error(`不支持的 TRANSLATION_PROVIDER: ${providerName}`);
}

function parseLrcSegmentationMode(modeName: string): LrcSegmentationMode {
    const normalized = modeName.trim().toLowerCase();
    if (normalized === 'heuristic' || normalized === 'llm') {
        return normalized;
    }
    throw new Error(`不支持的 LRC_SEGMENTATION_MODE: ${modeName}`);
}

function parsePositiveIntEnv(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (!raw || !raw.trim()) return defaultValue;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} 必须是正整数`);
    }

    return parsed;
}

export function getApiProvider(modelName: string): ApiProvider {
    const lowerModel = modelName.toLowerCase();
    if (lowerModel.includes('deepseek')) return 'deepseek';
    if (lowerModel.includes('claude')) return 'claude';
    if (
        lowerModel.includes('/') ||
        lowerModel.includes('google') ||
        lowerModel.includes('gemini') ||
        lowerModel.includes('mistral') ||
        lowerModel.includes('gpt-oss') ||
        lowerModel.includes('llama')
    ) {
        return 'openrouter';
    }
    return 'openai';
}

export function getConfig(): SubtitleConfig {
    const rootDir = process.env.ROOT_DIR || '';
    const syncDir = process.env.SYNC_DIR || '';
    const translationProviderEnv = process.env.TRANSLATION_PROVIDER || '';
    const currentModel = process.env.CURRENT_MODEL || 'gpt-4o-mini';
    const openaiApiKey = process.env.OPENAI_API_KEY || '';
    const openaiApiUrl = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
    const claudeApiKey = process.env.CLAUDE_API_KEY || '';
    const claudeApiUrl = process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages';
    const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
    const openRouterApiUrl =
        process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
    const deepSeekApiKey = process.env.DEEPSEEK_API_KEY || '';
    const deepSeekApiUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

    // Whisper STT 配置
    const enableWhisperStt = (process.env.ENABLE_WHISPER_STT || 'true').toLowerCase() === 'true';
    const whisperServerUrl = process.env.WHISPER_SERVER_URL || '';
    const whisperModel = process.env.WHISPER_MODEL || 'default';
    const whisperAutoRelease = (process.env.WHISPER_AUTO_RELEASE || 'true').toLowerCase() === 'true';

    // LRC 分句配置。heuristic=使用服务端规则; llm=用 DeepSeek 基于 word timestamps 重切 LRC。
    const lrcSegmentationMode = parseLrcSegmentationMode(
        process.env.LRC_SEGMENTATION_MODE || 'heuristic'
    );
    const lrcSegmentationModel = process.env.LRC_SEGMENTATION_MODEL || 'deepseek-v4-flash';
    const lrcSegmentationChunkWords = Math.min(
        Math.max(parsePositiveIntEnv('LRC_SEGMENTATION_CHUNK_WORDS', 5000), 200),
        8000
    );
    const lrcSegmentationThinking = parseBoolEnv('LRC_SEGMENTATION_THINKING', true);
    const lrcSegmentationCritique = parseBoolEnv('LRC_SEGMENTATION_CRITIQUE', true);

    if (!rootDir) throw new Error('请在 .env 文件中设置 ROOT_DIR(音频根目录路径)');

    const provider = translationProviderEnv
        ? parseApiProvider(translationProviderEnv)
        : getApiProvider(currentModel);
    if (provider === 'openai' && !openaiApiKey)
        throw new Error(`当前模型 ${currentModel} 需要 OPENAI_API_KEY`);
    if (provider === 'claude' && !claudeApiKey)
        throw new Error(`当前模型 ${currentModel} 需要 CLAUDE_API_KEY`);
    if (provider === 'openrouter' && !openRouterApiKey)
        throw new Error(`当前模型 ${currentModel} 需要 OPENROUTER_API_KEY`);
    if (provider === 'deepseek' && !deepSeekApiKey)
        throw new Error(`当前模型 ${currentModel} 需要 DEEPSEEK_API_KEY`);
    if (lrcSegmentationMode === 'llm' && !deepSeekApiKey)
        throw new Error('LRC_SEGMENTATION_MODE=llm 需要 DEEPSEEK_API_KEY');

    if (enableWhisperStt && !whisperServerUrl) {
        throw new Error('开启了 Whisper STT,但未在 .env 中配置 WHISPER_SERVER_URL');
    }


    return {
        rootDir,
        languageFolders: LANGUAGE_CONFIGS,
        syncDir,
        currentModel,
        translationProvider: provider,
        openaiApiKey,
        openaiApiUrl,
        claudeApiKey,
        claudeApiUrl,
        openRouterApiKey,
        openRouterApiUrl,
        deepSeekApiKey,
        deepSeekApiUrl,
        enableWhisperStt,
        whisperServerUrl,
        whisperModel,
        whisperAutoRelease,
        lrcSegmentationMode,
        lrcSegmentationModel,
        lrcSegmentationChunkWords,
        lrcSegmentationThinking,    // NEW
        lrcSegmentationCritique,    // NEW
    };
}

export function getLanguageConfigFromPath(
    filePath: string
): { config: LanguageConfig; languageRoot: string } | null {
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

// 1. Add this small helper near the top, alongside parsePositiveIntEnv:

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return defaultValue;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    throw new Error(`${name} 必须是 true/false`);
}
