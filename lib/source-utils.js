/** Shared source identity helpers for webpages and page-addressable PDFs. */
/* exported SourceUtils */

const SourceUtils = (() => {
    'use strict';

    function pdfPageNumber(value) {
        const number = Number(value);
        return Number.isInteger(number) && number > 0 ? number : null;
    }

    function isPdfSnippet(snippet) {
        const page = pdfPageNumber(snippet?.sourcePageNumber);
        return Boolean(
            snippet &&
            typeof snippet === 'object' &&
            (snippet.sourceDocumentType === 'pdf' ||
                (page && ((snippet.tags || []).includes('pdf') || isLikelyPdfUrl(snippet.sourceUrl))))
        );
    }

    function withPdfPage(value, pageNumber) {
        const page = pdfPageNumber(pageNumber);
        if (!page) return String(value || '');
        try {
            const url = new URL(String(value || ''));
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
            url.hash = `page=${page}`;
            return url.href;
        } catch {
            return '';
        }
    }

    function annotationSourceUrl(snippet) {
        if (!snippet || typeof snippet !== 'object') return '';
        if (snippet.smartReadPageType === 'index' && snippet.sourcePageUrl) {
            return snippet.sourcePageUrl;
        }
        const sourceUrl = snippet.sourceUrl || '';
        return isPdfSnippet(snippet) ? withPdfPage(sourceUrl, snippet.sourcePageNumber) : sourceUrl;
    }

    function isLikelyPdfUrl(value, title = '') {
        try {
            const url = new URL(String(value || ''));
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
            let path = url.pathname;
            try {
                path = decodeURIComponent(path);
            } catch {}
            if (/\.pdf(?:$|[\/,;])/iu.test(path)) return true;
            for (const [key, candidate] of url.searchParams.entries()) {
                if (/\.pdf(?:$|[?#])/iu.test(candidate.trim())) return true;
                if (
                    /^(?:format|type|output|mime|content[-_]?type)$/iu.test(key) &&
                    /^(?:pdf|application\/pdf)$/iu.test(candidate.trim())
                ) {
                    return true;
                }
            }
        } catch {
            return false;
        }
        return /\.pdf(?:\s*$|\s*(?:[-—|]|\(|\[))/iu.test(String(title || '').trim());
    }

    function sameDocumentUrl(left, right) {
        try {
            const first = new URL(String(left || ''));
            const second = new URL(String(right || ''));
            first.hash = '';
            second.hash = '';
            return first.href === second.href;
        } catch {
            return String(left || '').split('#')[0] === String(right || '').split('#')[0];
        }
    }

    function safeHttpUrl(value) {
        try {
            const url = new URL(String(value || ''));
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
            return url.href;
        } catch {
            return '';
        }
    }

    /** Recover an original HTTP(S) URL exposed by a third-party viewer URL. */
    function embeddedHttpUrl(value) {
        try {
            const wrapper = new URL(String(value || ''));
            if (wrapper.protocol !== 'chrome-extension:') return '';
            for (const key of ['src', 'url', 'file']) {
                const candidate = safeHttpUrl(wrapper.searchParams.get(key));
                if (candidate) return candidate;
            }
            let path = wrapper.pathname.replace(/^\/+/, '');
            try { path = decodeURIComponent(path); } catch {}
            return safeHttpUrl(path);
        } catch {
            return '';
        }
    }

    function normalizePdfSelectionText(value) {
        let text = String(value || '');
        try {
            text = text.normalize('NFKC');
        } catch {}
        return text
            .replace(/\u00ad/gu, '')
            .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
            .replace(/\s+/gu, ' ')
            .trim()
            .toLocaleLowerCase();
    }

    function pdfSegmentGeometry(segment) {
        const transform = Array.isArray(segment?.transform) ? segment.transform : [];
        const x = Number(transform[4]);
        const y = Number(transform[5]);
        const width = Math.abs(Number(segment?.width) || 0);
        const height = Math.abs(Number(segment?.height) || Number(transform[3]) || 0);
        return {
            x: Number.isFinite(x) ? x : null,
            y: Number.isFinite(y) ? y : null,
            width: Number.isFinite(width) ? width : 0,
            height: Number.isFinite(height) ? height : 0,
        };
    }

    function pdfSegmentsNeedSpace(left, right) {
        const leftText = String(left?.text || '');
        const rightText = String(right?.text || '');
        if (!leftText || !rightText || /\s$/u.test(leftText) || /^\s/u.test(rightText)) return false;
        const leftChar = leftText[leftText.length - 1];
        const rightChar = rightText[0];
        if (/[-‐‑‒–—/([{（《【「『]/u.test(leftChar)) return false;
        if (/^[,.;:!?%\)\]\}，。；：！？、）》】」』]/u.test(rightChar)) return false;
        if (/[，。；：！？、]/u.test(leftChar)) return false;
        const cjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
        if (cjk.test(leftChar) && cjk.test(rightChar)) return false;

        const a = pdfSegmentGeometry(left);
        const b = pdfSegmentGeometry(right);
        if (a.x !== null && a.y !== null && b.x !== null && b.y !== null) {
            const scale = Math.max(1, a.height, b.height);
            const sameLine = Math.abs(a.y - b.y) <= Math.max(1.5, scale * 0.35);
            if (sameLine && a.width > 0) {
                // PDF text layers commonly split a visual word into adjacent
                // text items. A near-zero geometric gap means continuation,
                // while a normal word-space leaves a measurable gap.
                const gap = b.x - (a.x + a.width);
                if (gap <= Math.max(0.6, scale * 0.12)) return false;
            }
        }
        return true;
    }

    /** Join selected PDF.js text items without introducing mid-word spaces. */
    function joinPdfSelectionSegments(value) {
        const segments = Array.isArray(value) ? value : [];
        let output = '';
        let previous = null;
        for (const raw of segments) {
            const rawText = String(raw?.text || '');
            const text = rawText.replace(/\s+/gu, ' ').trim();
            if (!text) continue;
            const segment = {
                ...raw,
                text,
                hadLeadingSpace: /^\s/u.test(rawText),
                hadTrailingSpace: /\s$/u.test(rawText),
            };
            if (
                output &&
                (previous?.hadTrailingSpace || segment.hadLeadingSpace || pdfSegmentsNeedSpace(previous, segment))
            ) output += ' ';
            output += text;
            previous = segment;
        }
        return output.replace(/\s+/gu, ' ').trim();
    }

    function pdfSnippetsForDocument(snippets, sourceUrl) {
        const source = safeHttpUrl(sourceUrl);
        if (!source || !Array.isArray(snippets)) return [];
        return snippets.filter((snippet) => snippet?.type === 'text'
            && Boolean(snippet.content)
            && isPdfSnippet(snippet)
            && sameDocumentUrl(snippet.sourceUrl, source));
    }

    /**
     * Reuse already verified PDF evidence to infer the page for a manual
     * selection. A page is returned only when every match agrees; ambiguous
     * text is deliberately left page-less for the Weft viewer to resolve.
     */
    function inferPdfSelectionPage(sessions, sourceUrl, selectionText) {
        const source = safeHttpUrl(sourceUrl);
        const needle = normalizePdfSelectionText(selectionText);
        if (!source || needle.length < 2 || !sessions || typeof sessions !== 'object') return null;
        const pages = new Set();
        for (const snippets of Object.values(sessions)) {
            if (!Array.isArray(snippets)) continue;
            for (const snippet of snippets) {
                const page = pdfPageNumber(snippet?.sourcePageNumber);
                if (!page || !isPdfSnippet(snippet) || !sameDocumentUrl(snippet.sourceUrl, source)) continue;
                const evidence = normalizePdfSelectionText(snippet.content);
                if (evidence && evidence.includes(needle)) pages.add(page);
                if (pages.size > 1) return null;
            }
        }
        return pages.size === 1 ? [...pages][0] : null;
    }

    function pdfViewerUrl(sourceUrl, options = {}) {
        const source = safeHttpUrl(sourceUrl);
        const getUrl = globalThis.chrome?.runtime?.getURL;
        if (!source || typeof getUrl !== 'function') return '';
        try {
            const viewer = new URL(getUrl('pdf-viewer.html'));
            viewer.searchParams.set('src', source);
            const sessionName = String(options.sessionName || '').trim();
            if (sessionName) viewer.searchParams.set('session', sessionName.slice(0, 200));
            const page = pdfPageNumber(options.pageNumber);
            if (page) viewer.searchParams.set('page', String(page));
            const title = String(options.title || '').trim();
            if (title) viewer.searchParams.set('title', title.slice(0, 300));
            return viewer.href;
        } catch {
            return '';
        }
    }

    return Object.freeze({
        annotationSourceUrl,
        embeddedHttpUrl,
        isLikelyPdfUrl,
        isPdfSnippet,
        inferPdfSelectionPage,
        joinPdfSelectionSegments,
        normalizePdfSelectionText,
        pdfPageNumber,
        pdfSnippetsForDocument,
        pdfViewerUrl,
        safeHttpUrl,
        sameDocumentUrl,
        withPdfPage,
    });
})();
