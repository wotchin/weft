# Weft — Privacy Policy

_Last updated: 2026-07-23_

Weft is a browser extension that helps you collect snippets from web pages and synthesize them using a Large Language Model (LLM) of your choice. Weft is built around a simple principle: **your data stays on your machine.**

## What Weft stores, and where

- **Collected snippets** (text, image references, links, your comments, tags) and **your settings** are stored **locally** in your browser via `chrome.storage.local` and IndexedDB. They are never uploaded to us — we do not operate any server that receives your data.
- **Your API key** is stored locally and is sent **only** to the LLM endpoint you configure (e.g. OpenAI, Anthropic, Google, DeepSeek, Moonshot, a local Ollama instance, or a custom OpenAI-compatible endpoint). It is not transmitted anywhere else.

## When Weft reads page content

Weft only reads the content of a web page when **you** ask it to — for example when you select text and save a snippet, use the selection toolbar, or run a page-level action. It does not silently monitor, log, or transmit your browsing.

## What is sent to third parties

- **Your chosen LLM provider.** When you run a synthesis action (report, rewrite, diagram, verify, summarize, etc.), the relevant snippet text and your prompt are sent to the LLM endpoint you configured, so it can generate a response. This is subject to that provider's own privacy policy.
- **Optional web search.** If — and only if — you turn on web search, your search queries are sent to the provider you selected: a public SearXNG instance, your own SearXNG instance, or a keyed API (Tavily, Brave Search). Nothing else about your session is sent with the query. Weft does not scrape Google, Bing, or other search engines.

Weft does not use analytics, telemetry, advertising, or any third-party tracking. We do not sell or share your data.

## Chrome built-in AI

If you select "Chrome Built-in AI," inference runs locally in your browser via Chrome's on-device model. In that mode, snippet content is not sent to any external server.

## Permissions

- **Storage** — keeps your snippets, sessions and settings on your device.
- **Context menus** — adds the right-click "Save to Session" items.
- **Notifications** — confirms that a snippet was saved.
- **Tabs** — reads the current page's URL and title to record where a snippet came from, and opens the source page when you click a citation.
- **Scripting** — highlights a saved passage on its original page.
- **Side panel** — hosts the Workbench.
- **Access to websites you visit** — Weft must be able to run on whatever page you choose to collect from. Page content is read only when you actively save a snippet or run an action, never in the background.

## Data deletion

Uninstalling Weft removes all locally stored data. You can also delete individual snippets or whole sessions at any time from within the extension.

## Contact

Questions about privacy: open an issue on the project's GitHub repository.
