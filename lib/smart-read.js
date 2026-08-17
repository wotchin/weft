/**
 * Weft — pure helpers for the Smart Read pipeline.
 *
 * This module deliberately has no browser or storage dependencies. LLM output
 * and page DOM data are both untrusted inputs: validators project them onto a
 * small schema, and snippet builders revalidate before producing anything that
 * may be persisted by a caller.
 */
/* exported SmartRead */

const SmartRead = (() => {
    'use strict';

    const LIMITS = Object.freeze({
        sessionTitle: 80,
        topic: 240,
        takeawayTitle: 120,
        takeawaySummary: 600,
        takeaways: 8,
        evidencePerTakeaway: 4,
        evidenceQuoteMin: 8,
        evidenceQuoteMax: 1200,
        evidenceOriginalMax: 2000,
        selections: 12,
        selectionReason: 400,
        selectionCategory: 60,
        linkText: 500,
        linkHref: 4096,
        pageBlock: 200000,
        analysisChars: 24000,
        diagnosticErrors: 40,
    });

    const MAX_RAW_TAKEAWAYS = 64;
    const MAX_RAW_EVIDENCE = 32;
    const MAX_RAW_SELECTIONS = 64;
    const DEFAULT_SESSION_TITLE = 'Smart Read';
    const FORBIDDEN_SESSION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

    const KIND_TAGS = Object.freeze({
        fact: 'key-point',
        factual: 'key-point',
        claim: 'key-point',
        finding: 'key-point',
        data: 'data',
        statistic: 'data',
        statistics: 'data',
        number: 'data',
        metric: 'data',
        quote: 'quote',
        quotation: 'quote',
        context: 'reference',
        background: 'reference',
        reference: 'reference',
        analysis: 'key-point',
        insight: 'key-point',
        implication: 'key-point',
        opinion: 'opinion',
        perspective: 'opinion',
        definition: 'definition',
        example: 'example',
        risk: 'key-point',
        warning: 'key-point',
        recommendation: 'key-point',
        action: 'key-point',
        key: 'key-point',
        takeaway: 'key-point',
        'key-point': 'key-point',
    });

    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function collapseWhitespace(value) {
        return value.replace(/\s+/gu, ' ').trim();
    }

    function truncateCodePoints(value, limit) {
        const points = Array.from(value);
        return points.length <= limit ? value : points.slice(0, limit).join('').trim();
    }

    function cleanSessionCandidate(value) {
        if (typeof value !== 'string') return '';
        let result = value;
        try { result = result.normalize('NFKC'); } catch {}
        result = result
            // Control and bidi-control characters do not belong in a visible
            // session key. Removing them also avoids misleading UI labels.
            .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
            .replace(/[\u200b-\u200f\u2060\ufeff]/gu, '');
        result = collapseWhitespace(result);
        result = truncateCodePoints(result, LIMITS.sessionTitle);
        if (result === '.' || result === '..' || FORBIDDEN_SESSION_KEYS.has(result.toLowerCase())) return '';
        return result;
    }

    /**
     * Produce a safe, bounded session object key. The fallback passes through
     * the same sanitization and cannot reintroduce prototype-sensitive names.
     */
    function sanitizeSessionTitle(input, fallback = DEFAULT_SESSION_TITLE) {
        const primary = cleanSessionCandidate(input);
        if (primary) return primary;
        const secondary = cleanSessionCandidate(fallback);
        return secondary || DEFAULT_SESSION_TITLE;
    }

    /** Stable FNV-1a hash for lightweight identities (not cryptographic). */
    function fingerprint(input) {
        const value = typeof input === 'string' ? input : '';
        let hash = 0x811c9dc5;
        for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    /**
     * Normalize text for evidence matching while keeping a reverse map to the
     * original UTF-16 offsets. Matching is intentionally case-sensitive and
     * does not remove punctuation: only Unicode compatibility forms and runs
     * of whitespace are normalized, so a paraphrase cannot pass as evidence.
     */
    function normalizeWithMap(input) {
        const original = typeof input === 'string' ? input : '';
        let normalized = '';
        const starts = [];
        const ends = [];

        for (let offset = 0; offset < original.length;) {
            const codePoint = original.codePointAt(offset);
            let sourceChar = String.fromCodePoint(codePoint);
            let sourceEnd = offset + sourceChar.length;
            // Keep a base character and following combining marks together so
            // canonically equivalent composed/decomposed text still matches.
            while (sourceEnd < original.length) {
                const next = String.fromCodePoint(original.codePointAt(sourceEnd));
                if (!/^\p{M}$/u.test(next)) break;
                sourceChar += next;
                sourceEnd += next.length;
            }
            let folded = sourceChar;
            try { folded = sourceChar.normalize('NFKC'); } catch {}

            for (const outputChar of folded) {
                if (/\s/u.test(outputChar)) {
                    if (normalized && normalized[normalized.length - 1] !== ' ') {
                        normalized += ' ';
                        starts.push(offset);
                        ends.push(sourceEnd);
                    } else if (normalized && ends.length > 0) {
                        // Include every original whitespace character in the
                        // recovered range even though it is one match token.
                        ends[ends.length - 1] = sourceEnd;
                    }
                    continue;
                }

                normalized += outputChar;
                // A compatibility-normalized code point may expand to several
                // UTF-16 units. Every unit maps back to the same source span.
                for (let i = 0; i < outputChar.length; i++) {
                    starts.push(offset);
                    ends.push(sourceEnd);
                }
            }
            offset = sourceEnd;
        }

        if (normalized.endsWith(' ')) {
            normalized = normalized.slice(0, -1);
            starts.pop();
            ends.pop();
        }

        return { original, normalized, starts, ends };
    }

    function normalizeForMatch(input) {
        return normalizeWithMap(input).normalized;
    }

    function projectBlock(block, index) {
        if (!isRecord(block) || typeof block.id !== 'string' || !block.id.trim()) return null;
        if (typeof block.text !== 'string' || !block.text.trim() || block.text.length > LIMITS.pageBlock) return null;
        const projected = {
            id: block.id.trim(),
            text: block.text,
            tag: typeof block.tag === 'string' ? block.tag.slice(0, 40) : '',
            _index: index,
        };
        if (Number.isInteger(block.pageNumber) && block.pageNumber > 0) {
            projected.pageNumber = block.pageNumber;
        }
        return projected;
    }

    function validBlocks(page) {
        if (!isRecord(page) || !Array.isArray(page.blocks)) return [];
        const seen = new Set();
        const blocks = [];
        page.blocks.forEach((block, index) => {
            const projected = projectBlock(block, index);
            if (!projected || seen.has(projected.id)) return;
            seen.add(projected.id);
            blocks.push(projected);
        });
        return blocks;
    }

    /**
     * Locate a normalized-exact quote in one block and recover the untouched
     * source substring. A supplied blockId is authoritative; it never falls
     * back to another block. Omit blockId only for the legacy quotes schema.
     */
    function locateQuote(page, quote, blockId) {
        if (typeof quote !== 'string') return null;
        const needle = normalizeForMatch(quote);
        if (needle.length < LIMITS.evidenceQuoteMin || needle.length > LIMITS.evidenceQuoteMax) return null;

        const blocks = validBlocks(page);
        const hasPreferredBlock = typeof blockId === 'string' && blockId.trim() !== '';
        const candidates = hasPreferredBlock
            ? blocks.filter((block) => block.id === blockId.trim())
            : blocks;

        for (const block of candidates) {
            const haystack = normalizeWithMap(block.text);
            const normalizedStart = haystack.normalized.indexOf(needle);
            if (normalizedStart < 0) continue;
            const normalizedEnd = normalizedStart + needle.length;
            const start = haystack.starts[normalizedStart];
            const end = haystack.ends[normalizedEnd - 1];
            if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) continue;
            const originalQuote = block.text.slice(start, end);
            if (!originalQuote || originalQuote.length > LIMITS.evidenceOriginalMax) continue;
            return {
                blockId: block.id,
                quote: originalQuote,
                blockIndex: block._index,
                start,
                end,
                tag: block.tag,
                pageNumber: block.pageNumber,
            };
        }
        return null;
    }

    function readBoundedString(value, max, min = 1) {
        if (typeof value !== 'string') return null;
        const cleaned = collapseWhitespace(value);
        return cleaned.length >= min && cleaned.length <= max ? cleaned : null;
    }

    function pushError(result, code) {
        if (result.errors.length < LIMITS.diagnosticErrors && !result.errors.includes(code)) {
            result.errors.push(code);
        }
    }

    function baseResult(raw, page, collectionName) {
        const fallback = isRecord(page) && typeof page.title === 'string' ? page.title : DEFAULT_SESSION_TITLE;
        const suppliedTitle = isRecord(raw) ? raw.sessionTitle : '';
        const result = {
            sessionTitle: sanitizeSessionTitle(suppliedTitle, fallback),
            topic: '',
            [collectionName]: [],
            errors: [],
            omittedCount: 0,
        };
        if (!isRecord(raw)) {
            pushError(result, 'invalid-analysis');
            return result;
        }
        if (typeof raw.sessionTitle !== 'string' || !cleanSessionCandidate(raw.sessionTitle)) {
            pushError(result, 'invalid-session-title');
        }
        const topic = readBoundedString(raw.topic, LIMITS.topic);
        if (topic) result.topic = topic;
        else pushError(result, 'invalid-topic');
        return result;
    }

    function mapEvidenceKind(value, fallbackTag = '') {
        if (typeof value === 'string') {
            const key = collapseWhitespace(value).toLowerCase().replace(/[_\s]+/gu, '-');
            if (key.length > 40) return null;
            if (KIND_TAGS[key]) return KIND_TAGS[key];
            // Unknown model-provided labels do not become arbitrary user tags.
            return key ? 'key-point' : null;
        }
        const tag = typeof fallbackTag === 'string' ? fallbackTag.toLowerCase() : '';
        if (tag === 'blockquote' || tag === 'q') return 'quote';
        if (/^h[1-6]$/u.test(tag)) return 'reference';
        return 'key-point';
    }

    function validateEvidence(candidate, page, legacy) {
        let quote;
        let blockId;
        let kind;

        if (legacy) {
            quote = candidate;
            blockId = undefined;
            kind = null;
        } else {
            if (!isRecord(candidate)) return null;
            quote = candidate.quote;
            blockId = candidate.blockId;
            if (typeof blockId !== 'string' || !blockId.trim()) return null;
            if (typeof candidate.kind !== 'string') return null;
            kind = mapEvidenceKind(candidate.kind);
            if (!kind) return null;
        }

        if (typeof quote !== 'string') return null;
        const normalizedQuote = normalizeForMatch(quote);
        if (normalizedQuote.length < LIMITS.evidenceQuoteMin || normalizedQuote.length > LIMITS.evidenceQuoteMax) {
            return null;
        }

        const located = locateQuote(page, quote, blockId);
        if (!located) return null;
        return {
            blockId: located.blockId,
            quote: located.quote,
            kind: kind || mapEvidenceKind(null, located.tag),
            ...(located.pageNumber ? { pageNumber: located.pageNumber } : {}),
        };
    }

    /**
     * Validate the article response schema and discard every unverified quote.
     * Legacy `quotes: string[]` is accepted only when `evidence` is absent; its
     * strings must still be found verbatim (after whitespace normalization).
     */
    function validateArticleAnalysis(raw, page) {
        const result = baseResult(raw, page, 'takeaways');
        if (!isRecord(raw)) return result;
        if (!Array.isArray(raw.takeaways)) {
            pushError(result, 'invalid-takeaways');
            return result;
        }

        const globalEvidence = new Set();
        const seenTakeaways = new Set();
        const scanCount = Math.min(raw.takeaways.length, MAX_RAW_TAKEAWAYS);
        if (raw.takeaways.length > scanCount) result.omittedCount += raw.takeaways.length - scanCount;

        for (let i = 0; i < scanCount; i++) {
            if (result.takeaways.length >= LIMITS.takeaways) {
                result.omittedCount += scanCount - i;
                break;
            }

            const item = raw.takeaways[i];
            if (!isRecord(item)) {
                result.omittedCount++;
                pushError(result, 'invalid-takeaway');
                continue;
            }
            const title = readBoundedString(item.title, LIMITS.takeawayTitle);
            const summary = readBoundedString(item.summary, LIMITS.takeawaySummary);
            if (!title || !summary) {
                result.omittedCount++;
                pushError(result, 'invalid-takeaway-text');
                continue;
            }

            const takeawayKey = fingerprint(`${title.toLowerCase()}\n${summary.toLowerCase()}`);
            if (seenTakeaways.has(takeawayKey)) {
                result.omittedCount++;
                pushError(result, 'duplicate-takeaway');
                continue;
            }

            const legacy = !Array.isArray(item.evidence) && Array.isArray(item.quotes);
            const evidenceInput = Array.isArray(item.evidence)
                ? item.evidence
                : (legacy ? item.quotes : null);
            if (!evidenceInput) {
                result.omittedCount++;
                pushError(result, 'invalid-evidence');
                continue;
            }

            const evidence = [];
            const scanEvidence = Math.min(evidenceInput.length, MAX_RAW_EVIDENCE);
            if (evidenceInput.length > scanEvidence) result.omittedCount += evidenceInput.length - scanEvidence;
            for (let j = 0; j < scanEvidence; j++) {
                if (evidence.length >= LIMITS.evidencePerTakeaway) {
                    result.omittedCount += scanEvidence - j;
                    break;
                }
                const validated = validateEvidence(evidenceInput[j], page, legacy);
                if (!validated) {
                    result.omittedCount++;
                    pushError(result, 'unverified-evidence');
                    continue;
                }
                const quoteKey = fingerprint(normalizeForMatch(validated.quote).toLowerCase());
                if (globalEvidence.has(quoteKey)) {
                    result.omittedCount++;
                    pushError(result, 'duplicate-evidence');
                    continue;
                }
                globalEvidence.add(quoteKey);
                evidence.push(validated);
            }

            if (evidence.length === 0) {
                pushError(result, 'takeaway-without-evidence');
                continue;
            }
            seenTakeaways.add(takeawayKey);
            result.takeaways.push({ title, summary, evidence });
        }

        if (result.takeaways.length === 0) pushError(result, 'no-valid-takeaways');
        return result;
    }

    function projectLink(link) {
        if (!isRecord(link) || typeof link.id !== 'string' || !link.id.trim()) return null;
        const text = readBoundedString(link.text, LIMITS.linkText);
        const href = readBoundedString(link.href, LIMITS.linkHref);
        if (!text || !href || !/^https?:\/\//iu.test(href)) return null;
        return {
            id: link.id.trim(),
            text,
            href,
            section: typeof link.section === 'string'
                ? collapseWhitespace(link.section).slice(0, 120)
                : '',
        };
    }

    function knownLinks(page) {
        const links = new Map();
        if (!isRecord(page) || !Array.isArray(page.links)) return links;
        for (const candidate of page.links) {
            const link = projectLink(candidate);
            if (link && !links.has(link.id)) links.set(link.id, link);
        }
        return links;
    }

    /** Keep broad DOM coverage when a homepage contains hundreds of links. */
    function selectLinksForAnalysis(links, maxLinks = 80) {
        const known = knownLinks({ links });
        const valid = [...known.values()];
        const limit = Number.isFinite(maxLinks)
            ? Math.max(0, Math.min(200, Math.floor(maxLinks)))
            : 0;
        if (limit === 0 || valid.length === 0) return [];
        if (valid.length <= limit) return valid;
        if (limit === 1) return [valid[0]];

        const indices = new Set();
        for (let i = 0; i < limit; i++) {
            indices.add(Math.round(i * (valid.length - 1) / (limit - 1)));
        }
        return [...indices].sort((a, b) => a - b).map((index) => valid[index]);
    }

    /** Validate homepage/index selections against extractor-issued link IDs. */
    function validateIndexAnalysis(raw, page) {
        const result = baseResult(raw, page, 'selections');
        if (!isRecord(raw)) return result;
        if (!Array.isArray(raw.selections)) {
            pushError(result, 'invalid-selections');
            return result;
        }

        const links = knownLinks(page);
        const seen = new Set();
        const scanCount = Math.min(raw.selections.length, MAX_RAW_SELECTIONS);
        if (raw.selections.length > scanCount) result.omittedCount += raw.selections.length - scanCount;

        for (let i = 0; i < scanCount; i++) {
            if (result.selections.length >= LIMITS.selections) {
                result.omittedCount += scanCount - i;
                break;
            }
            const item = raw.selections[i];
            if (!isRecord(item) || typeof item.linkId !== 'string') {
                result.omittedCount++;
                pushError(result, 'invalid-selection');
                continue;
            }
            const linkId = item.linkId.trim();
            const link = links.get(linkId);
            const reason = readBoundedString(item.reason, LIMITS.selectionReason);
            if (!link || !reason) {
                result.omittedCount++;
                pushError(result, link ? 'invalid-selection-reason' : 'unknown-link-id');
                continue;
            }
            if (seen.has(linkId)) {
                result.omittedCount++;
                pushError(result, 'duplicate-selection');
                continue;
            }

            let category;
            if (item.category !== undefined) {
                category = readBoundedString(item.category, LIMITS.selectionCategory);
                if (!category) {
                    result.omittedCount++;
                    pushError(result, 'invalid-selection-category');
                    continue;
                }
            }

            seen.add(linkId);
            const selection = { linkId, reason, link };
            if (category) selection.category = category;
            result.selections.push(selection);
        }

        if (result.selections.length === 0) pushError(result, 'no-valid-selections');
        return result;
    }

    function sliceForPosition(text, size, position) {
        if (text.length <= size) return text;
        if (position === 'end') return text.slice(text.length - size);
        if (position === 'middle') {
            const start = Math.max(0, Math.floor((text.length - size) / 2));
            return text.slice(start, start + size);
        }
        return text.slice(0, size);
    }

    function exposedBlock(block, text) {
        return {
            id: block.id,
            text,
            tag: block.tag,
            ...(block.pageNumber ? { pageNumber: block.pageNumber } : {}),
        };
    }

    /**
     * Build a character-bounded, stratified block sample. When the document is
     * too large, the first, middle and last valid blocks each receive a fair
     * share before additional blocks are considered.
     */
    function selectBlocksForAnalysis(blocks, maxChars) {
        const page = { blocks: Array.isArray(blocks) ? blocks : [] };
        const valid = validBlocks(page);
        const budget = maxChars === undefined
            ? LIMITS.analysisChars
            : (Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0);
        if (valid.length === 0 || budget === 0) return [];

        const totalLength = valid.reduce((total, block) => total + block.text.length, 0);
        if (totalLength <= budget) return valid.map((block) => exposedBlock(block, block.text));

        const middle = Math.floor((valid.length - 1) / 2);
        const anchorIndices = [...new Set([0, middle, valid.length - 1])];
        const chosen = new Map();
        let remaining = budget;

        for (let i = 0; i < anchorIndices.length && remaining > 0; i++) {
            const index = anchorIndices[i];
            const anchorsLeft = anchorIndices.length - i;
            const allocation = Math.min(
                valid[index].text.length,
                Math.max(1, Math.floor(remaining / anchorsLeft))
            );
            const position = index === 0 ? 'start' : (index === valid.length - 1 ? 'end' : 'middle');
            const text = sliceForPosition(valid[index].text, allocation, position);
            if (text) {
                chosen.set(index, exposedBlock(valid[index], text));
                remaining -= text.length;
            }
        }

        // Short anchor blocks can leave budget behind. Add blocks that are
        // farthest from those already selected, preserving broad coverage.
        while (remaining > 0 && chosen.size < valid.length) {
            let nextIndex = -1;
            let bestDistance = -1;
            for (let i = 0; i < valid.length; i++) {
                if (chosen.has(i)) continue;
                const distance = Math.min(...Array.from(chosen.keys(), (selected) => Math.abs(i - selected)));
                if (distance > bestDistance) {
                    bestDistance = distance;
                    nextIndex = i;
                }
            }
            if (nextIndex < 0) break;
            const text = sliceForPosition(valid[nextIndex].text, Math.min(valid[nextIndex].text.length, remaining), 'start');
            if (!text) break;
            chosen.set(nextIndex, exposedBlock(valid[nextIndex], text));
            remaining -= text.length;
        }

        return [...chosen.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
    }

    function safeMetadataString(value, max = 200) {
        return typeof value === 'string' ? collapseWhitespace(value).slice(0, max) : '';
    }

    function snippetTimestamp(value) {
        return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    }

    function createSnippetId(idFactory, descriptor, usedIds) {
        let id = '';
        if (typeof idFactory === 'function') {
            try {
                const supplied = idFactory(descriptor, descriptor.index);
                if (typeof supplied === 'string') id = supplied.trim().slice(0, 200);
            } catch {}
        }
        if (!id || usedIds.has(id)) {
            id = `smart-${fingerprint(JSON.stringify(descriptor))}-${descriptor.index.toString(36)}`;
        }
        let unique = id;
        let suffix = 1;
        while (usedIds.has(unique)) unique = `${id}-${suffix++}`;
        usedIds.add(unique);
        return unique;
    }

    function buildSmartMetadata(options) {
        const opts = isRecord(options) ? options : {};
        return {
            runId: safeMetadataString(opts.runId),
            smartReadKey: safeMetadataString(opts.smartReadKey),
            timestamp: snippetTimestamp(opts.timestamp),
            idFactory: opts.idFactory,
        };
    }

    /** Build persistable text snippets from revalidated article evidence. */
    function buildArticleSnippets(validated, page, options = {}) {
        const analysis = validateArticleAnalysis(validated, page);
        const meta = buildSmartMetadata(options);
        const usedIds = new Set();
        const snippets = [];

        for (let takeawayIndex = 0; takeawayIndex < analysis.takeaways.length; takeawayIndex++) {
            const takeaway = analysis.takeaways[takeawayIndex];
            for (let evidenceIndex = 0; evidenceIndex < takeaway.evidence.length; evidenceIndex++) {
                const evidence = takeaway.evidence[evidenceIndex];
                const index = snippets.length;
                const isPdf = isRecord(page) && page.documentType === 'pdf';
                const sourcePageNumber = isPdf && Number.isInteger(evidence.pageNumber)
                    ? evidence.pageNumber
                    : null;
                const descriptor = {
                    type: 'article',
                    index,
                    runId: meta.runId,
                    smartReadKey: meta.smartReadKey,
                    sourceId: evidence.blockId,
                    sourcePageNumber,
                    contentFingerprint: fingerprint(evidence.quote),
                };
                snippets.push({
                    id: createSnippetId(meta.idFactory, descriptor, usedIds),
                    type: 'text',
                    content: evidence.quote,
                    comment: `${takeaway.title}: ${takeaway.summary}`,
                    sourceUrl: isRecord(page) && typeof page.url === 'string' ? page.url : '',
                    sourceTitle: isRecord(page) && typeof page.title === 'string' ? page.title : '',
                    timestamp: meta.timestamp,
                    tags: [mapEvidenceKind(evidence.kind) || 'key-point', 'smart-read', ...(isPdf ? ['pdf'] : [])],
                    smartReadKey: meta.smartReadKey,
                    smartReadRunId: meta.runId,
                    smartReadPageType: 'article',
                    smartReadTopic: analysis.topic,
                    smartReadSessionTitle: analysis.sessionTitle,
                    smartReadTakeawayIndex: takeawayIndex,
                    smartReadTakeawayTitle: takeaway.title,
                    smartReadSummary: takeaway.summary,
                    smartReadEvidenceKind: evidence.kind,
                    sourceBlockId: evidence.blockId,
                    ...(isPdf ? {
                        sourceDocumentType: 'pdf',
                        sourcePageNumber,
                        sourcePageCount: Number.isInteger(page.pageCount) ? page.pageCount : 0,
                    } : {}),
                });
            }
        }
        return snippets;
    }

    /** Build persistable link snippets from revalidated index selections. */
    function buildIndexSnippets(validated, page, options = {}) {
        const analysis = validateIndexAnalysis(validated, page);
        const meta = buildSmartMetadata(options);
        const usedIds = new Set();
        return analysis.selections.map((selection, index) => {
            const descriptor = {
                type: 'index',
                index,
                runId: meta.runId,
                smartReadKey: meta.smartReadKey,
                sourceId: selection.linkId,
                contentFingerprint: fingerprint(selection.link.text),
            };
            return {
                id: createSnippetId(meta.idFactory, descriptor, usedIds),
                type: 'link',
                content: selection.link.text,
                linkUrl: selection.link.href,
                comment: selection.reason,
                sourceUrl: selection.link.href,
                sourceTitle: selection.link.text,
                timestamp: meta.timestamp,
                tags: ['reference', 'smart-read'],
                smartReadKey: meta.smartReadKey,
                smartReadRunId: meta.runId,
                smartReadPageType: 'index',
                smartReadTopic: analysis.topic,
                smartReadSessionTitle: analysis.sessionTitle,
                smartReadReason: selection.reason,
                smartReadCategory: selection.category || '',
                smartReadSection: selection.link.section || '',
                sourcePageUrl: isRecord(page) && typeof page.url === 'string' ? page.url : '',
                sourceLinkId: selection.linkId,
            };
        });
    }

    /** Rebuild display data from the snippets that actually exist in storage. */
    function restoreAnalysisFromSnippets(snippets, pageType = 'article', fallback = {}) {
        const allItems = (Array.isArray(snippets) ? snippets : [])
            .filter((snippet) => isRecord(snippet));
        const requestedKey = isRecord(fallback) && typeof fallback.smartReadKey === 'string'
            ? fallback.smartReadKey
            : '';
        const keyedItems = allItems.filter((snippet) =>
            typeof snippet.smartReadKey === 'string' && snippet.smartReadKey
        );
        const items = requestedKey
            ? allItems.filter((snippet) => snippet.smartReadKey === requestedKey)
            : keyedItems.length ? keyedItems : allItems;
        const first = items[0] || {};
        const sessionTitle = sanitizeSessionTitle(
            first.smartReadSessionTitle,
            isRecord(fallback) ? fallback.sessionTitle : DEFAULT_SESSION_TITLE
        );
        const topic = safeMetadataString(
            first.smartReadTopic || (isRecord(fallback) ? fallback.topic : ''),
            LIMITS.topic
        );

        if (pageType === 'index') {
            const selections = [];
            for (const snippet of items) {
                if (snippet.type !== 'link') continue;
                const text = readBoundedString(snippet.content, LIMITS.linkText);
                const href = readBoundedString(snippet.linkUrl || snippet.sourceUrl, LIMITS.linkHref);
                const reason = readBoundedString(snippet.smartReadReason || snippet.comment, LIMITS.selectionReason);
                if (!text || !href || !reason || !/^https?:\/\//iu.test(href)) continue;
                const selection = {
                    linkId: safeMetadataString(snippet.sourceLinkId || snippet.id),
                    reason,
                    link: {
                        id: safeMetadataString(snippet.sourceLinkId || snippet.id),
                        text,
                        href,
                        section: safeMetadataString(snippet.smartReadSection, 120),
                    },
                };
                const category = safeMetadataString(snippet.smartReadCategory, LIMITS.selectionCategory);
                if (category) selection.category = category;
                selections.push(selection);
            }
            return { sessionTitle, topic, selections, errors: [], omittedCount: 0 };
        }

        const groups = new Map();
        for (const snippet of items) {
            if (snippet.type !== 'text' || typeof snippet.content !== 'string' || snippet.content.trim().length < 8) continue;
            const comment = safeMetadataString(snippet.comment, LIMITS.takeawaySummary + LIMITS.takeawayTitle + 2);
            const colon = comment.indexOf(':');
            const title = safeMetadataString(
                snippet.smartReadTakeawayTitle || (colon > 0 ? comment.slice(0, colon) : ''),
                LIMITS.takeawayTitle
            ) || 'Key point';
            const summary = safeMetadataString(
                snippet.smartReadSummary || (colon > 0 ? comment.slice(colon + 1) : comment),
                LIMITS.takeawaySummary
            );
            const explicitIndex = Number.isInteger(snippet.smartReadTakeawayIndex)
                ? snippet.smartReadTakeawayIndex
                : null;
            const groupKey = explicitIndex === null ? `${title}\n${summary}` : `index:${explicitIndex}`;
            if (!groups.has(groupKey)) groups.set(groupKey, { title, summary, evidence: [] });
            const group = groups.get(groupKey);
            if (group.evidence.some((entry) => entry.quote === snippet.content)) continue;
            const restoredEvidence = {
                blockId: safeMetadataString(snippet.sourceBlockId),
                quote: snippet.content,
                kind: mapEvidenceKind(snippet.smartReadEvidenceKind || snippet.tags?.[0]) || 'key-point',
            };
            if (Number.isInteger(snippet.sourcePageNumber) && snippet.sourcePageNumber > 0) {
                restoredEvidence.pageNumber = snippet.sourcePageNumber;
            }
            group.evidence.push(restoredEvidence);
        }
        return {
            sessionTitle,
            topic,
            takeaways: [...groups.values()].filter((group) => group.evidence.length > 0),
            errors: [],
            omittedCount: 0,
        };
    }

    return Object.freeze({
        LIMITS,
        sanitizeSessionTitle,
        fingerprint,
        normalizeForMatch,
        locateQuote,
        mapEvidenceKind,
        validateArticleAnalysis,
        validateIndexAnalysis,
        buildArticleSnippets,
        buildIndexSnippets,
        selectBlocksForAnalysis,
        selectLinksForAnalysis,
        restoreAnalysisFromSnippets,
    });
})();
