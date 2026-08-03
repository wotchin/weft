/* global Store, t, I18N */
/**
 * Popup — a lightweight launcher.
 *
 * Shows the active session and a peek at the most recent snippets, then hands
 * off to the Workbench (side panel), which owns session and snippet management.
 */
document.addEventListener('DOMContentLoaded', async () => {
    await I18N.init();
    I18N.apply();

    const sessionSelect = document.getElementById('sessionSelect');
    const sessionMeta = document.getElementById('sessionMeta');
    const recentList = document.getElementById('recentList');
    const showOnPageBtn = document.getElementById('showOnPage');
    const showOnPageLabel = document.getElementById('showOnPageLabel');
    const [activePageTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentWindowId = activePageTab?.windowId;

    const RECENT_LIMIT = 4;
    let sessions = {};
    let currentSession = null;
    let highlightStateGeneration = 0;
    let annotationInFlight = false;

    function createRequestId() {
        if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
        return `smart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function setShowOnPageState(active) {
        showOnPageBtn.classList.toggle('is-active', active);
        showOnPageBtn.setAttribute('aria-pressed', String(active));
        showOnPageLabel.textContent = t(active ? 'popup_hide_on_page' : 'popup_show_on_page');
        showOnPageBtn.title = t(active ? 'wb_remove_from_page' : 'wb_show_on_page');
    }

    function sendAnnotationMessage(type, sessionName) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), 5000);
            try {
                chrome.runtime.sendMessage({
                    type,
                    sessionName,
                    tabId: activePageTab?.id,
                    url: activePageTab?.url || '',
                }, (result) => {
                    if (chrome.runtime.lastError) finish(null);
                    else finish(result || null);
                });
            } catch {
                finish(null);
            }
        });
    }

    async function hideSessionAnnotations(sessionName) {
        if (!sessionName || !activePageTab?.id) return;
        await sendAnnotationMessage('hideSessionOnPage', sessionName);
    }

    async function refreshHighlightState() {
        const generation = ++highlightStateGeneration;
        const sessionName = currentSession;
        if (!sessionName || !activePageTab?.id || !/^https?:/i.test(activePageTab.url || '')) {
            setShowOnPageState(false);
            showOnPageBtn.disabled = true;
            return;
        }
        const result = await sendAnnotationMessage('getSessionHighlightState', sessionName);
        if (generation !== highlightStateGeneration || currentSession !== sessionName) return;
        if (result && !result.error) setShowOnPageState(Boolean(result.active));
        showOnPageBtn.disabled = annotationInFlight;
    }

    async function openWorkbench(preparation, options = {}) {
        // sidePanel.open must be initiated while the click's user activation is
        // still live, before awaiting storage or window queries.
        const activateCurrentSession = options.activateCurrentSession !== false;
        const preparationPromise = Promise.all([
            preparation || Promise.resolve(),
            activateCurrentSession && currentSession
                ? Store.setCurrentSession(currentSession)
                : Promise.resolve(),
        ]);
        let panelPromise;
        try {
            if (!chrome.sidePanel?.open || !Number.isInteger(currentWindowId)) throw new Error('Side panel unavailable');
            panelPromise = chrome.sidePanel.open({ windowId: currentWindowId });
            await Promise.all([preparationPromise, panelPromise]);
            window.close();
        } catch {
            await preparationPromise.catch(() => {});
            await chrome.windows.create({
                url: chrome.runtime.getURL(options.smartReadRequestId
                    ? `chat.html?smartReadRequestId=${encodeURIComponent(options.smartReadRequestId)}`
                    : 'chat.html'),
                type: 'popup',
                width: 900,
                height: 700,
            });
        }
    }

    function formatTime(ts) {
        if (!ts) return '';
        const diff = Date.now() - ts;
        const min = Math.floor(diff / 60000);
        if (min < 1) return t('time_just_now');
        if (min < 60) return t('time_minutes').replace('%s', min);
        const hrs = Math.floor(min / 60);
        if (hrs < 24) return t('time_hours').replace('%s', hrs);
        return t('time_days').replace('%s', Math.floor(hrs / 24));
    }

    function renderRecent() {
        recentList.innerHTML = '';
        const snippets = sessions[currentSession] || [];

        if (snippets.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'recent-empty';
            empty.textContent = t('popup_empty');
            recentList.appendChild(empty);
            return;
        }

        // Most recent first.
        snippets.slice(-RECENT_LIMIT).reverse().forEach((s) => {
            const item = document.createElement('div');
            item.className = 'recent-item';

            const icon = document.createElement('span');
            icon.className = `recent-icon recent-icon-${s.type === 'image' ? 'image' : (s.type === 'link' ? 'link' : 'text')}`;
            item.appendChild(icon);

            const body = document.createElement('div');
            body.className = 'recent-body';

            const text = document.createElement('div');
            text.className = 'recent-text';
            text.textContent = s.type === 'image' ? (s.imageUrl || t('popup_image')) : (s.content || '');
            text.title = text.textContent;
            body.appendChild(text);

            const meta = document.createElement('div');
            meta.className = 'recent-meta';
            meta.textContent = [s.sourceTitle || '', formatTime(s.timestamp)].filter(Boolean).join(' · ');
            body.appendChild(meta);

            item.appendChild(body);
            recentList.appendChild(item);
        });
    }

    async function load() {
        sessions = await Store.getSessions();
        const names = Object.keys(sessions);
        const saved = await Store.getCurrentSession();
        currentSession = names.includes(saved) ? saved : names[0] || null;

        sessionSelect.innerHTML = '';
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sessionSelect.appendChild(opt);
        }

        if (currentSession) {
            sessionSelect.value = currentSession;
            const count = (sessions[currentSession] || []).length;
            sessionMeta.textContent = t('popup_snippet_count').replace('%s', count);
        } else {
            sessionMeta.textContent = t('popup_no_session');
        }
        renderRecent();
        await refreshHighlightState();
    }

    sessionSelect.addEventListener('change', async () => {
        const previousSession = currentSession;
        const nextSession = sessionSelect.value;
        await hideSessionAnnotations(previousSession);
        if (sessionSelect.value !== nextSession) return;
        currentSession = nextSession;
        await Store.setCurrentSession(currentSession);
        const count = (sessions[currentSession] || []).length;
        sessionMeta.textContent = t('popup_snippet_count').replace('%s', count);
        renderRecent();
        await refreshHighlightState();
    });

    // Open the Workbench in the side panel. Must happen inside the click
    // gesture; fall back to a window if the side panel isn't available.
    document.getElementById('openChat').addEventListener('click', () => openWorkbench());

    document.getElementById('smartRead').addEventListener('click', async () => {
        const tab = activePageTab;
        if (!tab?.id || !/^https?:/i.test(tab.url || '')) return;
        const requestId = createRequestId();
        const pendingWrite = Store.setPendingSmartRead({
            requestId,
            tabId: tab.id,
            url: tab.url,
            sourceTitle: tab.title || '',
            windowId: currentWindowId,
            requestedAt: Date.now(),
            source: 'popup',
        });
        // Smart Read creates and activates its own new session. Do not race it
        // with a write that restores the popup's previously selected session.
        await openWorkbench(pendingWrite, {
            activateCurrentSession: false,
            smartReadRequestId: requestId,
        });
    });

    showOnPageBtn.addEventListener('click', async () => {
        if (!currentSession || annotationInFlight) return;
        const sessionName = currentSession;
        annotationInFlight = true;
        ++highlightStateGeneration;
        showOnPageBtn.disabled = true;
        showOnPageBtn.setAttribute('aria-busy', 'true');
        try {
            await sendAnnotationMessage('toggleSessionOnPage', sessionName);
        } finally {
            annotationInFlight = false;
            showOnPageBtn.removeAttribute('aria-busy');
            await refreshHighlightState();
        }
    });

    document.getElementById('openSettings').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && (changes.sessions || changes.currentSession)) {
            load().catch(() => {});
        }
    });
    chrome.runtime.onMessage.addListener((message) => {
        if (
            message.type === 'pageAnnotationStateChanged'
            && message.tabId === activePageTab?.id
            && message.sessionName === currentSession
        ) {
            refreshHighlightState().catch(() => {});
        }
        return false;
    });

    await load();

    const smartReadBtn = document.getElementById('smartRead');
    if (!activePageTab?.id || !/^https?:/i.test(activePageTab.url || '')) {
        smartReadBtn.disabled = true;
        smartReadBtn.title = t('wb_page_unavailable');
    }
});
