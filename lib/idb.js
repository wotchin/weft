/**
 * WeftIDB — Thin IndexedDB Promise wrapper for the RAG engine.
 * Covers open, get, put, getAll, delete, clear, count.
 */
/* exported WeftIDB */

const WeftIDB = (() => {
    'use strict';

    function open(dbName, version, onUpgrade) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, version);
            req.onupgradeneeded = (e) => onUpgrade(e.target.result, e.oldVersion);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function _tx(db, storeName, mode) {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        return { tx, store };
    }

    function _req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function get(db, storeName, key) {
        const { store } = _tx(db, storeName, 'readonly');
        return _req(store.get(key));
    }

    function put(db, storeName, value) {
        const { store } = _tx(db, storeName, 'readwrite');
        return _req(store.put(value));
    }

    function getAll(db, storeName, indexName, query) {
        const { store } = _tx(db, storeName, 'readonly');
        const source = indexName ? store.index(indexName) : store;
        return _req(source.getAll(query));
    }

    function del(db, storeName, key) {
        const { store } = _tx(db, storeName, 'readwrite');
        return _req(store.delete(key));
    }

    function clear(db, storeName) {
        const { store } = _tx(db, storeName, 'readwrite');
        return _req(store.clear());
    }

    function count(db, storeName) {
        const { store } = _tx(db, storeName, 'readonly');
        return _req(store.count());
    }

    // Batch put: multiple values in a single transaction
    function putAll(db, storeName, values) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            for (const val of values) store.put(val);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // Delete all records matching an index value
    function deleteByIndex(db, storeName, indexName, value) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const idx = store.index(indexName);
            const req = idx.openCursor(IDBKeyRange.only(value));
            req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    return { open, get, put, getAll, delete: del, clear, count, putAll, deleteByIndex };
})();
