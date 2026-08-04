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

`npm run pack` (the store zip) additionally needs the `zip` command. macOS and Linux
have it already; on Windows use WSL or Git Bash with `zip` installed. You only need
it to inspect the packaged output — CI builds the real release artifact.

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

## License and contribution terms

Weft is released under the **AGPL-3.0** (see [`LICENSE`](LICENSE)), and every
public release will stay under a free software licence.

By submitting a contribution you confirm that:

1. **You wrote it, or you have the right to submit it.** It is your original work,
   or you are authorised to contribute it, and you are not knowingly including code
   that belongs to someone else or that carries incompatible licence terms.
2. **You license it under AGPL-3.0**, on the same terms as the rest of the project.
3. **You grant the maintainer a relicensing right.** In addition to (2), you grant
   the Weft project maintainer — currently [@Wotchin](https://github.com/wotchin) —
   a perpetual, worldwide, non-exclusive, royalty-free, irrevocable licence to use,
   reproduce, modify, sublicense and distribute your contribution, **including under
   licence terms other than AGPL-3.0** (for example a paid commercial licence for
   organisations that cannot accept copyleft).
4. **That grant is transferable.** The maintainer may assign or transfer the rights
   in (3), in whole or in part, to a successor entity — for example a company later
   formed to hold the project's assets, or an acquirer of the project. The grant
   binds and benefits the maintainer's successors and assigns, and no further
   action by you is required for a transfer to take effect.

Points 3 and 4 exist so the project can offer a commercial licence alongside the
open source one, and so that option survives the project being put on a proper
legal footing later. Without them, a single external contribution would permanently
prevent it. You keep the copyright in your contribution; this is a licence grant,
not an assignment, and it does not restrict what you do with your own code
elsewhere.

If you cannot agree to points 3 and 4 — for instance because your employer's policy
forbids it — please say so in the pull request. We can usually still take the
change by reimplementing it independently, and we would rather know upfront
than have to unpick it later.
