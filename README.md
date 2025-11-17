# 字幕自动翻译工具

自动化处理音频字幕：SRT → 双语 LRC (原文-译文格式)

## 功能特点

- ✅ 自动将 SRT 字幕转换为 LRC 格式
- ✅ 调用 OpenRouter API (Gemini 2.5 Pro) 进行翻译
- ✅ 支持英文→中文、日文→中文
- ✅ 两种工作模式：手动批处理 / 自动监控文件夹
- ✅ 输出格式：`[时间戳]原文-译文`（无空格）
- ✅ 自动同步：翻译完成后可自动复制音频+字幕到指定文件夹

## 工作流程

```
MacWhisper (监控文件夹) → 生成 SRT 文件
    ↓
本工具自动检测 → SRT 转 LRC → AI 翻译 → 保存双语 LRC
```

## 安装

### 1. 安装依赖

```bash
cd subtitle-automation
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
ROOT_DIR=/Users/你的用户名/音频处理
OPENROUTER_API_KEY=sk-or-v1-your-actual-api-key
OPENROUTER_MODEL=google/gemini-2.0-flash-exp:free

# 可选：自动同步到手机文件夹
SYNC_DIR=/Users/你的用户名/手机同步
```

**关于 SYNC_DIR**：
- 如果设置了 `SYNC_DIR`，翻译完成后会自动复制音频+字幕到该目录
- 每次同步会在 SYNC_DIR 下创建一个时间戳命名的文件夹（如 `2024-01-15_14-30-25`）
- 留空则不执行自动同步

### 3. 文件夹结构

```
/Users/你的用户名/音频处理/
  ├── 英文/
  │   ├── audio1.mp3
  │   ├── audio1.srt      # MacWhisper 自动生成
  │   └── output/
  │       └── audio1.lrc  # 本工具自动生成（双语）
  │
  └── 日文/
      ├── audio2.mp3
      ├── audio2.srt
      └── output/
          └── audio2.lrc
```

## 使用方法

### 方式 A：手动批处理模式（SRT → 双语LRC）

处理所有现有的 SRT 文件：

```bash
# 开发模式（无需编译）
npm run dev

# 或者编译后运行
npm run build
npm start
```

### 方式 B：自动监控模式（SRT → 双语LRC）

持续监控文件夹，自动处理新出现的 SRT 文件：

```bash
# 开发模式
npm run dev:watch

# 或者编译后运行
npm run build
npm run watch
```

按 `Ctrl+C` 停止监控。

### 方式 C：LRC 直接翻译模式

翻译已有的 LRC 文件（单语 → 双语）：

```bash
# 开发模式
npm run dev:translate

# 或者编译后运行
npm run build
npm run translate
```

此模式会：
- 扫描 ROOT_DIR 下所有 `.lrc` 文件
- 跳过已翻译的文件（`*_translated.lrc`）
- 输出文件名格式：`原文件名_translated.lrc`

## 输出格式

生成的双语 LRC 保存在各语言文件夹的 `output/` 子目录中：

```
英文/output/audio1.lrc
```

文件内容格式：

```
[00:20.00]Hello world-你好世界
[00:24.40]How are you?-你好吗？
[00:28.15]I'm fine, thank you-我很好，谢谢
```

## 自定义配置

### 添加新语言

编辑 `src/config.ts`，在 `LANGUAGE_CONFIGS` 数组中添加：

```typescript
{
  folderName: '韩文',
  sourceLanguage: 'Korean',
  targetLanguage: 'Chinese',
  translationPrompt: `请为这个字幕添加中文翻译，生成lrc格式的韩中字幕
格式为
时间戳 韩-中
要求：严格按照格式要求 不要有空格`
}
```

### 修改翻译 Prompt

编辑 `src/config.ts` 中对应语言的 `translationPrompt`。

### 更换模型

在 `.env` 文件中修改 `OPENROUTER_MODEL`：

```env
# Gemini 免费版
OPENROUTER_MODEL=google/gemini-2.0-flash-exp:free

# Gemini Pro (付费)
OPENROUTER_MODEL=google/gemini-pro-1.5

# Claude 3.5 Sonnet (付费)
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
```

## 故障排除

### 1. API 调用失败

检查：
- OpenRouter API Key 是否正确
- 账户余额是否充足
- 网络连接是否正常

### 2. 文件未被处理

检查：
- 文件夹名称是否正确（`英文` 或 `日文`）
- SRT 文件是否在正确的文件夹中
- 监控模式下，文件是否在程序启动后才添加的

### 3. 转换后内容为空

检查：
- SRT 文件格式是否正确
- 文件编码是否为 UTF-8

## 开发说明

### 项目结构

```
src/
├── index.ts          # 手动模式入口（SRT → 双语LRC）
├── watcher.ts        # 监控模式入口（SRT → 双语LRC）
├── translate-lrc.ts  # LRC 翻译模式（单语LRC → 双语LRC）
├── converter.ts      # SRT → LRC 转换逻辑
├── translator.ts     # OpenRouter API 调用
├── config.ts         # 配置管理
└── types.ts          # TypeScript 类型定义
```

### 编译

```bash
npm run build
```

编译后的文件在 `dist/` 目录中。

## 许可证

MIT

## 自动同步到手机

翻译完成后，可以自动复制音频+字幕到指定文件夹（如 iCloud、Syncthing 等）。

### 快速配置

在 `.env` 中添加：
```env
SYNC_DIR=/Users/你的用户名/手机同步
```

每次同步会创建时间戳命名的文件夹（如 `2024-01-15_14-30-25`），包含音频和字幕。

详细说明请查看：
- **[SYNC_FEATURE.md](./SYNC_FEATURE.md)** - 快速开始
- **[SYNC.md](./SYNC.md)** - 完整文档