// Load shared modules into the service worker.
importScripts(
    'lib/idb.js',
    'lib/store.js',
    'lib/tokenizer.js',
    'lib/providers.js',
    'lib/llm-client.js',
    'lib/i18n.js'
);

// 保存子菜单的 ID 数组，用于更新右键菜单
let sessionMenuIds = [];
let _updatingMenus = false;
let _menuRefreshQueued = false;

function formatUiMessage(key, replacements = {}) {
    let message = t(key);
    for (const [token, value] of Object.entries(replacements)) {
        message = message.replaceAll(`%${token}`, String(value));
    }
    return message;
}

const TAG_LABEL_KEYS = {
    quote: 'tag_quote',
    data: 'tag_data',
    opinion: 'tag_opinion',
    reference: 'tag_reference',
    'key-point': 'tag_key_point',
};

function tagDisplayName(tag) {
    return TAG_LABEL_KEYS[tag] ? t(TAG_LABEL_KEYS[tag]) : tag;
}

// Build all static (non-session) context menus in the user's selected language.
async function createStaticMenus() {
    await I18N.init();
    chrome.contextMenus.create({
        id: "saveToSession",
        title: t('menu_save_to_session'),
        contexts: ["selection", "link", "page", "image"]
    });

    chrome.contextMenus.create({
        id: "tagSnippet",
        title: t('menu_tag_as'),
        contexts: ["selection"]
    });

    const defaultTags = ["quote", "data", "opinion", "reference", "key-point"];
    defaultTags.forEach(tag => {
        chrome.contextMenus.create({
            id: `tag-${tag}`,
            title: tagDisplayName(tag),
            contexts: ["selection"],
            parentId: "tagSnippet"
        });
    });

    chrome.contextMenus.create({
        id: "saveWithTag",
        title: t('menu_quick_save_tag'),
        contexts: ["selection"]
    });

    const quickTags = ["quote", "data", "opinion", "reference", "key-point"];
    quickTags.forEach(tag => {
        chrome.contextMenus.create({
            id: `saveTag-${tag}`,
            title: formatUiMessage('menu_save_as_tag', { s: tagDisplayName(tag) }),
            contexts: ["selection"],
            parentId: "saveWithTag"
        });
    });

    chrome.contextMenus.create({
        id: "savePageLink",
        title: t('menu_save_page_link'),
        contexts: ["page"]
    });

    // ---- Analyse selection ----
    // The context menu is the complete surface; the floating toolbar exposes a
    // frequently-used subset of these same actions. Everything reachable from
    // the toolbar must also be reachable here.
    chrome.contextMenus.create({
        id: "askAI",
        title: t('menu_analyse_selection'),
        contexts: ["selection"]
    });

    const askQuestions = [
        { id: "askAI-verify",     title: t('menu_verify') },
        { id: "askAI-explain",    title: t('menu_explain') },
        { id: "askAI-key_points", title: t('menu_key_points') },
        { id: "askAI-opposing",   title: t('menu_counterarguments') },
        { id: "askAI-separator",  title: "──────────", enabled: false },
        { id: "askAI-diagram",    title: t('menu_diagram') },
        { id: "askAI-freeform",   title: t('menu_freeform') },
    ];
    askQuestions.forEach(q => {
        chrome.contextMenus.create({
            id: q.id,
            title: q.title,
            enabled: q.enabled !== false,
            contexts: ["selection"],
            parentId: "askAI"
        });
    });

    // ---- Smart Read (top-level, separate from tree) ----
    chrome.contextMenus.create({
        id: "aiPageInsight",
        title: t('popup_smart_read'),
        contexts: ["page", "selection", "link", "image"]
    });

    // ---- Comment to Session ----
    chrome.contextMenus.create({
        id: "commentToSession",
        title: t('menu_comment_to_session'),
        contexts: ["selection"]
    });
}

chrome.runtime.onInstalled.addListener((details) => {
    // Bring persisted data up to the current schema (idempotent).
    Store.migrate().catch((e) => console.warn('[Weft] migrate failed', e));

    // First-run onboarding (also seeds a demo session).
    if (details && details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') }).catch(() => {});
    }

    // 初始化右键菜单（静态项和会话项一起原子重建）
    void updateSessionContextMenus();

    // Enable side panel if the API is available (Chrome 114+)
    if (chrome.sidePanel) {
        // chat.html is the single workbench, shown here as the side panel.
        chrome.sidePanel.setOptions({ path: 'chat.html?mode=panel', enabled: true }).catch(() => {});
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    }
});

// 最近一次保存的 snippet（用于给最近保存的内容打标签）
let lastSavedSnippetInfo = null;

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    // Service workers may restart long after the menus were created.
    await I18N.init();
    if (info.menuItemId.startsWith("session-")) {
        const sessionName = info.menuItemId.replace("session-", "");
        const { sessions } = await chrome.storage.local.get(["sessions"]);
        assert(sessions[sessionName], `Session ${sessionName} does not exist`);

        // 判断 snippet 类型
        const isImage = !!info.srcUrl;
        const isLink = !!info.linkUrl && !isImage;
        const snippetType = isImage ? 'image' : (isLink ? 'link' : 'text');

        // 构建新的 snippet 对象（带元数据）
        const snippet = {
            id: generateId(),
            type: snippetType,
            content: isImage ? (info.srcUrl || '') : (info.selectionText || info.linkUrl || ''),
            sourceUrl: tab?.url || '',
            sourceTitle: tab?.title || '',
            timestamp: Date.now(),
            tags: []
        };

        if (isImage) {
            snippet.imageUrl = info.srcUrl;
            // 尝试多策略缓存图片为 base64（service worker fetch → content script capture）
            snippet.cachedDataUrl = await cacheImage(info.srcUrl, tab?.id, tab?.url);
        } else if (isLink) {
            snippet.content = info.selectionText || info.linkUrl;
            snippet.linkUrl = info.linkUrl;
        }

        // Store.addSnippet offloads large base64 images into IndexedDB.
        await Store.addSnippet(sessionName, snippet);

        lastSavedSnippetInfo = { sessionName, snippetId: snippet.id };
        sendNotification(`${sessionName} +1`, snippet.content.substring(0, 50));

        // Auto-highlight the saved snippet on the page
        autoHighlightSnippet(tab, snippet);

    } else if (info.menuItemId === "savePageLink") {
        // 保存当前页面链接到默认 session
        const { sessions } = await chrome.storage.local.get(["sessions"]);
        const targetSession = Object.keys(sessions)[0] || 'default';

        const snippet = {
            id: generateId(),
            type: 'link',
            content: tab?.title || tab?.url || '',
            linkUrl: tab?.url || '',
            sourceUrl: tab?.url || '',
            sourceTitle: tab?.title || '',
            timestamp: Date.now(),
            tags: ['reference']
        };

        await Store.addSnippet(targetSession, snippet);
        sendNotification(`${targetSession} +1`, t('notify_page_link_saved'));

    } else if (info.menuItemId.startsWith("saveTag-")) {
        // 一键保存并打标签到默认 session
        const tag = info.menuItemId.replace("saveTag-", "");
        const { sessions } = await chrome.storage.local.get(["sessions"]);
        const targetSession = Object.keys(sessions)[0] || 'default';

        const snippet = {
            id: generateId(),
            type: 'text',
            content: info.selectionText || '',
            sourceUrl: tab?.url || '',
            sourceTitle: tab?.title || '',
            timestamp: Date.now(),
            tags: [tag]
        };

        await Store.addSnippet(targetSession, snippet);
        lastSavedSnippetInfo = { sessionName: targetSession, snippetId: snippet.id };
        sendNotification(
            `${targetSession} +1`,
            formatUiMessage('notify_saved_as_tag', { s: tagDisplayName(tag) })
        );

        // Auto-highlight the saved snippet on the page
        autoHighlightSnippet(tab, snippet);

    } else if (info.menuItemId.startsWith("askAI-")) {
        const questionType = info.menuItemId.replace("askAI-", "");
        const selectedText = info.selectionText || '';
        if (!selectedText) return;

        // Quick analyses answer inline on the page; the prompts stay in
        // QUICK_ACTIONS here and are never sent to the tab.
        if (QUICK_ACTIONS[questionType]) {
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    type: 'runQuickAction',
                    action: questionType,
                });
            } catch {
                // No content script (e.g. a restricted page) — nothing to show.
            }
            return;
        }

        // Diagrams and free-form questions need the workbench.
        await chrome.storage.local.set({
            askAIContext: {
                selectedText,
                question: '',
                questionType: questionType === 'diagram' ? 'diagram' : 'freeform',
                sourceUrl: tab?.url || '',
                sourceTitle: tab?.title || '',
                timestamp: Date.now(),
            }
        });

        chrome.windows.create({
            url: chrome.runtime.getURL('chat.html?mode=askAI'),
            type: 'popup',
            width: 900,
            height: 700,
        });

    } else if (info.menuItemId.startsWith("comment-")) {
        // Comment to Session — prompt user for comment via content script
        const sessionName = info.menuItemId.replace("comment-", "");
        const selectedText = info.selectionText || '';
        if (!selectedText || !tab?.id) return;

        // Ask the content script to show a comment input popup
        try {
            const result = await chrome.tabs.sendMessage(tab.id, {
                type: 'showCommentInput',
                selectedText,
                sessionName,
            });

            if (result && result.comment !== undefined) {
                // Save snippet with comment
                const { sessions } = await chrome.storage.local.get(["sessions"]);
                if (!sessions[sessionName]) return;

                const snippet = {
                    id: generateId(),
                    type: 'text',
                    content: selectedText,
                    comment: result.comment || '',
                    sourceUrl: tab?.url || '',
                    sourceTitle: tab?.title || '',
                    timestamp: Date.now(),
                    tags: [],
                };

                await Store.addSnippet(sessionName, snippet);
                lastSavedSnippetInfo = { sessionName, snippetId: snippet.id };
                sendNotification(
                    `${sessionName} +1`,
                    result.comment
                        ? formatUiMessage('notify_with_comment', { s: result.comment.substring(0, 40) })
                        : t('notify_saved')
                );

                // Auto-highlight the saved snippet on the page
                autoHighlightSnippet(tab, snippet);
            }
        } catch (e) {
            console.warn('Comment input failed:', e);
            // Fallback: save without comment
            const { sessions } = await chrome.storage.local.get(["sessions"]);
            if (!sessions[sessionName]) return;
            const snippet = {
                id: generateId(),
                type: 'text',
                content: selectedText,
                comment: '',
                sourceUrl: tab?.url || '',
                sourceTitle: tab?.title || '',
                timestamp: Date.now(),
                tags: [],
            };
            await Store.addSnippet(sessionName, snippet);
            sendNotification(`${sessionName} +1`, t('notify_comment_skipped'));
        }

    } else if (info.menuItemId === "aiPageInsight") {
        // Smart Read is completed by the workbench. Keep this user-gesture
        // handler small: identify the source tab, then let chat.js own page
        // extraction, purpose confirmation, LLM analysis and atomic saving.
        // Page annotation remains a separate, explicit user toggle.
        if (!tab?.id) return;

        const requestId = generateId();

        const pendingWrite = Store.setPendingSmartRead({
            requestId,
            tabId: tab.id,
            url: tab.url || info.pageUrl || '',
            sourceTitle: tab.title || '',
            windowId: tab.windowId,
            requestedAt: Date.now(),
            source: 'context-menu',
        });

        let panelOpened = false;
        let panelOpenPromise = null;
        if (chrome.sidePanel?.open) {
            try {
                const target = Number.isInteger(tab.windowId)
                    ? { windowId: tab.windowId }
                    : { tabId: tab.id };
                // Initiate this before the first await so Chrome still sees the
                // context-menu user gesture.
                panelOpenPromise = chrome.sidePanel.open(target);
            } catch (e) {
                console.warn('Could not open Smart Read in the side panel:', e);
            }
        }

        await pendingWrite;
        if (panelOpenPromise) {
            try {
                await panelOpenPromise;
                panelOpened = true;
            } catch (e) {
                console.warn('Could not open Smart Read in the side panel:', e);
            }
        }

        if (!panelOpened) {
            await chrome.windows.create({
                url: chrome.runtime.getURL(`chat.html?mode=panel&smartReadRequestId=${encodeURIComponent(requestId)}`),
                type: 'popup',
                width: 900,
                height: 700,
            });
        }

    } else if (info.menuItemId.startsWith("tag-")) {
        // 给最近保存的 snippet 打标签
        const tag = info.menuItemId.replace("tag-", "");

        if (lastSavedSnippetInfo) {
            const updated = await Store.updateSnippet(
                lastSavedSnippetInfo.sessionName,
                lastSavedSnippetInfo.snippetId,
                (snippet) => ({ tags: [...new Set([...(snippet.tags || []), tag])] })
            );
            if (updated) {
                sendNotification(
                    t('notify_tag_added_title'),
                    formatUiMessage('notify_tagged_as', { s: tagDisplayName(tag) })
                );
            }
        } else {
            sendNotification(t('notify_info_title'), t('notify_save_before_tag'));
        }
    }
});

// 更新右键菜单，根据已经存在的sessionNames更新子菜单
async function updateSessionContextMenus() {
    // 防止并发调用
    if (_updatingMenus) {
        _menuRefreshQueued = true;
        return;
    }
    _updatingMenus = true;

    try {
        let sessions = await Store.normalizeLegacySessions((text) => ({
            id: generateId(),
            type: 'text',
            content: text,
            sourceUrl: '',
            sourceTitle: '',
            timestamp: Date.now(),
            tags: [],
        }));

        // 如果 sessions 为空，则创建一个新的默认 session
        if (Object.keys(sessions).length === 0) {
            await Store.createEmptySession("default");
            sessions = await Store.getSessions();
        }

        // removeAll + full rebuild: guarantees deleted sessions are cleaned up
        // (the old per-ID approach failed when service worker restarted and
        //  sessionMenuIds was lost, leaving stale menu items)
        await chrome.contextMenus.removeAll();
        await createStaticMenus();

        const sessionNames = Object.keys(sessions);
        sessionMenuIds = [];
        for (const sessionName of sessionNames) {
            const menuId = `session-${sessionName}`;
            chrome.contextMenus.create({
                id: menuId,
                title: formatUiMessage('menu_add_to_session', { s: sessionName }),
                contexts: ["selection", "link", "page", "image"],
                parentId: "saveToSession"
            });
            sessionMenuIds.push(menuId);

            // Comment to Session submenu
            chrome.contextMenus.create({
                id: `comment-${sessionName}`,
                title: sessionName,
                contexts: ["selection"],
                parentId: "commentToSession"
            });
        }
    } catch (error) {
        console.error('Error updating context menus:', error);
    } finally {
        _updatingMenus = false;
        if (_menuRefreshQueued) {
            _menuRefreshQueued = false;
            void updateSessionContextMenus();
        }
    }
}

// 尝试 fetch 图片并转为 base64 data URL（解决反盗链和图片失效问题）
// 为节省存储空间，会将图片缩放为缩略图（最大 800px）
// Convert a blob to a base64 data URL via OffscreenCanvas (resize + JPEG compress)
async function blobToResizedDataUrl(blob, maxSize = 1024, quality = 0.85) {
    const imageBitmap = await createImageBitmap(blob);
    let { width, height } = imageBitmap;
    if (width > maxSize || height > maxSize) {
        const scale = maxSize / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, width, height);
    imageBitmap.close();

    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(outBlob);
    });
}

// Fetch image from URL and convert to base64 data URL
// Tries multiple strategies: plain fetch, fetch with Referer, no-cors mode
const IMAGE_FETCH_TIMEOUT_MS = 10000;
const MAX_IMAGE_SOURCE_BYTES = 15 * 1024 * 1024;

async function fetchImageAsDataUrl(imageUrl, sourcePageUrl) {
    const strategies = [
        // Strategy 1: plain fetch
        (signal) => fetch(imageUrl, { signal }),
        // Strategy 2: with Referer header (bypasses some hotlink protections)
        (signal) => fetch(imageUrl, {
            headers: { 'Referer': sourcePageUrl || new URL(imageUrl).origin + '/' },
            signal,
        }),
        // Strategy 3: no-cache to bypass stale responses
        (signal) => fetch(imageUrl, { cache: 'no-cache', signal }),
    ];

    for (const strategy of strategies) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
        try {
            const response = await strategy(controller.signal);
            if (!response.ok) continue;
            const declaredSize = Number(response.headers.get('content-length')) || 0;
            if (declaredSize > MAX_IMAGE_SOURCE_BYTES) continue;
            const blob = await response.blob();
            if (!blob.type.startsWith('image/') || blob.size > MAX_IMAGE_SOURCE_BYTES) continue;
            const result = await blobToResizedDataUrl(blob);
            if (result) return result;
        } catch (e) {
            // Try next strategy
        } finally {
            clearTimeout(timer);
        }
    }
    console.warn('All fetch strategies failed for image:', imageUrl);
    return null;
}

// Capture image from the page DOM using chrome.scripting.executeScript
// This works for images already loaded in the page (even some CORS-restricted ones)
async function captureImageFromTab(tabId, imageUrl) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            args: [imageUrl],
            func: (targetSrc) => {
                // Find all img elements and match by src
                const imgs = document.querySelectorAll('img');
                for (const img of imgs) {
                    if (img.src !== targetSrc && img.currentSrc !== targetSrc) continue;
                    if (!img.naturalWidth || !img.naturalHeight) continue;
                    try {
                        const MAX = 1024;
                        let w = img.naturalWidth, h = img.naturalHeight;
                        if (w > MAX || h > MAX) {
                            const s = MAX / Math.max(w, h);
                            w = Math.round(w * s);
                            h = Math.round(h * s);
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, w, h);
                        return canvas.toDataURL('image/jpeg', 0.85);
                    } catch (e) {
                        // Canvas tainted by cross-origin image — cannot extract
                        return null;
                    }
                }
                return null;
            }
        });
        return results?.[0]?.result || null;
    } catch (e) {
        console.warn('captureImageFromTab failed:', e);
        return null;
    }
}

// Main image caching function: tries background fetch first, then content-script capture
async function cacheImage(imageUrl, tabId, sourcePageUrl) {
    // Strategy A: fetch from service worker (works with host_permissions)
    let dataUrl = await fetchImageAsDataUrl(imageUrl, sourcePageUrl);
    if (dataUrl) return dataUrl;

    // Strategy B: capture from page DOM via content script
    if (tabId) {
        dataUrl = await captureImageFromTab(tabId, imageUrl);
        if (dataUrl) return dataUrl;
    }

    return null;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// 轻量级页内 toast 通知，降级为 OS 通知
async function sendNotification(title, message) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            await chrome.tabs.sendMessage(tab.id, {
                type: 'showToast',
                title: title,
                text: message
            });
            return;
        }
    } catch (e) {
        // Content script not available (chrome:// pages, etc.)
    }
    // Fallback: OS notification with unique ID to avoid suppression
    if (chrome.notifications) {
        chrome.notifications.create(`cyber-assistant-${Date.now()}`, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("assets/icon-128.png"),
            title: title,
            message: message,
        });
    }
}

function assert(condition, message) {
    if (!condition) {
        console.error(message || "Assertion failed");
    }
}

// ---- Quick actions (selection toolbar) --------------------------------------
// Run small, self-contained analyses and stream the result straight back into
// the page. Prompts are defined and used here, in the service worker, so they
// are never exposed to the page or shown to the user.

const QUICK_ACTIONS = {
    verify: {
        system: 'You assess the reliability of a short passage. Be brief and concrete. Answer in at most 5 short lines:\n' +
            'Verdict: one of Well-supported / Plausible / Unclear / Questionable / Misleading.\n' +
            'Why: one or two sentences citing what in the text drives that verdict.\n' +
            'Check: one concrete thing the reader should verify independently.\n' +
            'Never invent sources or claim you searched the web. If the passage cannot be judged from its own content, say so plainly.',
        user: (text) => `Assess this passage:\n\n"""${text}"""`,
    },
    explain: {
        system: 'Explain the passage in plain language for a smart non-expert. 3-4 short sentences. Define any jargon inline. No preamble, no bullet lists.',
        user: (text) => `Explain this:\n\n"""${text}"""`,
    },
    similar: {
        system: 'Summarise, in at most 4 short lines, what viewpoints or arguments align with this passage and what kind of evidence typically supports them. Do not fabricate specific sources, studies, or quotes.',
        user: (text) => `Passage:\n\n"""${text}"""`,
    },
    opposing: {
        system: 'Give the strongest good-faith counterarguments to this passage, in at most 4 short lines. Focus on reasoning and what evidence would challenge it. Do not fabricate specific sources or quotes.',
        user: (text) => `Passage:\n\n"""${text}"""`,
    },
    key_points: {
        system: 'Extract the key points as 3-5 terse bullet lines beginning with "- ". No introduction, no conclusion.',
        user: (text) => `Passage:\n\n"""${text}"""`,
    },
};

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'weft-quick') return;

    let disconnected = false;
    let activeController = null;
    port.onDisconnect.addListener(() => {
        disconnected = true;
        activeController?.abort();
        activeController = null;
    });

    port.onMessage.addListener(async (msg) => {
        if (!msg || msg.type !== 'run') return;
        const spec = QUICK_ACTIONS[msg.action];
        if (!spec) {
            port.postMessage({ type: 'error', kind: 'unknown_action' });
            return;
        }

        const text = (msg.text || '').slice(0, 8000);
        if (!text) {
            port.postMessage({ type: 'error', kind: 'no_selection' });
            return;
        }

        const started = Date.now();
        let out = '';
        activeController?.abort();
        const controller = new AbortController();
        activeController = controller;
        const isCurrentRun = () => !disconnected && activeController === controller;
        try {
            // Answer in the user's chosen language, not the page's.
            await I18N.init();
            const messages = [
                { role: 'system', content: spec.system + '\n' + I18N.promptLanguageInstruction() },
                { role: 'user', content: spec.user(text) },
            ];
            const { usage } = await LLMClient.chat(messages, {
                stream: true,
                // Generous enough that a reasoning model still has room to answer
                // after its thinking pass.
                maxTokens: 1500,
                temperature: 0.2,
                signal: controller.signal,
                onDelta: (delta) => {
                    if (!isCurrentRun()) return;
                    out += delta;
                    try {
                        port.postMessage({ type: 'delta', delta, elapsed: Date.now() - started });
                    } catch { /* port closed by the page */ }
                },
                onReasoning: () => {
                    if (!isCurrentRun()) return;
                    // Tell the card the model is thinking, without showing the
                    // chain-of-thought itself.
                    try { port.postMessage({ type: 'reasoning' }); } catch { /* closed */ }
                },
            });
            if (!isCurrentRun()) return;

            // Streaming responses rarely carry usage, so fall back to an estimate.
            const promptTokens = usage?.promptTokens
                ?? WeftTokenizer.estimateTokens(spec.system + spec.user(text));
            const completionTokens = usage?.completionTokens
                ?? WeftTokenizer.estimateTokens(out);

            try {
                port.postMessage({
                    type: 'done',
                    text: out,
                    elapsed: Date.now() - started,
                    promptTokens,
                    completionTokens,
                    estimated: !usage,
                });
            } catch { /* port closed after the final token */ }
        } catch (e) {
            if (!isCurrentRun()) return;
            try {
                port.postMessage({
                    type: 'error',
                    kind: e.kind || 'unknown',
                    status: Number.isFinite(e.status) ? e.status : undefined,
                });
            } catch { /* port closed while reporting the error */ }
        } finally {
            if (activeController === controller) activeController = null;
        }
    });
});

function inferChangedSessionName(sessionChange) {
    const before = sessionChange?.oldValue || {};
    const after = sessionChange?.newValue || {};
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed = [];

    for (const name of names) {
        const oldItems = before[name];
        const newItems = after[name];
        if (!Array.isArray(oldItems) || !Array.isArray(newItems)) {
            if (oldItems !== newItems) changed.push(name);
        } else if (JSON.stringify(oldItems) !== JSON.stringify(newItems)) {
            changed.push(name);
        }
        if (changed.length > 1) return null;
    }

    return changed[0] || null;
}

// Sync context menus when sessions change (e.g. from popup)
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.sessions || changes.uiLanguage) {
        void updateSessionContextMenus();
    }
    if (changes.uiLanguage) {
        // Extension pages receive the runtime event; content scripts need a
        // per-tab message because they live in a different execution world.
        chrome.runtime.sendMessage({ type: 'uiLanguageChanged' }).catch(() => {});
        chrome.tabs.query({}).then((tabs) => {
            for (const tab of tabs) {
                if (!Number.isInteger(tab.id)) continue;
                chrome.tabs.sendMessage(tab.id, { type: 'uiLanguageChanged' }).catch(() => {});
            }
        }).catch(() => {});
    }
    if (changes.sessions) {
        // Notify chat page to invalidate RAG index cache
        const activatedSession = typeof changes.currentSession?.newValue === 'string'
            ? changes.currentSession.newValue
            : null;
        const sessionName = activatedSession || inferChangedSessionName(changes.sessions);
        chrome.runtime.sendMessage({
            type: 'snippetsChanged',
            ...(sessionName ? { sessionName } : {}),
            activate: Boolean(activatedSession && activatedSession === sessionName),
        }).catch(() => {});
    } else if (changes.currentSession) {
        const sessionName = typeof changes.currentSession.newValue === 'string'
            ? changes.currentSession.newValue
            : null;
        chrome.runtime.sendMessage({
            type: 'currentSessionChanged',
            sessionName,
        }).catch(() => {});
    }
});

/**
 * Auto-highlight a single saved snippet on the page using tag-based underlines.
 * Sends a message to the content script to perform the highlight.
 */
async function autoHighlightSnippet(tab, snippet) {
    if (!tab || !tab.id) return;
    if (snippet.type !== 'text' || !snippet.content || snippet.content.trim().length < 8) return;

    try {
        await chrome.tabs.sendMessage(tab.id, {
            type: 'highlightSnippets',
            snippets: [snippet],
        });
    } catch (e) {
        // Content script not available — silently ignore
    }
}

function sessionSnippetsForPage(sessions, sessionName, tabUrl) {
    if (!sessions || !Array.isArray(sessions[sessionName])) return [];

    // Article snippets point at the article itself. Index Smart Read snippets
    // point at their destination article, so retain the originating index URL
    // separately and match that when restoring homepage highlights.
    return sessions[sessionName].filter((snippet) => {
        if (!snippet?.content || !tabUrl) return false;
        if (snippet.type === 'text') {
            const pageMatches = snippet.smartReadPageType === 'article'
                ? sameSmartReadPage(snippet.sourceUrl, tabUrl)
                : samePage(snippet.sourceUrl, tabUrl);
            return snippet.content.trim().length >= 8
                && Boolean(snippet.sourceUrl && pageMatches);
        }
        return snippet.type === 'link'
            && snippet.smartReadPageType === 'index'
            && snippet.content.trim().length >= 2
            && Boolean(snippet.sourcePageUrl && sameSmartReadPage(snippet.sourcePageUrl, tabUrl));
    });
}

function annotationSetKey(sessionName, snippets) {
    let hash = 0x811c9dc5;
    const values = snippets.map((snippet) => [
        snippet.id || '', snippet.type || '', snippet.content || '',
        snippet.linkUrl || '', snippet.sourceUrl || '', snippet.sourcePageUrl || '',
    ].join('\u001f')).sort();
    const framed = `${sessionName}\u001e${values.join('\u001e')}`;
    for (let index = 0; index < framed.length; index++) {
        hash ^= framed.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `session-${snippets.length}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Send one atomic session-annotation command to the exact source tab. */
async function sendSessionAnnotationCommand(command, sessionName, tabId, tabUrl) {
    const { sessions } = await chrome.storage.local.get(['sessions']);
    const pageSnippets = sessionSnippetsForPage(sessions, sessionName, tabUrl);
    const setKey = annotationSetKey(sessionName, pageSnippets);
    if (!Number.isInteger(tabId)) return { highlighted: 0, total: pageSnippets.length };

    try {
        const result = await chrome.tabs.sendMessage(tabId, {
            type: command === 'get' ? 'getSessionHighlightState' : 'toggleSessionHighlights',
            mode: command === 'hide' ? 'hide' : command === 'show' ? 'show' : 'toggle',
            sessionName,
            setKey,
            expectedUrl: tabUrl,
            snippets: pageSnippets,
        });

        if (!result || typeof result !== 'object') {
            return {
                active: false, state: 'hidden', highlighted: 0,
                total: pageSnippets.length, setKey, error: 'NO_RESPONSE',
            };
        }

        return {
            ...result,
            active: Boolean(result.active),
            total: Number.isFinite(result.total)
                ? Math.max(0, Math.trunc(result.total))
                : pageSnippets.length,
            setKey,
        };
    } catch (e) {
        return {
            active: false, state: 'hidden', highlighted: 0,
            total: pageSnippets.length, setKey, error: 'CONTENT_UNAVAILABLE',
        };
    }
}

const TRACKING_PARAM_RE = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|gbraid|wbraid|yclid|twclid|mc_cid|mc_eid|vero_(?:id|conv)|_hsenc|_hsmi|hscid|hsctatracking|mkt_tok|igshid)$/i;

function comparablePageUrl(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        const params = [];
        parsed.searchParams.forEach((value, key) => {
            if (!TRACKING_PARAM_RE.test(key)) params.push([key, value]);
        });
        params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
        parsed.search = '';
        params.forEach(([key, value]) => parsed.searchParams.append(key, value));
        return parsed.href;
    } catch {
        return String(url || '').split('#')[0];
    }
}

function comparablePagePath(url) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.length > 1
            ? parsed.pathname.replace(/\/+$/u, '')
            : parsed.pathname;
        return `${parsed.origin}${pathname}`;
    } catch {
        return String(url || '').split(/[?#]/u)[0].replace(/\/+$/u, '');
    }
}

/** Compare pages while ignoring only fragments and tracking parameters. */
function samePage(url1, url2) {
    return Boolean(url1 && url2) && comparablePageUrl(url1) === comparablePageUrl(url2);
}

/** Smart Read evidence is still guarded by an exact text/link match, so a
 * canonical redirect may safely fall back to the same origin and path. */
function sameSmartReadPage(url1, url2) {
    return samePage(url1, url2)
        || (Boolean(url1 && url2) && comparablePagePath(url1) === comparablePagePath(url2));
}

// Handle messages from chat.js and other extension pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'reCacheImages') {
        handleReCacheImages(message.sessionName)
            .then(sendResponse)
            .catch((error) => {
                console.warn('Image re-cache failed:', error);
                sendResponse({ updated: 0, failed: 0, skipped: 0, error: error.message || String(error) });
            });
        return true;
    }

    if (
        message.type === 'toggleSessionOnPage'
        || message.type === 'hideSessionOnPage'
        || message.type === 'getSessionHighlightState'
        || message.type === 'highlightSessionOnPage'
    ) {
        // Popup and Workbench normally identify the exact page explicitly.
        // Keep the active-tab fallback only for compatibility with an older
        // extension view that was already open during an update.
        (async () => {
            let tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;
            let tabUrl = typeof message.url === 'string' && message.url ? message.url : sender.tab?.url;

            if (Number.isInteger(tabId)) {
                try {
                    const tab = await chrome.tabs.get(tabId);
                    const actualUrl = tab?.pendingUrl || tab?.url || '';
                    if (tabUrl && !samePage(tabUrl, actualUrl)) {
                        sendResponse({ active: false, state: 'hidden', highlighted: 0, total: 0, error: 'TARGET_PAGE_CHANGED' });
                        return;
                    }
                    if (!/^https?:/i.test(actualUrl)) {
                        sendResponse({ active: false, state: 'hidden', highlighted: 0, total: 0, error: 'PAGE_UNAVAILABLE' });
                        return;
                    }
                    tabUrl = actualUrl;
                } catch {
                    sendResponse({ active: false, state: 'hidden', highlighted: 0, total: 0, error: 'TARGET_TAB_UNAVAILABLE' });
                    return;
                }
            }

            if (!Number.isInteger(tabId)) {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                tabId = tab?.id;
                if (!tabUrl) tabUrl = tab?.url || '';
            }

            if (!Number.isInteger(tabId)) {
                sendResponse({ active: false, state: 'hidden', highlighted: 0, total: 0 });
                return;
            }

            const result = await sendSessionAnnotationCommand(
                message.type === 'getSessionHighlightState'
                    ? 'get'
                    : message.type === 'hideSessionOnPage'
                        ? 'hide'
                        : message.type === 'highlightSessionOnPage' ? 'show' : 'toggle',
                message.sessionName,
                tabId,
                tabUrl || ''
            );
            if (message.type !== 'getSessionHighlightState' && !result?.error) {
                chrome.runtime.sendMessage({
                    type: 'pageAnnotationStateChanged',
                    tabId,
                    url: tabUrl || '',
                    sessionName: message.sessionName,
                    setKey: result.setKey || '',
                    active: Boolean(result.active),
                    highlighted: result.highlighted || 0,
                }).catch(() => {});
            }
            sendResponse(result);
        })().catch(() => sendResponse({
            active: false, state: 'hidden', highlighted: 0, total: 0, error: 'ANNOTATION_FAILED',
        }));
        return true;
    }

    if (message.type === 'openSidePanel') {
        if (chrome.sidePanel) {
            chrome.sidePanel.open({ windowId: sender.tab?.windowId }).catch(() => {});
        }
        return false;
    }

    if (message.type === 'getUiStrings') {
        // Content scripts can't read _locales directly, so the worker resolves
        // the user's chosen language and hands over just the strings they need.
        (async () => {
            await I18N.init();
            const keys = [
                'tb_save', 'tb_save_hint', 'tb_verify', 'tb_verify_hint',
                'tb_explain', 'tb_explain_hint', 'tb_points', 'tb_points_hint',
                'tb_ask', 'tb_ask_hint',
                'card_thinking', 'card_reasoning', 'card_copy', 'card_copied',
                'card_save', 'card_saved', 'card_save_hint', 'card_failed',
                'card_close', 'card_disconnected', 'card_reload',
                'toast_saved_to', 'toast_save_failed',
                'modal_cancel', 'modal_save', 'modal_comment_ph', 'modal_comment_title',
                'card_elapsed', 'card_stats',
                'llm_error_auth', 'llm_error_rate_limit', 'llm_error_context_length',
                'llm_error_network', 'llm_error_timeout', 'llm_error_abort',
                'llm_error_server', 'llm_error_bad_request',
                'llm_error_empty_response', 'llm_error_output_limit', 'llm_error_unknown',
                'quick_error_unknown_action', 'quick_error_no_selection',
                'tag_quote', 'tag_data', 'tag_opinion', 'tag_reference', 'tag_key_point',
                'tag_stats', 'tag_market', 'tag_counterpoint', 'tag_generated', 'tag_analysed',
            ];
            const out = {};
            for (const k of keys) out[k] = I18N.get(k) || k;
            sendResponse(out);
        })();
        return true;
    }

    if (message.type === 'saveSelection') {
        // One-click save from the selection toolbar — always the active session.
        // Choosing a different session is the context menu's job.
        (async () => {
            const sessions = await Store.getSessions();
            const target = (await Store.getCurrentSession()) || Object.keys(sessions)[0] || 'default';

            const snippet = {
                id: generateId(),
                type: 'text',
                content: message.text || '',
                sourceUrl: message.sourceUrl || '',
                sourceTitle: message.sourceTitle || '',
                timestamp: Date.now(),
                tags: [],
            };
            await Store.addSnippet(target, snippet);
            lastSavedSnippetInfo = { sessionName: target, snippetId: snippet.id };
            if (sender.tab) autoHighlightSnippet(sender.tab, snippet);
            sendResponse({ ok: true, session: target });
        })();
        return true;
    }

    if (message.type === 'saveQuickResult') {
        (async () => {
            const sessions = await Store.getSessions();
            const target = (await Store.getCurrentSession()) || Object.keys(sessions)[0] || 'default';
            await Store.addSnippet(target, {
                id: generateId(),
                type: 'text',
                content: message.selectedText || '',
                comment: message.result || '',
                sourceUrl: message.sourceUrl || '',
                sourceTitle: message.sourceTitle || '',
                timestamp: Date.now(),
                tags: ['analysed'],
            });
            sendResponse({ ok: true, session: target });
        })();
        return true;
    }

    if (message.type === 'openChatAskAI') {
        chrome.windows.create({
            url: chrome.runtime.getURL('chat.html?mode=askAI'),
            type: 'popup',
            width: 900,
            height: 700,
        });
    }
});

// Re-cache jobs are shared by every workbench/popup request handled by this
// service-worker instance. A session is the right key because the operation is
// based entirely on persisted snippets and does not depend on a source tab.
const reCacheImageJobs = new Map();
const reCacheFailureUntil = new Map();
const RECACHE_FAILURE_BACKOFF_MS = 60000;

function handleReCacheImages(sessionName) {
    const key = typeof sessionName === 'string' ? sessionName : '';
    if (!key) return Promise.resolve({ updated: 0, failed: 0, skipped: 0 });

    const inFlight = reCacheImageJobs.get(key);
    if (inFlight) return inFlight;

    const job = runReCacheImages(key);
    reCacheImageJobs.set(key, job);
    const clear = () => {
        if (reCacheImageJobs.get(key) === job) reCacheImageJobs.delete(key);
    };
    job.then(clear, clear);
    return job;
}

async function runReCacheImages(sessionName) {
    const { sessions } = await chrome.storage.local.get(['sessions']);
    if (!sessions || !Array.isArray(sessions[sessionName])) {
        return { updated: 0, failed: 0, skipped: 0 };
    }

    const snippets = sessions[sessionName];
    const cachedIds = [];
    let failed = 0;
    let skipped = 0;

    for (const snippet of snippets) {
        if (snippet.type !== 'image') continue;
        // Already cached (inline legacy or in IDB)?
        if (snippet.cachedDataUrl || snippet.hasCachedImage) continue;
        if (!snippet.imageUrl) continue;

        const failureKey = `${sessionName}\n${snippet.id}\n${snippet.imageUrl}`;
        const retryAt = reCacheFailureUntil.get(failureKey) || 0;
        if (retryAt > Date.now()) {
            skipped++;
            continue;
        }
        if (retryAt) reCacheFailureUntil.delete(failureKey);

        try {
            const dataUrl = await fetchImageAsDataUrl(snippet.imageUrl, snippet.sourceUrl);
            if (!dataUrl) {
                failed++;
                reCacheFailureUntil.set(failureKey, Date.now() + RECACHE_FAILURE_BACKOFF_MS);
                continue;
            }
            // Store bytes first. The storage flag is committed once for every
            // successful image after the loop, never once per image.
            await Store.putImage(snippet.id, dataUrl);
            cachedIds.push(snippet.id);
            reCacheFailureUntil.delete(failureKey);
        } catch (error) {
            failed++;
            reCacheFailureUntil.set(failureKey, Date.now() + RECACHE_FAILURE_BACKOFF_MS);
            console.warn('Could not re-cache image:', snippet.imageUrl, error);
        }
    }

    const updated = cachedIds.length > 0
        ? await Store.markImagesCached(sessionName, cachedIds)
        : 0;
    return { updated, failed, skipped };
}
