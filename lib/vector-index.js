/**
 * VectorIndex — Brute-force cosine similarity search.
 * Phase 1.1: Full implementation with cached L2 norms.
 * For ≤1000 vectors, search completes in <5ms.
 *
 * Phase 1: Stub with interface only. search() returns empty array.
 * Upgrade path: replace with mememo (HNSW+IDB) or voy (WASM HNSW).
 */
/* exported VectorIndex */

class VectorIndex {
    constructor() {
        // docId → { vector: number[], norm: number }
        this._docs = new Map();
    }

    get size() {
        return this._docs.size;
    }

    /**
     * Add a vector.
     * @param {string} docId
     * @param {number[]} vector
     */
    add(docId, vector) {
        const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
        this._docs.set(docId, { vector, norm });
    }

    /**
     * Remove a vector.
     * @param {string} docId
     */
    remove(docId) {
        this._docs.delete(docId);
    }

    /**
     * Search by cosine similarity.
     * @param {number[]} queryVector
     * @param {number} topK
     * @returns {{ docId: string, score: number }[]} sorted descending
     */
    search(queryVector, topK = 10) {
        if (this._docs.size === 0 || !queryVector || queryVector.length === 0) return [];

        const qNorm = Math.sqrt(queryVector.reduce((s, v) => s + v * v, 0));
        if (qNorm === 0) return [];

        const results = [];
        for (const [docId, { vector, norm }] of this._docs) {
            if (norm === 0 || vector.length !== queryVector.length) continue;
            // Dot product in single loop
            let dot = 0;
            for (let i = 0; i < vector.length; i++) {
                dot += vector[i] * queryVector[i];
            }
            results.push({ docId, score: dot / (qNorm * norm) });
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    /** Reset */
    clear() {
        this._docs.clear();
    }
}
