export interface LRCLine {
    timestamp: string;
    text: string;
}

export interface SubtitleConfig {
    rootDir: string;
    languageFolders: LanguageConfig[];
    syncDir: string;
    // 统一的模型配置
    currentModel: string;
    // 各 API 配置
    openaiApiKey: string;
    openaiApiUrl: string;
    claudeApiKey: string;
    claudeApiUrl: string;
    openRouterApiKey: string;
    openRouterApiUrl: string;
    // 新增：Google STT 配置
    enableGoogleStt: boolean;
    gcsBucketName: string;
}

export interface LanguageConfig {
    folderName: string;
    sourceLanguage: string;
    targetLanguage: string;
    translationPrompt: string;
    sttLanguageCode: string; // 新增：Google STT 的语言代码
}

export interface TranslationRequest {
    content: string;
    prompt: string;
}

export interface TranslationResponse {
    translatedContent: string;
}

// API 类型枚举
export type ApiProvider = 'openai' | 'claude' | 'openrouter';