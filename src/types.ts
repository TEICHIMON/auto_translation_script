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
    translationChunkLines: number;
    translationMaxTokens: number;
    // Whisper STT 配置
    enableWhisperStt: boolean;
    whisperServerUrl: string;
    whisperModel: string;
    whisperAutoRelease: boolean;
    // LRC 分句配置
    lrcSegmentationMode: LrcSegmentationMode;
    lrcSegmentationModel: string;
    lrcSegmentationChunkWords: number;
    lrcSegmentationThinking: boolean;   // NEW
    lrcSegmentationCritique: boolean;   // NEW
    maxConcurrentTasks: number;
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

export type LrcSegmentationMode = 'heuristic' | 'llm' | 'manual';

export interface WhisperWord {
    start: number;
    end: number;
    word: string;
}

export interface WhisperSegment {
    start: number;
    end: number;
    text: string;
    words?: WhisperWord[];
}

export interface WhisperTranscriptionResult {
    lrc: string;
    duration: number;
    lang?: string;
    model_key?: string;
    segments?: WhisperSegment[];
}
