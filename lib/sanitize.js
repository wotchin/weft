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
    // Citation source metadata never belongs in the DOM. Chips carry only a
    // validated marker and an opaque handle into Citations' private manifest.
    const GLOBAL_ATTRS = new Set(['class', 'title', 'dir', 'lang', 'data-cite', 'data-cite-scope']);
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
        if (tag === 'img') {
            return /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v);
        }
        if (/^\/\//u.test(v)) return false;
        // Relative / anchor / mailto — safe
        if (/^(#|\/|\.\/|\.\.\/|mailto:|tel:)/i.test(v)) return true;
        // Absolute http(s)
        if (/^https?:\/\//i.test(v)) return true;
        // Safe image data URLs only (for <img src>)
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
                if (name === 'data-cite' && !/^[SW][1-9]\d{0,5}$/u.test(attr.value)) {
                    child.removeAttribute(attr.name);
                    continue;
                }
                if (name === 'data-cite-scope'
                    && !/^weft-cite-(?:[a-f0-9]{24}|fallback-[a-z0-9]+)$/u.test(attr.value)) {
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
        if (!el || el.nodeName.toLowerCase() !== 'svg') return '';
        const safeTags = new Set([
            'svg', 'g', 'defs', 'marker', 'lineargradient', 'radialgradient', 'stop',
            'clippath', 'mask', 'path', 'rect', 'circle', 'ellipse', 'line',
            'polyline', 'polygon', 'text', 'tspan', 'title', 'desc',
        ]);
        const safeAttributes = new Set([
            'xmlns', 'viewbox', 'preserveaspectratio', 'width', 'height', 'x', 'y',
            'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
            'dx', 'dy', 'transform', 'fill', 'fill-opacity', 'stroke', 'stroke-width',
            'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity',
            'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor',
            'dominant-baseline', 'offset', 'stop-color', 'stop-opacity',
            'gradientunits', 'gradienttransform', 'markerwidth', 'markerheight',
            'refx', 'refy', 'orient', 'markerunits', 'id', 'role',
            'aria-label', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'style',
        ]);
        const localReferenceAttributes = new Set([
            'fill', 'stroke', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end',
        ]);
        const cssValueAttributes = new Set([
            'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
            'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity',
            'font-family', 'font-size', 'font-weight', 'text-anchor',
            'dominant-baseline', 'stop-color', 'stop-opacity',
        ]);
        const safeStyleProperties = new Set([
            'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
            'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
            'stroke-opacity', 'opacity', 'color', 'font-family', 'font-size',
            'font-style', 'font-weight', 'text-anchor', 'dominant-baseline', 'visibility',
        ]);
        const localReferencePattern = /^url\(\s*#([A-Za-z_][\w:.-]{0,127})\s*\)$/iu;
        const unsafeCssSyntax = /\\|\/\*|\*\/|[\u0000-\u001f\u007f-\u009f]/u;
        const cssFunctionPattern = /([A-Za-z_-][\w-]*)\s*\(/gu;
        const safeColorFunction = /^(?:rgb|rgba|hsl|hsla)\(\s*[-+.%\d,\s/]+\)$/iu;
        const safeTransform = /^(?:(?:matrix|translate|scale|rotate|skewx|skewy)\(\s*[-+\d.eE,\s]+\)\s*)+$/iu;
        const idMap = new Map();
        const duplicateIds = new Set();
        let idPrefix = '';
        try {
            const randomBytes = new Uint8Array(12);
            globalThis.crypto.getRandomValues(randomBytes);
            idPrefix = `weftsvg-${Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}-`;
        } catch {
            // Fail closed below by dropping IDs and their references. Chrome extension
            // pages provide Web Crypto; this branch mainly protects unusual test hosts.
        }
        const rewriteLocalReference = (value) => {
            const match = String(value || '').match(localReferencePattern);
            if (!match || !idPrefix || !idMap.has(match[1])) return '';
            return `url(#${idMap.get(match[1])})`;
        };
        const hasForbiddenCssFunction = (value, allowLocalReference = false) => {
            if (allowLocalReference && localReferencePattern.test(value)) return false;
            const functions = Array.from(String(value || '').matchAll(cssFunctionPattern), (match) => match[1].toLowerCase());
            return functions.length > 0 && !(functions.length === 1 && safeColorFunction.test(value));
        };
        const cleanStyle = (value) => {
            const source = String(value || '');
            if (unsafeCssSyntax.test(source)) return '';
            return source.split(';').map((declaration) => {
                const separator = declaration.indexOf(':');
                if (separator < 1) return '';
                const property = declaration.slice(0, separator).trim().toLowerCase();
                const cssValue = declaration.slice(separator + 1).trim();
                if (!safeStyleProperties.has(property) || !cssValue
                    || /url\s*\(|expression\s*\(|[@{}<>]/iu.test(cssValue)
                    || hasForbiddenCssFunction(cssValue)) {
                    const localReference = (property === 'fill' || property === 'stroke')
                        ? rewriteLocalReference(cssValue) : '';
                    return localReference ? `${property}:${localReference}` : '';
                }
                return `${property}:${cssValue}`;
            }).filter(Boolean).join(';');
        };

        // Remove unknown elements before collecting identifiers, so references can
        // never target content that the allowlist later discards.
        for (const n of [el, ...el.querySelectorAll('*')]) {
            const tag = String(n.nodeName || '').toLowerCase();
            if (!safeTags.has(tag)) {
                for (const attr of Array.from(n.attributes || [])) n.removeAttribute(attr.name);
                if (n !== el) n.remove();
            }
        }

        const safeNodes = [el, ...el.querySelectorAll('*')];
        for (const n of safeNodes) {
            if (!n.hasAttribute || !n.hasAttribute('id')) continue;
            const originalId = String(n.getAttribute('id') || '').trim();
            const validId = /^[A-Za-z_][\w:.-]{0,127}$/u.test(originalId);
            if (!validId || !idPrefix || idMap.has(originalId)) {
                duplicateIds.add(originalId);
                n.removeAttribute('id');
                continue;
            }
            const scopedId = `${idPrefix}${originalId}`;
            idMap.set(originalId, scopedId);
            if (typeof n.setAttribute === 'function') n.setAttribute('id', scopedId);
            else {
                idMap.delete(originalId);
                n.removeAttribute('id');
            }
        }
        for (const duplicateId of duplicateIds) idMap.delete(duplicateId);

        for (const n of safeNodes) {
            for (const attr of Array.from(n.attributes)) {
                const name = attr.name.toLowerCase();
                const value = String(attr.value || '').trim();
                if (name === 'id') continue;
                if (name === 'style') {
                    const cleaned = cleanStyle(value);
                    if (!cleaned) n.removeAttribute(attr.name);
                    else if (typeof n.setAttribute === 'function') n.setAttribute(attr.name, cleaned);
                    else n.removeAttribute(attr.name);
                    continue;
                }
                if (!safeAttributes.has(name) || name.startsWith('on') || unsafeCssSyntax.test(value)) {
                    n.removeAttribute(attr.name);
                    continue;
                }
                if (name === 'xmlns') {
                    if (n !== el || value !== 'http://www.w3.org/2000/svg') n.removeAttribute(attr.name);
                    continue;
                }
                const localReference = localReferenceAttributes.has(name)
                    ? rewriteLocalReference(value) : '';
                if (localReference) {
                    if (typeof n.setAttribute === 'function') n.setAttribute(attr.name, localReference);
                    else n.removeAttribute(attr.name);
                    continue;
                }
                if (/url\s*\(/iu.test(value) || localReferencePattern.test(value)) {
                    n.removeAttribute(attr.name);
                    continue;
                }
                if ((name === 'transform' || name === 'gradienttransform') && !safeTransform.test(value)) {
                    n.removeAttribute(attr.name);
                    continue;
                }
                if (cssValueAttributes.has(name) && hasForbiddenCssFunction(value)) {
                    n.removeAttribute(attr.name);
                }
            }
        }
        return new XMLSerializer().serializeToString(el);
    }

    return { clean, cleanSvg };
})();
