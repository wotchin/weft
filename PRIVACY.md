# Weft — Privacy Policy

_Last updated: 2026-08-16_

Weft is a browser extension that helps you collect snippets from web pages and synthesize them using a Large Language Model (LLM) of your choice. Weft is built around a simple principle: **your data stays on your machine.**

## What Weft stores, and where

- **Collected snippets** (text, image references, links, your comments, tags) and **your settings** are stored **locally** in your browser via `chrome.storage.local` and IndexedDB. They are never uploaded to us — we do not operate any server that receives your data.
- **Your API key** is stored locally and is sent **only** to the LLM endpoint you configure (e.g. OpenAI, Anthropic, Google, DeepSeek, Moonshot, a local Ollama instance, or a custom OpenAI-compatible endpoint). It is not transmitted anywhere else.

## When Weft reads page content

Weft only reads the content of a web page when **you** ask it to — for example when you select text and save a snippet, use the selection toolbar, or run a page-level action. It does not silently monitor, log, or transmit your browsing.

**Smart Read** is also user-initiated. For a normal web page, it reads only the DOM content already rendered in the source tab. For a text-layer PDF opened from an HTTP(S) address, Weft makes a second request to that exact PDF URL, parses the downloaded file locally with its bundled PDF.js worker, and discards the file after extraction. That request may include browser cookies for the PDF host; cookies and login credentials are never sent to the configured LLM. POST-only, one-time, `blob:`, local-file, password-protected and scanned PDFs are not supported in this version.

For an article or PDF, Weft sends a bounded selection of readable text blocks to your configured LLM so it can propose key passages; for a link-heavy page, it sends visible headline and teaser text only after asking for your reading focus. Weft does not follow those links in the background, bypass an access gate, or retrieve content that the current PDF URL does not return. Before saving, every proposed quotation is checked against the extracted source text. The resulting session stores the selected passages, their PDF page numbers where applicable, or selected links — not a complete copy of the page or PDF.

## What is sent to third parties

- **Your chosen LLM provider.** When you run a synthesis action (report, rewrite, diagram, verify, summarize, Smart Read, etc.), the relevant snippet or page text and your prompt are sent to the LLM endpoint you configured, so it can generate a response. This is subject to that provider's own privacy policy.
- **Optional Deep Search.** Weft first uses your configured LLM to compare your question with a bounded set of relevant Session evidence and propose an evidence-gap search plan. The exact queries are shown for you to select and edit. Only after you confirm are those query strings sent to the search provider you selected: a public SearXNG instance, your own SearXNG instance, or a keyed API (Tavily, Brave Search). The search provider does not receive the Session, comments, snippets or current webpage. Weft does not scrape Google, Bing, or other search engines.

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
- **Access to websites you visit** — Weft must be able to run on whatever page you choose to collect from. It also uses this access to retrieve an HTTP(S) PDF only after you explicitly run Smart Read on that PDF. Content is never monitored in the background.

## Data deletion

Uninstalling Weft removes all locally stored data. You can also delete individual snippets or whole sessions at any time from within the extension.

## Contact

Questions about privacy: open an issue on the project's [GitHub repository](https://github.com/wotchin/weft)
