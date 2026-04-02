
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

    // ---- Ask AI about selection ----
    chrome.contextMenus.create({
        id: "askAI",
        title: "Ask AI",
        contexts: ["selection"]
    });

    const askQuestions = [
        { id: "askAI-freeform",    title: "Ask about this..." },
        { id: "askAI-reliability", title: "Check reliability & sources" },
        { id: "askAI-similar",     title: "Find similar viewpoints" },
        { id: "askAI-opposing",    title: "Find opposing viewpoints" },
        { id: "askAI-explain",     title: "Explain in simple terms" },
        { id: "askAI-factcheck",   title: "Fact-check this claim" },
    ];
    askQuestions.forEach(q => {
        chrome.contextMenus.create({
            id: q.id,
            title: q.title,
            contexts: ["selection"],
            parentId: "askAI"
        });
    });

    // ---- Comment to Session ----
    chrome.contextMenus.create({
        id: "commentToSession",
        title: "Comment to Session",
        contexts: ["selection"]
    });
}

chrome.runtime.onInstalled.addListener(() => {
    createStaticMenus();

    // 初始化右键菜单
    updateSessionContextMenus();

    // Enable side panel if the API is available (Chrome 114+)
    if (chrome.sidePanel) {
        chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch(() => {});
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    }

    // Set up Knowledge Replay alarm (check every 6 hours)
    chrome.alarms.create('knowledgeReplay', { periodInMinutes: 360 });
});

// Knowledge Replay alarm handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'knowledgeReplay') {
        await checkAndNotifyReplay();
    }
});

async function checkAndNotifyReplay() {
    const { replayData = {} } = await chrome.storage.local.get(['replayData']);
    const now = Date.now();
    let dueCount = 0;

    for (const items of Object.values(replayData)) {
        for (const item of items) {
            if (item.nextReview && item.nextReview <= now) dueCount++;
        }
    }

    if (dueCount > 0) {
        // Update badge
        chrome.action.setBadgeText({ text: String(dueCount) });
        chrome.action.setBadgeBackgroundColor({ color: '#7b1fa2' });

        // Notification
        if (chrome.notifications) {
            chrome.notifications.create(`replay-${now}`, {
                type: 'basic',
                iconUrl: chrome.runtime.getURL('assets/icon.png'),
                title: 'Knowledge Replay',
                message: `You have ${dueCount} item${dueCount > 1 ? 's' : ''} due for review!`,
            });
        }
    } else {
        chrome.action.setBadgeText({ text: '' });
    }
}

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

        sessions[sessionName].push(snippet);
        await chrome.storage.local.set({ "sessions": sessions });

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

        sessions[targetSession].push(snippet);
        await chrome.storage.local.set({ "sessions": sessions });
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

        sessions[targetSession].push(snippet);
        await chrome.storage.local.set({ "sessions": sessions });
        lastSavedSnippetInfo = { sessionName: targetSession, snippetId: snippet.id };
        sendNotification(`${targetSession} +1`, `Saved as "${tag}"`);

        // Auto-highlight the saved snippet on the page
        autoHighlightSnippet(tab, snippet);

    } else if (info.menuItemId.startsWith("askAI-")) {
        // Ask AI about selected text
        const questionType = info.menuItemId.replace("askAI-", "");
        const selectedText = info.selectionText || '';
        if (!selectedText) return;

        const questionMap = {
            'freeform':    '', // user types their own question in chat
            'reliability': 'Please evaluate the reliability and credibility of this information. Identify the likely source, check for potential biases, assess factual accuracy, and rate the trustworthiness. Search the web if needed to verify claims.',
            'similar':     'What are similar viewpoints, arguments, or perspectives to the one expressed in this text? Search for related opinions and supporting evidence from other sources.',
            'opposing':    'What are the main counterarguments or opposing viewpoints to this claim? Search for credible sources that disagree with or challenge this perspective.',
            'explain':     'Please explain this content in simple, easy-to-understand terms. Break down any jargon or complex concepts.',
            'factcheck':   'Please fact-check this claim. Verify the key assertions by searching for reliable sources. Provide a verdict (True/Mostly True/Misleading/False/Unverifiable) with evidence.',
        };

        const question = questionMap[questionType] || '';

        // Store context for chat page to pick up
        await chrome.storage.local.set({
            askAIContext: {
                selectedText,
                question,
                questionType,
                sourceUrl: tab?.url || '',
                sourceTitle: tab?.title || '',
                timestamp: Date.now(),
            }
        });

        // Open chat window
        chrome.windows.create({
            url: chrome.runtime.getURL('chat.html?mode=askAI'),
            type: 'popup',
            width: 900,
            height: 700,
            left: Math.round((screen.width - 900) / 2),
            top: Math.round((screen.height - 700) / 2)
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

                sessions[sessionName].push(snippet);
                await chrome.storage.local.set({ sessions });
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
            sessions[sessionName].push(snippet);
            await chrome.storage.local.set({ sessions });
            sendNotification(`${sessionName} +1`, 'Saved (comment skipped)');
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

async function fetchOpenAIResponse(text, apiKey) {
    const { apiBaseUrl = 'https://api.openai.com', modelName = 'gpt-4o-mini' } =
        await chrome.storage.local.get(['apiBaseUrl', 'modelName']);

    const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                { role: "system", content: "You are a helpful assistant. Generate insights based on the user's content." },
                { role: "user", content: text }
            ],
            max_tokens: 500
        })
    });
    const data = await response.json();
    if (data.choices && data.choices[0]?.message?.content) {
        const generatedText = data.choices[0].message.content;
        await chrome.storage.local.set({ generatedText });
        sendNotification("Success", "Insight Generated! Check the popup.");
    }
}

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

    if (message.type === 'getReplayDueCount') {
        (async () => {
            const { replayData = {} } = await chrome.storage.local.get(['replayData']);
            const now = Date.now();
            let dueCount = 0;
            for (const items of Object.values(replayData)) {
                for (const item of items) {
                    if (item.nextReview && item.nextReview <= now) dueCount++;
                }
            }
            sendResponse({ dueCount });
        })();
        return true;
    }

    if (message.type === 'openChatAskAI') {
        chrome.windows.create({
            url: chrome.runtime.getURL('chat.html?mode=askAI'),
            type: 'popup',
            width: 900,
            height: 700,
            left: Math.round((screen.width - 900) / 2),
            top: Math.round((screen.height - 700) / 2)
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
        if (snippet.type !== 'image' || snippet.cachedDataUrl) continue;
        if (!snippet.imageUrl) continue;

        const dataUrl = await fetchImageAsDataUrl(snippet.imageUrl, snippet.sourceUrl);
        if (dataUrl) {
            snippet.cachedDataUrl = dataUrl;
            updated++;
        }
    }

    if (updated > 0) {
        await chrome.storage.local.set({ sessions });
    }
    return { updated };
}
