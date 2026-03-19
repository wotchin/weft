/**
 * RAGIndexer — Snippet-to-chunk pipeline with IndexedDB persistence.
 * Handles: chunking, IDB storage, lazy migration from chrome.storage.local,
 *          session index validation, and chunk retrieval.
 *
 * IndexedDB is a PARALLEL search index, not a replacement for chrome.storage.local.
 * If corrupted, it can be fully rebuilt from the source data.
 */
/* exported RAGIndexer */
/* global CyberIDB, CyberTokenizer */

const RAGIndexer = (() => {
    'use strict';

    const DB_NAME = 'cyber-rag';
    const DB_VERSION = 1;
    let _db = null;

    /**
     * Open (or create) the IndexedDB database.
     */
    async function init() {
        if (_db) return _db;
        _db = await CyberIDB.open(DB_NAME, DB_VERSION, (db, oldVersion) => {
            if (oldVersion < 1) {
                // Chunks store
                const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
                chunks.createIndex('by-session', 'sessionName', { unique: false });
                chunks.createIndex('by-snippet', 'snippetId', { unique: false });

                // Vectors store (Phase 1.1)
                const vectors = db.createObjectStore('vectors', { keyPath: 'snippetId' });
                vectors.createIndex('by-session', 'sessionName', { unique: false });

                // Meta store
                db.createObjectStore('meta', { keyPath: 'key' });
            }
        });
        return _db;
    }

    /**
     * Check if a session is already indexed and up-to-date.
     */
    async function isSessionIndexed(sessionName, snippetCount) {
        const db = await init();
        const meta = await CyberIDB.get(db, 'meta', `session:${sessionName}`);
        if (!meta) return false;
        return meta.value.snippetCount === snippetCount;
    }

    /**
     * Build searchable text for a snippet (regardless of type).
     */
    function _snippetToText(snippet) {
        if (snippet.type === 'image') {
            const source = snippet.sourceTitle || snippet.sourceUrl || '';
            const tags = (snippet.tags || []).join(' ');
            return `[Image] ${source} ${tags} ${snippet.imageUrl || ''}`.trim();
        }
        if (snippet.type === 'link') {
            const tags = (snippet.tags || []).join(' ');
            return `${snippet.content || ''} [link: ${snippet.linkUrl || ''}] ${tags}`.trim();
        }
        // Text snippet
        return snippet.content || '';
    }

    /**
     * Index all snippets for a session (full rebuild).
     * Clears existing chunks for this session first.
     */
    async function indexSession(sessionName, snippets) {
        const db = await init();

        // Clear existing data for this session
        await CyberIDB.deleteByIndex(db, 'chunks', 'by-session', sessionName);

        const allChunks = [];

        for (const snippet of snippets) {
            const text = _snippetToText(snippet);
            const chunks = CyberTokenizer.chunkText(text);

            for (const chunk of chunks) {
                allChunks.push({
                    id: chunks.length === 1 ? snippet.id : `${snippet.id}_${chunk.chunkIndex}`,
                    snippetId: snippet.id,
                    sessionName,
                    content: chunk.content,
                    tokenCount: CyberTokenizer.estimateTokens(chunk.content),
                    sourceUrl: snippet.sourceUrl || '',
                    sourceTitle: snippet.sourceTitle || '',
                    timestamp: snippet.timestamp || Date.now(),
                    tags: snippet.tags || [],
                    chunkIndex: chunk.chunkIndex,
                    parentId: chunks.length > 1 ? snippet.id : undefined,
                    type: snippet.type || 'text'
                });
            }
        }

        // Batch write all chunks
        if (allChunks.length > 0) {
            await CyberIDB.putAll(db, 'chunks', allChunks);
        }

        // Update meta
        await CyberIDB.put(db, 'meta', {
            key: `session:${sessionName}`,
            value: {
                indexedAt: Date.now(),
                snippetCount: snippets.length,
                chunkCount: allChunks.length
            }
        });

        return allChunks.length;
    }

    /**
     * Get all chunks for a session.
     */
    async function getSessionChunks(sessionName) {
        const db = await init();
        return CyberIDB.getAll(db, 'chunks', 'by-session', sessionName);
    }

    /**
     * Get chunks by array of IDs.
     */
    async function getChunks(chunkIds) {
        const db = await init();
        const results = [];
        for (const id of chunkIds) {
            const chunk = await CyberIDB.get(db, 'chunks', id);
            if (chunk) results.push(chunk);
        }
        return results;
    }

    /**
     * Get all chunks belonging to a specific snippet (by snippetId).
     */
    async function getSnippetChunks(snippetId) {
        const db = await init();
        return CyberIDB.getAll(db, 'chunks', 'by-snippet', snippetId);
    }

    /**
     * Remove all chunks for a specific snippet.
     */
    async function removeSnippet(snippetId) {
        const db = await init();
        await CyberIDB.deleteByIndex(db, 'chunks', 'by-snippet', snippetId);
    }

    /**
     * Clear all data for a session.
     */
    async function clearSession(sessionName) {
        const db = await init();
        await CyberIDB.deleteByIndex(db, 'chunks', 'by-session', sessionName);
        await CyberIDB.deleteByIndex(db, 'vectors', 'by-session', sessionName);
        await CyberIDB.delete(db, 'meta', `session:${sessionName}`);
    }

    return {
        init,
        isSessionIndexed,
        indexSession,
        getSessionChunks,
        getChunks,
        getSnippetChunks,
        removeSnippet,
        clearSession
    };
})();
