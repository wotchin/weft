/**
 * Weft — unified, safe render entry point.
 *
 * The ONLY sanctioned way to turn LLM/markdown/untrusted text into DOM HTML.
 * Pipeline: markdown → (optional citation decoration) → sanitize.
 *
 * Usage:
 *   el.innerHTML = Render.markdown(text, { indexMap });
 *   el.innerHTML = Render.html(untrustedHtml);
 *   Render.setInto(el, text, { indexMap });   // convenience
 */
/* exported Render */
/* global renderMarkdown, WeftSanitize, Citations */

const Render = (() => {
    'use strict';

    function markdown(text, opts = {}) {
        let html;
        try {
            html = typeof renderMarkdown === 'function' ? renderMarkdown(text || '') : escapeText(text);
        } catch {
            html = escapeText(text);
        }
        if (opts.indexMap && typeof Citations !== 'undefined' && Citations.decorate) {
            html = Citations.decorate(html, opts.indexMap);
        }
        return WeftSanitize.clean(html);
    }

    function html(untrusted) {
        return WeftSanitize.clean(untrusted || '');
    }

    function svg(untrustedSvg) {
        return WeftSanitize.cleanSvg(untrustedSvg || '');
    }

    function setInto(el, text, opts) {
        if (el) el.innerHTML = markdown(text, opts);
    }

    function escapeText(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    return { markdown, html, svg, setInto, escapeText };
})();
