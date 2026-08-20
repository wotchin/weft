/**
 * BM25Index — In-memory BM25 search index with incremental add/remove.
 * Standard BM25 scoring (k1=1.5, b=0.75).
 * Accepts tokens produced by WeftTokenizer at the RAG boundary.
 */
/* exported BM25Index */

class BM25Index {
    constructor(k1 = 1.5, b = 0.75) {
        this.k1 = k1;
        this.b = b;
        // term → Map<docId, termFrequency>
        this.invertedIndex = new Map();
        // docId → document length (number of tokens)
        this.docLengths = new Map();
        // Running totals for avgDL calculation
        this._totalLength = 0;
    }

    get size() {
        return this.docLengths.size;
    }

    get _avgDL() {
        return this.size > 0 ? this._totalLength / this.size : 0;
    }

    /**
     * Add a document to the index.
     * @param {string} docId
     * @param {string[]} tokens - pre-tokenized array from WeftTokenizer.tokenize()
     */
    add(docId, tokens) {
        if (this.docLengths.has(docId)) this.remove(docId);

        this.docLengths.set(docId, tokens.length);
        this._totalLength += tokens.length;

        // Count term frequencies
        const tf = new Map();
        for (const t of tokens) {
            tf.set(t, (tf.get(t) || 0) + 1);
        }

        // Update inverted index
        for (const [term, freq] of tf) {
            if (!this.invertedIndex.has(term)) {
                this.invertedIndex.set(term, new Map());
            }
            this.invertedIndex.get(term).set(docId, freq);
        }
    }

    /**
     * Remove a document from the index.
     * @param {string} docId
     */
    remove(docId) {
        const dl = this.docLengths.get(docId);
        if (dl === undefined) return;

        this.docLengths.delete(docId);
        this._totalLength -= dl;

        // Remove from inverted index
        for (const [term, postings] of this.invertedIndex) {
            postings.delete(docId);
            if (postings.size === 0) {
                this.invertedIndex.delete(term);
            }
        }
    }

    /**
     * Search the index.
     * @param {string[]} queryTokens - tokenized query
     * @param {number} topK - max results to return
     * @returns {{ docId: string, score: number }[]} sorted by score descending
     */
    search(queryTokens, topK = 30) {
        if (this.size === 0 || queryTokens.length === 0) return [];

        const N = this.size;
        const avgDL = this._avgDL;
        const scores = new Map();

        for (const term of queryTokens) {
            const postings = this.invertedIndex.get(term);
            if (!postings) continue;

            const df = postings.size;
            // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
            const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

            for (const [docId, tf] of postings) {
                const dl = this.docLengths.get(docId);
                // BM25 term score
                const tfNorm = (tf * (this.k1 + 1)) /
                    (tf + this.k1 * (1 - this.b + this.b * dl / avgDL));
                const s = idf * tfNorm;

                scores.set(docId, (scores.get(docId) || 0) + s);
            }
        }

        // Sort by score descending, return top-K
        const results = [];
        for (const [docId, score] of scores) {
            results.push({ docId, score });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }
}
