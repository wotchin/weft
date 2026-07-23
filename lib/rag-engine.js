/**
 * RAGEngine — Orchestrator for the browser-side RAG pipeline.
 *
 * Decision chain (token-based routing):
 *   DIRECT  (<15K tokens): send all snippets as-is
 *   BM25    (15K–80K):     BM25 recall top-30, trim to token budget
 *   HYBRID  (>80K):        BM25 + vector dual recall + RRF fusion (Phase 1.1: BM25 only)
 *
 * Entry point: RAGEngine.retrieve(query, sessionName, snippets, options)
 */
/* exported RAGEngine */
/* global CyberTokenizer, BM25Index, VectorIndex, RAGIndexer */

const RAGEngine = (() => {
    'use strict';

    // Thresholds (in estimated tokens)
    const DIRECT_THRESHOLD = 15000;
    const HYBRID_THRESHOLD = 80000;
    const DEFAULT_TOKEN_BUDGET = 12000;

    // Cached BM25 index per session (rebuilt when session changes)
    let _cachedSession = null;
    let _bm25 = null;
    // Map from chunkId → chunk object for fast lookup
    let _chunkMap = null;

    /**
     * Estimate total tokens for all snippets in a session.
     */
    function estimateSessionTokens(snippets) {
        let total = 0;
        for (const s of snippets) {
            total += CyberTokenizer.estimateTokens(s.content || '');
        }
        return total;
    }

    /**
     * Ensure the BM25 index is built for the given session.
     * Lazy: only rebuilds if session changed or index is empty.
     */
    async function ensureIndex(sessionName, snippets) {
        // Check if IDB index is up-to-date
        const isIndexed = await RAGIndexer.isSessionIndexed(sessionName, snippets.length);
        if (!isIndexed) {
            await RAGIndexer.indexSession(sessionName, snippets);
        }

        // Rebuild in-memory BM25 if session changed
        if (_cachedSession !== sessionName || !_bm25) {
            _bm25 = new BM25Index();
            _chunkMap = new Map();

            const chunks = await RAGIndexer.getSessionChunks(sessionName);
            for (const chunk of chunks) {
                const tokens = CyberTokenizer.tokenize(chunk.content);
                _bm25.add(chunk.id, tokens);
                _chunkMap.set(chunk.id, chunk);
            }
            _cachedSession = sessionName;
        }
    }

    /**
     * Invalidate the cached index for a session.
     * Called when snippets change (e.g., from background.js notification).
     */
    function invalidateCache(sessionName) {
        if (_cachedSession === sessionName) {
            _cachedSession = null;
            _bm25 = null;
            _chunkMap = null;
        }
    }

    /**
     * BM25 retrieval: search, deduplicate by snippetId, fill token budget.
     * Returns array of snippet-like objects with relevance scores.
     */
    async function bm25Retrieve(query, sessionName, tokenBudget, topK = 30) {
        const queryTokens = CyberTokenizer.tokenize(query);
        const results = _bm25.search(queryTokens, topK);

        // Deduplicate: if a sub-chunk matches, include the parent snippet (all its chunks)
        const seenSnippets = new Set();
        const rankedSnippets = [];
        let usedTokens = 0;

        for (const { docId, score } of results) {
            const chunk = _chunkMap.get(docId);
            if (!chunk) continue;

            const snippetId = chunk.snippetId;
            if (seenSnippets.has(snippetId)) continue;
            seenSnippets.add(snippetId);

            // If this chunk has a parent (was split), gather all sibling chunks
            let fullContent = chunk.content;
            let totalTokens = chunk.tokenCount;

            if (chunk.parentId) {
                // Get all chunks for this snippet, ordered by chunkIndex
                const siblings = [];
                for (const [, c] of _chunkMap) {
                    if (c.snippetId === snippetId) siblings.push(c);
                }
                siblings.sort((a, b) => a.chunkIndex - b.chunkIndex);
                fullContent = siblings.map(c => c.content).join('\n\n');
                totalTokens = siblings.reduce((s, c) => s + c.tokenCount, 0);
            }

            // Check token budget
            if (usedTokens + totalTokens > tokenBudget && rankedSnippets.length > 0) {
                break; // Budget exhausted
            }

            rankedSnippets.push({
                snippetId,
                content: fullContent,
                sourceUrl: chunk.sourceUrl,
                sourceTitle: chunk.sourceTitle,
                tags: chunk.tags,
                type: chunk.type,
                timestamp: chunk.timestamp,
                score
            });
            usedTokens += totalTokens;
        }

        return { snippets: rankedSnippets, usedTokens };
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
        const tokenBudget = options.ragTokenBudget || DEFAULT_TOKEN_BUDGET;
        const totalTokens = estimateSessionTokens(snippets);

        // DIRECT: small session, send everything
        if (totalTokens < DIRECT_THRESHOLD) {
            return {
                snippets,
                method: 'DIRECT',
                totalTokens,
                usedTokens: totalTokens,
                totalCount: snippets.length,
                returnedCount: snippets.length
            };
        }

        // Ensure index is built
        await ensureIndex(sessionName, snippets);

        // BM25 retrieval (used for both BM25 and HYBRID modes)
        const topK = totalTokens >= HYBRID_THRESHOLD ? 50 : 30;
        const bm25Result = await bm25Retrieve(query, sessionName, tokenBudget, topK);

        // GraphRAG augmentation: use knowledge graph to discover related snippets
        // that BM25 missed (multi-hop connections via shared keywords)
        let method = totalTokens >= HYBRID_THRESHOLD ? 'HYBRID' : 'BM25';
        let finalSnippets = bm25Result.snippets;
        let finalUsedTokens = bm25Result.usedTokens;

        try {
            if (typeof GraphBuilder !== 'undefined' && snippets.length >= 5) {
                const graphResult = graphRAGAugment(
                    query, snippets, bm25Result.snippets,
                    tokenBudget - bm25Result.usedTokens
                );
                if (graphResult.added.length > 0) {
                    finalSnippets = [...bm25Result.snippets, ...graphResult.added];
                    finalUsedTokens += graphResult.addedTokens;
                    method += '+GRAPH';
                }
            }
        } catch (e) {
            console.warn('[GraphRAG] augmentation failed, using BM25 only:', e);
        }

        return {
            snippets: finalSnippets,
            method,
            totalTokens,
            usedTokens: finalUsedTokens,
            totalCount: snippets.length,
            returnedCount: finalSnippets.length
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
            const source = snippet.sourceTitle || snippet.sourceUrl || '';
            const tags = (snippet.tags || []).join(', ');

            if (snippet.type === 'image') {
                if (visionEnabled) {
                    text += `\n[Snippet ${i + 1}] (image — embedded in the conversation)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n`;
                } else {
                    text += `\n[Snippet ${i + 1}] (image, not displayed - model does not support vision)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\nNote: This is an image snippet. The image cannot be displayed because the current model does not support vision.\n`;
                }
            } else {
                const content = snippet.content || '';
                text += `\n[Snippet ${i + 1}]${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n${content}\n`;
            }
        });

        text += '\n=== END SNIPPETS ===\n';
        return text;
    }

    /**
     * GraphRAG augmentation: use knowledge graph to find snippets related to
     * the BM25 results that BM25 missed.
     *
     * Algorithm:
     * 1. Extract keywords from query
     * 2. Build graph from all snippets (cached)
     * 3. Find keyword nodes matching query keywords
     * 4. Walk graph edges to discover connected snippet nodes
     * 5. Filter out snippets already in BM25 results
     * 6. Score by graph distance (1-hop > 2-hop)
     * 7. Fill remaining token budget
     */
    function graphRAGAugment(query, allSnippets, bm25Snippets, remainingBudget) {
        if (remainingBudget <= 500) return { added: [], addedTokens: 0 };

        // Extract query keywords
        const queryKeywords = GraphBuilder.extractKeywords(query, 8);
        if (queryKeywords.length === 0) return { added: [], addedTokens: 0 };

        // Build graph (lightweight — reuses existing logic)
        const graph = GraphBuilder.buildGraph(allSnippets);

        // Build adjacency map for fast traversal
        const adj = new Map(); // nodeId → Set<{ targetId, type }>
        for (const edge of graph.edges) {
            if (!adj.has(edge.source)) adj.set(edge.source, []);
            if (!adj.has(edge.target)) adj.set(edge.target, []);
            adj.get(edge.source).push({ targetId: edge.target, type: edge.type });
            adj.get(edge.target).push({ targetId: edge.source, type: edge.type });
        }

        // Find keyword nodes that match query keywords
        const matchedKwNodes = new Set();
        for (const kw of queryKeywords) {
            const kwNodeId = `kw:${kw}`;
            if (adj.has(kwNodeId)) matchedKwNodes.add(kwNodeId);
        }

        if (matchedKwNodes.size === 0) return { added: [], addedTokens: 0 };

        // BFS from matched keyword nodes to discover snippet nodes
        const bm25SnippetIds = new Set(bm25Snippets.map(s => s.snippetId || s.id));
        const discoveredSnippets = new Map(); // snippetId → { score, snippet }

        // 1-hop: keyword → snippet (direct connection)
        for (const kwId of matchedKwNodes) {
            for (const neighbor of (adj.get(kwId) || [])) {
                if (!neighbor.targetId.startsWith('snippet:')) continue;
                const snippetId = neighbor.targetId.replace('snippet:', '');
                if (bm25SnippetIds.has(snippetId)) continue;
                if (!discoveredSnippets.has(snippetId)) {
                    discoveredSnippets.set(snippetId, { score: 0 });
                }
                discoveredSnippets.get(snippetId).score += 1.0; // 1-hop score
            }
        }

        // 2-hop: keyword → snippet → keyword → snippet (via shared keywords)
        for (const kwId of matchedKwNodes) {
            for (const n1 of (adj.get(kwId) || [])) {
                if (!n1.targetId.startsWith('snippet:')) continue;
                // From this snippet, find its other keywords
                for (const n2 of (adj.get(n1.targetId) || [])) {
                    if (!n2.targetId.startsWith('kw:')) continue;
                    if (matchedKwNodes.has(n2.targetId)) continue; // skip original keywords
                    // From this keyword, find other snippets
                    for (const n3 of (adj.get(n2.targetId) || [])) {
                        if (!n3.targetId.startsWith('snippet:')) continue;
                        const snippetId = n3.targetId.replace('snippet:', '');
                        if (bm25SnippetIds.has(snippetId)) continue;
                        if (!discoveredSnippets.has(snippetId)) {
                            discoveredSnippets.set(snippetId, { score: 0 });
                        }
                        discoveredSnippets.get(snippetId).score += 0.3; // 2-hop score (weaker)
                    }
                }
            }
        }

        if (discoveredSnippets.size === 0) return { added: [], addedTokens: 0 };

        // Sort by score descending
        const ranked = Array.from(discoveredSnippets.entries())
            .sort((a, b) => b[1].score - a[1].score);

        // Fill remaining token budget
        const added = [];
        let addedTokens = 0;

        for (const [snippetId, { score }] of ranked) {
            const snippet = allSnippets.find(s => s.id === snippetId);
            if (!snippet) continue;

            const tokens = CyberTokenizer.estimateTokens(snippet.content || '');
            if (addedTokens + tokens > remainingBudget) continue; // skip if too big

            added.push({
                ...snippet,
                snippetId: snippet.id,
                score: score * 0.5, // Graph scores weighted lower than BM25
                _graphRAG: true,
            });
            addedTokens += tokens;

            if (added.length >= 5) break; // Max 5 graph-augmented snippets
        }

        return { added, addedTokens };
    }

    return {
        retrieve,
        estimateSessionTokens,
        invalidateCache,
        rrfFuse,
        buildFilteredSnippetsText
    };
})();
