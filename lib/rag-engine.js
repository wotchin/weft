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
            state = { generation: 0, revision: null, snapshot: null };
            _sessionStates.set(sessionName, state);
        }
        return state;
    }

    function staleGenerationError() {
        const error = new Error('The session changed while its RAG index was being prepared.');
        error.code = 'RAG_STALE_GENERATION';
        return error;
    }

    /**
     * Estimate total tokens for all snippets in a session.
     */
    async function estimateSessionTokens(snippets, options = {}) {
        const signal = options.signal;
        const items = Array.isArray(snippets) ? snippets : [];
        let total = 0;
        for (let index = 0; index < items.length; index++) {
            throwIfAborted(signal);
            const s = items[index] || {};
            const searchable =
                typeof RAGIndexer.snippetToSearchText === 'function'
                    ? RAGIndexer.snippetToSearchText(s)
                    : s.content || '';
            total += WeftTokenizer.estimateTokens(searchable);
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
            return;
        }
        for (const state of _sessionStates.values()) {
            state.generation++;
            state.revision = null;
            state.snapshot = null;
        }
    }

    /**
     * BM25 retrieval: search, deduplicate by snippetId, fill token budget.
     * Returns array of snippet-like objects with relevance scores.
     */
    async function bm25Retrieve(query, snapshot, tokenBudget, topK = 30, options = {}) {
        const signal = options.signal;
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
            if (totalTokens > remainingTokens) {
                if (rankedSnippets.length > 0 || remainingTokens === 0) continue;
                fullContent = truncateToTokenBudget(fullContent, remainingTokens);
                totalTokens = WeftTokenizer.estimateTokens(fullContent);
                if (!fullContent || totalTokens === 0) continue;
            }

            const original = snapshot.snippetMap.get(snippetId) || {};
            rankedSnippets.push({
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
            });
            usedTokens += totalTokens;
            if (rankedSnippets.length % 8 === 0) await yieldToMainThread(signal);
        }

        throwIfAborted(signal);
        return { snippets: rankedSnippets, usedTokens };
    }

    function truncateToTokenBudget(value, tokenBudget) {
        const text = String(value || '');
        const budget = Math.max(0, Math.floor(Number(tokenBudget) || 0));
        if (!text || budget === 0) return '';
        if (WeftTokenizer.estimateTokens(text) <= budget) return text;

        let low = 0;
        let high = text.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (WeftTokenizer.estimateTokens(text.slice(0, middle)) <= budget) low = middle;
            else high = middle - 1;
        }
        return text.slice(0, low).trimEnd();
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

    function fallbackRetrieve(snippets, tokenBudget) {
        const items = Array.isArray(snippets) ? snippets : [];
        const signalled = items.filter(hasInterestMetadata);
        const ordinary = items.filter((item) => !hasInterestMetadata(item));
        const candidates = [...evenlySpaced(signalled, 20), ...evenlySpaced(ordinary, 20)];
        const selected = [];
        let usedTokens = 0;

        for (const snippet of candidates) {
            const remaining = tokenBudget - usedTokens;
            if (remaining <= 0) break;
            const searchable =
                typeof RAGIndexer.snippetToSearchText === 'function'
                    ? RAGIndexer.snippetToSearchText(snippet)
                    : snippet?.content || '';
            const tokenCount = WeftTokenizer.estimateTokens(searchable);
            if (tokenCount <= remaining) {
                selected.push(snippet);
                usedTokens += tokenCount;
                continue;
            }
            if (selected.length === 0) {
                const content = truncateToTokenBudget(searchable, remaining);
                if (content) {
                    selected.push({ ...snippet, id: snippet.id, content });
                    usedTokens += WeftTokenizer.estimateTokens(content);
                }
            }
        }
        return { snippets: selected, usedTokens };
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
        const requestGeneration = getSessionState(sessionName).generation;
        throwIfAborted(signal);
        const requestedBudget = Number(options.ragTokenBudget);
        const tokenBudget =
            Number.isFinite(requestedBudget) && requestedBudget > 0
                ? Math.floor(requestedBudget)
                : DEFAULT_TOKEN_BUDGET;
        const totalTokens = await estimateSessionTokens(items, { signal });

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
        const bm25Result = await bm25Retrieve(query, snapshot, tokenBudget, topK, { signal });

        let method = 'BM25';
        let finalSnippets = bm25Result.snippets;
        let finalUsedTokens = bm25Result.usedTokens;
        if (finalSnippets.length === 0 && items.length > 0) {
            const fallback = fallbackRetrieve(items, tokenBudget);
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
        const { snippets, method, totalCount, returnedCount } = ragResult;
        let text = '';

        if (snippets.length === 0) return text;

        text += '=== COLLECTED SNIPPETS ===\n';

        if (method !== 'DIRECT') {
            text += `(Smart retrieval: showing ${returnedCount} most relevant snippets out of ${totalCount} total, based on your query)\n`;
        }

        snippets.forEach((snippet, i) => {
            const pdfPage = snippet.sourceDocumentType === 'pdf' && Number.isInteger(snippet.sourcePageNumber)
                ? ` (PDF page ${snippet.sourcePageNumber})`
                : '';
            const source = `${snippet.sourceTitle || snippet.sourceUrl || ''}${pdfPage}`;
            const tags = (snippet.tags || []).join(', ');
            const comment = snippet.comment || '';

            if (snippet.type === 'image') {
                if (visionEnabled) {
                    text += `\n[S${i + 1}] (image — embedded in the conversation)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n`;
                } else {
                    text += `\n[S${i + 1}] (image, not displayed - model does not support vision)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\nNote: This is an image snippet. The image cannot be displayed because the current model does not support vision.\n`;
                }
            } else {
                const content = snippet.content || '';
                const link = snippet.type === 'link' && snippet.linkUrl ? `\nResearch lead: ${snippet.linkUrl}` : '';
                text += `\n[S${i + 1}]${snippet.type === 'link' ? ' (saved link — not yet verified)' : ''}${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n${content}${link}\n`;
            }
            if (comment) {
                text += `[User's note]: ${comment}\n`;
            }
        });

        text += '\n=== END SNIPPETS ===\n';
        return text;
    }

    return {
        retrieve,
        estimateSessionTokens,
        invalidateCache,
        rrfFuse,
        buildFilteredSnippetsText,
    };
})();
