/**
 * RAGEngine — Orchestrator for the browser-side RAG pipeline.
 *
 * Decision chain (token-based routing):
 *   DIRECT: the complete Session fits both the direct threshold and request budget
 *   BM25:   lexical recall with a strict request budget
 *
 * VectorIndex is not wired into this orchestrator yet, so large-session results
 * are deliberately reported as BM25 rather than claiming hybrid retrieval.
 *
 * Entry point: RAGEngine.retrieve(query, sessionName, snippets, options)
 */
/* exported RAGEngine */
/* global WeftTokenizer, BM25Index, RAGIndexer */

const RAGEngine = (() => {
    'use strict';

    // Thresholds (in estimated tokens)
    const DIRECT_THRESHOLD = 15000;
    const LARGE_SESSION_THRESHOLD = 80000;
    const DEFAULT_TOKEN_BUDGET = 12000;

    // Each retrieval retains its own snapshot. Publishing a newer snapshot can
    // therefore never change the maps used by an already-running retrieval.
    const _sessionStates = new Map();
    const _buildJobs = new Map();
    const _boundedSessionCache = new WeakMap();

    function abortError(signal) {
        if (signal?.reason?.name === 'AbortError') return signal.reason;
        const error = new Error('RAG operation was aborted.');
        error.name = 'AbortError';
        if (signal?.reason !== undefined) error.cause = signal.reason;
        return error;
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) throw abortError(signal);
    }

    async function yieldToMainThread(signal) {
        throwIfAborted(signal);
        await new Promise((resolve) => setTimeout(resolve, 0));
        throwIfAborted(signal);
    }

    function getSessionState(sessionName) {
        let state = _sessionStates.get(sessionName);
        if (!state) {
            state = {
                generation: 0,
                revision: null,
                snapshot: null,
                sourceSnippets: null,
                tokenSource: null,
                totalTokens: null,
            };
            _sessionStates.set(sessionName, state);
        }
        return state;
    }

    function staleGenerationError() {
        const error = new Error('The session changed while its RAG index was being prepared.');
        error.code = 'RAG_STALE_GENERATION';
        return error;
    }

    function boundedSourceText(value, maxLength = 300) {
        return String(value || '')
            .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, ' ')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, maxLength);
    }

    /**
     * Return the only URL-derived label that may be sent to an LLM. Full source
     * URLs stay in the local citation manifest: query strings, fragments,
     * credentials, and path tokens are deliberately excluded here.
     */
    function llmUrlLabel(value) {
        try {
            const url = new URL(String(value || ''));
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
            return boundedSourceText(url.hostname, 253);
        } catch {
            return '';
        }
    }

    function llmSourceLabel(snippet) {
        if (!snippet || typeof snippet !== 'object') return '';
        const title = boundedSourceText(snippet.sourceTitle, 300);
        const host = llmUrlLabel(snippet.sourceUrl || snippet.sourcePageUrl || snippet.linkUrl);
        const base = title && host && !title.toLowerCase().includes(host.toLowerCase())
            ? `${title} (${host})`
            : (title || host);
        const page = snippet.sourceDocumentType === 'pdf' && Number.isInteger(snippet.sourcePageNumber)
            ? ` (PDF page ${snippet.sourcePageNumber})`
            : '';
        return `${base}${page}`.trim();
    }

    function neutralizeCitationMarkers(value) {
        return String(value || '').replace(/\[([SW][1-9]\d{0,5})\]/giu, '［$1］');
    }

    function promptSnippetBlock(snippet, index, visionEnabled = false) {
        const item = snippet && typeof snippet === 'object' ? snippet : {};
        const source = llmSourceLabel(item);
        const tags = Array.isArray(item.tags)
            ? neutralizeCitationMarkers(item.tags.join(', ')).replace(/\s+/gu, ' ').trim().slice(0, 240)
            : '';
        const comment = typeof item.comment === 'string'
            ? neutralizeCitationMarkers(item.comment)
            : '';
        let text = '';

        if (item.type === 'image') {
            if (visionEnabled) {
                text += `\n[S${index + 1}] (image — embedded in the conversation)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n`;
            } else {
                text += `\n[S${index + 1}] (image, not displayed - model does not support vision)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\nNote: This is an image snippet. The image cannot be displayed because the current model does not support vision.\n`;
            }
        } else {
            const content = typeof item.content === 'string'
                ? neutralizeCitationMarkers(item.content)
                : '';
            const linkHost = item.type === 'link' ? llmUrlLabel(item.linkUrl) : '';
            const link = linkHost ? `\nResearch lead host: ${linkHost}` : '';
            text += `\n[S${index + 1}]${item.type === 'link' ? ' (saved link — not yet verified)' : ''}${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n${content}${link}\n`;
        }
        if (comment) text += `[User's note]: ${comment}\n`;
        return text;
    }

    function promptContextText(snippets, method = 'DIRECT', totalCount, visionEnabled = false) {
        const items = Array.isArray(snippets) ? snippets : [];
        if (items.length === 0) return '';
        const knownTotal = Number.isFinite(Number(totalCount))
            ? Math.max(items.length, Math.floor(Number(totalCount)))
            : items.length;
        let text = '=== COLLECTED SNIPPETS ===\n';
        if (method === 'BOUNDED') {
            text += `(Context limit: showing ${items.length} representative snippets out of ${knownTotal} total.)\n`;
        } else if (method !== 'DIRECT') {
            text += `(Smart retrieval: showing ${items.length} most relevant snippets out of ${knownTotal} total, based on your query)\n`;
        }
        for (let index = 0; index < items.length; index++) {
            text += promptSnippetBlock(items[index], index, visionEnabled);
        }
        return `${text}\n=== END SNIPPETS ===\n`;
    }

    function promptContextOverheadTokens(method, totalCount, returnedCount) {
        const count = Math.max(0, Math.floor(Number(returnedCount) || 0));
        const knownTotal = Math.max(count, Math.floor(Number(totalCount) || 0));
        let text = '=== COLLECTED SNIPPETS ===\n';
        if (method === 'BOUNDED') {
            text += `(Context limit: showing ${count} representative snippets out of ${knownTotal} total.)\n`;
        } else if (method !== 'DIRECT') {
            text += `(Smart retrieval: showing ${count} most relevant snippets out of ${knownTotal} total, based on your query)\n`;
        }
        text += '\n=== END SNIPPETS ===\n';
        return WeftTokenizer.estimateTokens(text);
    }

    function promptSnippetTokens(snippet, index, visionEnabled = false) {
        return WeftTokenizer.estimateTokens(promptSnippetBlock(snippet, index, visionEnabled));
    }

    function promptContextTokens(snippets, method, totalCount, visionEnabled = false) {
        const items = Array.isArray(snippets) ? snippets : [];
        if (items.length === 0) return 0;
        let total = promptContextOverheadTokens(method, totalCount, items.length);
        for (let index = 0; index < items.length; index++) {
            // Summing individually rounded entries is intentionally conservative:
            // the fully serialized prompt can only be smaller than this estimate.
            total += promptSnippetTokens(items[index], index, visionEnabled);
        }
        return total;
    }

    function fitTextFieldToContext(candidate, field, fits) {
        const original = typeof candidate?.[field] === 'string' ? candidate[field] : '';
        if (!original) return candidate;
        let low = 0;
        let high = original.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            const projected = { ...candidate, [field]: original.slice(0, middle).trimEnd() };
            if (fits(projected)) low = middle;
            else high = middle - 1;
        }
        return { ...candidate, [field]: original.slice(0, low).trimEnd() };
    }

    /**
     * Project one stored snippet into the remaining prompt budget. Stored data is
     * never mutated; only the LLM-facing content/note may be shortened.
     */
    function fitPromptSnippet(selected, snippet, tokenBudget, method, totalCount) {
        const full = { ...(snippet || {}) };
        const selectedItems = Array.isArray(selected) ? selected : [];
        const nextIndex = selectedItems.length;
        const selectedTokens = selectedItems.reduce(
            (sum, item, index) => sum + promptSnippetTokens(item, index, false),
            0
        );
        const fits = (candidate) => (
            promptContextOverheadTokens(method, totalCount, nextIndex + 1)
            + selectedTokens
            + promptSnippetTokens(candidate, nextIndex, false)
        ) <= tokenBudget;
        if (fits(full)) return full;

        // Content is the primary evidence. Fit it first without a potentially
        // huge note, then spend any remaining space on the note.
        let projected = { ...full, comment: '' };
        if (!fits(projected)) projected = fitTextFieldToContext(projected, 'content', fits);
        if (!fits(projected)) return null;
        if (typeof full.comment === 'string' && full.comment) {
            projected = fitTextFieldToContext({ ...projected, comment: full.comment }, 'comment', fits);
        }

        const hasEvidence = projected.type === 'image'
            || Boolean(String(projected.content || '').trim())
            || Boolean(String(projected.comment || '').trim())
            || Boolean(llmSourceLabel(projected));
        if (!hasEvidence) return null;
        return fits(projected) ? projected : null;
    }

    /**
     * Estimate total tokens for all snippets in a session.
     */
    async function estimateSessionTokens(snippets, options = {}) {
        const signal = options.signal;
        const items = Array.isArray(snippets) ? snippets : [];
        let total = items.length > 0
            ? promptContextOverheadTokens('DIRECT', items.length, items.length)
            : 0;
        for (let index = 0; index < items.length; index++) {
            throwIfAborted(signal);
            total += promptSnippetTokens(items[index] || {}, index, false);
            if (index > 0 && index % 100 === 0) await yieldToMainThread(signal);
        }
        throwIfAborted(signal);
        return total;
    }

    /**
     * Ensure the BM25 index is built for the given session.
     * Lazy: only rebuilds if session changed or index is empty.
     */
    async function buildSnapshot(sessionName, generation, revision, snippets, signal) {
        throwIfAborted(signal);
        const chunks = await RAGIndexer.ensureSessionChunks(sessionName, snippets, revision, { signal });
        throwIfAborted(signal);

        const bm25 = new BM25Index();
        const chunkMap = new Map();
        const chunksBySnippet = new Map();
        const snippetMap = new Map();

        for (const snippet of snippets) {
            if (snippet?.id) snippetMap.set(snippet.id, snippet);
        }

        for (let index = 0; index < chunks.length; index++) {
            throwIfAborted(signal);
            const chunk = chunks[index];
            bm25.add(chunk.id, WeftTokenizer.tokenize(chunk.content));
            chunkMap.set(chunk.id, chunk);
            const siblings = chunksBySnippet.get(chunk.snippetId) || [];
            siblings.push(chunk);
            chunksBySnippet.set(chunk.snippetId, siblings);
            if (index > 0 && index % 100 === 0) await yieldToMainThread(signal);
        }
        for (const siblings of chunksBySnippet.values()) {
            throwIfAborted(signal);
            siblings.sort((a, b) => a.chunkIndex - b.chunkIndex);
            Object.freeze(siblings);
        }

        return Object.freeze({
            sessionName,
            generation,
            revision,
            bm25,
            chunkMap,
            chunksBySnippet,
            snippetMap,
        });
    }

    function subscribeToBuild(job, signal) {
        throwIfAborted(signal);
        job.waiters++;

        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (callback, value, wasAborted = false) => {
                if (finished) return;
                finished = true;
                if (signal) signal.removeEventListener('abort', onAbort);
                job.waiters--;
                if (wasAborted && job.waiters === 0 && !job.settled && job.controller) {
                    if (_buildJobs.get(job.key) === job) _buildJobs.delete(job.key);
                    job.controller.abort(abortError(signal));
                }
                callback(value);
            };
            const onAbort = () => finish(reject, abortError(signal), true);

            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            job.promise.then(
                (snapshot) => finish(resolve, snapshot),
                (error) => finish(reject, error)
            );
            if (signal?.aborted) onAbort();
        });
    }

    /**
     * Return one immutable-ish BM25 snapshot for this session generation.
     * Same-generation callers share the build; invalidated builds may finish
     * for their original caller but are never published into the live cache.
     */
    async function ensureIndex(sessionName, snippets, requestGeneration, options = {}) {
        const signal = options.signal;
        throwIfAborted(signal);
        const cachedState = getSessionState(sessionName);
        if (cachedState.generation === requestGeneration
            && cachedState.sourceSnippets === snippets
            && cachedState.snapshot?.generation === requestGeneration) {
            return cachedState.snapshot;
        }
        const revision = await RAGIndexer.computeSessionRevision(snippets, { signal });
        throwIfAborted(signal);

        const state = getSessionState(sessionName);
        if (state.generation !== requestGeneration && state.revision !== revision) {
            throw staleGenerationError();
        }

        let generation = state.generation;
        if (state.revision === null) {
            if (generation !== requestGeneration) throw staleGenerationError();
            state.revision = revision;
        } else if (state.revision !== revision) {
            if (generation !== requestGeneration) throw staleGenerationError();
            generation = ++state.generation;
            state.revision = revision;
            state.snapshot = null;
            state.sourceSnippets = null;
        }

        if (state.snapshot?.generation === generation && state.snapshot.revision === revision) {
            return state.snapshot;
        }

        const key = JSON.stringify([sessionName, generation, revision]);
        let job = _buildJobs.get(key);
        if (!job) {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            job = {
                key,
                sessionName,
                controller,
                waiters: 0,
                settled: false,
                promise: null,
            };
            job.promise = buildSnapshot(sessionName, generation, revision, snippets, controller?.signal);
            _buildJobs.set(key, job);
            const settle = () => {
                job.settled = true;
                if (_buildJobs.get(key) === job) _buildJobs.delete(key);
            };
            job.promise.then(settle, settle);
        }

        const snapshot = await subscribeToBuild(job, signal);
        throwIfAborted(signal);

        // An invalidate or same-count edit may have advanced the generation
        // while this job was yielding. Only the still-current job may publish.
        const latestState = getSessionState(sessionName);
        if (latestState.generation === generation && latestState.revision === revision) {
            latestState.snapshot = snapshot;
            latestState.sourceSnippets = snippets;
        }
        return snapshot;
    }

    /**
     * Invalidate the cached index for a session.
     * Called when snippets change (e.g., from background.js notification).
     */
    function invalidateCache(sessionName) {
        if (typeof sessionName === 'string' && sessionName) {
            const state = getSessionState(sessionName);
            state.generation++;
            state.revision = null;
            state.snapshot = null;
            state.sourceSnippets = null;
            state.tokenSource = null;
            state.totalTokens = null;
            return;
        }
        for (const state of _sessionStates.values()) {
            state.generation++;
            state.revision = null;
            state.snapshot = null;
            state.sourceSnippets = null;
            state.tokenSource = null;
            state.totalTokens = null;
        }
    }

    /**
     * Forget every in-memory reference for a deleted or renamed Session.
     * Lifecycle removal also aborts unpublished builds and removes the map
     * entry instead of retaining an empty per-name shell indefinitely.
     */
    function dropSession(sessionName) {
        if (typeof sessionName !== 'string' || !sessionName) return;
        const state = _sessionStates.get(sessionName);
        if (state) {
            state.generation++;
            state.revision = null;
            state.snapshot = null;
            _sessionStates.delete(sessionName);
        }
        for (const [key, job] of _buildJobs) {
            if (job.sessionName !== sessionName) continue;
            _buildJobs.delete(key);
            if (!job.settled) job.controller?.abort();
        }
    }

    /**
     * BM25 retrieval: search, deduplicate by snippetId, fill token budget.
     * Returns array of snippet-like objects with relevance scores.
     */
    async function bm25Retrieve(query, snapshot, tokenBudget, topK = 30, options = {}) {
        const signal = options.signal;
        const totalCount = Math.max(0, Math.floor(Number(options.totalCount) || 0));
        throwIfAborted(signal);
        const queryTokens = WeftTokenizer.tokenize(query);
        const results = snapshot.bm25.search(queryTokens, topK);

        // Deduplicate: if a sub-chunk matches, include the parent snippet (all its chunks)
        const seenSnippets = new Set();
        const rankedSnippets = [];
        let usedTokens = 0;

        for (const { docId, score } of results) {
            throwIfAborted(signal);
            const chunk = snapshot.chunkMap.get(docId);
            if (!chunk) continue;

            const snippetId = chunk.snippetId;
            if (seenSnippets.has(snippetId)) continue;
            seenSnippets.add(snippetId);

            // Prefer the complete snippet when it fits. If it does not, retain
            // only the matched chunk so one long capture cannot consume the
            // entire budget or block shorter candidates below it.
            let fullContent = chunk.content;
            let totalTokens = chunk.tokenCount;

            if (chunk.parentId) {
                // Group once during index construction instead of scanning the
                // complete chunk map for every search hit.
                const siblings = snapshot.chunksBySnippet.get(snippetId) || [chunk];
                fullContent = siblings.map((c) => c.content).join('\n\n');
                totalTokens = siblings.reduce((s, c) => s + c.tokenCount, 0);
            }

            const remainingTokens = Math.max(0, tokenBudget - usedTokens);
            if (totalTokens > remainingTokens) {
                fullContent = chunk.content;
                totalTokens = chunk.tokenCount;
            }

            const original = snapshot.snippetMap.get(snippetId) || {};
            let candidate = {
                ...original,
                id: original.id || snippetId,
                snippetId,
                content: fullContent,
                sourceUrl: original.sourceUrl || chunk.sourceUrl,
                sourceTitle: original.sourceTitle || chunk.sourceTitle,
                tags: original.tags || chunk.tags,
                type: original.type || chunk.type,
                timestamp: original.timestamp || chunk.timestamp,
                score,
            };
            candidate = fitPromptSnippet(
                rankedSnippets,
                candidate,
                tokenBudget,
                'BM25',
                totalCount
            );
            if (!candidate) continue;
            rankedSnippets.push(candidate);
            usedTokens = promptContextTokens(rankedSnippets, 'BM25', totalCount, false);
            if (rankedSnippets.length % 8 === 0) await yieldToMainThread(signal);
        }

        throwIfAborted(signal);
        return { snippets: rankedSnippets, usedTokens };
    }

    function hasInterestMetadata(snippet) {
        return Boolean(
            snippet?.comment ||
            snippet?.smartReadTopic ||
            snippet?.smartReadSummary ||
            snippet?.smartReadReason ||
            snippet?.smartReadTakeawayTitle
        );
    }

    function evenlySpaced(items, limit) {
        if (items.length <= limit) return items;
        if (limit <= 1) return items.slice(0, 1);
        const selected = [];
        const seen = new Set();
        for (let index = 0; index < limit; index++) {
            const itemIndex = Math.round((index * (items.length - 1)) / (limit - 1));
            if (!seen.has(itemIndex)) {
                seen.add(itemIndex);
                selected.push(items[itemIndex]);
            }
        }
        return selected;
    }

    function fallbackRetrieve(snippets, tokenBudget, options = {}) {
        const items = Array.isArray(snippets) ? snippets : [];
        const method = options.method || 'FALLBACK';
        const totalCount = Math.max(items.length, Math.floor(Number(options.totalCount) || 0));
        const signalled = items.filter(hasInterestMetadata);
        const ordinary = items.filter((item) => !hasInterestMetadata(item));
        const candidates = [...evenlySpaced(signalled, 20), ...evenlySpaced(ordinary, 20)];
        const selected = [];
        let usedTokens = 0;

        for (const snippet of candidates) {
            if (usedTokens >= tokenBudget) break;
            const projected = fitPromptSnippet(
                selected,
                snippet,
                tokenBudget,
                method,
                totalCount
            );
            if (!projected) continue;
            selected.push(projected);
            usedTokens = promptContextTokens(selected, method, totalCount, false);
        }
        return { snippets: selected, usedTokens };
    }

    function fitContext(snippets, options = {}) {
        const items = Array.isArray(snippets) ? snippets : [];
        const requestedBudget = Number(options.ragTokenBudget);
        const tokenBudget = Number.isFinite(requestedBudget) && requestedBudget > 0
            ? Math.floor(requestedBudget)
            : DEFAULT_TOKEN_BUDGET;
        const method = options.method || 'BOUNDED';
        const totalCount = Math.max(items.length, Math.floor(Number(options.totalCount) || 0));
        const selected = [];
        let usedTokens = 0;
        for (const snippet of items) {
            if (usedTokens >= tokenBudget) break;
            const projected = fitPromptSnippet(
                selected,
                snippet,
                tokenBudget,
                method,
                totalCount
            );
            if (!projected) continue;
            selected.push(projected);
            usedTokens = promptContextTokens(selected, method, totalCount, false);
        }
        return {
            snippets: selected,
            method,
            totalTokens: Number.isFinite(Number(options.totalTokens))
                ? Math.max(0, Math.floor(Number(options.totalTokens)))
                : usedTokens,
            usedTokens,
            totalCount,
            returnedCount: selected.length,
        };
    }

    /**
     * Fit explicitly referenced snippets before ordinary retrieval results.
     * Each referenced item receives an equal initial share so one very long
     * capture cannot consume the complete prompt and erase later [S#] items.
     */
    function fitReferencedContext(referencedSnippets, otherSnippets, options = {}) {
        const requestedBudget = Number(options.ragTokenBudget);
        const tokenBudget = Number.isFinite(requestedBudget) && requestedBudget > 0
            ? Math.floor(requestedBudget)
            : DEFAULT_TOKEN_BUDGET;
        const method = options.method || 'BOUNDED';
        const extras = Array.isArray(otherSnippets) ? otherSnippets : [];
        const maxReferenced = Math.max(1, Math.min(8, Math.floor(Number(options.maxReferenced) || 8)));
        const referenced = [];
        const seen = new Set();
        for (const snippet of Array.isArray(referencedSnippets) ? referencedSnippets : []) {
            const identity = snippet?.id || snippet?.snippetId || snippet;
            if (!snippet || seen.has(identity)) continue;
            seen.add(identity);
            referenced.push(snippet);
            if (referenced.length >= maxReferenced) break;
        }
        const totalCount = Math.max(
            referenced.length + extras.length,
            Math.floor(Number(options.totalCount) || 0)
        );
        if (referenced.length === 0) {
            return fitContext(extras, { ...options, ragTokenBudget: tokenBudget, method, totalCount });
        }

        // A single-item fit includes the framing overhead, so summing these
        // equal shares is conservative compared with the final shared framing.
        // Retry with a little more reserve if marker lengths make the combined
        // context marginally larger than the individual projections.
        let projected = [];
        let baseline = null;
        for (let attempt = 0; attempt < 4; attempt++) {
            const share = Math.max(1, Math.floor((tokenBudget / referenced.length) * (0.92 ** attempt)));
            projected = referenced
                .map((snippet) => fitContext([snippet], {
                    ragTokenBudget: share,
                    method,
                    totalCount,
                }).snippets[0])
                .filter(Boolean);
            baseline = fitContext(projected, {
                ragTokenBudget: tokenBudget,
                method,
                totalCount,
            });
            if (baseline.returnedCount === projected.length) break;
        }

        const includedIds = new Set(projected.map((snippet) => snippet?.id || snippet?.snippetId));
        const remaining = extras.filter((snippet) => {
            const identity = snippet?.id || snippet?.snippetId;
            return !identity || !includedIds.has(identity);
        });
        return fitContext([...projected, ...remaining], {
            ...options,
            ragTokenBudget: tokenBudget,
            method,
            totalCount,
        });
    }

    /**
     * Bound a Session deterministically without performing relevance ranking.
     * This is the safety path for users who have disabled RAG: the preference
     * is respected, while an oversized Session can never become an unbounded
     * provider request. Interest-bearing snippets and broad document coverage
     * are retained by fallbackRetrieve().
     */
    async function boundSession(snippets, options = {}) {
        const signal = options.signal;
        throwIfAborted(signal);
        const items = Array.isArray(snippets) ? snippets : [];
        const requestedBudget = Number(options.ragTokenBudget);
        const tokenBudget = Number.isFinite(requestedBudget) && requestedBudget > 0
            ? Math.floor(requestedBudget)
            : DEFAULT_TOKEN_BUDGET;
        if (Array.isArray(snippets)) {
            const cached = _boundedSessionCache.get(snippets)?.get(tokenBudget);
            if (cached) return cached;
        }
        const totalTokens = await estimateSessionTokens(items, { signal });
        if (totalTokens <= tokenBudget) {
            const result = {
                snippets: items,
                method: 'DIRECT',
                totalTokens,
                usedTokens: totalTokens,
                totalCount: items.length,
                returnedCount: items.length,
            };
            if (Array.isArray(snippets)) {
                const cache = _boundedSessionCache.get(snippets) || new Map();
                cache.set(tokenBudget, result);
                _boundedSessionCache.set(snippets, cache);
            }
            return result;
        }
        const fallback = fallbackRetrieve(items, tokenBudget, {
            method: 'BOUNDED',
            totalCount: items.length,
        });
        const result = {
            snippets: fallback.snippets,
            method: 'BOUNDED',
            totalTokens,
            usedTokens: fallback.usedTokens,
            totalCount: items.length,
            returnedCount: fallback.snippets.length,
        };
        if (Array.isArray(snippets)) {
            const cache = _boundedSessionCache.get(snippets) || new Map();
            cache.set(tokenBudget, result);
            _boundedSessionCache.set(snippets, cache);
        }
        return result;
    }

    /**
     * RRF (Reciprocal Rank Fusion) — combine two ranked lists.
     * @param {{ docId: string, score: number }[]} listA
     * @param {{ docId: string, score: number }[]} listB
     * @param {number} k - RRF constant (default 60)
     * @returns {{ docId: string, score: number }[]} fused results, sorted descending
     */
    function rrfFuse(listA, listB, k = 60) {
        const scores = new Map();

        listA.forEach(({ docId }, rank) => {
            scores.set(docId, (scores.get(docId) || 0) + 1 / (k + rank + 1));
        });
        listB.forEach(({ docId }, rank) => {
            scores.set(docId, (scores.get(docId) || 0) + 1 / (k + rank + 1));
        });

        const results = [];
        for (const [docId, score] of scores) {
            results.push({ docId, score });
        }
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    /**
     * Main entry point: retrieve relevant snippets for a query.
     *
     * @param {string} query - user's message
     * @param {string} sessionName
     * @param {object[]} snippets - all snippets in the session
     * @param {object} options - { ragEnabled, ragTokenBudget }
     * @returns {{ snippets: object[], method: string, totalTokens: number, usedTokens: number }}
     */
    async function retrieve(query, sessionName, snippets, options = {}) {
        const signal = options.signal;
        const items = Array.isArray(snippets) ? snippets : [];
        const initialState = getSessionState(sessionName);
        const requestGeneration = initialState.generation;
        throwIfAborted(signal);
        const requestedBudget = Number(options.ragTokenBudget);
        const tokenBudget =
            Number.isFinite(requestedBudget) && requestedBudget > 0
                ? Math.floor(requestedBudget)
                : DEFAULT_TOKEN_BUDGET;
        let totalTokens = initialState.tokenSource === items
            ? initialState.totalTokens
            : null;
        if (!Number.isFinite(totalTokens)) {
            totalTokens = await estimateSessionTokens(items, { signal });
            const latestState = getSessionState(sessionName);
            if (latestState.generation === requestGeneration) {
                latestState.tokenSource = items;
                latestState.totalTokens = totalTokens;
            }
        }

        // DIRECT only when the complete Session also fits the caller's budget.
        if (totalTokens < DIRECT_THRESHOLD && totalTokens <= tokenBudget) {
            return {
                snippets: items,
                method: 'DIRECT',
                totalTokens,
                usedTokens: totalTokens,
                totalCount: items.length,
                returnedCount: items.length,
            };
        }

        // Ensure index is built
        const snapshot = await ensureIndex(sessionName, items, requestGeneration, { signal });

        // Use a wider lexical candidate pool for very large Sessions.
        const topK = totalTokens >= LARGE_SESSION_THRESHOLD ? 50 : 30;
        const bm25Result = await bm25Retrieve(query, snapshot, tokenBudget, topK, {
            signal,
            totalCount: items.length,
        });

        let method = 'BM25';
        let finalSnippets = bm25Result.snippets;
        let finalUsedTokens = bm25Result.usedTokens;
        if (finalSnippets.length === 0 && items.length > 0) {
            const fallback = fallbackRetrieve(items, tokenBudget, {
                method: 'FALLBACK',
                totalCount: items.length,
            });
            finalSnippets = fallback.snippets;
            finalUsedTokens = fallback.usedTokens;
            method = 'FALLBACK';
        }

        return {
            snippets: finalSnippets,
            method,
            totalTokens,
            usedTokens: finalUsedTokens,
            totalCount: items.length,
            returnedCount: finalSnippets.length,
        };
    }

    /**
     * Build filtered snippets text for the system message.
     * Mirrors the format of the original buildSnippetsText but only includes ranked snippets.
     */
    function buildFilteredSnippetsText(ragResult, visionEnabled) {
        const snippets = Array.isArray(ragResult?.snippets) ? ragResult.snippets : [];
        return promptContextText(
            snippets,
            ragResult?.method || 'DIRECT',
            ragResult?.totalCount,
            Boolean(visionEnabled)
        );
    }

    return {
        retrieve,
        boundSession,
        fitContext,
        fitReferencedContext,
        estimateSessionTokens,
        invalidateCache,
        dropSession,
        rrfFuse,
        buildFilteredSnippetsText,
        llmSourceLabel,
        llmUrlLabel,
    };
})();
