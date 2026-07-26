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
/* global WeftIDB */

const Store = (() => {
    'use strict';

    const SCHEMA_VERSION = 5;
    const IMG_DB = 'weft';
    const IMG_DB_VERSION = 1;

    // Legacy flat LLM keys → unified llmConfig (migration source)
    const LEGACY_LLM_KEYS = ['apiKey', 'apiBaseUrl', 'modelName', 'maxTokens', 'temperature', 'visionMode'];
    // Keys belonging to removed features — cleared on migration
    const DEAD_KEYS = ['replayData'];

    const DEFAULT_LLM_CONFIG = {
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        temperature: 0.7,
        maxTokens: 2000,
        visionMode: 'auto',
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

    // ── Sessions ────────────────────────────────────────────────────────
    async function getSessions() {
        const { sessions = {} } = await chrome.storage.local.get(['sessions']);
        return sessions;
    }

    async function setSessions(sessions) {
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

    /**
     * The single write path for snippets. Large base64 images are offloaded
     * to IndexedDB; the snippet keeps a lightweight `hasCachedImage` flag while
     * remaining backward-compatible if a caller still reads `cachedDataUrl`.
     */
    async function addSnippet(sessionName, snippet) {
        const sessions = await getSessions();
        if (!sessions[sessionName]) sessions[sessionName] = [];

        if (snippet.type === 'image' && snippet.cachedDataUrl) {
            await putImage(snippet.id, snippet.cachedDataUrl);
            snippet.hasCachedImage = true;
            delete snippet.cachedDataUrl; // keep storage.local small
        }

        sessions[sessionName].push(snippet);
        await setSessions(sessions);
        return snippet;
    }

    async function removeSnippet(sessionName, id) {
        const sessions = await getSessions();
        if (!sessions[sessionName]) return;
        sessions[sessionName] = sessions[sessionName].filter((s) => s.id !== id);
        await setSessions(sessions);
        await deleteImage(id).catch(() => {});
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
    async function getLlmConfig() {
        const data = await chrome.storage.local.get(['llmConfig', ...LEGACY_LLM_KEYS]);
        if (data.llmConfig) {
            return { ...DEFAULT_LLM_CONFIG, ...data.llmConfig };
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
        await chrome.storage.local.set({ llmConfig: merged });
        return merged;
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
        await chrome.storage.local.remove(LEGACY_LLM_KEYS);

        // 1b) Move any inline base64 images (legacy) out of storage.local into IDB
        //     to stop write-amplification on the big `sessions` object.
        try {
            const sessions = await getSessions();
            let touched = false;
            for (const arr of Object.values(sessions)) {
                for (const s of arr) {
                    if (s && s.type === 'image' && s.cachedDataUrl) {
                        await putImage(s.id, s.cachedDataUrl);
                        s.hasCachedImage = true;
                        delete s.cachedDataUrl;
                        touched = true;
                    }
                }
            }
            if (touched) await setSessions(sessions);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[Weft] image migration skipped:', e);
        }

        // 2) Back up then drop keys from removed features (defensive: log, don't silently nuke)
        const dead = await chrome.storage.local.get(DEAD_KEYS);
        const hasDead = Object.keys(dead).some((k) => dead[k] != null);
        if (hasDead) {
            // eslint-disable-next-line no-console
            console.info('[Weft] migration: removing data from retired features', Object.keys(dead));
            await chrome.storage.local.remove(DEAD_KEYS);
        }

        await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION });
    }

    return {
        SCHEMA_VERSION,
        getSessions, setSessions, getSession,
        getCurrentSession, setCurrentSession,
        addSnippet, removeSnippet, resolveImage,
        putImage, getImage, deleteImage,
        getLlmConfig, setLlmConfig,
        migrate,
    };
})();
