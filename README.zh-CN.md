<div align="center">

<img src="assets/icon.svg" width="120" alt="Weft logo" />

# Weft

**把分散在各标签页的碎片信息采集起来，一键整合成带引用来源的报告、重写文档、图表与事实核查。**

*一款开源、LLM 原生的 Chrome 扩展，专为研究员、分析师与知识工作者打造。*

[![Chrome 应用商店](https://img.shields.io/badge/Chrome_应用商店-即将上线-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://github.com/wotchin/weft/releases/latest)
[![GitHub Release](https://img.shields.io/github/v/release/wotchin/weft?style=flat-square&logo=github&label=Release&color=blue)](https://github.com/wotchin/weft/releases/latest)
[![CI](https://github.com/wotchin/weft/actions/workflows/ci.yml/badge.svg?branch=main&style=flat-square&logo=githubactions&logoColor=white)](https://github.com/wotchin/weft/actions/workflows/ci.yml)
[![Release](https://github.com/wotchin/weft/actions/workflows/release.yml/badge.svg?style=flat-square&logo=githubactions&logoColor=white)](https://github.com/wotchin/weft/actions/workflows/release.yml)
[![License: GPL-3.0](https://img.shields.io/badge/许可证-GPL--3.0-blue?style=flat-square&logo=gnu&logoColor=white)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Stars](https://img.shields.io/github/stars/wotchin/weft?style=flat-square&logo=github&color=yellow)](https://github.com/wotchin/weft/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/wotchin/weft?style=flat-square&logo=git&logoColor=white)](https://github.com/wotchin/weft/commits/main)

[特性](#-特性) · [工作流](#-核心工作流) · [安装](#-安装) · [服务商](#-支持的服务商) · [文档](#-文档) · [常见问题](#-常见问题)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

> **Weft 绝不悄悄把"当前标签页"当作你的研究主题。**
> 网页只是采集点，由你手工整理的 **Session** 才是研究范围。
> 每一个被合成的论断都能溯源到它出处的原文段落。

Weft 由 [@Wotchin](https://thejackstudio.com) 出于解决一个真实日常痛点而开发：跨大量浏览器标签页采集数据片段又慢、又容易出错、还无法引用。Weft 不仅解决了这个问题，还在上面叠加了一层 LLM 原生的综合分析能力。

## ✨ 特性

### 🎯 天然可溯源
每条合成事实都带引用标记，回到原始片段与来源页面。`[S#]` 指向你保存的原文段落，`[W#]` 指向经过核验的网页检索片段。点击任何标记即可跳转到来源。再也不会有"模型这条是从哪编出来的？"。

### 🧵 Session 优先的研究范式
**Session** 是你整理过的研究范围。你可以基于你**有意保存**的内容提问，再通过 **Deep Search** 扩展，寻找一手资料、反方观点与更新。Weft 从不悄悄把当前标签页提升为研究范围。

### 🤖 自带密钥（BYOK）
兼容 **OpenAI、Anthropic、Gemini、DeepSeek、Moonshot、Qwen、本地 Ollama、任意 OpenAI 兼容端点，或 Chrome 内置的设备端 AI**（无需密钥）。
你的密钥与片段都留在本机——只会发往**你指定**的端点。

### 🔍 人机协同的 Deep Search
Weft 会基于你的问题提出一份**证据缺口搜索方案**——你可以在执行前**审阅或编辑**搜索语句。外部检索片段以 `[W#]` 形式**追加**到你 Session 的 `[S#]` 证据旁，绝不替换。

### 📑 Smart Read —— 经来源校验的抽取
对文章运行 **Smart Read**，可基于关键段落建立一个新的聚焦 Session。每条引文都会在保存前**与渲染后的源文比对**，幻觉证据会被静默丢弃。在链接密集的页面上，先告诉 Weft 你关注什么，它只会筛选出**可见的、相关的**链接。

### 🧩 一键综合场景
单点发布的场景把原始片段变成明确的交付物：
**报告 · 重写 · 核查 · 摘要 · 对比 · 抽取 · 表格 · 翻译 · 图表（Mermaid）**。

### 🏅 私密 · 本地优先
片段存放在 `chrome.storage.local` / IndexedDB。**零遥测、零账号、零第三方追踪，我们自己也不运营任何服务器。** 详见 [`PRIVACY.md`](PRIVACY.md)。

### 🌍 本地化界面 + 多语言回答
界面提供 **English** 与 **简体中文**；AI 回答支持 9+ 种语言。

## 🧭 核心工作流

```mermaid
flowchart LR
    A[1. Smart Read<br/>经核验的抽取] --> B[2. 采集<br/>文本 · 图片 · 链接]
    B --> C[3. 综合<br/>报告 · 重写 · 核查 · 图表]
    C --> D{需要更多<br/>证据？}
    D -- 是 --> E[4. Deep Search<br/>审阅并批准方案]
    E --> C
    D -- 否 --> F[5. 溯源<br/>点击 [S#]/[W#] 跳转来源]
    C --> F
```

1. **阅读** —— 对文章运行 `Smart Read` 建立聚焦 Session；切换 **Show on Page** 在源页面查看已保存的段落。
2. **采集** —— 右键或用选区工具栏，把更多文本/图片/链接片段保存进该 Session。
3. **综合** —— 打开侧边栏 Workbench，向当前 Session 提问，或选择某个场景。
4. **Deep Search** —— 从一个 Session 问题出发，审阅并批准搜索方案，把网页片段补充进来。
5. **溯源** —— 点击任何引用，打开它的原文段落或外部链接。

## 🚀 安装

### 方式 A —— 应用商店（上线后推荐）
即将登陆 Chrome 应用商店。在此之前请用下方开发者构建。

### 方式 B —— 加载已解压的扩展（开发 / 侧载）

1. 从 [Releases](https://github.com/wotchin/weft/releases/latest) 下载最新的 `weft-<version>.zip` 并解压，或克隆本仓库。
2. 打开 `chrome://extensions` → 开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序** → 选择解压目录（或本仓库）。
4. 打开 **Settings** → 选择服务商 → 粘贴密钥（或选 Ollama / Chrome 内置 AI）→ 点击 **Test Connection**。

> 💡 把 Weft 固定到工具栏，然后通过侧边栏打开它（右键图标 → *Open side panel*），即可拥有一个常驻的 Workbench。

## 🔌 支持的服务商

| 服务商 | 是否需要密钥 | 备注 |
|---|---|---|
| OpenAI | ✅ | GPT-4o / o 系列，支持视觉 |
| Anthropic | ✅ | Claude 3.5 Sonnet / Haiku |
| Google Gemini | ✅ | 多模态 |
| DeepSeek | ✅ | 廉价推理 |
| Moonshot（Kimi） | ✅ | 长上下文 |
| Qwen（通义千问） | ✅ | 经 DashScope |
| Ollama | ❌ | 本地、完全离线 |
| OpenAI 兼容 | ✅ | 任何暴露 OpenAI schema 的端点 |
| **Chrome 内置 AI** | ❌ | 设备端推理，不外传任何数据 |

Settings 中已按服务商预填 Base URL 与模型名，可完全覆盖。

## 🛠️ 架构

Weft 有意保持 **原生 JS、Manifest V3、无构建步骤、无框架**。你看到的就是在浏览器里运行的代码。

| 层 | 文件 | 职责 |
|---|---|---|
| UI / Workbench | `chat.js`、`popup.js`、`settings.js`、`onboarding.js` | 侧边栏、弹窗、设置、引导 |
| 渲染 | `markdown.js`、`lib/render.js`、`lib/diagram-generator.js` | Markdown + 引用 + Mermaid 渲染 |
| LLM 层 | `lib/llm-client.js`、`lib/providers.js` | 多服务商对话、JSON 模式、流式 |
| 检索 | `lib/rag-engine.js`、`lib/rag-indexer.js`、`lib/bm25.js`、`lib/vector-index.js`、`lib/tokenizer.js` | 混合 BM25 + 嵌入式 RAG |
| 抽取 | `lib/page-extractor.js`、`lib/smart-read.js`、`lib/highlighter.js` | 经来源校验的阅读、页面高亮 |
| 搜索 | `lib/search-provider.js` | Deep Search 的 SearXNG / Tavily / Brave |
| 持久化 | `lib/store.js`、`lib/idb.js` | chrome.storage + IndexedDB 的 session、聊天、图片 |
| 国际化 | `lib/i18n.js`、`_locales/` | UI 与 AI 输出语言 |
| 安全 | `lib/sanitize.js`、`lib/citations.js` | HTML 消毒、引用契约 |
| 后台 | `background.js`、`content-assist.js` | Service Worker、页面级内容脚本 |

### 卓越工程点

- **混合 RAG**：`rag-engine.js` 中带 token 预算的检索，挑选恰当证据，不会撑爆上下文窗口。
- **来源校验**：任何 Smart Read 片段在保存前都会校验，`smart-read.js` 会丢弃渲染源文中找不到的引文，防止幻觉证据进入你的 Session。
- **并发安全的存储**：`lib/store.js` 通过 Web Locks（+ 跨上下文 promise 队列）串行化所有 session 写入，让侧边栏、弹窗与 service worker 不会互相覆盖。
- **流式安全、可恢复的聊天**：`chat.js` 的 `processStream` 处理截断恢复，并把流式 token 映射到引用索引，不必逐 token 重解析。
- **引用契约**：`lib/citations.js` 强制严格的标记语法（`[S#]`、`[W#]`），让每条 AI 论断都可审计。
- **Prompt 卫生**：内部场景 prompt 永不落盘、永不回显，存储的只是用户可见的"意图标签"（见 `chat.js` ↔ `lib/store.js`）。

## 📚 文档

| 主题 | 文件 |
|---|---|
| 📜 隐私政策 | [`PRIVACY.md`](PRIVACY.md) |
| 🤝 贡献指南 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| 📋 许可证（GPL-3.0） | [`LICENSE`](LICENSE) |
| 🚦 CI / CD | [`.github/workflows/ci.yml`](.github/workflows/ci.yml)、[`.github/workflows/release.yml`](.github/workflows/release.yml) |

## ❓ 常见问题

**Weft 会把我的数据发给任何人吗？**
不会。片段和密钥都保存在 `chrome.storage.local` / IndexedDB 中。只有当你**主动运行某个综合操作**时，片段/文本内容才会离开本机——而且只会发往**你配置**的 LLM 服务商。详见 [`PRIVACY.md`](PRIVACY.md)。

**没有 API 密钥能用吗？**
可以——在 Settings 里选 **Ollama**（本地 LLM）或 **Chrome 内置 AI**（设备端）。数据完全不离开你的设备。

**为什么是 Manifest V3？**
这是当前 Chrome 扩展标准。Weft 的 service worker（`background.js`）是 MV3 原生实现。

**支持 Firefox / Edge 吗？**
目前仅支持 Chrome / Chromium。我们持续关注 MV3 跨浏览器兼容性，待 Edge / Firefox 的侧边栏 API 稳定后会加入支持。

**免费吗？**
是的——GPL-3.0，永久免费。模型自带即可。

## 🤝 贡献

非常欢迎 PR 与 issue！Weft 是原生 JS + MV3，开发回路非常快：

```bash
npm install          # 仅开发工具（eslint、prettier）
npm run check        # 校验 manifest + lint + 单元测试
npm run format       # prettier 格式化
npm run pack         # 打包出可上传商店的 zip
```

详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；如果要先讨论某个特性，请开一个 [issue](https://github.com/wotchin/weft/issues/new)。

## ⭐ 支持我们

如果 Weft 帮你省了时间，请**给本仓库点个 Star** —— 这能让更多研究者发现它，也让项目持续维护下去。

[![Star History Chart](https://api.star-history.com/svg?repos=wotchin/weft&type=Date)](https://star-history.com/#wotchin/weft&Date)

## 📝 许可证

[GNU General Public License v3.0](LICENSE) © [@Wotchin](https://thejackstudio.com).

<div align="center">

<sub>用 ❤️ 为每一个在太多标签页里收集证据的人而做。</sub>

</div>
