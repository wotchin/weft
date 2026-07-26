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
/* global Store, t */

const Citations = (() => {
    'use strict';

    const CONTRACT = [
        'When you use information from a source, cite it inline with its marker, e.g. [S1] or [S1][S3].',
        'Every factual claim derived from the sources MUST carry at least one citation marker.',
        'Do not invent markers that were not provided.',
    ].join(' ');

    function snippetLine(s, n) {
        const src = s.sourceTitle || s.sourceUrl || 'unknown source';
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
            indexMap['S' + n] = { id: s.id, title: s.sourceTitle || '', url: s.sourceUrl || '', content: s.content || '' };
            lines.push(snippetLine(s, n));
        });
        return { contextText: lines.join('\n\n'), indexMap };
    }

    // Replace [S1] or [S1][S3] runs with superscript chips.
    function decorate(html, indexMap) {
        if (!indexMap) return html;
        // Avoid rewriting inside tags: split on tags, only process text segments.
        return html.replace(/\[S(\d+)\]/g, (whole, num) => {
            const key = 'S' + num;
            const meta = indexMap[key];
            if (!meta) return whole; // unknown marker → leave as text
            const label = escapeAttr(meta.title || meta.url || ('Source ' + num));
            const preview = escapeAttr((meta.content || '').slice(0, 120));
            return `<sup class="weft-cite" data-snippet-id="${escapeAttr(meta.id)}" data-cite="${num}" title="${label}${preview ? ' — ' + preview : ''}">${num}</sup>`;
        });
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
        if (!snippet || !snippet.sourceUrl) {
            notify(t('cite_no_source'));
            return;
        }
        try {
            const tab = await chrome.tabs.create({ url: snippet.sourceUrl });
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

    /**
     * Wire click handling for citation chips within a container (event-delegated).
     */
    function bindClicks(container) {
        if (!container || container._weftCiteBound) return;
        container._weftCiteBound = true;
        container.addEventListener('click', (e) => {
            const chip = e.target.closest && e.target.closest('.weft-cite');
            if (!chip) return;
            const id = chip.getAttribute('data-snippet-id');
            if (id) jumpToSource(id);
        });
    }

    return { CONTRACT, buildContext, decorate, jumpToSource, bindClicks, notify };
})();
