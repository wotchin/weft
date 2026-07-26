/**
 * Weft — dependency-free HTML sanitizer.
 *
 * A conservative allowlist sanitizer built on the browser's own parser: it
 * parses untrusted HTML into a detached document, walks the tree, and drops any
 * element, attribute, or URL not explicitly allowed. Zero dependencies, so the
 * extension ships no third-party code for this security-critical path.
 *
 * Threat model: LLM-generated markdown→HTML and text collected from arbitrary
 * web pages, rendered inside privileged extension pages. Blocks scripts, event
 * handlers, javascript:/data: URLs (except safe image data URLs), and unknown
 * tags — the vectors that matter for an extension surface.
 *
 * Usage: WeftSanitize.clean(htmlString) → safe HTML string
 *        WeftSanitize.cleanSvg(svgString) → safe SVG string
 */
/* exported WeftSanitize */

const WeftSanitize = (() => {
    'use strict';

    const ALLOWED_TAGS = new Set([
        'a', 'b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
        'p', 'br', 'hr', 'span', 'div', 'blockquote', 'pre', 'code', 'kbd', 'samp',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'dl', 'dt', 'dd',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
        'img', 'figure', 'figcaption',
    ]);

    // Attributes allowed on any element
    const GLOBAL_ATTRS = new Set(['class', 'title', 'dir', 'lang', 'data-snippet-id', 'data-cite']);
    // Per-tag additional attributes
    const TAG_ATTRS = {
        a: new Set(['href', 'target', 'rel']),
        img: new Set(['src', 'alt', 'width', 'height']),
        td: new Set(['colspan', 'rowspan', 'align']),
        th: new Set(['colspan', 'rowspan', 'align', 'scope']),
        col: new Set(['span']),
        colgroup: new Set(['span']),
    };

    const URL_ATTRS = new Set(['href', 'src']);

    function isSafeUrl(value, tag) {
        const v = (value || '').trim();
        if (v === '') return false;
        // Relative / anchor / mailto — safe
        if (/^(#|\/|\.\/|\.\.\/|mailto:|tel:)/i.test(v)) return true;
        // Absolute http(s)
        if (/^https?:\/\//i.test(v)) return true;
        // Safe image data URLs only (for <img src>)
        if (tag === 'img' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(v)) return true;
        // Everything else (javascript:, data: on non-img, vbscript:, etc.) — blocked
        return false;
    }

    function sanitizeNode(node, doc) {
        // Walk children snapshot (we mutate during iteration)
        const children = Array.from(node.childNodes);
        for (const child of children) {
            if (child.nodeType === Node.COMMENT_NODE) {
                child.remove();
                continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) continue; // keep text nodes

            const tag = child.tagName.toLowerCase();
            if (!ALLOWED_TAGS.has(tag)) {
                // Unwrap: replace disallowed element with its (sanitized) text/children
                sanitizeNode(child, doc);
                const frag = doc.createDocumentFragment();
                while (child.firstChild) frag.appendChild(child.firstChild);
                child.replaceWith(frag);
                continue;
            }

            // Scrub attributes
            const allowed = TAG_ATTRS[tag];
            for (const attr of Array.from(child.attributes)) {
                const name = attr.name.toLowerCase();
                const okName = GLOBAL_ATTRS.has(name) || (allowed && allowed.has(name));
                if (!okName || name.startsWith('on')) {
                    child.removeAttribute(attr.name);
                    continue;
                }
                if (URL_ATTRS.has(name) && !isSafeUrl(attr.value, tag)) {
                    child.removeAttribute(attr.name);
                }
            }

            // Harden links
            if (tag === 'a' && child.hasAttribute('href')) {
                child.setAttribute('target', '_blank');
                child.setAttribute('rel', 'noopener noreferrer');
            }

            sanitizeNode(child, doc);
        }
    }

    function clean(html) {
        const doc = new DOMParser().parseFromString(`<div id="__weft_root">${html || ''}</div>`, 'text/html');
        const root = doc.getElementById('__weft_root');
        if (!root) return '';
        sanitizeNode(root, doc);
        return root.innerHTML;
    }

    function cleanSvg(svg) {
        const doc = new DOMParser().parseFromString(svg || '', 'image/svg+xml');
        const el = doc.documentElement;
        if (!el || el.nodeName.toLowerCase() === 'parsererror') return '';
        // Strip scripts, event handlers, and foreignObject (can host HTML/scripts)
        el.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
        el.querySelectorAll('*').forEach((n) => {
            for (const attr of Array.from(n.attributes)) {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on')) n.removeAttribute(attr.name);
                if ((name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
                    n.removeAttribute(attr.name);
                }
            }
        });
        return new XMLSerializer().serializeToString(el);
    }

    return { clean, cleanSvg };
})();
