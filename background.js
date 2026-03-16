
// 保存子菜单的 ID 数组，用于更新右键菜单
let sessionMenuIds = [];

chrome.runtime.onInstalled.addListener(() => {
    // 创建主菜单项 "Save to Session"
    chrome.contextMenus.create({
        id: "saveToSession",
        title: "Save to Session",
        contexts: ["selection", "link", "page"]
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
    // 更新右键菜单
    updateSessionContextMenus();

    if (info.menuItemId.startsWith("session-")) {
        const sessionName = info.menuItemId.replace("session-", "");
        const { sessions } = await chrome.storage.local.get(["sessions"]);
        assert(sessions[sessionName], `Session ${sessionName} does not exist`);

        // 构建新的 snippet 对象（带元数据）
        const snippet = {
            id: generateId(),
            type: info.linkUrl ? 'link' : 'text',
            content: info.selectionText || info.linkUrl || '',
            sourceUrl: tab?.url || '',
            sourceTitle: tab?.title || '',
            timestamp: Date.now(),
            tags: []
        };

        if (info.linkUrl) {
            snippet.content = info.selectionText || info.linkUrl;
            snippet.linkUrl = info.linkUrl;
        }

        sessions[sessionName].push(snippet);
        await chrome.storage.local.set({ "sessions": sessions });

        lastSavedSnippetInfo = { sessionName, snippetId: snippet.id };
        sendNotification("Session Updated", `Added to session: ${sessionName}`);

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
        sendNotification("Page Saved", `Link saved to session: ${targetSession}`);

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

    try {
        // 删除之前的子菜单
        for (const id of sessionMenuIds) {
            chrome.contextMenus.remove(id);
        }
        sessionMenuIds = [];

        // 创建新的子菜单
        sessionNames.forEach(sessionName => {
            const id = chrome.contextMenus.create({
                id: `session-${sessionName}`,
                title: `Add to ${sessionName}`,
                contexts: ["selection", "link", "page"],
                parentId: "saveToSession"
            });
            sessionMenuIds.push(id);
        });
    } catch (error) {
        console.error('Error updating context menus:', error);
    }
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// 添加通知的函数
function sendNotification(title, message) {
    if (chrome.notifications) {
        chrome.notifications.create("cyber-assistant", {
            type: "basic",
            iconUrl: chrome.runtime.getURL("assets/icon.png"),
            title: title,
            message: message,
        }, function(notificationId) {
            if (chrome.runtime.lastError) {
                console.error('Notification error:', chrome.runtime.lastError);
            }
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

    const baseUrl = apiBaseUrl.replace(/\/+$/, '');
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
