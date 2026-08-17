/**
 * Weft — Citations: traceable output, the product's core differentiator.
 *
 * 1. buildContext(snippets) → { contextText, indexMap }
 *    Numbers snippets as [S1], [S2]… and returns a map back to snippet ids.
 * 2. decorate(html, indexMap) → html
 *    Turns inline [S1] / [S1][S3] markers in rendered output into clickable
 *    superscript chips. Unknown markers are left as plain text.
 * 3. jumpToSource(snippetId) → opens the source page and highlights the passage
 *    by reusing the existing highlighter message flow.
 *
 * The citation contract text (CONTRACT) is appended to scenario system prompts.
 */
/* exported Citations */
/* global SourceUtils, Store, t */

const Citations = (() => {
    'use strict';

    // Citation metadata deliberately lives outside the rendered DOM. A model
    // may emit arbitrary HTML/markdown, so putting source URLs or snippet IDs
    // in data attributes would let untrusted output forge a privileged-looking
    // citation. Rendered chips carry only a marker plus an opaque scope handle;
    // the handle resolves to this module-owned snapshot when it is clicked.
    const MAX_MANIFEST_SCOPES = 512;
    const _manifestScopes = new Map();
    const _bindings = new WeakMap();
    let _scopeCounter = 0;

    const CONTRACT = [
        'Cite Session evidence with its [S#] marker and web-search excerpts with their [W#] marker.',
        'Every material factual claim derived from supplied evidence MUST carry at least one marker.',
        'A [W#] item is only a search-result excerpt, not proof that the full page was read or verified.',
        'Do not invent markers that were not provided.',
    ].join(' ');

    function snippetLine(s, n) {
        const pdfPage = SourceUtils.isPdfSnippet(s) && SourceUtils.pdfPageNumber(s.sourcePageNumber)
            ? ` (PDF page ${s.sourcePageNumber})`
            : '';
        const src = `${s.sourceTitle || s.sourceUrl || 'unknown source'}${pdfPage}`;
        const kind = s.type || 'text';
        const body = kind === 'image'
            ? `(image) ${s.imageUrl || ''}`
            : (s.content || '').trim();
        const tags = (s.tags && s.tags.length) ? ` [tags: ${s.tags.join(', ')}]` : '';
        return `[S${n}] from: ${src}${tags}\n${body}`;
    }

    /**
     * @param {Array} snippets
     * @returns {{contextText:string, indexMap:Object<string,object>}}
     */
    function buildContext(snippets) {
        const indexMap = {};
        const lines = [];
        (snippets || []).forEach((s, i) => {
            const n = i + 1;
            indexMap['S' + n] = {
                id: s.id,
                title: s.sourceTitle || '',
                url: SourceUtils.annotationSourceUrl(s),
                content: s.content || '',
            };
            lines.push(snippetLine(s, n));
        });
        return { contextText: lines.join('\n\n'), indexMap };
    }

    // Replace [S1] or [S1][S3] runs with superscript chips.
    function safeExternalUrl(value) {
        try {
            const url = new URL(String(value || ''));
            return (url.protocol === 'https:' || url.protocol === 'http:')
                && !url.username && !url.password ? url.href : '';
        } catch {
            return '';
        }
    }

    function boundedMetadata(value, maxChars) {
        return String(value || '')
            .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, maxChars);
    }

    function createScopeId() {
        const bytes = new Uint8Array(12);
        try {
            globalThis.crypto.getRandomValues(bytes);
            return 'weft-cite-' + Array.from(bytes, (value) =>
                value.toString(16).padStart(2, '0')).join('');
        } catch {
            // Older test/browser contexts may not expose Web Crypto. The
            // counter is still an opaque lookup handle, never source data.
            _scopeCounter++;
            return `weft-cite-fallback-${_scopeCounter.toString(36)}`;
        }
    }

    function snapshotCitation(key, meta) {
        if (!/^[SW][1-9]\d{0,5}$/u.test(key) || !meta || typeof meta !== 'object') return null;
        try {
            const prefix = key[0];
            const rawUrl = String(meta.url || '').trim();
            const url = rawUrl.length <= 2048 ? safeExternalUrl(rawUrl) : '';
            const id = boundedMetadata(meta.id, 256);
            // Web citations must have a safe destination. Session citations can be
            // resolved by snippet id, with a safe URL as a legacy fallback.
            if (prefix === 'W' && !url) return null;
            if (prefix === 'S' && !id && !url) return null;
            return Object.freeze({
                id,
                url,
                title: boundedMetadata(meta.title, 500),
                content: boundedMetadata(meta.content, 2000),
                query: boundedMetadata(meta.query, 500),
            });
        } catch {
            // Treat accessor/proxy failures like malformed persisted data.
            return null;
        }
    }

    function normalizeManifest(value, referencedText = '') {
        const normalized = Object.create(null);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
        let entries;
        try {
            entries = Object.entries(value);
        } catch {
            return normalized;
        }
        const requested = [];
        const requestedSet = new Set();
        if (typeof referencedText === 'string' && referencedText) {
            for (const match of referencedText.matchAll(/\[([SW][1-9]\d{0,5})\]/giu)) {
                const key = match[1].toUpperCase();
                if (!requestedSet.has(key)) {
                    requestedSet.add(key);
                    requested.push(key);
                    if (requested.length >= 64) break;
                }
            }
        }
        const entryMap = new Map(entries.map(([key, meta]) => [String(key || '').toUpperCase(), meta]));
        const candidates = requested.length > 0
            ? requested.map((key) => [key, entryMap.get(key)])
            : entries;
        let count = 0;
        for (const [rawKey, rawMeta] of candidates) {
            if (count >= 64) break;
            const key = String(rawKey || '').toUpperCase();
            const meta = snapshotCitation(key, rawMeta);
            if (meta && !Object.hasOwn(normalized, key)) {
                normalized[key] = meta;
                count++;
            }
        }
        return normalized;
    }

    function registerManifest(indexMap, referencedText) {
        const snapshot = normalizeManifest(indexMap, referencedText);
        if (Object.keys(snapshot).length === 0) return { scopeId: '', snapshot };

        const scopeId = createScopeId();
        _manifestScopes.set(scopeId, Object.freeze(snapshot));
        while (_manifestScopes.size > MAX_MANIFEST_SCOPES) {
            _manifestScopes.delete(_manifestScopes.keys().next().value);
        }
        return { scopeId, snapshot };
    }

    function decorate(html, indexMap) {
        if (!indexMap) return html;
        const { scopeId, snapshot } = registerManifest(indexMap, String(html || ''));
        if (!scopeId) return html;
        let decorated = false;
        const decorateText = (text) => text.replace(/\[([SW])(\d+)\]/g, (whole, prefix, num) => {
            const key = prefix + num;
            const meta = snapshot[key];
            if (!meta) return whole; // unknown marker → leave as text
            const label = escapeAttr(meta.title || meta.url || ('Source ' + num));
            const preview = escapeAttr((meta.content || '').slice(0, 120));
            const title = `${label}${preview ? ' — ' + preview : ''}`;
            decorated = true;
            return `<sup class="weft-cite" data-cite="${key}" data-cite-scope="${escapeAttr(scopeId)}" title="${title}">${key}</sup>`;
        });
        // Never rewrite a marker that appears inside an existing HTML tag or
        // attribute. Markdown text segments remain eligible for decoration.
        const output = String(html).split(/(<[^>]*>)/gu)
            .map((segment) => segment.startsWith('<') ? segment : decorateText(segment))
            .join('');
        if (!decorated) _manifestScopes.delete(scopeId);
        return output;
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Transient status message inside the current extension page.
     * (Extension pages have no content script, so this is self-contained.)
     */
    function notify(text) {
        let el = document.getElementById('weft-cite-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'weft-cite-toast';
            el.style.cssText = [
                'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
                'background:#323232', 'color:#fff', 'padding:9px 16px', 'border-radius:8px',
                'font-size:13px', 'line-height:1.4', 'max-width:88%', 'z-index:2147483647',
                'box-shadow:0 4px 12px rgba(0,0,0,.3)', 'opacity:0', 'transition:opacity .2s',
                'pointer-events:none',
            ].join(';');
            document.body.appendChild(el);
        }
        el.textContent = text;
        requestAnimationFrame(() => { el.style.opacity = '1'; });
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
    }

    /**
     * Open the source page and ask the content script to highlight the passage.
     */
    async function jumpToSource(snippetId) {
        const sessions = await Store.getSessions();
        let snippet = null;
        for (const arr of Object.values(sessions)) {
            const found = (arr || []).find((s) => s.id === snippetId);
            if (found) { snippet = found; break; }
        }
        const sourceUrl = safeExternalUrl(SourceUtils.annotationSourceUrl(snippet));
        if (!sourceUrl) {
            notify(t('cite_no_source'));
            return;
        }
        try {
            const tab = await chrome.tabs.create({ url: sourceUrl });
            if (SourceUtils.isPdfSnippet(snippet)) return;
            // Give the page a moment to load, then request a highlight.
            const trySend = (attempt) => {
                chrome.tabs.sendMessage(tab.id, { type: 'highlightSnippet', snippet }, (resp) => {
                    if (chrome.runtime.lastError && attempt < 5) {
                        setTimeout(() => trySend(attempt + 1), 800);
                    } else if (!resp || !resp.found) {
                        notify(t('cite_passage_changed'));
                    }
                });
            };
            setTimeout(() => trySend(0), 1200);
        } catch (e) {
            notify(t('cite_open_failed') + ': ' + e.message);
        }
    }

    async function openExternalSource(value) {
        const url = safeExternalUrl(value);
        if (!url) return;
        try {
            await chrome.tabs.create({ url });
        } catch (error) {
            notify(t('cite_open_failed') + ': ' + error.message);
        }
    }

    /**
     * Wire click handling for citation chips within a container (event-delegated).
     */
    function bindClicks(container, resolver) {
        if (!container) return;
        const existing = _bindings.get(container);
        if (existing) {
            // A later caller may install a persisted per-message resolver after
            // the initial delegated binding has already been created.
            if (typeof resolver === 'function') existing.resolver = resolver;
            return existing.unbind;
        }

        const state = { resolver: typeof resolver === 'function' ? resolver : null };
        const onClick = async (e) => {
            const chip = e.target.closest && e.target.closest('.weft-cite');
            if (!chip) return;
            const marker = String(chip.getAttribute('data-cite') || '').toUpperCase();
            if (!/^[SW][1-9]\d{0,5}$/u.test(marker)) return;
            e.preventDefault?.();

            const scopeId = chip.getAttribute('data-cite-scope') || '';
            let meta;
            try {
                if (state.resolver) {
                    meta = await state.resolver(marker, { chip, scopeId, container });
                }
            } catch (error) {
                console.warn('[Weft] Citation resolver failed:', error);
                return;
            }
            if (meta === undefined) meta = _manifestScopes.get(scopeId)?.[marker];
            const safeMeta = snapshotCitation(marker, meta);
            if (!safeMeta) return;

            if (marker[0] === 'W' || !safeMeta.id) {
                await openExternalSource(safeMeta.url);
            } else {
                await jumpToSource(safeMeta.id);
            }
        };
        const unbind = () => {
            container.removeEventListener('click', onClick);
            _bindings.delete(container);
            container._weftCiteBound = false;
        };
        state.unbind = unbind;
        _bindings.set(container, state);
        container._weftCiteBound = true;
        container.addEventListener('click', onClick);
        return unbind;
    }

    return {
        CONTRACT,
        buildContext,
        normalizeManifest,
        decorate,
        jumpToSource,
        bindClicks,
        notify,
        safeExternalUrl,
    };
})();
