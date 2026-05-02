# 字幕自动翻译工具

自动化处理音频字幕：SRT → 单语 LRC → 双语 LRC (原文-译文格式)

## 功能特点

- ✅ 自动将 SRT 字幕转换为 LRC 格式
- ✅ 支持分步处理：先转换单语 LRC，再翻译为双语
- ✅ 调用 OpenAI API 进行翻译
- ✅ 支持英文→中文、日文→中文
- ✅ 多种工作模式：手动批处理 / 自动监控 / 单独翻译 / 仅转换
- ✅ 输出格式：`[时间戳]原文|||译文`（无空格）
- ✅ 自动同步：翻译完成后可自动复制音频+字幕到指定文件夹

## 工作流程

```
MacWhisper (监控文件夹) → 生成 SRT 文件
    ↓
本工具自动检测 → SRT 转单语 LRC → 保存单语 LRC
    ↓
AI 翻译 → 保存双语 LRC (在 output 文件夹)
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
TRANSLATION_PROVIDER=openai
CURRENT_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-proj-your-api-key-here

# 可选：自动同步到手机文件夹
SYNC_DIR=/Users/你的用户名/手机同步
```

### 3. 文件夹结构

```
/Users/你的用户名/音频处理/
  ├── English/
  │   ├── audio1.mp3
  │   ├── audio1.srt      # MacWhisper 自动生成
  │   ├── audio1.lrc      # 本工具生成（单语 LRC）
  │   └── output/
  │       └── audio1.lrc  # 本工具生成（双语 LRC）
  │
  └── Japanese/
      ├── audio2.mp3
      ├── audio2.srt
      ├── audio2.lrc      # 单语
      └── output/
          └── audio2.lrc  # 双语
```

## 使用方法

### 方式 A：手动批处理模式（SRT → 单语 → 双语）

处理所有现有的 SRT 文件，完整流程：

```bash
# 开发模式（无需编译）
npm run dev

# 或者编译后运行
npm run build
npm start
```

**流程说明：**
1. 扫描所有 `.srt` 文件
2. 转换为单语 LRC（如果不存在）
3. 翻译为双语 LRC（如果不存在）
4. 自动同步（如果配置了 SYNC_DIR）

### 方式 B：自动监控模式（SRT → 单语 → 双语）

持续监控文件夹，自动处理新出现的 SRT 文件：

```bash
# 开发模式
npm run dev:watch

# 或者编译后运行
npm run build
npm run watch
```

按 `Ctrl+C` 停止监控。

### 方式 C：单独翻译模式（单语 LRC → 双语 LRC）

翻译已有的单语 LRC 文件：

```bash
# 开发模式
npm run dev:translate

# 或者编译后运行
npm run build
npm run translate
```

**此模式会：**
- 扫描所有 `.lrc` 文件（排除 output 文件夹）
- 检查 `output/` 下是否已存在双语 LRC
- 如果不存在 → 翻译 → 保存到 `output/`

### 方式 D：仅转换模式（SRT → 单语 LRC）⭐ 新增

只转换 SRT 为单语 LRC，**不进行翻译**：

```bash
# 开发模式
npm run dev:convert

# 或者编译后运行
npm run build
npm run convert
```

**此模式会：**
- 扫描所有 `.srt` 文件
- 转换为单语 LRC
- 保存到与 SRT 同级目录
- **跳过翻译步骤**

**使用场景：**
- 批量转换格式，之后手动校对
- 仅需要单语字幕
- 分步处理：先转换，稍后翻译

## 输出格式

### 单语 LRC（与 SRT 同级）
```
English/audio1.lrc
```

文件内容：
```
[00:20.00]Hello world
[00:24.40]How are you?
[00:28.15]I'm fine, thank you
```

### 双语 LRC（在 output 文件夹）
```
English/output/audio1.lrc
```

文件内容：
```
[00:20.00]Hello world|||你好世界
[00:24.40]How are you?|||你好吗？
[00:28.15]I'm fine, thank you|||我很好，谢谢
```

## 智能跳过逻辑

### 整体流程模式（A、B）
1. 检查 `output/audio1.lrc`（双语）是否存在 → 存在则**跳过整个流程**
2. 检查 `audio1.lrc`（单语）是否存在 → 存在则**跳过转换，直接翻译**
3. 否则 → 转换 SRT → 保存单语 → 翻译 → 保存双语

### 单独翻译模式（C）
- 检查 `output/audio1.lrc` 是否存在 → 存在则**跳过**
- 否则 → 翻译单语 LRC → 保存双语 LRC

### 仅转换模式（D）
- 检查 `audio1.lrc` 是否存在 → 存在则**跳过**
- 否则 → 转换 SRT → 保存单语 LRC

## 自定义配置

### 添加新语言

编辑 `src/config.ts`，在 `LANGUAGE_CONFIGS` 数组中添加：

```typescript
{
  folderName: '韩文',
  sourceLanguage: 'Korean',
  targetLanguage: 'Chinese',
  translationPrompt: `请为这个字幕添加中文翻译，生成lrc格式的韩中字幕

格式要求：
[时间戳]韩文原文|||中文翻译

注意事项：
1. 韩文原文保持原样
2. 分隔符"|||"两侧不要有任何空格
3. 如果原文有错误，可以修正使其通顺、符合上下文

示例：
[00:20.00]안녕하세요|||你好
[00:24.40]잘 지내세요?|||你好吗？`
}
```

### 修改翻译 Prompt

编辑 `src/config.ts` 中对应语言的 `translationPrompt`。

**重要：** 确保 prompt 中明确说明：
- ✅ 保留原文中的空格和标点
- ✅ 分隔符"|||"两侧不要空格
- ✅ 提供示例格式

### 更换翻译供应商和模型

在 `.env` 文件中修改 `TRANSLATION_PROVIDER` 和 `CURRENT_MODEL`：

```env
# OpenAI
TRANSLATION_PROVIDER=openai
CURRENT_MODEL=gpt-4o-mini

# Claude
TRANSLATION_PROVIDER=claude
CURRENT_MODEL=claude-3-5-sonnet-latest

# OpenRouter
TRANSLATION_PROVIDER=openrouter
CURRENT_MODEL=openai/gpt-4o-mini

# DeepSeek
TRANSLATION_PROVIDER=deepseek
CURRENT_MODEL=deepseek-v4-flash
```

### Whisper 与 LRC 分句

无本地 SRT 时可启用 Whisper 服务器兜底转录；`server_general_lrc.py` 默认对英文、日文都使用 `large-v3`。

```env
ENABLE_WHISPER_STT=true
WHISPER_SERVER_URL=http://192.168.31.50:8000
WHISPER_MODEL=default

# 使用 DeepSeek 根据 word timestamps 重新分句
LRC_SEGMENTATION_MODE=llm
LRC_SEGMENTATION_MODEL=deepseek-v4-flash
LRC_SEGMENTATION_CHUNK_WORDS=900
```

## 故障排除

### 1. API 调用失败

检查：
- OpenAI API Key 是否正确
- 账户余额是否充足
- 网络连接是否正常

### 2. 文件未被处理

检查：
- 文件夹名称是否正确（`English` 或 `Japanese`）
- SRT 文件是否在正确的文件夹中
- 监控模式下，文件是否在程序启动后才添加的

### 3. 转换后内容为空

检查：
- SRT 文件格式是否正确
- 文件编码是否为 UTF-8

### 4. 英文单词之间空格被删除

检查 `src/config.ts` 中的 `translationPrompt`：
- ❌ 错误：说"不要有空格"（太笼统）
- ✅ 正确：说"分隔符两侧不要空格，但保留原文中的空格"

## 开发说明

### 项目结构

```
src/
├── index.ts          # 手动模式入口（SRT → 单语 → 双语）
├── watcher.ts        # 监控模式入口（SRT → 单语 → 双语）
├── translate-lrc.ts  # 翻译模式（单语 → 双语）
├── convert-only.ts   # 转换模式（SRT → 单语）⭐ 新增
├── sync-only.ts      # 仅同步模式
├── converter.ts      # SRT → LRC 转换逻辑
├── whisper-stt.ts    # Whisper 服务器客户端
├── lrc-segmenter.ts  # DeepSeek word timestamp 分句
├── translator.ts     # OpenAI API 调用
├── sync.ts           # 文件同步逻辑
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
