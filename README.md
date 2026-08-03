# Weft

**Collect fragments from across your tabs and weave them into cited reports, rewrites, diagrams and fact-checks.**

Weft is an open-source, LLM-native Chrome extension for researchers and knowledge workers. Select text, images or links on any page, collect them into a session, then let an LLM synthesize and extend that research — with every claim traceable back to its original source. Webpages are collection points; the user-curated Session is the research scope.

This tool was developed in response to a practical challenge encountered by the author ([@Wotchin](https://thejackstudio.com)) during the process of collecting data snippets from multiple websites. It is designed to help users streamline this task and mitigate common inefficiencies and frustrations associated with cross-source data aggregation.


## Why Weft

- **Traceable by design** — every synthesized claim carries a citation back to the exact snippet and source page. This is the core differentiator from closed all-in-one assistants.
- **Session-first research** — ask questions across what you intentionally saved, then use Deep Search to find missing evidence, primary sources, counterpoints and updates. Weft does not silently turn the active tab into the research topic.
- **Bring your own key (BYOK)** — works with OpenAI, Anthropic, Gemini, DeepSeek, Moonshot, local Ollama, or Chrome's built-in on-device AI (no key needed). Your key and your data never leave your machine except to the endpoint you configure.
- **Private & local** — snippets live in `chrome.storage` / IndexedDB. No telemetry, no third-party sharing.

## Core workflow

1. **Read** — run **Smart Read** on an article to create a new focused session from source-verified passages. Use **Show on Page** when you want to toggle those saved passages on the source page. On link-heavy pages, tell Weft what matters first and it will shortlist only the visible links.
2. **Collect** — right-click or use the selection toolbar to save additional text / images / links into that session.
3. **Synthesize** — open the Workbench (side panel), ask the current Session a question, or pick a scenario: **Report**, **Rewrite**, **Diagram**, or **Verify**.
4. **Deep Search** — start from a Session question, review or edit Weft's evidence-gap search plan, then add public-web excerpts to the answer. Session evidence is cited as `[S#]`; external search excerpts are cited as `[W#]`.
5. **Trace** — click any citation marker to open its Session passage or external source.

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
