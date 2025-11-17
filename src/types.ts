export interface LRCLine {
    timestamp: string;
    text: string;
}

export interface SubtitleConfig {
    rootDir: string;
    languageFolders: LanguageConfig[];
    openRouterApiKey: string;
    openRouterModel: string;
    syncDir: string;
}

export interface LanguageConfig {
    folderName: string;
    sourceLanguage: string;
    targetLanguage: string;
    translationPrompt: string;
}

export interface TranslationRequest {
    content: string;
    prompt: string;
}

export interface TranslationResponse {
    translatedContent: string;
}