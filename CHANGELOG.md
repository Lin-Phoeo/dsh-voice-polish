# Changelog · dsh-voice-polish

本插件 fork 自 [dsh-voice-scribe](https://www.npmjs.com/package/dsh-voice-scribe) by PensiveFei。

## [0.2.2] — 2026-11-02（架构清理）

### 优化
- **apply 函数重写**：累积 patch 导致 try/catch 嵌套乱但侥幸通过语法；重写成「buttons 循环挂载 + settings 独立 try」的清晰结构
- **effect label 统一**：全部改成 `dsh-voice-polish:*`（原部分还是 `dsh-voice-scribe:*`）
- **删 ASR 残留 export**：TRANSCRIBE_TIMEOUT_MS、MAX_ASR_RESPONSE_BYTES、normalizeLanguageCode（本插件不录音）
- 保证运行时行为完全一致，向后兼容

## [0.2.1] — 2026-11-02

### 新增 - 吸收 OpenWhispr 翻译模式
- **🌐 翻译按钮**：输入框第 3 个按钮（order 36.5），EN/ZH/JA/KO
  - 点击 = 翻译到当前目标语言
  - Shift + 点击 = 循环切换目标语言
- 独立 `translate` action、独立 `DEFAULT_TRANSLATE_PROMPT`、独立 `<text_to_translate>` XML 隔离

### 清理
- 卸载 OpenWhispr 本体（160 MB 用户数据、271 MB ow-src 解压、安装目录、注册表、CLI 包全清）

## [0.2.0] — 2026-11-02

深度优化版，吸收了 Wispr Flow / OpenWhispr / SayIt / Superwhisper 的最佳实践。

### 新增
- **XML 身份隔离**：所有用户输入强制包进 `<text_to_clean>...</text_to_clean>`，防止 Kiro 类强身份 AI 模型把文本误当对话指令
- **⚡ 清理强度 3 档**（轻/标/深）：输入框工具栏点一下循环切换（启发：Wispr Flow Auto Cleanup）
- **Undo 还原**：Alt + 点整理按钮 15 秒内还原（启发：Wispr Flow Undo AI edit）
- **Shift + 点加热词**：输入框快速加一条，不离开当前窗口
- **Ctrl + 点跳过 AI**：纯本地热词+Snippets 替换，离线免费
- **🕐 整理历史**：输入框下拉查看最近 10 条，一键复用
- **🧪 测试整理**：粘贴看效果，不写回输入框
- **📝 语气预设**：口语保留 / 正式商务 / 技术文档 / 精简纪要 / 🎯 智能纠错
- **📋 热词替换表**：面板直接编辑 textarea
- **⚡ Snippets 短语扩展**：触发词→完整内容（OpenWhispr 风格）
- **📊 使用洞察**：今日次数 / 累计 / 净删字数 / 平均耗时
- **🔧 自检**：一键测试宿主路由 / provider / 热词 / 模型调用

### 修复
- **热词断链**：polish 流程前置 `applyHotwordsBounded`
- **自定义 prompt 丢保护**：`resolvePolishPrompt` 强制前置 XML_GUARD_HEADER
- **Ctrl+点死调用**：删 `provider: __noop__` 预热请求

### 架构变更
- fork id：`dsh-voice-scribe` → `dsh-voice-polish`
- locale 命名空间：`settings.voiceScribe` → `settings.voicePolish`
- 卸载 Alt 单键录音
- 新宿主 action: `add-hotword` / `get-hotwords` / `save-hotwords` / `get-snippets` / `save-snippets`

### 已知限制
- Kiro 身份 guard 要求 XML 包裹才能稳定压住；GPT/Claude 原生直通
- claude-haiku-4.5 技术类输入仍可能泄露身份，推荐 opus-4.7 或 glm-5

---

## [0.1.0] — 2026-11-01（内部版）
初次 fork + 添加 PolishButton，供 lead 自测
