/**
 * RAGIndexer — Snippet-to-chunk pipeline with IndexedDB persistence.
 * Handles: chunking, IDB storage, lazy migration from chrome.storage.local,
 *          session index validation, and chunk retrieval.
 *
 * IndexedDB is a PARALLEL search index, not a replacement for chrome.storage.local.
 * If corrupted, it can be fully rebuilt from the source data.
 */
/* exported RAGIndexer */
/* global WeftIDB, WeftTokenizer */

const RAGIndexer = (() => {
    'use strict';

    function abortError(signal) {
        if (signal?.reason?.name === 'AbortError') return signal.reason;
        const error = new Error('RAG indexing was aborted.');
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

    const DB_NAME = 'cyber-rag';
    const DB_VERSION = 1;
    let _db = null;
    let _dbPromise = null;
    const _sessionQueues = new Map();

    /**
     * Open (or create) the IndexedDB database.
     */
    async function init() {
        if (_db) return _db;
        if (_dbPromise) return _dbPromise;
        _dbPromise = WeftIDB.open(DB_NAME, DB_VERSION, (db, oldVersion) => {
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
        }).then((db) => {
            _db = db;
            return db;
        }).finally(() => {
            _dbPromise = null;
        });
        return _dbPromise;
    }

    function updateHashPair(state, value) {
        const text = String(value == null ? '' : value);
        // Length-prefix every field so concatenation cannot create ambiguous
        // revisions (for example ["ab", "c"] versus ["a", "bc"]).
        const framed = `${text.length}:` + text;
        for (let index = 0; index < framed.length; index++) {
            const code = framed.charCodeAt(index);
            state.fnv ^= code;
            state.fnv = Math.imul(state.fnv, 0x01000193);
            state.djb = Math.imul(state.djb, 33) ^ code;
        }
        state.chars += framed.length;
    }

    /**
     * Stable revision of every field represented in the persisted RAG chunks.
     * This catches edits that preserve snippet count, unlike the legacy meta.
     */
    async function computeSessionRevision(snippets, options = {}) {
        const signal = options.signal;
        const items = Array.isArray(snippets) ? snippets : [];
        const state = { fnv: 0x811c9dc5, djb: 5381, chars: 0 };
        let charsAtLastYield = 0;

        throwIfAborted(signal);
        updateHashPair(state, items.length);
        for (let index = 0; index < items.length; index++) {
            throwIfAborted(signal);
            const snippet = items[index] || {};
            updateHashPair(state, snippet.id);
            updateHashPair(state, snippet.type || 'text');
            updateHashPair(state, _snippetToText(snippet));
            updateHashPair(state, snippet.sourceUrl);
            updateHashPair(state, snippet.sourceTitle);
            updateHashPair(state, snippet.timestamp);
            updateHashPair(state, Array.isArray(snippet.tags) ? snippet.tags.join('\u001f') : '');
            if (state.chars - charsAtLastYield >= 50000) {
                charsAtLastYield = state.chars;
                await yieldToMainThread(signal);
            }
        }

        throwIfAborted(signal);
        return `rag-v4-${items.length}-${(state.fnv >>> 0).toString(16).padStart(8, '0')}-${(state.djb >>> 0).toString(16).padStart(8, '0')}`;
    }

    /**
     * Check if a session is already indexed and up-to-date.
     */
    async function isSessionIndexed(sessionName, revision, snippetCount) {
        const db = await init();
        const meta = await WeftIDB.get(db, 'meta', `session:${sessionName}`);
        const value = meta?.value;
        if (!value) return false;
        return value.indexVersion === 4
            && value.state === 'ready'
            && value.revision === revision
            && value.snippetCount === snippetCount;
    }

    /**
     * Build searchable text for a snippet (regardless of type).
     */
    function _snippetToText(snippet) {
        const fields = [];
        const seen = new Set();
        const add = (label, value, maxChars = 1000) => {
            const text = String(value || '').replace(/\s+/gu, ' ').trim().slice(0, maxChars);
            if (!text) return;
            const key = text.toLocaleLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            fields.push(label ? `[${label}] ${text}` : text);
        };

        if (snippet.type === 'image') {
            add('Image', snippet.content || snippet.imageUrl, 800);
        } else {
            add('', snippet.content, Number.MAX_SAFE_INTEGER);
            if (snippet.type === 'link') add('Link', snippet.linkUrl, 500);
        }

        // User-authored comments and Smart Read metadata express why an item
        // belongs in the Session. They are retrieval signals, not mere display
        // decoration, so include them alongside the captured passage.
        add('Source', snippet.sourceTitle || snippet.sourceUrl, 400);
        if (snippet.sourceDocumentType === 'pdf' && Number.isInteger(snippet.sourcePageNumber)) {
            add('PDF page', snippet.sourcePageNumber, 20);
        }
        add('Tags', Array.isArray(snippet.tags) ? snippet.tags.join(' ') : '', 400);
        add('User note', snippet.comment, 1200);
        add('Topic', snippet.smartReadTopic, 500);
        add('Takeaway', snippet.smartReadTakeawayTitle, 500);
        add('Summary', snippet.smartReadSummary, 1200);
        add('Reason saved', snippet.smartReadReason, 1000);
        add('Category', snippet.smartReadCategory, 300);
        add('Section', snippet.smartReadSection, 300);
        return fields.join('\n');
    }

    /**
     * Index all snippets for a session (full rebuild).
     * Clears existing chunks for this session first.
     */
    async function buildSessionChunks(sessionName, snippets, revision, options = {}) {
        const signal = options.signal;
        throwIfAborted(signal);
        const db = await init();
        throwIfAborted(signal);
        const allChunks = [];

        for (let snippetIndex = 0; snippetIndex < snippets.length; snippetIndex++) {
            throwIfAborted(signal);
            const snippet = snippets[snippetIndex] || {};
            const text = _snippetToText(snippet);
            const chunks = WeftTokenizer.chunkText(text);

            for (const chunk of chunks) {
                allChunks.push({
                    id: chunks.length === 1 ? snippet.id : `${snippet.id}_${chunk.chunkIndex}`,
                    snippetId: snippet.id,
                    sessionName,
                    content: chunk.content,
                    tokenCount: WeftTokenizer.estimateTokens(chunk.content),
                    sourceUrl: snippet.sourceUrl || '',
                    sourceTitle: snippet.sourceTitle || '',
                    sourceDocumentType: snippet.sourceDocumentType || '',
                    sourcePageNumber: Number.isInteger(snippet.sourcePageNumber) ? snippet.sourcePageNumber : 0,
                    timestamp: snippet.timestamp || Date.now(),
                    tags: snippet.tags || [],
                    chunkIndex: chunk.chunkIndex,
                    parentId: chunks.length > 1 ? snippet.id : undefined,
                    type: snippet.type || 'text'
                });
            }
            if (snippetIndex > 0 && snippetIndex % 25 === 0) {
                await yieldToMainThread(signal);
            }
        }

        // Build completely before touching the durable index. If tokenization
        // fails, the last known-good chunks and meta remain usable.
        throwIfAborted(signal);
        const existingChunks = await WeftIDB.getAll(db, 'chunks', 'by-session', sessionName);
        throwIfAborted(signal);

        // Mark the previous commit unusable immediately before mutating chunks.
        // If this context is suspended or aborted midway, another writer will
        // rebuild instead of trusting old meta alongside partially new chunks.
        await WeftIDB.put(db, 'meta', {
            key: `session:${sessionName}`,
            value: {
                indexVersion: 4,
                state: 'building',
                revision,
                snippetCount: snippets.length
            }
        });
        throwIfAborted(signal);

        // Overwrite current IDs first, then remove records no longer present.
        // This avoids the legacy delete-first window where readers saw an empty
        // index for the whole cooperative build.
        if (allChunks.length > 0) {
            await WeftIDB.putAll(db, 'chunks', allChunks);
            throwIfAborted(signal);
        }

        const currentIds = new Set(allChunks.map((chunk) => chunk.id));
        let deleted = 0;
        for (const oldChunk of existingChunks) {
            throwIfAborted(signal);
            if (currentIds.has(oldChunk.id)) continue;
            await WeftIDB.delete(db, 'chunks', oldChunk.id);
            deleted++;
            if (deleted % 100 === 0) await yieldToMainThread(signal);
        }

        // A read created after the chunk writes is a transaction barrier for
        // this object store. Do not publish ready meta before stale deletes are
        // durably visible.
        await WeftIDB.getAll(db, 'chunks', 'by-session', sessionName);
        throwIfAborted(signal);
        return allChunks;
    }

    function withSessionQueue(sessionName, task) {
        const previous = _sessionQueues.get(sessionName) || Promise.resolve();
        const operation = previous.catch(() => {}).then(task);
        _sessionQueues.set(sessionName, operation);
        operation.then(() => {
            if (_sessionQueues.get(sessionName) === operation) _sessionQueues.delete(sessionName);
        }, () => {
            if (_sessionQueues.get(sessionName) === operation) _sessionQueues.delete(sessionName);
        });
        return operation;
    }

    function withCrossContextLock(sessionName, task, signal) {
        if (typeof navigator !== 'undefined' && navigator.locks?.request) {
            const lockOptions = { mode: 'exclusive' };
            if (signal) lockOptions.signal = signal;
            return navigator.locks.request(`weft-rag-index-v4:${sessionName}`, lockOptions, task);
        }
        return task();
    }

    function waitWithSignal(promise, signal) {
        if (!signal) return promise;
        throwIfAborted(signal);
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (callback, value) => {
                if (finished) return;
                finished = true;
                signal.removeEventListener('abort', onAbort);
                callback(value);
            };
            const onAbort = () => finish(reject, abortError(signal));
            signal.addEventListener('abort', onAbort, { once: true });
            promise.then(
                (value) => finish(resolve, value),
                (error) => finish(reject, signal.aborted ? abortError(signal) : error)
            );
            if (signal.aborted) onAbort();
        });
    }

    /**
     * Return chunks for exactly this revision, rebuilding at most once per
     * session/revision in this context and serializing writers across contexts.
     */
    async function ensureSessionChunks(sessionName, snippets, suppliedRevision, options = {}) {
        const signal = options.signal;
        const items = Array.isArray(snippets) ? snippets : [];
        throwIfAborted(signal);
        const revision = suppliedRevision || await computeSessionRevision(items, { signal });
        throwIfAborted(signal);

        // The queue is intentionally retained even after a caller aborts. Its
        // task observes the signal before doing work, while later revisions can
        // safely proceed once the current writer releases the session lock.
        const operation = withSessionQueue(sessionName, () => withCrossContextLock(sessionName, async () => {
            throwIfAborted(signal);
            if (await isSessionIndexed(sessionName, revision, items.length)) {
                throwIfAborted(signal);
                return getSessionChunks(sessionName);
            }

            const chunks = await buildSessionChunks(sessionName, items, revision, { signal });
            throwIfAborted(signal);
            const db = await init();
            throwIfAborted(signal);

            // Meta is the commit marker and is deliberately written last.
            await WeftIDB.put(db, 'meta', {
                key: `session:${sessionName}`,
                value: {
                    indexVersion: 4,
                    state: 'ready',
                    revision,
                    indexedAt: Date.now(),
                    snippetCount: items.length,
                    chunkCount: chunks.length
                }
            });
            throwIfAborted(signal);
            return chunks;
        }, signal));
        return waitWithSignal(operation, signal);
    }

    /** Preserve the existing count-returning API for external callers. */
    async function indexSession(sessionName, snippets, suppliedRevision, options = {}) {
        const chunks = await ensureSessionChunks(sessionName, snippets, suppliedRevision, options);
        return chunks.length;
    }

    /**
     * Get all chunks for a session.
     */
    async function getSessionChunks(sessionName) {
        const db = await init();
        return WeftIDB.getAll(db, 'chunks', 'by-session', sessionName);
    }

    /**
     * Get chunks by array of IDs.
     */
    async function getChunks(chunkIds) {
        const db = await init();
        const results = [];
        for (const id of chunkIds) {
            const chunk = await WeftIDB.get(db, 'chunks', id);
            if (chunk) results.push(chunk);
        }
        return results;
    }

    /**
     * Get all chunks belonging to a specific snippet (by snippetId).
     */
    async function getSnippetChunks(snippetId) {
        const db = await init();
        return WeftIDB.getAll(db, 'chunks', 'by-snippet', snippetId);
    }

    /**
     * Remove all chunks for a specific snippet.
     */
    async function removeSnippet(snippetId) {
        const db = await init();
        await WeftIDB.deleteByIndex(db, 'chunks', 'by-snippet', snippetId);
    }

    /**
     * Clear all data for a session.
     */
    async function clearSession(sessionName) {
        if (typeof sessionName !== 'string' || !sessionName || sessionName.length > 512) return 0;
        return withSessionQueue(sessionName, () => withCrossContextLock(sessionName, async () => {
            const db = await init();
            const meta = await WeftIDB.get(db, 'meta', `session:${sessionName}`);
            await WeftIDB.deleteByIndex(db, 'chunks', 'by-session', sessionName);
            // The vectors store is currently dormant, but its records use the
            // same Session lifecycle and must not outlive a deleted Session.
            await WeftIDB.deleteByIndex(db, 'vectors', 'by-session', sessionName);
            await WeftIDB.delete(db, 'meta', `session:${sessionName}`);
            return meta ? 1 : 0;
        }));
    }

    /**
     * Prune durable indexes whose Session no longer exists. Callers provide a
     * storage-locked snapshot of authoritative names; malformed records are
     * intentionally left untouched rather than broadening the deletion scope.
     */
    async function collectGarbage(liveSessionNames) {
        const live = new Set(
            (Array.isArray(liveSessionNames) ? liveSessionNames : [])
                .filter((name) => typeof name === 'string' && name)
        );
        const db = await init();
        // Every committed or interrupted build writes session meta before its
        // chunks. Scanning those tiny keys avoids loading all chunk text or
        // dormant vector payloads during browser startup.
        const metaKeys = await WeftIDB.getAllKeys(db, 'meta');
        const orphanNames = new Set();
        for (const key of Array.isArray(metaKeys) ? metaKeys : []) {
            if (typeof key !== 'string' || !key.startsWith('session:')) continue;
            const name = key.slice('session:'.length);
            if (name && name.length <= 512 && !live.has(name)) orphanNames.add(name);
        }

        let deleted = 0;
        for (const name of orphanNames) deleted += await clearSession(name);
        return deleted;
    }

    return {
        init,
        snippetToSearchText: _snippetToText,
        computeSessionRevision,
        isSessionIndexed,
        ensureSessionChunks,
        indexSession,
        getSessionChunks,
        getChunks,
        getSnippetChunks,
        removeSnippet,
        clearSession,
        collectGarbage
    };
})();
