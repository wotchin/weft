/**
 * Weft — Store: single source of truth for persistence.
 *
 * Wraps chrome.storage.local (sessions, config) and IndexedDB (cached images)
 * behind one API, plus an idempotent schema migration for data saved by older
 * versions. Large base64 images live in IndexedDB so that writing a snippet
 * doesn't rewrite megabytes of `sessions` each time.
 *
 * Runs in both the service worker and extension pages.
 *
 * Usage: Store.getSessions(), Store.addSnippet(name, snip), Store.getLlmConfig()...
 */
/* exported Store */
/* global WeftIDB, RAGIndexer, RAGEngine */

const Store = (() => {
    'use strict';

    const SCHEMA_VERSION = 8;
    const IMG_DB = 'weft';
    const IMG_DB_VERSION = 1;

    // Legacy flat LLM keys → unified llmConfig (migration source)
    const LEGACY_LLM_KEYS = ['apiKey', 'apiBaseUrl', 'modelName', 'maxTokens', 'temperature', 'visionMode'];
    // Keys belonging to removed features — cleared on migration
    const DEAD_KEYS = ['replayData'];

    // NOTE: this is the deep fallback for users with no saved config and no
    // first-run probe result (e.g. refreshed upgrade where onInstalled never
    // ran for reason='install'). Fresh installs are routed to either
    // 'builtin' (Chrome 138+ Prompt API available) or 'custom' by
    // pickFirstRunProvider(). Do NOT assume the default provider is OpenAI.
    const DEFAULT_LLM_CONFIG = {
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.6-luna',
        temperature: 0.7,
        maxTokens: 2000,
        visionMode: 'auto',
        // Thinking is strict opt-in. Missing, legacy `auto`, and malformed
        // values all normalize to `off`; only an explicit user choice of
        // `on` may enable provider-side reasoning.
        reasoning: 'off',
    };

    // ── IndexedDB (images) ──────────────────────────────────────────────
    let _imgDb = null;
    async function _imgdb() {
        if (_imgDb) return _imgDb;
        _imgDb = await WeftIDB.open(IMG_DB, IMG_DB_VERSION, (db) => {
            if (!db.objectStoreNames.contains('images')) {
                db.createObjectStore('images', { keyPath: 'id' });
            }
        });
        return _imgDb;
    }

    async function putImage(snippetId, dataUrl) {
        const db = await _imgdb();
        await WeftIDB.put(db, 'images', { id: snippetId, dataUrl });
    }

    async function getImage(snippetId) {
        const db = await _imgdb();
        const rec = await WeftIDB.get(db, 'images', snippetId);
        return rec ? rec.dataUrl : null;
    }

    async function deleteImage(snippetId) {
        const db = await _imgdb();
        await WeftIDB.delete(db, 'images', snippetId);
    }

    function liveSnippetIds(sessions) {
        const ids = new Set();
        for (const snippets of Object.values(sessions || {})) {
            if (!Array.isArray(snippets)) continue;
            for (const snippet of snippets) {
                if (typeof snippet?.id === 'string' && snippet.id) ids.add(snippet.id);
            }
        }
        return ids;
    }

    function dropRagMemory(sessionNames) {
        if (typeof RAGEngine === 'undefined' || typeof RAGEngine.dropSession !== 'function') return;
        for (const sessionName of sessionNames) RAGEngine.dropSession(sessionName);
    }

    async function clearRagSessions(sessionNames) {
        if (typeof RAGIndexer === 'undefined' || typeof RAGIndexer.clearSession !== 'function') return;
        for (const sessionName of sessionNames) await RAGIndexer.clearSession(sessionName);
    }

    /**
     * Remove rebuildable data after the authoritative storage.local commit.
     * A cache failure must never roll back or disguise a successful Session
     * mutation; startup maintenance will retry any remaining orphan later.
     */
    async function cleanupDerivedSessionData(sessionNames, imageIds = []) {
        const names = [...new Set(sessionNames.filter((name) => typeof name === 'string' && name))];
        const errors = [];
        try { dropRagMemory(names); } catch (error) { errors.push(error); }
        for (const id of new Set(imageIds)) {
            try { await deleteImage(id); } catch (error) { errors.push(error); }
        }
        try { await clearRagSessions(names); } catch (error) { errors.push(error); }
        if (errors.length > 0) {
            console.warn('[Weft] derived Session cleanup will be retried by maintenance:', errors[0]);
        }
        return errors.length;
    }

    // ── Chat transcripts (per-session message history) ──────────────────
    //
    // Stored separately from `sessions` (snippets) so the two can evolve
    // independently and so writing a chat turn never rewrites the much
    // larger snippets array. Keyed by session name; trimmed to a sliding
    // window with both turn and byte-like character budgets so a few very
    // large model responses cannot make every restore rewrite megabytes.
    const MAX_CHAT_TURNS = 100;
    const MAX_CHAT_CHARS = 320_000;
    const MAX_CHAT_TURN_CHARS = 135_000;
    const MAX_CHAT_CITATION_CHARS = 20_000;

    function boundedStoredText(value, limit) {
        const text = typeof value === 'string' ? value : '';
        if (text.length <= limit) return text;
        const marker = '\n[Stored conversation content truncated.]';
        if (limit <= marker.length) return marker.slice(0, Math.max(0, limit));
        return text.slice(0, Math.max(0, limit - marker.length)).trimEnd() + marker;
    }

    function boundedStoredCitations(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const kept = Object.create(null);
        let chars = 2;
        for (const [marker, metadata] of Object.entries(value)) {
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
            let encoded;
            try {
                encoded = JSON.stringify({ [marker]: metadata });
            } catch {
                continue;
            }
            if (chars + encoded.length > MAX_CHAT_CITATION_CHARS) break;
            kept[marker] = metadata;
            chars += encoded.length;
        }
        return Object.keys(kept).length > 0 ? kept : undefined;
    }

    function compactStoredChat(messages) {
        const source = Array.isArray(messages) ? messages.slice(-MAX_CHAT_TURNS) : [];
        const next = source.map((message) => {
            const stored = {
                role: message?.role === 'assistant' ? 'assistant' : 'user',
                content: boundedStoredText(message?.content, MAX_CHAT_TURN_CHARS),
            };
            const citations = boundedStoredCitations(message?.citations);
            if (citations) stored.citations = citations;
            return stored;
        });
        // Count the actual serialized payload (one comma per item plus the
        // closing bracket) so quotes and escapes cannot slip past the cap.
        const cost = (message) => JSON.stringify(message).length + 1;
        let total = 1 + next.reduce((sum, message) => sum + cost(message), 0);
        while (total > MAX_CHAT_CHARS && next.length > 2) {
            total -= cost(next.shift());
            // Persist complete exchanges where possible; an orphaned assistant
            // turn at the start has no useful question context after reload.
            if (next[0]?.role === 'assistant' && next.length > 2) {
                total -= cost(next.shift());
            }
        }
        // Escape-heavy content (quotes/backslashes) can make even the newest
        // two individually bounded turns exceed the serialized payload cap.
        // Preserve the exchange but binary-fit its stored text against the
        // actual JSON size; citations remain bounded separately above.
        for (let index = 0; total > MAX_CHAT_CHARS && index < next.length; index++) {
            const original = next[index].content;
            let low = 0;
            let high = original.length;
            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                const candidate = next.map((message, messageIndex) => (
                    messageIndex === index
                        ? { ...message, content: boundedStoredText(original, middle) }
                        : message
                ));
                if (JSON.stringify(candidate).length <= MAX_CHAT_CHARS) low = middle;
                else high = middle - 1;
            }
            next[index] = { ...next[index], content: boundedStoredText(original, low) };
            total = JSON.stringify(next).length;
        }
        return next;
    }

    function storedChatMatches(source, compacted) {
        if (!Array.isArray(source) || source.length !== compacted.length) return false;
        const allowedKeys = new Set(['role', 'content', 'citations']);
        for (let index = 0; index < source.length; index++) {
            const original = source[index];
            const bounded = compacted[index];
            if (!original || typeof original !== 'object' || Array.isArray(original)) return false;
            if (Object.keys(original).some((key) => !allowedKeys.has(key))) return false;
            if (original.role !== bounded.role || original.content !== bounded.content) return false;

            const originalHasCitations = Object.prototype.hasOwnProperty.call(original, 'citations');
            const boundedHasCitations = Object.prototype.hasOwnProperty.call(bounded, 'citations');
            if (originalHasCitations !== boundedHasCitations) return false;
            if (!boundedHasCitations) continue;

            const originalCitations = original.citations;
            if (!originalCitations || typeof originalCitations !== 'object' || Array.isArray(originalCitations)) {
                return false;
            }
            const originalMarkers = Object.keys(originalCitations);
            const boundedMarkers = Object.keys(bounded.citations);
            if (originalMarkers.length !== boundedMarkers.length) return false;
            for (let markerIndex = 0; markerIndex < originalMarkers.length; markerIndex++) {
                const marker = originalMarkers[markerIndex];
                if (marker !== boundedMarkers[markerIndex]
                    || originalCitations[marker] !== bounded.citations[marker]) return false;
            }
        }
        return true;
    }

    function validChatMap(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }

    /**
     * Normalize every persisted transcript in one locked storage commit. This
     * is used by migration so an upgrade cannot leave dormant, oversized
     * Sessions waiting to stall the first workbench restore.
     */
    async function compactStoredChatMap() {
        return withSessionWriteLock(async () => {
            const stored = await chrome.storage.local.get(['chat']);
            if (!Object.prototype.hasOwnProperty.call(stored, 'chat')) return false;
            const current = validChatMap(stored.chat);
            if (!current) {
                await chrome.storage.local.set({ chat: {} });
                return true;
            }

            let changed = false;
            const next = Object.create(null);
            for (const [sessionName, messages] of Object.entries(current)) {
                const compacted = compactStoredChat(messages);
                next[sessionName] = compacted;
                if (!storedChatMatches(messages, compacted)) changed = true;
            }
            if (changed) await chrome.storage.local.set({ chat: next });
            return changed;
        });
    }

    async function getChat(sessionName) {
        if (!sessionName) return [];
        const stored = await chrome.storage.local.get(['chat']);
        const chat = validChatMap(stored.chat);
        if (!chat || !Object.prototype.hasOwnProperty.call(chat, sessionName)) return [];

        const compacted = compactStoredChat(chat[sessionName]);
        if (storedChatMatches(chat[sessionName], compacted)) return compacted;

        // Re-read inside the shared lock before repairing. A panel may have
        // written a newer transcript after the optimistic read above; that
        // newer value must win instead of being overwritten by stale cleanup.
        return withSessionWriteLock(async () => {
            const latestStored = await chrome.storage.local.get(['chat']);
            const latestChat = validChatMap(latestStored.chat);
            if (!latestChat || !Object.prototype.hasOwnProperty.call(latestChat, sessionName)) return [];
            const latestCompacted = compactStoredChat(latestChat[sessionName]);
            if (!storedChatMatches(latestChat[sessionName], latestCompacted)) {
                await chrome.storage.local.set({
                    chat: { ...latestChat, [sessionName]: latestCompacted },
                });
            }
            return latestCompacted;
        });
    }

    async function setChat(sessionName, messages) {
        if (!sessionName) return;
        await withSessionWriteLock(async () => {
            const stored = await chrome.storage.local.get(['chat']);
            const chat = validChatMap(stored.chat);
            await chrome.storage.local.set({
                chat: { ...(chat || {}), [sessionName]: compactStoredChat(messages) },
            });
        });
    }

    // ── Sessions ────────────────────────────────────────────────────────
    async function getSessions() {
        const { sessions = {} } = await chrome.storage.local.get(['sessions']);
        return sessions;
    }

    // Full-object writes are intentionally private. Public callers must use a
    // locked mutation API so another extension context cannot be overwritten.
    async function writeSessionsSnapshot(sessions) {
        await chrome.storage.local.set({ sessions });
    }

    async function getSession(name) {
        const sessions = await getSessions();
        return sessions[name] || [];
    }

    async function getCurrentSession() {
        const { currentSession } = await chrome.storage.local.get(['currentSession']);
        return currentSession || null;
    }

    async function setCurrentSession(name) {
        await chrome.storage.local.set({ currentSession: name });
    }

    const SMART_READ_REQUEST_QUEUE_LIMIT = 64;
    let _smartReadRequestQueue = Promise.resolve();

    function withSmartReadRequestLock(task) {
        const run = () => {
            if (typeof navigator !== 'undefined' && navigator.locks?.request) {
                return navigator.locks.request('weft-smart-read-request-v1', { mode: 'exclusive' }, task);
            }
            return task();
        };
        const operation = _smartReadRequestQueue.then(run, run);
        _smartReadRequestQueue = operation.catch(() => {});
        return operation;
    }

    function normalizePendingSmartReads(value, legacy) {
        const source = Array.isArray(value)
            ? value
            : value && typeof value === 'object' ? Object.values(value) : [];
        const queue = [];
        const seen = new Set();
        for (const candidate of [...source, legacy]) {
            if (!candidate || typeof candidate !== 'object' || typeof candidate.requestId !== 'string') continue;
            if (!candidate.requestId || seen.has(candidate.requestId)) continue;
            seen.add(candidate.requestId);
            queue.push({ ...candidate });
        }
        queue.sort((left, right) =>
            (Number(left.requestedAt) || 0) - (Number(right.requestedAt) || 0)
                || left.requestId.localeCompare(right.requestId)
        );
        return queue;
    }

    async function readPendingSmartReads() {
        const stored = await chrome.storage.local.get(['pendingSmartReads', 'pendingSmartRead']);
        return {
            queue: normalizePendingSmartReads(stored.pendingSmartReads, stored.pendingSmartRead),
            hasLegacy: Boolean(stored.pendingSmartRead),
        };
    }

    async function writePendingSmartReads(queue, hasLegacy = false) {
        await chrome.storage.local.set({ pendingSmartReads: queue });
        if (hasLegacy) await chrome.storage.local.remove('pendingSmartRead');
    }

    async function setPendingSmartRead(request) {
        return withSmartReadRequestLock(async () => {
            const pending = request && typeof request === 'object' ? { ...request } : null;
            if (!pending?.requestId) throw new Error('Smart Read requestId is required');
            const { queue, hasLegacy } = await readPendingSmartReads();
            const next = queue.filter(item => item.requestId !== pending.requestId);
            next.push(pending);
            next.sort((left, right) =>
                (Number(left.requestedAt) || 0) - (Number(right.requestedAt) || 0)
                    || left.requestId.localeCompare(right.requestId)
            );
            const bounded = next.slice(-SMART_READ_REQUEST_QUEUE_LIMIT);
            await writePendingSmartReads(bounded, hasLegacy);
            return pending;
        });
    }

    async function claimPendingSmartRead(consumerId, canClaim, opts = {}) {
        return withSmartReadRequestLock(async () => {
            const { queue, hasLegacy } = await readPendingSmartReads();
            if (typeof canClaim !== 'function') {
                return { claimed: false, pending: null, pendingRequests: queue, retryAfterMs: 0 };
            }

            const now = Date.now();
            let selectedIndex = -1;
            let retryAfterMs = 0;
            for (let index = 0; index < queue.length; index++) {
                const pending = queue[index];
                if (!canClaim(pending)) continue;
                const claimUntil = Number(pending.claimUntil) || 0;
                if (pending.claimedBy && claimUntil > now) {
                    const wait = Math.max(50, claimUntil - now + 25);
                    retryAfterMs = retryAfterMs ? Math.min(retryAfterMs, wait) : wait;
                    continue;
                }
                selectedIndex = index;
                break;
            }

            if (selectedIndex < 0) {
                if (hasLegacy) await writePendingSmartReads(queue, true);
                return {
                    claimed: false,
                    pending: null,
                    pendingRequests: queue,
                    retryAfterMs,
                };
            }

            const leaseMs = Math.max(30000, Number(opts.leaseMs) || 120000);
            const claimed = {
                ...queue[selectedIndex],
                claimedBy: consumerId,
                claimedAt: now,
                claimUntil: now + leaseMs,
            };
            queue[selectedIndex] = claimed;
            await writePendingSmartReads(queue, hasLegacy);
            return { claimed: true, pending: claimed, pendingRequests: queue, retryAfterMs: 0 };
        });
    }

    async function renewPendingSmartRead(requestId, consumerId, leaseMs = 120000) {
        return withSmartReadRequestLock(async () => {
            const { queue, hasLegacy } = await readPendingSmartReads();
            const index = queue.findIndex(item =>
                item.requestId === requestId && item.claimedBy === consumerId
            );
            if (index < 0) return false;
            queue[index] = {
                ...queue[index],
                claimUntil: Date.now() + Math.max(30000, Number(leaseMs) || 120000),
            };
            await writePendingSmartReads(queue, hasLegacy);
            return true;
        });
    }

    async function finishPendingSmartRead(requestId, consumerId) {
        return withSmartReadRequestLock(async () => {
            const { queue, hasLegacy } = await readPendingSmartReads();
            const index = queue.findIndex(item =>
                item.requestId === requestId && item.claimedBy === consumerId
            );
            if (index < 0) return false;
            queue.splice(index, 1);
            await writePendingSmartReads(queue, hasLegacy);
            return true;
        });
    }

    async function releasePendingSmartRead(requestId, consumerId) {
        return withSmartReadRequestLock(async () => {
            const { queue, hasLegacy } = await readPendingSmartReads();
            const index = queue.findIndex(item =>
                item.requestId === requestId && item.claimedBy === consumerId
            );
            if (index < 0) return false;
            const released = { ...queue[index] };
            delete released.claimedBy;
            delete released.claimedAt;
            delete released.claimUntil;
            queue[index] = released;
            await writePendingSmartReads(queue, hasLegacy);
            return true;
        });
    }

    async function discardPendingSmartRead(requestId) {
        return withSmartReadRequestLock(async () => {
            if (!requestId) return false;
            const { queue, hasLegacy } = await readPendingSmartReads();
            const next = queue.filter(item => item.requestId !== requestId);
            if (next.length === queue.length) return false;
            await writePendingSmartReads(next, hasLegacy);
            return true;
        });
    }

    const MAX_SESSION_NAME_LENGTH = 80;
    const UNSAFE_SESSION_KEYS = new Set([
        '__proto__', 'prototype', 'constructor',
        'toString', 'toLocaleString', 'valueOf',
        'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
        '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
    ].map((key) => key.toLowerCase()));
    let _sessionWriteQueue = Promise.resolve();

    /**
     * Serialize session read-modify-write operations. Web Locks coordinate the
     * service worker, side panel and popup; the promise queue is the fallback
     * for older runtimes and also preserves ordering within one context.
     */
    function withSessionWriteLock(task) {
        const run = () => {
            if (typeof navigator !== 'undefined' && navigator.locks?.request) {
                return navigator.locks.request('weft-session-storage-v1', { mode: 'exclusive' }, task);
            }
            return task();
        };
        const operation = _sessionWriteQueue.then(run, run);
        _sessionWriteQueue = operation.catch(() => {});
        return operation;
    }

    function cleanSessionName(value) {
        let name = typeof value === 'string' ? value : '';
        try { name = name.normalize('NFKC'); } catch { /* unsupported normalization */ }
        name = name
            .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_SESSION_NAME_LENGTH)
            .trim();
        return UNSAFE_SESSION_KEYS.has(name.toLowerCase()) ? '' : name;
    }

    function uniqueSessionName(sessions, baseName) {
        if (!Object.prototype.hasOwnProperty.call(sessions, baseName)) return baseName;

        let number = 2;
        while (number < 100000) {
            const suffix = ` (${number})`;
            const stem = baseName.slice(0, MAX_SESSION_NAME_LENGTH - suffix.length).trimEnd();
            const candidate = `${stem}${suffix}`;
            if (!Object.prototype.hasOwnProperty.call(sessions, candidate)) return candidate;
            number++;
        }

        // This is practically unreachable, but preserves both the length limit
        // and collision safety even for deliberately adversarial session data.
        const suffix = ` (${Date.now().toString(36)})`;
        return `${baseName.slice(0, MAX_SESSION_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
    }

    /**
     * Create and activate a session in one storage commit.
     *
     * Smart Read callers may supply a stable key derived from the source page
     * and reading focus. Deduplication is the default for legacy callers;
     * explicit reading runs pass `deduplicate: false` so every run gets a new,
     * already-populated session while still retaining the analysis key.
     */
    async function createSessionWithSnippets(baseName, snippets, opts = {}) {
        return withSessionWriteLock(async () => {
            opts = opts && typeof opts === 'object' ? opts : {};
            const { sessions: storedSessions = {} } = await chrome.storage.local.get(['sessions']);
            const sessions = storedSessions && typeof storedSessions === 'object' && !Array.isArray(storedSessions)
                ? { ...storedSessions }
                : {};
            const smartReadKey = typeof opts.smartReadKey === 'string' ? opts.smartReadKey : '';
            const smartReadRequestId = typeof opts.smartReadRequestId === 'string'
                ? opts.smartReadRequestId
                : '';
            const deduplicate = opts.deduplicate !== false;

            // A lease can be recovered by another workbench after the first
            // one committed storage but closed before acknowledging the queue.
            // The request receipt makes that recovery idempotent without
            // conflating separate explicit reads of the same page.
            if (smartReadRequestId) {
                for (const [sessionName, items] of Object.entries(sessions)) {
                    if (!cleanSessionName(sessionName) || !Array.isArray(items)) continue;
                    if (!items.some(snippet => snippet?.smartReadRequestId === smartReadRequestId)) continue;
                    await chrome.storage.local.set({ sessions, currentSession: sessionName });
                    return {
                        sessionName,
                        snippets: items,
                        created: false,
                        deduplicated: true,
                        recovered: true,
                    };
                }
            }

            if (smartReadKey && deduplicate) {
                for (const [sessionName, items] of Object.entries(sessions)) {
                    if (!cleanSessionName(sessionName)) continue;
                    if (!Array.isArray(items)) continue;
                    const matches = items.some((snippet) =>
                        snippet && typeof snippet === 'object' && snippet.smartReadKey === smartReadKey
                    );
                    if (!matches) continue;

                    await chrome.storage.local.set({ sessions, currentSession: sessionName });
                    return {
                        sessionName,
                        snippets: items,
                        created: false,
                        deduplicated: true,
                    };
                }
            }

            const fallbackName = cleanSessionName(opts.fallbackName) || 'Smart Read';
            const safeBaseName = cleanSessionName(baseName) || fallbackName;
            const sessionName = uniqueSessionName(sessions, safeBaseName);
            const preparedSnippets = (Array.isArray(snippets) ? snippets : [])
                .filter((snippet) => snippet && typeof snippet === 'object' && !Array.isArray(snippet))
                .map((snippet) => {
                    const prepared = { ...snippet };
                    if (smartReadKey) prepared.smartReadKey = smartReadKey;
                    if (smartReadRequestId) prepared.smartReadRequestId = smartReadRequestId;
                    return prepared;
                });
            if (preparedSnippets.length === 0) {
                throw new Error('A populated session requires at least one snippet');
            }

            sessions[sessionName] = preparedSnippets;
            await chrome.storage.local.set({ sessions, currentSession: sessionName });
            return {
                sessionName,
                snippets: preparedSnippets,
                created: true,
                deduplicated: false,
            };
        });
    }

    async function findSessionBySmartReadKey(smartReadKey) {
        if (typeof smartReadKey !== 'string' || !smartReadKey) return null;
        const sessions = await getSessions();
        for (const [sessionName, items] of Object.entries(sessions)) {
            if (!Array.isArray(items)) continue;
            if (items.some((snippet) => snippet?.smartReadKey === smartReadKey)) {
                return { sessionName, snippets: items };
            }
        }
        return null;
    }

    async function createEmptySession(name) {
        return withSessionWriteLock(async () => {
            const safeName = cleanSessionName(name);
            if (!safeName) return { created: false, reason: 'invalid-name', sessionName: '' };
            const sessions = await getSessions();
            if (Object.prototype.hasOwnProperty.call(sessions, safeName)) {
                return { created: false, reason: 'exists', sessionName: safeName };
            }
            sessions[safeName] = [];
            await chrome.storage.local.set({ sessions, currentSession: safeName });
            return { created: true, sessionName: safeName };
        });
    }

    /** Seed a named session exactly once without racing normal session writes. */
    async function createSessionIfMissing(name, snippets = [], opts = {}) {
        return withSessionWriteLock(async () => {
            const safeName = cleanSessionName(name);
            if (!safeName) return { created: false, reason: 'invalid-name', sessionName: '' };
            const sessions = await getSessions();
            if (Object.prototype.hasOwnProperty.call(sessions, safeName)) {
                return { created: false, reason: 'exists', sessionName: safeName };
            }

            sessions[safeName] = (Array.isArray(snippets) ? snippets : [])
                .filter((snippet) => snippet && typeof snippet === 'object' && !Array.isArray(snippet))
                .map((snippet) => ({ ...snippet }));
            const changes = { sessions };
            if (opts?.activate) changes.currentSession = safeName;
            await chrome.storage.local.set(changes);
            return { created: true, sessionName: safeName, snippets: sessions[safeName] };
        });
    }

    async function renameSession(oldName, newName) {
        return withSessionWriteLock(async () => {
            const safeName = cleanSessionName(newName);
            const sessions = await getSessions();
            if (!Object.prototype.hasOwnProperty.call(sessions, oldName)) {
                return { renamed: false, reason: 'missing', sessionName: oldName };
            }
            if (!safeName) return { renamed: false, reason: 'invalid-name', sessionName: oldName };
            if (safeName !== oldName && Object.prototype.hasOwnProperty.call(sessions, safeName)) {
                return { renamed: false, reason: 'exists', sessionName: oldName };
            }
            if (safeName === oldName) return { renamed: false, reason: 'unchanged', sessionName: oldName };
            sessions[safeName] = sessions[oldName];
            delete sessions[oldName];
            // Carry over the chat transcript under the new name in the same
            // critical section (no nested lock acquisition).
            const { chat = {} } = await chrome.storage.local.get(['chat']);
            if (Object.prototype.hasOwnProperty.call(chat, oldName)) {
                chat[safeName] = chat[oldName];
                delete chat[oldName];
                await chrome.storage.local.set({ sessions, chat, currentSession: safeName });
            } else {
                await chrome.storage.local.set({ sessions, currentSession: safeName });
            }
            // A durable index is keyed by Session name. Keeping either the old
            // key or a stale orphan under the new key could make the renamed
            // Session retrieve unrelated passages, so both are discarded and
            // rebuilt lazily on the next query.
            const cleanupFailures = await cleanupDerivedSessionData([oldName, safeName]);
            return { renamed: true, sessionName: safeName, cleanupPending: cleanupFailures > 0 };
        });
    }

    async function deleteSession(name) {
        return withSessionWriteLock(async () => {
            const sessions = await getSessions();
            if (!Object.prototype.hasOwnProperty.call(sessions, name)) return { deleted: false, currentSession: null };
            const deletedSnippets = Array.isArray(sessions[name]) ? sessions[name] : [];
            delete sessions[name];
            const { currentSession, chat = {} } = await chrome.storage.local.get(['currentSession', 'chat']);
            const nextSession = currentSession === name ? Object.keys(sessions)[0] || null : currentSession || null;
            // Drop the chat transcript for the deleted session in the same
            // critical section (no nested lock acquisition).
            const chatChanged = Object.prototype.hasOwnProperty.call(chat, name);
            if (chatChanged) delete chat[name];
            await chrome.storage.local.set(
                chatChanged ? { sessions, chat, currentSession: nextSession } : { sessions, currentSession: nextSession }
            );
            // Legacy/imported data can contain duplicate snippet IDs across
            // Sessions. Never delete bytes that remain referenced elsewhere.
            const remainingIds = liveSnippetIds(sessions);
            const imageIds = deletedSnippets
                .filter((snippet) => snippet?.type === 'image' && !remainingIds.has(snippet.id))
                .map((snippet) => snippet.id)
                .filter((id) => typeof id === 'string' && id);
            const cleanupFailures = await cleanupDerivedSessionData([name], imageIds);
            return {
                deleted: true,
                currentSession: nextSession,
                cleanupPending: cleanupFailures > 0,
            };
        });
    }

    /**
     * The single write path for snippets. Large base64 images are offloaded
     * to IndexedDB; the snippet keeps a lightweight `hasCachedImage` flag while
     * remaining backward-compatible if a caller still reads `cachedDataUrl`.
     */
    async function addSnippet(sessionName, snippet) {
        await withSessionWriteLock(async () => {
            // Keep the image write under the same lifecycle lock as the
            // reference commit so orphan GC cannot race the two operations.
            if (snippet.type === 'image' && snippet.cachedDataUrl) {
                await putImage(snippet.id, snippet.cachedDataUrl);
                snippet.hasCachedImage = true;
                delete snippet.cachedDataUrl; // keep storage.local small
            }
            const sessions = await getSessions();
            if (!sessions[sessionName]) sessions[sessionName] = [];
            sessions[sessionName].push(snippet);
            await writeSessionsSnapshot(sessions);
        });
        return snippet;
    }

    /**
     * Delete only derived records that cannot be reached from any live
     * Session. The Session map remains the sole source of truth and is never
     * modified by this routine.
     */
    async function collectGarbage() {
        return withSessionWriteLock(async () => {
            const sessions = await getSessions();
            const ids = liveSnippetIds(sessions);
            const db = await _imgdb();
            // Read keys only: image values can be multi-megabyte data URLs and
            // must never all be materialized during startup maintenance.
            const imageIds = await WeftIDB.getAllKeys(db, 'images');
            let imagesDeleted = 0;
            for (const id of Array.isArray(imageIds) ? imageIds : []) {
                // Be deliberately conservative around malformed/foreign data:
                // only delete non-empty string keys used by Weft snippets.
                if (typeof id !== 'string' || !id || ids.has(id)) continue;
                await WeftIDB.delete(db, 'images', id);
                imagesDeleted++;
            }

            let ragDeleted = 0;
            if (typeof RAGIndexer !== 'undefined' && typeof RAGIndexer.collectGarbage === 'function') {
                ragDeleted = await RAGIndexer.collectGarbage(Object.keys(sessions));
            }
            return { imagesDeleted, ragDeleted };
        });
    }

    async function removeSnippet(sessionName, id) {
        await withSessionWriteLock(async () => {
            const sessions = await getSessions();
            if (!sessions[sessionName]) return false;
            const next = sessions[sessionName].filter((s) => s.id !== id);
            if (next.length === sessions[sessionName].length) {
                return false;
            }
            sessions[sessionName] = next;
            await writeSessionsSnapshot(sessions);
            // Keep the last-reference decision and derived-cache deletion inside
            // the same cross-context lock. A concurrent add with a legacy/shared
            // id can no longer land between the decision and deleteImage().
            if (!liveSnippetIds(sessions).has(id)) await deleteImage(id).catch(() => {});
            return true;
        });
    }

    async function updateSnippet(sessionName, id, changes) {
        return withSessionWriteLock(async () => {
            const sessions = await getSessions();
            const items = sessions[sessionName];
            if (!Array.isArray(items)) return null;
            const index = items.findIndex((snippet) => snippet?.id === id);
            if (index < 0) return null;
            const current = { ...items[index] };
            const patch = typeof changes === 'function' ? await changes(current) : changes;
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return current;
            const updated = { ...current, ...patch, id: current.id };
            items[index] = updated;
            await writeSessionsSnapshot(sessions);
            return updated;
        });
    }

    /** Apply several snippet patches with one locked storage commit. */
    async function updateSnippets(sessionName, patches) {
        const byId = new Map();
        for (const entry of Array.isArray(patches) ? patches : []) {
            if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
            if (!entry.changes || typeof entry.changes !== 'object' || Array.isArray(entry.changes)) continue;
            byId.set(entry.id, entry.changes);
        }
        if (byId.size === 0) return 0;
        return withSessionWriteLock(async () => {
            const sessions = await getSessions();
            const items = sessions[sessionName];
            if (!Array.isArray(items)) return 0;
            let updated = 0;
            sessions[sessionName] = items.map((snippet) => {
                const changes = byId.get(snippet?.id);
                if (!changes) return snippet;
                updated++;
                return { ...snippet, ...changes, id: snippet.id };
            });
            if (updated > 0) await writeSessionsSnapshot(sessions);
            return updated;
        });
    }

    /**
     * Mark several image snippets as cached in one read-modify-write commit.
     *
     * Image bytes are written to IndexedDB before this is called. Keeping this
     * metadata update batched prevents one `sessions` storage event per image,
     * and the no-op check makes overlapping cache jobs harmless.
     * @returns {Promise<number>} number of snippets whose flag changed
     */
    async function markImagesCached(sessionName, snippetIds) {
        const ids = new Set(
            (Array.isArray(snippetIds) ? snippetIds : [])
                .filter((id) => typeof id === 'string' && id)
        );
        if (ids.size === 0) return 0;

        return withSessionWriteLock(async () => {
            const sessions = await getSessions();
            const items = sessions[sessionName];
            if (!Array.isArray(items)) return 0;

            let updated = 0;
            sessions[sessionName] = items.map((snippet) => {
                if (
                    !snippet || snippet.type !== 'image' || !ids.has(snippet.id)
                    || snippet.hasCachedImage === true
                ) {
                    return snippet;
                }
                updated++;
                return { ...snippet, hasCachedImage: true };
            });

            if (updated > 0) await writeSessionsSnapshot(sessions);
            return updated;
        });
    }

    async function normalizeLegacySessions(makeSnippet) {
        return withSessionWriteLock(async () => {
            const sessions = await getSessions();
            let touched = false;
            for (const [sessionName, items] of Object.entries(sessions)) {
                if (!Array.isArray(items) || !items.some((item) => typeof item === 'string')) continue;
                sessions[sessionName] = items.map((item, index) => {
                    if (typeof item !== 'string') return item;
                    touched = true;
                    if (typeof makeSnippet === 'function') return makeSnippet(item, sessionName, index);
                    return {
                        id: `legacy-${Date.now().toString(36)}-${index.toString(36)}`,
                        type: 'text', content: item, sourceUrl: '', sourceTitle: '',
                        timestamp: Date.now(), tags: [],
                    };
                });
            }
            if (touched) await writeSessionsSnapshot(sessions);
            return sessions;
        });
    }

    /**
     * Resolve an image snippet's data URL from either IDB (new) or the inline
     * cachedDataUrl (legacy). Callers should use this instead of reading fields.
     */
    async function resolveImage(snippet) {
        if (snippet.cachedDataUrl) return snippet.cachedDataUrl;
        if (snippet.hasCachedImage) return getImage(snippet.id);
        return null;
    }

    // ── LLM config ──────────────────────────────────────────────────────
    function normalizeReasoningMode(value) {
        return value === 'on' ? 'on' : 'off';
    }

    async function getLlmConfig() {
        const data = await chrome.storage.local.get(['llmConfig', ...LEGACY_LLM_KEYS]);
        if (data.llmConfig) {
            const merged = { ...DEFAULT_LLM_CONFIG, ...data.llmConfig };
            merged.reasoning = normalizeReasoningMode(merged.reasoning);
            return merged;
        }
        // Fallback: synthesize from legacy flat keys (pre-migration reads)
        return {
            ...DEFAULT_LLM_CONFIG,
            apiKey: data.apiKey || '',
            baseUrl: data.apiBaseUrl || DEFAULT_LLM_CONFIG.baseUrl,
            model: data.modelName || DEFAULT_LLM_CONFIG.model,
            maxTokens: Number(data.maxTokens) || DEFAULT_LLM_CONFIG.maxTokens,
            temperature: data.temperature != null ? Number(data.temperature) : DEFAULT_LLM_CONFIG.temperature,
            visionMode: data.visionMode || DEFAULT_LLM_CONFIG.visionMode,
        };
    }

    async function setLlmConfig(cfg) {
        const merged = { ...DEFAULT_LLM_CONFIG, ...cfg };
        merged.reasoning = normalizeReasoningMode(merged.reasoning);
        await chrome.storage.local.set({ llmConfig: merged });
        return merged;
    }

    /**
     * First-run provider probe — called once from background.js on install.
     *
     * Picks 'builtin' (Chrome built-in AI, model 'gemini-nano') when the
     * Prompt API is available and downloadable, so a brand-new user can try
     * the extension with zero config. Falls back to 'custom' provider with a
     * blank baseUrl/model: the onboarding screen sets the expectation that a
     * provider + key must be configured, and 'custom' is the most honest
     * placeholder until the user picks one (rather than silently defaulting
     * to an OpenAI preset that would 401 with an empty key).
     *
     * Idempotent: skips the write if the user already has a non-default
     * llmConfig (defensive — handles the rare case where onInstalled fires
     * twice with reason='install' on a Chrome rollback).
     *
     * Also records `builtinModelStatus` reflecting LanguageModel.availability()
     * so onboarding.js can show different copy when the on-device model has
     * already been downloaded (status === 'available') versus when the first
     * chat will trigger a multi-GB download (status === 'downloadable').
     */
    async function pickFirstRunProvider() {
        const existing = await chrome.storage.local.get(['llmConfig']);
        if (existing.llmConfig && existing.llmConfig.provider) {
            // User already has a config — don't clobber it.
            return existing.llmConfig.provider;
        }

        let provider = 'custom';
        let model = '';
        let builtinModelStatus = '';
        try {
            // LanguageModel.availability() is the spec-compliant way to probe;
            // 'available' means the model is already downloaded and ready,
            // 'downloadable' means the first use will trigger a one-time
            // multi-GB download. We accept either and pick 'builtin' — the
            // on-device model is always a better zero-config default than a
            // custom provider pointing nowhere.
            if (typeof LanguageModel !== 'undefined' && LanguageModel.availability) {
                const avail = await LanguageModel.availability();
                if (avail === 'available' || avail === 'downloadable') {
                    provider = 'builtin';
                    model = 'gemini-nano';
                    builtinModelStatus = avail;
                }
            }
        } catch (e) {
            // Probe failed (rare: extension context invalidated, etc.).
            // Fall through to 'custom' below.
            console.warn('[Weft] LanguageModel probe failed, defaulting to custom:', e);
        }

        await setLlmConfig({ provider, model, builtinModelStatus });
        return provider;
    }

    // ── Migration ───────────────────────────────────────────────────────
    /**
     * Idempotent. Brings storage up to SCHEMA_VERSION. Safe to call on every
     * onInstalled / startup.
     */
    async function migrate() {
        const { schemaVersion = 0 } = await chrome.storage.local.get(['schemaVersion']);
        if (schemaVersion >= SCHEMA_VERSION) return;

        // 1) Consolidate legacy flat LLM keys → llmConfig, then drop them.
        //    All call sites now read via Store.getLlmConfig / LLMClient.
        const existing = await chrome.storage.local.get(['llmConfig', ...LEGACY_LLM_KEYS]);
        if (!existing.llmConfig && (existing.apiKey || existing.modelName || existing.apiBaseUrl)) {
            await setLlmConfig({
                apiKey: existing.apiKey || '',
                baseUrl: existing.apiBaseUrl || DEFAULT_LLM_CONFIG.baseUrl,
                model: existing.modelName || DEFAULT_LLM_CONFIG.model,
                maxTokens: Number(existing.maxTokens) || DEFAULT_LLM_CONFIG.maxTokens,
                temperature: existing.temperature != null ? Number(existing.temperature) : DEFAULT_LLM_CONFIG.temperature,
                visionMode: existing.visionMode || DEFAULT_LLM_CONFIG.visionMode,
            });
        }
        if (existing.llmConfig) {
            const reasoning = normalizeReasoningMode(existing.llmConfig.reasoning);
            if (existing.llmConfig.reasoning !== reasoning) {
                await chrome.storage.local.set({
                    llmConfig: { ...existing.llmConfig, reasoning },
                });
            }
        }
        await chrome.storage.local.remove(LEGACY_LLM_KEYS);

        // 1b) Move any inline base64 images (legacy) out of storage.local into IDB
        //     to stop write-amplification on the big `sessions` object.
        await withSessionWriteLock(async () => {
            const sessions = await getSessions();
            let touched = false;
            for (const arr of Object.values(sessions)) {
                if (!Array.isArray(arr)) continue;
                for (const s of arr) {
                    if (s && s.type === 'image' && s.cachedDataUrl) {
                        await putImage(s.id, s.cachedDataUrl);
                        s.hasCachedImage = true;
                        delete s.cachedDataUrl;
                        touched = true;
                    }
                }
            }
            if (touched) await writeSessionsSnapshot(sessions);
        });

        // 1c) Schema v8 bounds transcripts that predate the write-time chat
        //     budget. Keep this inside the same cross-context lock protocol as
        //     normal transcript writes so migration cannot clobber a live turn.
        await compactStoredChatMap();

        // 2) Back up then drop keys from removed features (defensive: log, don't silently nuke)
        const dead = await chrome.storage.local.get(DEAD_KEYS);
        const hasDead = Object.keys(dead).some((k) => dead[k] != null);
        if (hasDead) {
            console.info('[Weft] migration: removing data from retired features', Object.keys(dead));
            await chrome.storage.local.remove(DEAD_KEYS);
        }

        await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION });
    }

    return {
        SCHEMA_VERSION,
        getSessions, getSession,
        getCurrentSession, setCurrentSession,
        getChat, setChat,
        setPendingSmartRead, claimPendingSmartRead, renewPendingSmartRead,
        finishPendingSmartRead, releasePendingSmartRead, discardPendingSmartRead,
        addSnippet, createSessionWithSnippets, findSessionBySmartReadKey,
        createEmptySession, createSessionIfMissing, renameSession, deleteSession,
        removeSnippet, updateSnippet, updateSnippets, markImagesCached, normalizeLegacySessions, resolveImage,
        putImage, getImage, deleteImage,
        getLlmConfig, setLlmConfig, pickFirstRunProvider,
        migrate, collectGarbage,
    };
})();
