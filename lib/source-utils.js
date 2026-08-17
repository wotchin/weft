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

    return Object.freeze({
        annotationSourceUrl,
        isLikelyPdfUrl,
        isPdfSnippet,
        pdfPageNumber,
        sameDocumentUrl,
        withPdfPage,
    });
})();
