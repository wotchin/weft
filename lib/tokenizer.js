/**
 * WeftTokenizer — Token estimation, BM25 tokenizer, and text chunker.
 *
 * Token estimation: Chinese chars / 1.5 + non-Chinese chars / 4
 * Tokenizer: word-level for Latin + char bigrams for CJK (中日韩)
 * Chunker: paragraph → sentence → hard-split with overlap
 */
/* exported WeftTokenizer */

const WeftTokenizer = (() => {
    'use strict';

    // CJK Unicode ranges: Chinese, Japanese Hiragana/Katakana, Korean
    const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
    const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;

    /**
     * Estimate token count for a string.
     * Rough but fast: Chinese chars ≈ 1.5 tokens each, other chars ≈ 4 chars per token.
     */
    function estimateTokens(text) {
        if (!text) return 0;
        const cjkChars = (text.match(CJK_CHAR_RE) || []).length;
        const otherChars = text.length - cjkChars;
        return Math.ceil(cjkChars / 1.5 + otherChars / 4);
    }

    /**
     * Tokenize text for BM25 indexing/search.
     * Dual strategy: word-level splits for Latin text, char bigrams for CJK.
     * All tokens are lowercased. Stopwords are not removed (BM25 handles frequency naturally).
     */
    function tokenize(text) {
        if (!text) return [];
        const lower = text.toLowerCase();
        const tokens = [];

        // Extract Latin words (split on non-alphanumeric)
        const words = lower.replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g, ' ').trim().split(/\s+/);
        for (const w of words) {
            if (!w) continue;
            if (CJK_RE.test(w)) {
                // For CJK strings: generate character bigrams
                const chars = [...w].filter(c => CJK_RE.test(c));
                // Unigrams
                for (const c of chars) tokens.push(c);
                // Bigrams
                for (let i = 0; i < chars.length - 1; i++) {
                    tokens.push(chars[i] + chars[i + 1]);
                }
            } else if (w.length >= 2) {
                tokens.push(w);
            }
        }
        return tokens;
    }

    /**
     * Split text into chunks of approximately maxTokens each.
     * Returns array of { content: string, chunkIndex: number }.
     * Most snippets are small and won't be split (single chunk returned).
     */
    function chunkText(text, maxTokens = 512) {
        if (!text) return [{ content: '', chunkIndex: 0 }];

        const totalTokens = estimateTokens(text);
        if (totalTokens <= maxTokens) {
            return [{ content: text, chunkIndex: 0 }];
        }

        // Step 1: Split on paragraph boundaries
        const segments = text.split(/\n\n+/).filter(s => s.trim());

        // Step 2: If any segment is still too large, split on sentence boundaries
        const finer = [];
        for (const seg of segments) {
            if (estimateTokens(seg) <= maxTokens) {
                finer.push(seg);
            } else {
                // Split on sentence endings (. ! ? followed by space or end)
                const sentences = seg.split(/(?<=[.!?。！？])\s+/).filter(s => s.trim());
                finer.push(...sentences);
            }
        }

        // Step 3: Merge small segments and split large ones into final chunks
        const chunks = [];
        let current = '';
        let currentTokens = 0;

        for (const seg of finer) {
            const segTokens = estimateTokens(seg);

            if (segTokens > maxTokens) {
                // Flush current buffer
                if (current) {
                    chunks.push(current.trim());
                    current = '';
                    currentTokens = 0;
                }
                // Hard-split this segment by character count
                const charsPerChunk = Math.floor(maxTokens * 3); // rough: 3 chars per token avg
                const overlap = 150; // ~50 tokens of overlap
                for (let i = 0; i < seg.length; i += charsPerChunk - overlap) {
                    chunks.push(seg.slice(i, i + charsPerChunk).trim());
                }
            } else if (currentTokens + segTokens > maxTokens) {
                // Current buffer is full, start new chunk
                chunks.push(current.trim());
                current = seg;
                currentTokens = segTokens;
            } else {
                current += (current ? '\n\n' : '') + seg;
                currentTokens += segTokens;
            }
        }
        if (current.trim()) chunks.push(current.trim());

        return chunks.map((content, i) => ({ content, chunkIndex: i }));
    }

    return { estimateTokens, tokenize, chunkText };
})();
