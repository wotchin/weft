/**
 * Weft Session transfer format.
 *
 * A Session export is readable HTML plus one inert JSON envelope. The
 * application version is informational; formatVersion is the compatibility
 * boundary. Imported values are treated as untrusted data and normalized
 * before the Store sees them.
 */
/* exported SessionTransfer */

const SessionTransfer = (() => {
    'use strict';

    const FORMAT = 'weft.session';
    const FORMAT_VERSION = 1;
    const DATA_ELEMENT_ID = 'weft-session-data';
    const DATA_OPEN_TAG = `<script id="${DATA_ELEMENT_ID}" type="application/json">`;
    // Accepted only so files produced by the first v1 development build remain
    // readable. Future versions must keep DATA_OPEN_TAG stable and negotiate
    // compatibility through the JSON envelope, not through HTML attributes.
    const LEGACY_V1_DATA_OPEN_TAG = `<script id="${DATA_ELEMENT_ID}" type="application/json" data-weft-session-format="1">`;
    const DATA_CLOSE_TAG = '</script>';
    const MAX_HTML_BYTES = 20 * 1024 * 1024;
    const MAX_HTML_CHARS = 20 * 1024 * 1024;
    const MAX_SNIPPETS = 5000;
    // The text appears twice in a standalone export (visible HTML + escaped
    // JSON). One MiB keeps even the worst escaping expansion below the 20 MiB
    // file-import ceiling, including per-snippet markup.
    const MAX_TOTAL_TEXT_CHARS = 1 * 1024 * 1024;
    const MAX_TAGS = 32;
    const MAX_TAG_LENGTH = 80;
    const MAX_LEGACY_NODES = 100_000;
    const MAX_LEGACY_DEPTH = 128;
    const MAX_LEGACY_TAG_CHARS = 16_384;
    const SUPPORTED_REQUIRED_FEATURES = new Set();

    const STRING_LIMITS = Object.freeze({
        content: 1_000_000,
        comment: 100_000,
        sourceUrl: 8192,
        sourceTitle: 2000,
        imageUrl: 8192,
        linkUrl: 8192,
        sourceDocumentType: 40,
        smartReadPageType: 40,
        smartReadTopic: 4000,
        smartReadSessionTitle: 500,
        smartReadTakeawayTitle: 1000,
        smartReadSummary: 10_000,
        smartReadEvidenceKind: 80,
        smartReadReason: 4000,
        smartReadCategory: 500,
        smartReadSection: 1000,
        sourceBlockId: 500,
        sourceLinkId: 500,
        sourcePageUrl: 8192,
    });

    const URL_FIELDS = new Set(['sourceUrl', 'imageUrl', 'linkUrl', 'sourcePageUrl']);
    const STRING_FIELDS = Object.keys(STRING_LIMITS);

    function transferError(code, message, details = {}) {
        const error = new Error(message);
        error.name = 'SessionTransferError';
        error.code = code;
        Object.assign(error, details);
        return error;
    }

    function isRecord(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function cleanString(value, maxLength, { controls = true, normalize = false } = {}) {
        if (typeof value !== 'string') return '';
        let text = value;
        if (normalize) {
            try { text = text.normalize('NFKC'); } catch { /* optional normalization */ }
        }
        if (controls) {
            text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
        }
        return text.slice(0, maxLength);
    }

    function strictString(value, maxLength, label, { optional = true } = {}) {
        if (value == null && optional) return '';
        if (typeof value !== 'string') {
            throw transferError('INVALID_SNIPPET', `${label} must be a string.`);
        }
        if (value.length > maxLength) {
            throw transferError('TOO_LARGE', `${label} exceeds the transfer limit.`, {
                field: label,
                length: value.length,
                maximum: maxLength,
            });
        }
        return value;
    }

    function safeHttpUrl(value) {
        if (typeof value !== 'string' || value.length > STRING_LIMITS.sourceUrl) return '';
        const text = value.trim();
        if (!text) return '';
        try {
            const url = new URL(text);
            // Validation is the security boundary; retain the user's original
            // spelling instead of canonicalizing percent escapes or Unicode.
            return url.protocol === 'https:' || url.protocol === 'http:' ? text : '';
        } catch {
            return '';
        }
    }

    function portableTags(value, snippetIndex, state) {
        if (value == null) return [];
        if (!Array.isArray(value)) {
            throw transferError('INVALID_SNIPPET', `Snippet ${snippetIndex + 1} tags must be an array.`);
        }
        if (value.length > MAX_TAGS) {
            throw transferError('TOO_LARGE', `Snippet ${snippetIndex + 1} has too many tags.`, {
                field: `snippet[${snippetIndex}].tags`,
                length: value.length,
                maximum: MAX_TAGS,
            });
        }
        return value.map((raw, tagIndex) => {
            const tag = strictString(
                raw,
                MAX_TAG_LENGTH,
                `Snippet ${snippetIndex + 1} tag ${tagIndex + 1}`,
                { optional: false }
            );
            state.totalText += tag.length;
            if (state.totalText > MAX_TOTAL_TEXT_CHARS) {
                throw transferError('TOO_LARGE', 'The Session text exceeds the transfer limit.');
            }
            // Tags are user data. Preserve their spelling, leading #, order and
            // duplicates instead of silently changing the exported Session.
            return tag;
        });
    }

    function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
        return Number.isInteger(value) && value > 0 && value <= maximum ? value : null;
    }

    function nonNegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
        return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;
    }

    function normalizedTimestamp(value) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 && number <= 8_640_000_000_000_000
            ? Math.floor(number)
            : Date.now();
    }

    function portableSnippet(raw, index, state, { importing = false } = {}) {
        if (!isRecord(raw) && !importing && typeof raw === 'string') {
            raw = { type: 'text', content: raw };
        }
        if (!isRecord(raw)) {
            throw transferError('INVALID_SNIPPET', `Snippet ${index + 1} is not an object.`);
        }
        if (raw.type != null && typeof raw.type !== 'string') {
            throw transferError('INVALID_SNIPPET', `Snippet ${index + 1} type must be a string.`);
        }
        const inputType = typeof raw.type === 'string' ? raw.type.toLowerCase() : 'text';
        if (!['text', 'link', 'image'].includes(inputType)) {
            throw transferError('INVALID_SNIPPET', `Snippet ${index + 1} has an unsupported type.`);
        }

        const snippet = {};
        for (const field of STRING_FIELDS) {
            const limit = STRING_LIMITS[field];
            const rawValue = strictString(
                raw[field],
                limit,
                `Snippet ${index + 1} field "${field}"`
            );
            const value = URL_FIELDS.has(field) ? safeHttpUrl(rawValue) : rawValue;
            if (value) snippet[field] = value;
            state.totalText += value.length;
            if (state.totalText > MAX_TOTAL_TEXT_CHARS) {
                throw transferError('TOO_LARGE', 'The Session text exceeds the transfer limit.');
            }
        }

        snippet.type = inputType;
        snippet.timestamp = normalizedTimestamp(raw.timestamp);
        snippet.tags = portableTags(raw.tags, index, state);

        if (raw.smartReadCoverageLimited === true) snippet.smartReadCoverageLimited = true;
        const takeawayIndex = nonNegativeInteger(raw.smartReadTakeawayIndex, 100_000);
        if (takeawayIndex !== null) snippet.smartReadTakeawayIndex = takeawayIndex;
        const sourcePageNumber = positiveInteger(raw.sourcePageNumber, 1_000_000);
        if (sourcePageNumber !== null) snippet.sourcePageNumber = sourcePageNumber;
        const sourcePageCount = positiveInteger(raw.sourcePageCount, 1_000_000);
        if (sourcePageCount !== null) snippet.sourcePageCount = sourcePageCount;

        // Exported image URLs are references, not trusted image bytes. On
        // import, convert them to link/text snippets so loading the Session
        // cannot silently fetch a tracker or an internal-network resource.
        if (importing && inputType === 'image') {
            const imageUrl = snippet.imageUrl || safeHttpUrl(snippet.content);
            snippet.type = imageUrl ? 'link' : 'text';
            snippet.content = snippet.content || imageUrl || snippet.sourceTitle;
            if (imageUrl) snippet.linkUrl = imageUrl;
            delete snippet.imageUrl;
            if (
                !snippet.tags.includes('image-reference')
                && snippet.tags.length < MAX_TAGS
                && state.totalText + 'image-reference'.length <= MAX_TOTAL_TEXT_CHARS
            ) {
                snippet.tags = [...snippet.tags, 'image-reference'];
                state.totalText += 'image-reference'.length;
            }
            state.convertedImages++;
        }

        if (snippet.type === 'link') {
            snippet.linkUrl = snippet.linkUrl || safeHttpUrl(snippet.content);
            snippet.content = snippet.content || snippet.linkUrl || snippet.sourceTitle;
        } else if (snippet.type === 'image') {
            snippet.imageUrl = snippet.imageUrl || safeHttpUrl(snippet.content);
            snippet.content = snippet.content || snippet.imageUrl || snippet.sourceTitle;
        }

        if (!snippet.content || (snippet.type === 'link' && !snippet.linkUrl)) {
            throw transferError('INVALID_SNIPPET', `Snippet ${index + 1} has no usable content.`);
        }
        if (snippet.type === 'image' && !snippet.imageUrl) {
            throw transferError('INVALID_SNIPPET', `Image snippet ${index + 1} has no safe URL.`);
        }

        // id, cachedDataUrl, hasCachedImage and Smart Read run/cache keys are
        // deliberately absent. They are local runtime identities, not portable
        // Session data, and importing them can collide with IDB or cache state.
        return snippet;
    }

    function normalizedSession(rawSession, options = {}) {
        if (!isRecord(rawSession) || !Array.isArray(rawSession.snippets)) {
            throw transferError('INVALID_PAYLOAD', 'The export does not contain a Session snippet list.');
        }
        if (rawSession.snippets.length === 0) {
            throw transferError('EMPTY_SESSION', 'The exported Session is empty.');
        }
        if (rawSession.snippets.length > MAX_SNIPPETS) {
            throw transferError('TOO_MANY_SNIPPETS', 'The exported Session has too many snippets.', {
                count: rawSession.snippets.length,
                maximum: MAX_SNIPPETS,
            });
        }

        const state = { totalText: 0, convertedImages: 0 };
        const snippets = rawSession.snippets.map((snippet, index) =>
            portableSnippet(snippet, index, state, options));
        const name = strictString(rawSession.name, 500, 'Session name').trim();
        state.totalText += name.length;
        if (state.totalText > MAX_TOTAL_TEXT_CHARS) {
            throw transferError('TOO_LARGE', 'The Session text exceeds the transfer limit.');
        }
        return {
            name,
            snippets,
            convertedImages: state.convertedImages,
        };
    }

    function createPayload(sessionName, snippets, options = {}) {
        const session = normalizedSession({ name: sessionName, snippets });
        const version = strictString(options.version, 80, 'Exporter version').trim();
        const versionName = strictString(options.versionName, 120, 'Exporter version name').trim() || version;
        return {
            format: FORMAT,
            formatVersion: FORMAT_VERSION,
            requiredFeatures: [],
            exportedAt: new Date(Number.isFinite(options.exportedAt) ? options.exportedAt : Date.now()).toISOString(),
            exporter: {
                name: 'Weft',
                version,
                versionName,
                url: 'https://github.com/wotchin/weft',
            },
            session: { name: session.name, snippets: session.snippets },
        };
    }

    function serializePayload(payload) {
        return JSON.stringify(payload)
            .replace(/&/gu, '\\u0026')
            .replace(/</gu, '\\u003c')
            .replace(/>/gu, '\\u003e')
            .replace(/\u2028/gu, '\\u2028')
            .replace(/\u2029/gu, '\\u2029');
    }

    function embeddedPayloadHtml(payload) {
        return `${DATA_OPEN_TAG}${serializePayload(payload)}${DATA_CLOSE_TAG}`;
    }

    function nextDataOpenTag(html, fromIndex = 0) {
        const current = html.indexOf(DATA_OPEN_TAG, fromIndex);
        const earlyV1 = html.indexOf(LEGACY_V1_DATA_OPEN_TAG, fromIndex);
        if (current < 0) return earlyV1 < 0 ? null : { index: earlyV1, tag: LEGACY_V1_DATA_OPEN_TAG };
        if (earlyV1 < 0 || current < earlyV1) return { index: current, tag: DATA_OPEN_TAG };
        return { index: earlyV1, tag: LEGACY_V1_DATA_OPEN_TAG };
    }

    function extractEmbeddedPayloadText(html) {
        const source = String(html || '');
        const opening = nextDataOpenTag(source);
        if (!opening) return null;
        const payloadStart = opening.index + opening.tag.length;
        const payloadEnd = source.indexOf(DATA_CLOSE_TAG, payloadStart);
        if (payloadEnd < 0) {
            throw transferError('INVALID_PAYLOAD', 'The embedded Session data is incomplete.');
        }
        if (nextDataOpenTag(source, payloadEnd + DATA_CLOSE_TAG.length)) {
            throw transferError('INVALID_PAYLOAD', 'The export contains multiple Session payloads.');
        }
        return source.slice(payloadStart, payloadEnd);
    }

    function validateEnvelope(raw) {
        if (!isRecord(raw) || raw.format !== FORMAT) {
            throw transferError('INVALID_PAYLOAD', 'This is not a Weft Session export.');
        }
        if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1) {
            throw transferError('INVALID_PAYLOAD', 'The Session export format version is invalid.');
        }
        if (raw.formatVersion > FORMAT_VERSION) {
            throw transferError('FUTURE_VERSION', 'This Session was exported by a newer transfer format.', {
                foundVersion: raw.formatVersion,
                supportedVersion: FORMAT_VERSION,
            });
        }
        if (raw.formatVersion !== FORMAT_VERSION) {
            throw transferError('UNSUPPORTED_VERSION', 'This Session export format is no longer supported.');
        }
        if (!Array.isArray(raw.requiredFeatures)) {
            throw transferError('INVALID_PAYLOAD', 'The Session requiredFeatures field is invalid.');
        }
        const unsupported = raw.requiredFeatures.filter((feature) =>
            typeof feature !== 'string' || !SUPPORTED_REQUIRED_FEATURES.has(feature));
        if (unsupported.length > 0) {
            throw transferError('UNSUPPORTED_FEATURES', 'This Session needs features supported by a newer Weft.', {
                unsupportedFeatures: unsupported,
            });
        }
        return raw;
    }

    function decodeHtmlEntities(value) {
        const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        return String(value || '').replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/giu,
            (whole, entity) => {
                const lower = entity.toLowerCase();
                if (Object.hasOwn(named, lower)) return named[lower];
                const isHex = lower.startsWith('#x');
                const number = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
                if (!Number.isFinite(number) || number < 0 || number > 0x10ffff) return whole;
                try { return String.fromCodePoint(number); } catch { return whole; }
            });
    }

    const LEGACY_VOID_TAGS = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr',
    ]);

    function htmlSpace(char) {
        return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
    }

    function htmlNameChar(char) {
        if (!char) return false;
        const code = char.charCodeAt(0);
        return (code >= 48 && code <= 57)
            || (code >= 65 && code <= 90)
            || (code >= 97 && code <= 122)
            || char === ':' || char === '-' || char === '_';
    }

    function legacyTagEnd(source, fromIndex) {
        let quote = '';
        for (let index = fromIndex; index < source.length; index++) {
            const char = source[index];
            if (quote) {
                if (char === quote) quote = '';
            } else if (char === '"' || char === "'") {
                quote = char;
            } else if (char === '>') {
                return index;
            }
        }
        return -1;
    }

    function legacyAttributes(raw, fromIndex) {
        const attributes = Object.create(null);
        let index = fromIndex;
        while (index < raw.length) {
            while (index < raw.length && htmlSpace(raw[index])) index++;
            if (index >= raw.length || raw[index] === '/') break;

            const nameStart = index;
            while (index < raw.length && htmlNameChar(raw[index])) index++;
            if (index === nameStart) {
                index++;
                continue;
            }
            const name = raw.slice(nameStart, index).toLowerCase();
            while (index < raw.length && htmlSpace(raw[index])) index++;
            let value = '';
            if (raw[index] === '=') {
                index++;
                while (index < raw.length && htmlSpace(raw[index])) index++;
                const quote = raw[index] === '"' || raw[index] === "'" ? raw[index++] : '';
                const valueStart = index;
                if (quote) {
                    while (index < raw.length && raw[index] !== quote) index++;
                    value = raw.slice(valueStart, index);
                    if (raw[index] === quote) index++;
                } else {
                    while (index < raw.length && !htmlSpace(raw[index])) {
                        if (raw[index] === '/') {
                            let remainder = index + 1;
                            while (remainder < raw.length && htmlSpace(raw[remainder])) remainder++;
                            if (remainder === raw.length) break;
                        }
                        index++;
                    }
                    value = raw.slice(valueStart, index);
                }
            }
            if (!Object.hasOwn(attributes, name)) attributes[name] = value;
        }
        return attributes;
    }

    function parseLegacyTag(raw) {
        if (raw.length > MAX_LEGACY_TAG_CHARS) {
            throw transferError('TOO_LARGE', 'A legacy HTML tag exceeds the safe parsing limit.');
        }
        let index = 0;
        while (index < raw.length && htmlSpace(raw[index])) index++;
        if (raw[index] === '!' || raw[index] === '?') return null;
        const closing = raw[index] === '/';
        if (closing) {
            index++;
            while (index < raw.length && htmlSpace(raw[index])) index++;
        }
        const nameStart = index;
        while (index < raw.length && htmlNameChar(raw[index])) index++;
        if (index === nameStart) return null;
        const tag = raw.slice(nameStart, index).toLowerCase();
        if (closing) return { tag, closing: true, selfClosing: false, attributes: Object.create(null) };

        let tail = raw.length - 1;
        while (tail >= index && htmlSpace(raw[tail])) tail--;
        return {
            tag,
            closing: false,
            selfClosing: raw[tail] === '/' || LEGACY_VOID_TAGS.has(tag),
            attributes: legacyAttributes(raw, index),
        };
    }

    /**
     * Parse the small, static subset of HTML emitted by old Weft exports.
     * Every cursor only moves forward; malformed input is bounded by node,
     * depth and tag-size limits so an imported file cannot trigger regex
     * backtracking or an unbounded parser stack.
     */
    function parseLegacyDocument(html) {
        const source = String(html || '');
        const root = { tag: '#document', attributes: Object.create(null), children: [] };
        const stack = [root];
        let nodeCount = 1;
        let cursor = 0;

        function append(child) {
            if (typeof child === 'string' && !child) return;
            nodeCount++;
            if (nodeCount > MAX_LEGACY_NODES) {
                throw transferError('TOO_LARGE', 'The legacy HTML contains too many nodes.');
            }
            stack[stack.length - 1].children.push(child);
        }

        while (cursor < source.length) {
            const opening = source.indexOf('<', cursor);
            if (opening < 0) {
                append(source.slice(cursor));
                break;
            }
            append(source.slice(cursor, opening));

            if (source.startsWith('<!--', opening)) {
                const commentEnd = source.indexOf('-->', opening + 4);
                if (commentEnd < 0) {
                    throw transferError('INVALID_PAYLOAD', 'The legacy HTML contains an incomplete comment.');
                }
                cursor = commentEnd + 3;
                continue;
            }

            const end = legacyTagEnd(source, opening + 1);
            if (end < 0) {
                throw transferError('INVALID_PAYLOAD', 'The legacy HTML contains an incomplete tag.');
            }
            if (end - opening - 1 > MAX_LEGACY_TAG_CHARS) {
                throw transferError('TOO_LARGE', 'A legacy HTML tag exceeds the safe parsing limit.');
            }
            const parsed = parseLegacyTag(source.slice(opening + 1, end));
            cursor = end + 1;
            if (!parsed) continue;
            if (parsed.tag === 'script') {
                throw transferError('INVALID_PAYLOAD', 'Legacy Session exports cannot contain scripts.');
            }

            if (parsed.closing) {
                if (stack.length === 1 || stack[stack.length - 1].tag !== parsed.tag) {
                    throw transferError('INVALID_PAYLOAD', 'The legacy HTML has mismatched tags.');
                }
                stack.pop();
                continue;
            }

            const node = { tag: parsed.tag, attributes: parsed.attributes, children: [] };
            append(node);
            if (!parsed.selfClosing) {
                stack.push(node);
                if (stack.length > MAX_LEGACY_DEPTH) {
                    throw transferError('TOO_LARGE', 'The legacy HTML nesting is too deep.');
                }
            }
        }

        if (stack.length !== 1) {
            throw transferError('INVALID_PAYLOAD', 'The legacy HTML contains unclosed tags.');
        }
        return root;
    }

    function legacyHasClass(node, wanted) {
        const value = node?.attributes?.class;
        if (typeof value !== 'string') return false;
        let index = 0;
        while (index < value.length) {
            while (index < value.length && htmlSpace(value[index])) index++;
            const start = index;
            while (index < value.length && !htmlSpace(value[index])) index++;
            if (value.slice(start, index) === wanted) return true;
        }
        return false;
    }

    function legacyElements(root, predicate) {
        const found = [];
        const stack = [root];
        while (stack.length > 0) {
            const current = stack.pop();
            if (!current || typeof current === 'string') continue;
            if (predicate(current)) found.push(current);
            for (let index = current.children.length - 1; index >= 0; index--) {
                stack.push(current.children[index]);
            }
        }
        return found;
    }

    function firstLegacyElement(root, predicate) {
        return legacyElements(root, predicate)[0] || null;
    }

    function legacyText(root, excludedNode = null) {
        if (!root || root === excludedNode) return '';
        const pieces = [];
        const stack = [root];
        while (stack.length > 0) {
            const current = stack.pop();
            if (current === excludedNode) continue;
            if (typeof current === 'string') {
                pieces.push(current);
                continue;
            }
            for (let index = current.children.length - 1; index >= 0; index--) {
                stack.push(current.children[index]);
            }
        }
        return decodeHtmlEntities(pieces.join('')).trim();
    }

    function trimLegacySourceSeparator(value) {
        let end = value.length;
        while (end > 0) {
            const char = value[end - 1];
            if (!htmlSpace(char) && char !== '—' && char !== '-') break;
            end--;
        }
        return value.slice(0, end).trim();
    }

    function legacySessionName(documentRoot, fileName) {
        const metaNode = firstLegacyElement(documentRoot,
            node => node.tag === 'p' && legacyHasClass(node, 'meta'));
        const meta = legacyText(metaNode);
        if (meta) {
            const separator = meta.lastIndexOf(' · ');
            return (separator > 0 ? meta.slice(0, separator) : meta).trim();
        }
        const match = String(fileName || '').match(/^weft-snippets-(.+?)(?:-\d{4}-\d{2}-\d{2})?\.html?$/iu);
        return match ? match[1].replace(/[-_]+/gu, ' ').trim() : '';
    }

    function legacySnippet(itemNode, index) {
        const preNode = firstLegacyElement(itemNode, node => node.tag === 'pre');
        const emNode = preNode ? null : firstLegacyElement(itemNode, node => node.tag === 'em');
        const pre = legacyText(preNode);
        const imageReference = legacyText(emNode);
        const sourceElement = firstLegacyElement(itemNode,
            node => node.tag === 'div' && legacyHasClass(node, 'snippet-source'));
        let sourceUrl = '';
        let sourceTitle = '';
        if (sourceElement) {
            const anchor = firstLegacyElement(sourceElement, node => node.tag === 'a');
            if (anchor) {
                sourceUrl = safeHttpUrl(decodeHtmlEntities(anchor.attributes.href || legacyText(anchor)));
                sourceTitle = trimLegacySourceSeparator(legacyText(sourceElement, anchor));
            } else {
                sourceTitle = legacyText(sourceElement);
            }
        }

        const tags = legacyElements(itemNode,
            node => node.tag === 'span' && legacyHasClass(node, 'tag'))
            .map((node) => {
                let tag = legacyText(node);
                while (tag.startsWith('#')) tag = tag.slice(1);
                return tag;
            });
        const commentNode = firstLegacyElement(itemNode,
            node => node.tag === 'div' && legacyHasClass(node, 'snippet-comment'));
        let comment = legacyText(commentNode);
        if (comment.startsWith('💬')) {
            comment = comment.slice('💬'.length).trimStart();
        }
        const safeImageReference = safeHttpUrl(imageReference);
        const safePreReference = safeHttpUrl(pre);
        const raw = safeImageReference
            ? {
                type: 'image', content: imageReference, imageUrl: safeImageReference,
                sourceUrl, sourceTitle, comment, tags,
            }
            : safePreReference
                ? { type: 'link', content: pre, linkUrl: safePreReference, sourceUrl, sourceTitle, comment, tags }
                : { type: 'text', content: pre || imageReference, sourceUrl, sourceTitle, comment, tags };
        if (!raw.content) {
            throw transferError('INVALID_SNIPPET', `Legacy snippet ${index + 1} has no usable content.`);
        }
        return raw;
    }

    function parseLegacyHtml(html, options = {}) {
        const documentRoot = parseLegacyDocument(html);
        const list = firstLegacyElement(documentRoot,
            node => node.tag === 'div' && legacyHasClass(node, 'snippets-list'));
        const items = list
            ? legacyElements(list, node => node.tag === 'div' && legacyHasClass(node, 'snippet-item'))
            : [];
        if (items.length === 0) {
            throw transferError('NOT_WEFT_EXPORT', 'This HTML file is not a Weft Session export.');
        }
        if (items.length > MAX_SNIPPETS) {
            throw transferError('TOO_MANY_SNIPPETS', 'The legacy Session has too many snippets.');
        }
        const session = normalizedSession({
            name: legacySessionName(documentRoot, options.fileName),
            snippets: items.map((item, index) => legacySnippet(item, index)),
        }, { importing: true });
        return {
            format: FORMAT,
            formatVersion: 0,
            exporter: { name: 'Weft', version: '', versionName: '' },
            session,
            legacy: true,
            convertedImages: session.convertedImages,
        };
    }

    function parseHtml(html, options = {}) {
        if (typeof html !== 'string' || !html.trim()) {
            throw transferError('NOT_WEFT_EXPORT', 'The selected HTML file is empty.');
        }
        if (html.length > MAX_HTML_CHARS) {
            throw transferError('TOO_LARGE', 'The selected HTML file exceeds the import limit.');
        }

        const embedded = extractEmbeddedPayloadText(html);
        if (embedded === null) {
            // Any appearance of the reserved marker without the exact stable
            // sentinel is a damaged or tampered v1 file. Never downgrade it to
            // the permissive legacy reader, including unquoted id attributes.
            if (html.includes(DATA_ELEMENT_ID)) {
                throw transferError('INVALID_PAYLOAD', 'The embedded Session data is incomplete.');
            }
            return parseLegacyHtml(html, options);
        }

        let raw;
        try {
            raw = JSON.parse(embedded);
        } catch {
            throw transferError('INVALID_PAYLOAD', 'The embedded Session data is damaged.');
        }
        const envelope = validateEnvelope(raw);
        const session = normalizedSession(envelope.session, { importing: true });
        return {
            format: FORMAT,
            formatVersion: envelope.formatVersion,
            exportedAt: typeof envelope.exportedAt === 'string' ? envelope.exportedAt : '',
            exporter: isRecord(envelope.exporter) ? {
                name: strictString(envelope.exporter.name, 80, 'Exporter name'),
                version: strictString(envelope.exporter.version, 80, 'Exporter version'),
                versionName: strictString(envelope.exporter.versionName, 120, 'Exporter version name'),
            } : { name: '', version: '', versionName: '' },
            session,
            legacy: false,
            convertedImages: session.convertedImages,
        };
    }

    function createImportedSnippetIds(snippets, idFactory) {
        const factory = typeof idFactory === 'function'
            ? idFactory
            : () => globalThis.crypto?.randomUUID?.()
                || `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
        const used = new Set();
        return snippets.map((snippet, index) => {
            let base = cleanString(factory(index), 160).trim();
            if (!base) base = `import-${Date.now().toString(36)}-${index.toString(36)}`;
            let id = base;
            let suffix = 2;
            while (used.has(id)) id = `${base.slice(0, 145)}-${suffix++}`;
            used.add(id);
            return { ...snippet, id };
        });
    }

    function prepareImport(parsed, options = {}) {
        if (!isRecord(parsed) || !isRecord(parsed.session)) {
            throw transferError('INVALID_PAYLOAD', 'The parsed Session is invalid.');
        }
        return {
            sessionName: parsed.session.name,
            snippets: createImportedSnippetIds(parsed.session.snippets, options.idFactory),
            formatVersion: parsed.formatVersion,
            exporterVersion: parsed.exporter?.versionName || parsed.exporter?.version || '',
            legacy: parsed.legacy === true,
            convertedImages: parsed.convertedImages || 0,
        };
    }

    function safeFilenamePart(value) {
        const text = cleanString(value, 120, { normalize: true }).trim()
            .replace(/[<>:"/\\|?*]/gu, '-')
            .replace(/[. ]+$/gu, '')
            .replace(/\s+/gu, ' ');
        return text || 'session';
    }

    return {
        FORMAT,
        FORMAT_VERSION,
        DATA_ELEMENT_ID,
        MAX_HTML_BYTES,
        MAX_SNIPPETS,
        createPayload,
        serializePayload,
        embeddedPayloadHtml,
        extractEmbeddedPayloadText,
        parseHtml,
        prepareImport,
        safeHttpUrl,
        safeFilenamePart,
    };
})();
