
// 保存子菜单的 ID 数组，用于更新右键菜单
let sessionMenuIds = [];

chrome.runtime.onInstalled.addListener(() => {
    // 创建主菜单项 "Save to Session"
    chrome.contextMenus.create({
        id: "saveToSession",
        title: "Save to Session",
        contexts: ["selection", "link", "page", "image"]
    });

    // 创建标签子菜单
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

    // 一键保存并打标签
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

    // 保存页面链接
    chrome.contextMenus.create({
        id: "savePageLink",
        title: "Save Page Link to Session",
        contexts: ["page"]
    });

    // 初始化右键菜单
    updateSessionContextMenus();
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
            // 尝试 fetch 图片并缓存为 base64（解决反盗链问题）
            snippet.cachedDataUrl = await fetchImageAsDataUrl(info.srcUrl);
        } else if (isLink) {
            snippet.content = info.selectionText || info.linkUrl;
            snippet.linkUrl = info.linkUrl;
        }

        sessions[sessionName].push(snippet);
        await chrome.storage.local.set({ "sessions": sessions });

        lastSavedSnippetInfo = { sessionName, snippetId: snippet.id };
        sendNotification(`${sessionName} +1`, snippet.content.substring(0, 50));

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
let _updatingMenus = false;
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

        const sessionNames = Object.keys(sessions);

        // 先尝试删除所有已知的 session 菜单项（兼容 service worker 重启后内存丢失）
        // 同时删除按 sessionNames 推算出的 ID，确保不遗漏
        const idsToRemove = new Set([
            ...sessionMenuIds,
            ...sessionNames.map(n => `session-${n}`)
        ]);
        // 也删除可能残留的旧 session（已删除的 session 的菜单项）
        // chrome.contextMenus.remove 对不存在的 ID 会报错，需要 catch
        for (const id of idsToRemove) {
            try {
                await new Promise((resolve, reject) => {
                    chrome.contextMenus.remove(id, () => {
                        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                        else resolve();
                    });
                });
            } catch (_) {
                // Menu item doesn't exist, that's fine
            }
        }
        sessionMenuIds = [];

        // 创建新的子菜单
        for (const sessionName of sessionNames) {
            const menuId = `session-${sessionName}`;
            chrome.contextMenus.create({
                id: menuId,
                title: `Add to ${sessionName}`,
                contexts: ["selection", "link", "page", "image"],
                parentId: "saveToSession"
            });
            sessionMenuIds.push(menuId);
        }
    } catch (error) {
        console.error('Error updating context menus:', error);
    } finally {
        _updatingMenus = false;
    }
}

// 尝试 fetch 图片并转为 base64 data URL（解决反盗链和图片失效问题）
// 为节省存储空间，会将图片缩放为缩略图（最大 800px）
async function fetchImageAsDataUrl(imageUrl) {
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) return null;
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) return null;

        // 使用 OffscreenCanvas 缩放图片（service worker 中无 DOM）
        const imageBitmap = await createImageBitmap(blob);
        const MAX_SIZE = 800;
        let { width, height } = imageBitmap;
        if (width > MAX_SIZE || height > MAX_SIZE) {
            const scale = MAX_SIZE / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0, width, height);
        imageBitmap.close();

        const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(outBlob);
        });
    } catch (e) {
        console.warn('Failed to cache image:', e);
        return null;
    }
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
    }
});
