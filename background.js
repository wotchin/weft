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

// Build all static (non-session) context menus
function createStaticMenus() {
    chrome.contextMenus.create({
        id: "saveToSession",
        title: "Save to Session",
        contexts: ["selection", "link", "page", "image"]
    });

    chrome.contextMenus.create({
        id: "tagSnippet",
        title: "Tag as...",
        contexts: ["selection"]
    });

    const defaultTags = ["quote", "data", "opinion", "reference", "key-point"];
    defaultTags.forEach(tag => {
        chrome.contextMenus.create({
            id: `tag-${tag}`,
            title: tag,
            contexts: ["selection"],
            parentId: "tagSnippet"
        });
    });

    chrome.contextMenus.create({
        id: "saveWithTag",
        title: "Quick Save with Tag",
        contexts: ["selection"]
    });

    const quickTags = ["quote", "data", "opinion", "reference", "key-point"];
    quickTags.forEach(tag => {
        chrome.contextMenus.create({
            id: `saveTag-${tag}`,
            title: `Save as "${tag}"`,
            contexts: ["selection"],
            parentId: "saveWithTag"
        });
    });

    chrome.contextMenus.create({
        id: "savePageLink",
        title: "Save Page Link to Session",
        contexts: ["page"]
    });

    // ---- Analyse selection ----
    // The context menu is the complete surface; the floating toolbar exposes a
    // frequently-used subset of these same actions. Everything reachable from
    // the toolbar must also be reachable here.
    chrome.contextMenus.create({
        id: "askAI",
        title: "Analyse selection",
        contexts: ["selection"]
    });

    const askQuestions = [
        { id: "askAI-verify",     title: "Verify this" },
        { id: "askAI-explain",    title: "Explain in simple terms" },
        { id: "askAI-key_points", title: "Extract key points" },
        { id: "askAI-opposing",   title: "Counterarguments" },
        { id: "askAI-separator",  title: "──────────", enabled: false },
        { id: "askAI-diagram",    title: "Make a diagram…" },
        { id: "askAI-freeform",   title: "Ask a question…" },
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

    // ---- AI Page Insight (top-level, separate from tree) ----
    chrome.contextMenus.create({
        id: "aiPageInsight",
        title: "✦ AI Insight — Analyze This Page",
        contexts: ["page", "selection", "link", "image"]
    });

    // ---- Comment to Session ----
    chrome.contextMenus.create({
        id: "commentToSession",
        title: "Comment to Session",
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

    createStaticMenus();

    // 初始化右键菜单
    updateSessionContextMenus();

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
        sendNotification(`${targetSession} +1`, 'Page link saved');

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
        sendNotification(`${targetSession} +1`, `Saved as "${tag}"`);

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
                sendNotification(`${sessionName} +1`, result.comment ? `With comment: ${result.comment.substring(0, 40)}` : 'Saved');

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
            sendNotification(`${sessionName} +1`, 'Saved (comment skipped)');
        }

    } else if (info.menuItemId === "aiPageInsight") {
        // AI Page Insight — extract page content and open chat with full context
        if (!tab?.id) return;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    // Lightweight page extraction inline
                    const REMOVE = ['script','style','noscript','iframe','svg','nav','footer','header','.ad','.ads','.sidebar','.menu','.comments','#comments'];
                    const clone = document.body.cloneNode(true);
                    REMOVE.forEach(s => { try { clone.querySelectorAll(s).forEach(el => el.remove()); } catch {} });

                    const main = clone.querySelector('article,main,[role="main"],.article,.post,.content,.entry-content,#content,#main') || clone;
                    const text = main.innerText || main.textContent || '';
                    const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => h.textContent.trim()).filter(Boolean).slice(0, 20);
                    const meta = document.querySelector('meta[name="description"]');

                    return {
                        title: document.title,
                        url: location.href,
                        description: meta ? meta.content : '',
                        content: text.substring(0, 20000),
                        headings,
                        wordCount: text.split(/\s+/).length,
                        selectedText: window.getSelection().toString().trim(),
                    };
                }
            });

            const pageData = results?.[0]?.result;
            if (!pageData) return;

            await chrome.storage.local.set({
                askAIContext: {
                    selectedText: pageData.selectedText || '',
                    question: '__PAGE_INSIGHT__',
                    questionType: 'page-insight',
                    sourceUrl: pageData.url,
                    sourceTitle: pageData.title,
                    pageData,
                    timestamp: Date.now(),
                }
            });

            chrome.windows.create({
                url: chrome.runtime.getURL('chat.html?mode=askAI'),
                type: 'popup',
                width: 900,
                height: 700,
            });
        } catch (e) {
            console.warn('AI Page Insight extraction failed:', e);
        }

    } else if (info.menuItemId.startsWith("tag-")) {
        // 给最近保存的 snippet 打标签
        const tag = info.menuItemId.replace("tag-", "");

        if (lastSavedSnippetInfo) {
            const { sessions } = await chrome.storage.local.get(["sessions"]);
            const session = sessions[lastSavedSnippetInfo.sessionName];
            if (session) {
                const snippet = session.find(s => s.id === lastSavedSnippetInfo.snippetId);
                if (snippet && !snippet.tags.includes(tag)) {
                    snippet.tags.push(tag);
                    await chrome.storage.local.set({ "sessions": sessions });
                    sendNotification("Tag Added", `Tagged as "${tag}"`);
                }
            }
        } else {
            sendNotification("Info", "Save a snippet first, then tag it.");
        }
    }
});

// 更新右键菜单，根据已经存在的sessionNames更新子菜单
async function updateSessionContextMenus() {
    // 防止并发调用
    if (_updatingMenus) return;
    _updatingMenus = true;

    try {
        const { sessions = {} } = await chrome.storage.local.get(["sessions"]);

        // 如果 sessions 为空，则创建一个新的默认 session
        if (Object.keys(sessions).length === 0) {
            const defaultSessionName = "default";
            sessions[defaultSessionName] = [];
            await chrome.storage.local.set({ "sessions": sessions });
        }

        // 数据迁移：将旧格式的纯字符串数组转换为新格式的 snippet 对象数组
        let needsMigration = false;
        for (const name of Object.keys(sessions)) {
            const items = sessions[name];
            if (items.length > 0 && typeof items[0] === 'string') {
                sessions[name] = items.map(text => ({
                    id: generateId(),
                    type: 'text',
                    content: text,
                    sourceUrl: '',
                    sourceTitle: '',
                    timestamp: Date.now(),
                    tags: []
                }));
                needsMigration = true;
            }
        }
        if (needsMigration) {
            await chrome.storage.local.set({ "sessions": sessions });
        }

        // removeAll + full rebuild: guarantees deleted sessions are cleaned up
        // (the old per-ID approach failed when service worker restarted and
        //  sessionMenuIds was lost, leaving stale menu items)
        await chrome.contextMenus.removeAll();
        createStaticMenus();

        const sessionNames = Object.keys(sessions);
        sessionMenuIds = [];
        for (const sessionName of sessionNames) {
            const menuId = `session-${sessionName}`;
            chrome.contextMenus.create({
                id: menuId,
                title: `Add to ${sessionName}`,
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
async function fetchImageAsDataUrl(imageUrl, sourcePageUrl) {
    const strategies = [
        // Strategy 1: plain fetch
        () => fetch(imageUrl),
        // Strategy 2: with Referer header (bypasses some hotlink protections)
        () => fetch(imageUrl, {
            headers: { 'Referer': sourcePageUrl || new URL(imageUrl).origin + '/' }
        }),
        // Strategy 3: no-cache to bypass stale responses
        () => fetch(imageUrl, { cache: 'no-cache' }),
    ];

    for (const strategy of strategies) {
        try {
            const response = await strategy();
            if (!response.ok) continue;
            const blob = await response.blob();
            if (!blob.type.startsWith('image/')) continue;
            const result = await blobToResizedDataUrl(blob);
            if (result) return result;
        } catch (e) {
            // Try next strategy
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
            iconUrl: chrome.runtime.getURL("assets/icon.png"),
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

    port.onMessage.addListener(async (msg) => {
        if (!msg || msg.type !== 'run') return;
        const spec = QUICK_ACTIONS[msg.action];
        if (!spec) {
            port.postMessage({ type: 'error', message: 'Unknown action.' });
            return;
        }

        const text = (msg.text || '').slice(0, 8000);
        if (!text) {
            port.postMessage({ type: 'error', message: 'No text selected.' });
            return;
        }

        const started = Date.now();
        let out = '';
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
                onDelta: (delta) => {
                    out += delta;
                    try {
                        port.postMessage({ type: 'delta', delta, elapsed: Date.now() - started });
                    } catch { /* port closed by the page */ }
                },
                onReasoning: () => {
                    // Tell the card the model is thinking, without showing the
                    // chain-of-thought itself.
                    try { port.postMessage({ type: 'reasoning' }); } catch { /* closed */ }
                },
            });

            // Streaming responses rarely carry usage, so fall back to an estimate.
            const promptTokens = usage?.promptTokens
                ?? WeftTokenizer.estimateTokens(spec.system + spec.user(text));
            const completionTokens = usage?.completionTokens
                ?? WeftTokenizer.estimateTokens(out);

            port.postMessage({
                type: 'done',
                text: out,
                elapsed: Date.now() - started,
                promptTokens,
                completionTokens,
                estimated: !usage,
            });
        } catch (e) {
            port.postMessage({
                type: 'error',
                message: e.message || String(e),
                hint: e.hint || '',
            });
        }
    });
});

// Sync context menus when sessions change (e.g. from popup)
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.sessions) {
        updateSessionContextMenus();
        // Notify chat page to invalidate RAG index cache
        chrome.runtime.sendMessage({ type: 'snippetsChanged' }).catch(() => {});
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

/**
 * Highlight all snippets from a session that match the current page URL.
 * Called on-demand from popup or content script.
 */
async function highlightSessionSnippetsOnPage(sessionName, tabId, tabUrl) {
    const { sessions } = await chrome.storage.local.get(['sessions']);
    if (!sessions || !sessions[sessionName]) return { highlighted: 0, total: 0 };

    // Filter snippets that were saved from this page
    const pageSnippets = sessions[sessionName].filter(s =>
        s.type === 'text' && s.content && s.content.trim().length >= 8 &&
        s.sourceUrl && tabUrl && samePage(s.sourceUrl, tabUrl)
    );

    if (pageSnippets.length === 0) return { highlighted: 0, total: 0 };

    try {
        await chrome.tabs.sendMessage(tabId, {
            type: 'highlightSnippets',
            snippets: pageSnippets,
        });
        return { highlighted: pageSnippets.length, total: pageSnippets.length };
    } catch (e) {
        return { highlighted: 0, total: pageSnippets.length };
    }
}

/** Check if two URLs point to the same page (ignoring hash/query differences) */
function samePage(url1, url2) {
    try {
        const a = new URL(url1);
        const b = new URL(url2);
        return a.origin === b.origin && a.pathname === b.pathname;
    } catch (e) {
        return url1 === url2;
    }
}

// Handle messages from chat.js and other extension pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'reCacheImages') {
        handleReCacheImages(message.sessionName).then(sendResponse);
        return true;
    }

    if (message.type === 'highlightSessionOnPage') {
        // On-demand: highlight all session snippets from the current page
        (async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) { sendResponse({ highlighted: 0, total: 0 }); return; }
            const result = await highlightSessionSnippetsOnPage(
                message.sessionName, tab.id, tab.url
            );
            sendResponse(result);
        })();
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
                'modal_cancel', 'modal_save', 'modal_comment_ph',
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
            if (!sessions[target]) { sessions[target] = []; await Store.setSessions(sessions); }

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
            if (!sessions[target]) { sessions[target] = []; await Store.setSessions(sessions); }
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

// Re-cache all images in a session that don't have cachedDataUrl
async function handleReCacheImages(sessionName) {
    const { sessions } = await chrome.storage.local.get(['sessions']);
    if (!sessions || !sessions[sessionName]) return { updated: 0 };

    const snippets = sessions[sessionName];
    let updated = 0;

    for (const snippet of snippets) {
        if (snippet.type !== 'image') continue;
        // Already cached (inline legacy or in IDB)?
        if (snippet.cachedDataUrl || snippet.hasCachedImage) continue;
        if (!snippet.imageUrl) continue;

        const dataUrl = await fetchImageAsDataUrl(snippet.imageUrl, snippet.sourceUrl);
        if (dataUrl) {
            // Offload to IndexedDB; keep only a flag on the snippet.
            await Store.putImage(snippet.id, dataUrl);
            snippet.hasCachedImage = true;
            delete snippet.cachedDataUrl;
            updated++;
        }
    }

    if (updated > 0) {
        await chrome.storage.local.set({ sessions });
    }
    return { updated };
}
