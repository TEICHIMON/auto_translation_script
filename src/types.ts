export interface LRCLine {
    timestamp: string;
    text: string;
}

export interface SubtitleConfig {
    rootDir: string;
    languageFolders: LanguageConfig[];
    syncDir: string;
    // 翻译模型配置
    currentModel: string;
    translationProvider: ApiProvider;
    openaiApiKey: string;
    openaiApiUrl: string;
    claudeApiKey: string;
    claudeApiUrl: string;
    openRouterApiKey: string;
    openRouterApiUrl: string;
    deepSeekApiKey: string;
    deepSeekApiUrl: string;
    // Whisper STT 配置
    enableWhisperStt: boolean;
    whisperServerUrl: string;
    whisperModel: string;
    whisperAutoRelease: boolean;
}

export interface LanguageConfig {
    folderName: string;
    sourceLanguage: string;
    targetLanguage: string;
    translationPrompt: string;
    sttLanguageCode: string; // Whisper: 'en' / 'ja'
}

export interface TranslationRequest {
    content: string;
    prompt: string;
}

export interface TranslationResponse {
    translatedContent: string;
}

export type ApiProvider = 'openai' | 'claude' | 'openrouter' | 'deepseek';
