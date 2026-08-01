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

    const RECENT_LIMIT = 4;
    let sessions = {};
    let currentSession = null;

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
    }

    sessionSelect.addEventListener('change', async () => {
        currentSession = sessionSelect.value;
        await Store.setCurrentSession(currentSession);
        const count = (sessions[currentSession] || []).length;
        sessionMeta.textContent = t('popup_snippet_count').replace('%s', count);
        renderRecent();
    });

    // Open the Workbench in the side panel. Must happen inside the click
    // gesture; fall back to a window if the side panel isn't available.
    document.getElementById('openChat').addEventListener('click', async () => {
        if (currentSession) await Store.setCurrentSession(currentSession);
        try {
            const win = await chrome.windows.getCurrent();
            await chrome.sidePanel.open({ windowId: win.id });
            window.close();
        } catch {
            chrome.windows.create({
                url: chrome.runtime.getURL('chat.html'),
                type: 'popup',
                width: 900,
                height: 700,
            });
        }
    });

    document.getElementById('showOnPage').addEventListener('click', () => {
        if (!currentSession) return;
        const label = document.getElementById('showOnPageLabel');
        chrome.runtime.sendMessage(
            { type: 'highlightSessionOnPage', sessionName: currentSession },
            (result) => {
                if (chrome.runtime.lastError) return;
                const n = result && result.highlighted ? result.highlighted : 0;
                label.textContent = n > 0 ? t('popup_shown').replace('%s', n) : t('popup_shown_none');
                setTimeout(() => { label.textContent = t('popup_show_on_page'); }, 2000);
            }
        );
    });

    document.getElementById('openSettings').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });

    await load();
});
