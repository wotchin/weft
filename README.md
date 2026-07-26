# Weft

**Collect fragments from across your tabs and weave them into cited reports, rewrites, diagrams and fact-checks.**

Weft is an open-source, LLM-native Chrome extension for researchers and knowledge workers. Select text, images or links on any page, collect them into a session, then let an LLM synthesize everything — with every claim traceable back to its original source.

## Why Weft

- **Traceable by design** — every synthesized claim carries a citation back to the exact snippet and source page. This is the core differentiator from closed all-in-one assistants.
- **Bring your own key (BYOK)** — works with OpenAI, Anthropic, Gemini, DeepSeek, Moonshot, local Ollama, or Chrome's built-in on-device AI (no key needed). Your key and your data never leave your machine except to the endpoint you configure.
- **Private & local** — snippets live in `chrome.storage` / IndexedDB. No telemetry, no third-party sharing.

## Core workflow

1. **Collect** — right-click or use the selection toolbar to save text / images / links into a session.
2. **Synthesize** — open the Workbench (side panel) and pick a scenario: **Report**, **Rewrite**, **Diagram**, or **Verify**.
3. **Trace** — click any citation marker in the output to jump back and highlight the original passage.

## Install (development)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open **Settings**, choose a provider and paste your API key (or select Ollama / Chrome built-in AI).

## Configuration

Settings → pick a provider → paste key → **Test Connection**. Base URL and model name are pre-filled per provider and can be overridden.

## Privacy

Snippets and settings are stored only on your device. Your API key is sent solely to the provider endpoint you configure. No telemetry, no accounts, no third-party sharing. See [PRIVACY.md](PRIVACY.md).

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-3.0. See [LICENSE](LICENSE).
