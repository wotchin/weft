# Contributing to Weft

Thanks for your interest! Weft is a vanilla-JS Manifest V3 Chrome extension — no build step, no framework.

Our project's official website is through [Github Repository](https://github.com/wotchin/weft). Feel free to submit your pull requests or share your suggestions by github issues.

## Getting started

1. Clone the repo.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the repo folder.
3. Make changes, then click the reload icon on the extension card to test.

## Before opening a PR

```bash
npm install        # dev tooling only (eslint, prettier)
npm run check      # validate manifest + lint + unit tests
npm run format     # prettier
```

Unit tests live in `test/unit.mjs` and cover the pure-logic modules (storage/migration, citations, providers, markdown). They run in plain Node with small `chrome.*` shims — no browser needed. Please add a case when you touch that logic.

## Architecture

No bundler: modules are plain IIFEs loaded via `<script>` tags, exposing one global each. Load order matters — check the `<script>` list in `chat.html` before adding a dependency.

Key modules:
- `lib/store.js` — the only place that reads/writes persistence + schema migration.
- `lib/llm-client.js` + `lib/providers.js` — the only place that calls an LLM. Route all model calls through `LLMClient`.
- `lib/render.js` + `lib/sanitize.js` — the only sanctioned way to turn LLM/untrusted text into DOM HTML. Never assign untrusted content to `innerHTML` directly; use `Render.markdown()` / `Render.html()`.
- `lib/citations.js` — traceable-output markers and jump-to-source.

## Conventions

- Match existing style (4-space indent, single quotes, semicolons — see `.prettierrc.json`).
- Add user-facing strings to `_locales/en/messages.json` and `_locales/zh_CN/messages.json` (keys must stay in parity) and reference them with `data-i18n` / `t()`.
- Keep permissions minimal. Adding one to `manifest.json` needs a clear user-facing reason in the PR description.

## License

By contributing you agree your contributions are licensed under the project's license (GPL-3.0). See `LICENSE`.
