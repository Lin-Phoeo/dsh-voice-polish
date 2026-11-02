# dsh-voice-polish

**DSH 输入框 AI 整理 + 润色按钮**。配合 Windows 自带 **Win+H** 语音输入，把口语变通顺文本；需要时再一键扩展为结构化 AI 提示词。

- **✦ 整理**：清口语、补标点、修同音错字（走热词 + Snippets + LLM 三层）
- **✨ 润色**：把整理后的描述扩展为给下游 AI 的完整提示词（独立函数，不绑死）
- 完全脱耦：热词、Snippets、提示词、模型全在设置里改，不改代码

Fork 自 [dsh-voice-scribe](https://www.npmjs.com/package/dsh-voice-scribe)，专注"后处理"：不录音、不装 ASR 模型，分发包 ~85 KB。

---

## 快速开始

**1. 安装**

```bash
# 如装过 voice-scribe 要先卸（它会抢 /voice-input 路由）
dsh plugin --profile desktop remove dsh-voice-scribe

dsh plugin --profile desktop add file:<路径>/dsh-voice-polish-0.2.0.tgz
```

重启 DSH 或插件市场点刷新。

**2. 配一次模型**

**设置 → AI 整理（语音/文本） → 润色模型**，推荐（实测）：

| provider | model | 评级 | 耗时 | 备注 |
|---|---|---|---|---|
| kiro | **claude-opus-4.7** | ★★★★★ | 3s | 质量最高，首选 |
| kiro | **glm-5** | ★★★★★ | 3s | 中文首选，最快最保守 |
| kiro | claude-sonnet-4.5 | ★★★★ | 10s | 稳但慢 |
| kiro | deepseek-3.2 | ★★★ | 5s | 偶尔过度精简 |
| ⛔ kiro | claude-haiku-4.5 | — | 5s | 技术类输入会泄露身份 |
| openai | gpt-4o-mini | — | — | 备选，未实测 |
| 任意 | OpenAI 兼容接口 | — | — | 填 base_url + key 即可 |

> 5 组用例 × 5 模型实测，详见 `CHANGELOG` v0.2.0。

**3. 用**

```
按 Win+H → 说话 → 文字进输入框
→ 点 ✦ 整理 → 变通顺（2-10s）
→ 需要扩展成完整 AI 提示词时再按 ✨ 润色
```

---

## 输入框按钮（5 个）

| 按钮 | 行为 |
|---|---|
| **⚡ 轻/标/深** | 清理强度切换（循环点击） |
| **✦ 整理** | AI 整理（热词 + Snippets + LLM） |
| **🌐 EN/ZH/JA/KO** | AI 翻译（Shift+点循环切目标语言） |
| **✨ 润色** | 把草稿扩展为完整 AI 提示词（独立 action） |
| **🕐 N** | 下拉查看最近 10 条历史 |

**✦ 整理** 4 种点击组合：

| 组合 | 行为 |
|---|---|
| 点击 | AI 整理 |
| Ctrl + 点击 | 仅本地热词 + Snippets（跳过 LLM，离线免费） |
| Alt + 点击 | 还原到整理前（15 秒内） |
| Shift + 点击 | 弹输入框快速加一条热词 |

**整理** 与 **润色** 是独立的两个 action（`polish` 和 `enhance`），用不同的 system prompt，不想润色就不碰 ✨。

---

## 设置面板（8 区块）

**设置 → AI 整理（语音/文本）**：

| # | 区块 | 用途 |
|---|---|---|
| ① | 润色模型 | 下拉选 DSH 已配 provider + model |
| ② | 润色提示词 | 留空用默认（含 XML 守护 + 4 条 few-shot） |
| ③ | 🧪 测试整理 | 粘贴看效果，不写回输入框 |
| ④ | 📝 语气预设 | 口语保留 / 正式商务 / 技术文档 / 精简纪要 / 🎯 智能纠错 |
| ⑤ | 📋 热词替换表 | textarea 编辑 `hot.txt`，保存立即生效 |
| ⑥ | ⚡ Snippets | 触发词→完整内容 |
| ⑦ | 📊 使用洞察 | 今日 / 累计 / 净删字数 / 平均耗时 |
| ⑧ | 🔧 自检 | 一键测宿主/provider/热词/模型调用 |

**润色（✨）** 用独立的 `enhance` system prompt，不占 ② 的槽位。

---

## 热词 & Snippets 文件

| 文件 | 作用 | 位置 |
|---|---|---|
| `hot.txt` | 热词替换（音近错字→正确词） | `~/.dsh/voice/hot.txt` |
| `snippets.txt` | 短语扩展（触发词→完整内容） | `~/.dsh/voice/snippets.txt` |

格式 `左=右`，每行一条，`#` 注释。文件直接改或面板里改（保存同步到文件）。

---

## 整理流程

```
用户输入
  ↓
① hot.txt 热词替换
  ↓
② snippets.txt 短语扩展
  ↓
③ localPolish 删基础填充词（嗯/啊/呃）
  ↓
④ XML 包裹 <text_to_clean>
  ↓
⑤ LLM 清理（system = XML 守护 + 默认规则 + 强度指令）
  ↓
⑥ 剥 XML 标签
  ↓
⑦ setDraft 写回 + 存 history + 更新 stats
```

**润色（✨）** 不经过 ①②③，直接 ④⑤⑥⑦，system 换成 `DEFAULT_ENHANCE_PROMPT`，标签换 `<text_to_enhance>`。

**翻译（🌐）** 走独立 `translate` action，`system` 为 `DEFAULT_TRANSLATE_PROMPT` + 目标语言，标签 `<text_to_translate>`。目标语言在 localStorage 持久化，支持 EN/ZH/JA/KO。

---

## 三条独立流水线对比

| 按钮 | action | system prompt | XML 标签 | 用途 |
|---|---|---|---|---|
| ✦ 整理 | `polish` | `DEFAULT_POLISH_PROMPT` + 强度指令 | `<text_to_clean>` | 清口语变通顺 |
| 🌐 翻译 | `translate` | `DEFAULT_TRANSLATE_PROMPT` + 目标语言 | `<text_to_translate>` | 翻译 |
| ✨ 润色 | `enhance` | `DEFAULT_ENHANCE_PROMPT` | `<text_to_enhance>` | 扩展为 AI 提示词 |

三条互不干扰，想用哪条点哪个按钮，输出都会存进 🕐 历史。

---

## 完全脱耦

| 层 | 配置来源 | 分发时携带吗 |
|---|---|---|
| 模型 | 用户在 DSH 里选 | 否 |
| 提示词 | 用户自定义或内置默认 | 默认完全通用 |
| 热词 | `~/.dsh/voice/hot.txt` | 空文件 |
| Snippets | `~/.dsh/voice/snippets.txt` | 空文件 |
| 示例 | 内置通用（React/Vue/app.py） | 无私有词 |

**插件本身没有业务数据**，装谁家都即装即用。

---

## 排错

| 现象 | 原因 | 修法 |
|---|---|---|
| 按钮红色「请选模型」 | 没配 provider | 设置 → 润色模型 选一个 |
| 按钮灰 | 输入框空 | 先说/打字 |
| 显示"失败" | 模型超时或 key 失效 | F12 看 `[voice-polish]` log，或 🔧 自检 |
| 整理结果说 "I'm Kiro..." | 用了 claude-haiku-4.5 | 换 opus-4.7 或 glm-5 |
| 整理结果不如意 | 默认提示词不符场景 | 「语气预设」挑一个，或自写 |
| 专有名词被改错 | 没加热词 | Shift+点按钮，或面板编辑 |

调试日志：

```
[voice-polish] 整理: { len: 42, provider: "kiro", model: "claude-opus-4.7", intensity: "standard" }
[voice-polish] 结果: { changed: true, outLen: 38, ms: 3012 }
```

---

## 性能与资源

- 分发包：**~85 KB** gzipped tgz
- 运行时：客户端 bundle ~180 KB，宿主 ~70 KB
- 热词走 worker 线程不阻塞；LLM 流式返回
- Ctrl+点可完全离线整理（不花 token）

---

## 架构

```
┌─ 浏览器端 (lib/client.js, 177 KB) ────────────────┐
│  ⚡ IntensityButton   order 34                     │
│  ✦ PolishButton      order 35                     │
│  🌐 TranslateButton   order 36.5                   │
│  ✨ EnrichButton      order 36                     │
│  🕐 HistoryButton    order 37                     │
│                                                   │
│  ⚙️  PolishLabRow（settings.voicePolish.item）    │
└───────────────────────────────────────────────────┘
                  │ fetch /voice-input
                  ▼
┌─ 宿主端 (lib/index.js, 22 KB) ─────────────────┐
│  POST /voice-input                             │
│  ├─ polish          热词 + Snippets + XML + LLM│
│  ├─ enhance         扩展为完整 AI 提示词        │
│  ├─ translate       翻译到目标语言 EN/ZH/JA/KO │
│  ├─ get/save-hotwords                          │
│  ├─ get/save-snippets                          │
│  ├─ add-hotword                                │
│  ├─ get/set-settings                           │
│  └─ list-models                                │
└───────────────────────────────────────────────────┘

辅助：host-utils.js (~41 KB) · hotword-worker.js (<1 KB)
```

---

## 分发给别人

发 `dsh-voice-polish-0.2.0.tgz` 给对方：

```bash
dsh plugin --profile desktop remove dsh-voice-scribe   # 如装过
dsh plugin --profile desktop add file:<他的路径>/dsh-voice-polish-0.2.0.tgz
```

重启 DSH。对方只要配一个 OpenAI 兼容 provider 就能用。

---

## 维护者笔记

- `jsx(type, props, key)` 第三参是 key 不是 children
- DSH 向子进程注入 `[::1]` NO_PROXY，用本地网关要在 Python 内覆盖
- locale 用 `settings.voicePolish`，不要与 voice-scribe 共存
- 路由 `/voice-input` 不能和 voice-scribe 共存
- Kiro 类模型身份 guard 强，必须 XML + 显式否认
- 自定义 prompt 不含 `text_to_clean` 时，`resolvePolishPrompt` 自动前置 XML_GUARD_HEADER
- 热词在 polish 流程前置应用（原 fork 只在 transcribe 路径用）

---

MIT. Based on dsh-voice-scribe by PensiveFei.
