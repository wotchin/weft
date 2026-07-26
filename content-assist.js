/**
 * Content Assist — injected into all pages.
 * Provides:
 * 1. Floating "Ask AI" toolbar on text selection
 * 2. Comment input popup when triggered from context menu
 */
(() => {
    // Guard: check if extension context is still valid (survives extension reload)
    function contextValid() {
        try {
            // chrome.runtime.id is undefined when context is invalidated;
            // accessing chrome.runtime itself may throw after full GC.
            const id = chrome.runtime?.id;
            if (!id) return false;
            // Double-check by touching an API that throws immediately
            void chrome.runtime.getURL('');
            return true;
        } catch { return false; }
    }

    // ---- Configuration ----
    // The toolbar is a deliberate SUBSET of the context menu: the actions that
    // are frequent and cheap enough to want one click. Anything rarer (choosing
    // a session, tagging, diagrams, custom questions) lives in the right-click
    // menu, which remains the complete surface.
    //
    // Prompts live in the service worker (QUICK_ACTIONS in background.js) and
    // are never exposed to the page.
    const QUICK_ACTIONS = [
        { id: 'verify',     icon: '\u2713', key: 'verify' },
        { id: 'explain',    icon: '?', key: 'explain' },
        { id: 'key_points', icon: '\u2261', key: 'points' },
    ];

    // Strings resolved by the service worker in the user's chosen language.
    // English defaults keep the toolbar usable if the lookup ever fails.
    let S = {
        tb_save: 'Save', tb_save_hint: 'Save to the current session',
        tb_verify: 'Verify', tb_verify_hint: 'Check how well this holds up',
        tb_explain: 'Explain', tb_explain_hint: 'Explain in plain language',
        tb_points: 'Points', tb_points_hint: 'Extract the key points',
        tb_ask: 'Ask', tb_ask_hint: 'Ask your own question about this',
        card_thinking: 'Thinking\u2026', card_reasoning: 'Reasoning\u2026',
        card_copy: 'Copy', card_copied: 'Copied', card_save: 'Save', card_saved: 'Saved',
        card_save_hint: 'Save the passage and this result to your session',
        card_failed: 'Failed', card_close: 'Close',
        modal_cancel: 'Cancel', modal_save: 'Save', modal_comment_ph: 'Add your comment (optional)…',
        card_disconnected: 'The connection to Weft ended before an answer arrived. Try again.',
        card_reload: 'Weft was reloaded \u2014 refresh the page and try again.',
        toast_saved_to: 'Saved to \u201c%s\u201d', toast_save_failed: 'Could not save \u2014 try reloading the page.',
    };

    try {
        chrome.runtime.sendMessage({ type: 'getUiStrings' }, (res) => {
            if (chrome.runtime.lastError || !res) return;
            S = { ...S, ...res };
            // Rebuild the toolbar so it picks up the new language.
            if (toolbar) { toolbar.remove(); toolbar = null; }
        });
    } catch { /* extension context invalidated */ }

    let toolbar = null;
    let commentModal = null;
    let cachedSelection = ''; // captured when toolbar shows, before click clears it

    // ---- Floating selection toolbar ----
    // Styles are injected once into a <style> tag so hover/active states are
    // real CSS rather than JS listeners, and page styles can't bleed in.
    const TOOLBAR_STYLE_ID = 'weft-toolbar-style';
    const WEFT_CSS = `
    #weft-toolbar, #weft-card {
        --weft-fg:#1f2328; --weft-muted:#6b7280; --weft-line:#e5e7eb;
        --weft-accent:#2563eb; --weft-bg:#fff;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
        box-sizing:border-box;
    }
    #weft-toolbar *, #weft-card * { box-sizing:border-box; }
    #weft-toolbar {
        position:fixed; z-index:2147483647; display:none;
        background:var(--weft-bg);
        border:1px solid var(--weft-line); border-radius:12px;
        box-shadow:0 6px 24px rgba(15,23,42,.14), 0 1px 2px rgba(15,23,42,.06);
        padding:4px; white-space:nowrap; line-height:1;
        animation:weft-pop .12s ease-out;
    }
    @keyframes weft-pop { from { opacity:0; transform:translateY(3px) scale(.98); } to { opacity:1; transform:none; } }
    #weft-toolbar .weft-brand {
        display:inline-flex; align-items:center; justify-content:center;
        width:24px; height:24px; margin:0 3px 0 2px; border-radius:7px;
        background:linear-gradient(135deg,#3b82f6,#1d4ed8); color:#fff;
        font-size:11px; font-weight:700; vertical-align:middle; letter-spacing:-.3px;
    }
    #weft-toolbar .weft-sep {
        display:inline-block; width:1px; height:18px; margin:0 4px;
        background:var(--weft-line); vertical-align:middle;
    }
    #weft-toolbar button {
        display:inline-flex; align-items:center; gap:5px; vertical-align:middle;
        margin:0 1px; padding:6px 9px;
        border:0; border-radius:8px; background:transparent;
        font-family:inherit; font-size:12px; font-weight:500; color:var(--weft-fg);
        cursor:pointer; line-height:1; transition:background .12s, color .12s;
    }
    #weft-toolbar button:hover { background:#eff4ff; color:var(--weft-accent); }
    #weft-toolbar button:active { background:#dbe6ff; }
    #weft-toolbar button .weft-ico { font-size:12px; opacity:.75; }
    #weft-toolbar button:hover .weft-ico { opacity:1; }
    /* Primary action (Save) — the one people reach for most. */
    #weft-toolbar button.weft-primary { color:var(--weft-accent); font-weight:600; }
    #weft-toolbar button.weft-primary .weft-ico { opacity:1; font-weight:700; }
    #weft-toolbar button.weft-primary:hover { background:#dbe6ff; }

    /* Result card */
    #weft-card {
        position:fixed; z-index:2147483647; width:380px; max-width:calc(100vw - 24px);
        background:var(--weft-bg); color:var(--weft-fg);
        border:1px solid var(--weft-line); border-radius:14px;
        box-shadow:0 12px 40px rgba(15,23,42,.18), 0 1px 3px rgba(15,23,42,.08);
        animation:weft-pop .14s ease-out; overflow:hidden;
    }
    #weft-card .weft-card-head {
        display:flex; align-items:center; gap:8px;
        padding:11px 13px; border-bottom:1px solid var(--weft-line); background:#fbfcfe;
    }
    #weft-card .weft-card-title { font-size:13px; font-weight:600; flex:1; }
    #weft-card .weft-card-x {
        border:0; background:transparent; cursor:pointer; color:var(--weft-muted);
        font-size:16px; line-height:1; padding:2px 4px; border-radius:5px;
    }
    #weft-card .weft-card-x:hover { background:#eee; color:var(--weft-fg); }
    #weft-card .weft-progress { height:2px; background:#eef2f7; overflow:hidden; }
    #weft-card .weft-progress i {
        display:block; height:100%; width:35%; border-radius:2px;
        background:linear-gradient(90deg,#3b82f6,#60a5fa);
        animation:weft-slide 1.1s ease-in-out infinite;
    }
    @keyframes weft-slide { 0%{transform:translateX(-100%)} 100%{transform:translateX(320%)} }
    #weft-card .weft-card-body {
        padding:12px 13px; font-size:13px; line-height:1.62; color:#25303f;
        max-height:320px; overflow-y:auto; white-space:pre-wrap; word-break:break-word;
    }
    #weft-card .weft-status { color:var(--weft-muted); font-style:italic; }
    #weft-card .weft-card-foot {
        display:flex; align-items:center; gap:8px;
        padding:8px 13px; border-top:1px solid var(--weft-line);
        font-size:11px; color:var(--weft-muted); background:#fbfcfe;
    }
    #weft-card .weft-stats { flex:1; font-variant-numeric:tabular-nums; }
    #weft-card .weft-act {
        border:1px solid var(--weft-line); background:#fff; color:#374151;
        border-radius:7px; padding:4px 9px; font-size:11px; font-family:inherit;
        cursor:pointer; transition:border-color .12s,color .12s;
    }
    #weft-card .weft-act:hover { border-color:var(--weft-accent); color:var(--weft-accent); }
    #weft-card .weft-err { color:#b42318; }
    `;

    function injectStyles() {
        if (document.getElementById(TOOLBAR_STYLE_ID)) return;
        const st = document.createElement('style');
        st.id = TOOLBAR_STYLE_ID;
        st.textContent = WEFT_CSS;
        (document.head || document.documentElement).appendChild(st);
    }

    function createToolbar() {
        if (toolbar) return toolbar;
        injectStyles();

        toolbar = document.createElement('div');
        toolbar.id = 'weft-toolbar';

        // Save is the most frequent action, so it leads and is visually primary.
        const saveBtn = createToolbarBtn('\uFF0B', S.tb_save, 'save', saveSelection, S.tb_save_hint);
        saveBtn.classList.add('weft-primary');
        toolbar.appendChild(saveBtn);

        const sep = document.createElement('span');
        sep.className = 'weft-sep';
        toolbar.appendChild(sep);

        // Quick analyses run inline and render into a compact result card.
        QUICK_ACTIONS.forEach((q) => {
            const label = S[`tb_${q.key}`];
            toolbar.appendChild(createToolbarBtn(q.icon, label, q.id, () => {
                runQuickAction(q.id, label);
            }, S[`tb_${q.key}_hint`]));
        });

        // Free-form questions need the full workbench.
        toolbar.appendChild(createToolbarBtn('\u270E', S.tb_ask, 'freeform', () => {
            askAI('', 'freeform');
        }, S.tb_ask_hint));

        document.body.appendChild(toolbar);
        return toolbar;
    }

    /** One-click save of the selection into the active session. */
    function saveSelection() {
        if (!contextValid()) return;
        const sel = window.getSelection();
        const text = cachedSelection || (sel ? sel.toString().trim() : '');
        cachedSelection = '';
        if (!text) return;

        chrome.runtime.sendMessage({
            type: 'saveSelection',
            text,
            sourceUrl: location.href,
            sourceTitle: document.title,
        }, (res) => {
            if (chrome.runtime.lastError || !res || !res.ok) {
                showToast('Weft', S.toast_save_failed);
                return;
            }
            showToast(S.toast_saved_to.replace('%s', res.session), text.slice(0, 60));
        });
    }

    function createToolbarBtn(icon, label, id, onClick, hint) {
        const btn = document.createElement('button');
        btn.dataset.weftAction = id;
        // Short label on screen, fuller description on hover.
        btn.title = hint || label;

        const ico = document.createElement('span');
        ico.className = 'weft-ico';
        ico.textContent = icon;
        btn.appendChild(ico);
        btn.appendChild(document.createTextNode(label));

        btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            onClick();
            hideToolbar();
        });
        return btn;
    }

    function showToolbar(x, y) {
        // Capture selection NOW — clicking a toolbar button may clear it
        const sel = window.getSelection();
        cachedSelection = sel ? sel.toString().trim() : '';

        const tb = createToolbar();
        tb.style.display = 'block';

        // Measure and clamp to viewport
        requestAnimationFrame(() => {
            const rect = tb.getBoundingClientRect();
            let left = x - rect.width / 2;
            let top = y - rect.height - 12;
            const vw = window.innerWidth;
            if (left < 8) left = 8;
            if (left + rect.width > vw - 8) left = vw - rect.width - 8;
            if (top < 8) top = y + 20;
            tb.style.left = left + 'px';
            tb.style.top = top + 'px';
        });
    }

    function hideToolbar() {
        if (toolbar) toolbar.style.display = 'none';
    }

    // ---- Inline result card ----------------------------------------------
    // Quick actions render here instead of opening the workbench: a small card
    // anchored to the selection, showing progress, elapsed time and token cost,
    // then the answer itself. Text is inserted with textContent, never HTML.

    let card = null;
    let cardPort = null;

    function closeCard() {
        if (cardPort) { try { cardPort.disconnect(); } catch { /* already gone */ } cardPort = null; }
        if (card) { card.remove(); card = null; }
    }

    function createCard(title, anchorRect) {
        closeCard();
        injectStyles();

        card = document.createElement('div');
        card.id = 'weft-card';

        const head = document.createElement('div');
        head.className = 'weft-card-head';
        const brand = document.createElement('span');
        brand.className = 'weft-brand';
        brand.textContent = 'W';
        const titleEl = document.createElement('span');
        titleEl.className = 'weft-card-title';
        titleEl.textContent = title;
        const close = document.createElement('button');
        close.className = 'weft-card-x';
        close.textContent = '×';
        close.title = S.card_close;
        close.addEventListener('click', closeCard);
        head.append(brand, titleEl, close);

        const progress = document.createElement('div');
        progress.className = 'weft-progress';
        progress.appendChild(document.createElement('i'));

        const body = document.createElement('div');
        body.className = 'weft-card-body';
        // Explicit status line — replaced by the answer, an error, or a clear
        // "empty response" notice. It is never left dangling.
        const status = document.createElement('div');
        status.className = 'weft-status';
        status.textContent = S.card_thinking;
        body.appendChild(status);

        const foot = document.createElement('div');
        foot.className = 'weft-card-foot';
        const stats = document.createElement('span');
        stats.className = 'weft-stats';
        stats.textContent = '0.0s';
        foot.appendChild(stats);

        card._status = status;
        card.append(head, progress, body, foot);
        document.body.appendChild(card);

        // Position near the selection, clamped to the viewport.
        const r = card.getBoundingClientRect();
        let left = (anchorRect ? anchorRect.left : 20);
        let top = (anchorRect ? anchorRect.bottom + 10 : 20);
        if (left + r.width > window.innerWidth - 12) left = window.innerWidth - r.width - 12;
        if (left < 12) left = 12;
        if (top + r.height > window.innerHeight - 12) {
            const above = (anchorRect ? anchorRect.top : 0) - r.height - 10;
            top = above > 12 ? above : Math.max(12, window.innerHeight - r.height - 12);
        }
        card.style.left = Math.round(left) + 'px';
        card.style.top = Math.round(top) + 'px';

        return { body, stats, progress, foot };
    }

    function runQuickAction(actionId, label) {
        if (!contextValid()) return;

        const sel = window.getSelection();
        const selectedText = cachedSelection || (sel ? sel.toString().trim() : '');
        cachedSelection = '';
        if (!selectedText) return;

        // Anchor the card to the selection before it gets cleared.
        let anchorRect = null;
        try {
            if (sel && sel.rangeCount) anchorRect = sel.getRangeAt(0).getBoundingClientRect();
        } catch { /* detached range */ }

        const { body, stats, progress, foot } = createCard(label, anchorRect);

        const started = Date.now();
        const ticker = setInterval(() => {
            stats.textContent = ((Date.now() - started) / 1000).toFixed(1) + 's';
        }, 100);

        function finish() {
            clearInterval(ticker);
            progress.remove();
        }

        let port;
        try {
            port = chrome.runtime.connect({ name: 'weft-quick' });
        } catch {
            finish();
            body.textContent = S.card_reload;
            return;
        }
        cardPort = port;

        // If the worker goes away mid-flight, don't leave the card spinning.
        port.onDisconnect.addListener(() => {
            finish();
            cardPort = null;
            const s = statusEl();
            if (s && !answer) {
                s.textContent = S.card_disconnected;
                s.classList.add('weft-err');
            }
        });

        let answer = '';
        const statusEl = () => card && card._status;

        port.onMessage.addListener((msg) => {
            if (!msg) return;

            if (msg.type === 'reasoning') {
                const s = statusEl();
                if (s && !answer) s.textContent = S.card_reasoning;
                return;
            }

            if (msg.type === 'delta') {
                // First token replaces the status line with the answer itself.
                if (!answer) {
                    const s = statusEl();
                    if (s) s.remove();
                }
                answer += msg.delta;
                body.textContent = answer;
                body.scrollTop = body.scrollHeight;
                return;
            }

            if (msg.type === 'done') {
                finish();
                const secs = (msg.elapsed / 1000).toFixed(1);
                const tok = (msg.promptTokens || 0) + (msg.completionTokens || 0);
                stats.textContent = `${secs}s · ${msg.estimated ? '~' : ''}${tok} tokens`;
                if (answer.trim()) addCardActions(foot, msg.text || answer, selectedText);
                try { port.disconnect(); } catch { /* noop */ }
                cardPort = null;
                return;
            }

            if (msg.type === 'error') {
                finish();
                stats.textContent = '';
                body.textContent = msg.message + (msg.hint ? '\n\n' + msg.hint : '');
                body.classList.add('weft-err');
                try { port.disconnect(); } catch { /* noop */ }
                cardPort = null;
            }
        });

        port.postMessage({
            type: 'run',
            action: actionId,
            text: selectedText,
            url: location.href,
            title: document.title,
        });
    }

    function addCardActions(foot, resultText, selectedText) {
        const copy = document.createElement('button');
        copy.className = 'weft-act';
        copy.textContent = S.card_copy;
        copy.addEventListener('click', () => {
            navigator.clipboard.writeText(resultText).then(() => {
                copy.textContent = S.card_copied;
                setTimeout(() => { copy.textContent = S.card_copy; }, 1400);
            }).catch(() => { copy.textContent = S.card_failed; });
        });

        const save = document.createElement('button');
        save.className = 'weft-act';
        save.textContent = S.card_save;
        save.title = S.card_save_hint;
        save.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'saveQuickResult',
                selectedText,
                result: resultText,
                sourceUrl: location.href,
                sourceTitle: document.title,
            }, () => {
                if (chrome.runtime.lastError) { save.textContent = S.card_failed; return; }
                save.textContent = S.card_saved;
                setTimeout(() => { save.textContent = S.card_save; }, 1400);
            });
        });

        foot.append(copy, save);
    }

    // Dismiss the card on outside click or Escape.
    document.addEventListener('mousedown', (e) => {
        if (card && !card.contains(e.target)) closeCard();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && card) closeCard();
    }, true);

    /**
     * Send selected text + question to the chat window via background.
     */
    function askAI(question, questionType, label) {
        if (!contextValid()) return;
        // Use cached selection (captured when toolbar appeared) as primary,
        // fall back to current selection
        const sel = window.getSelection();
        const selectedText = cachedSelection || (sel ? sel.toString().trim() : '');
        cachedSelection = ''; // consume
        if (!selectedText) return;

        const ctx = {
            selectedText,
            question: question === '__DIAGRAM__' ? '' : question,
            questionType: question === '__DIAGRAM__' ? 'diagram' : questionType,
            label: label || '',
            sourceUrl: location.href,
            sourceTitle: document.title,
            timestamp: Date.now(),
        };

        try {
            chrome.storage.local.set({ askAIContext: ctx }, () => {
                try {
                    if (chrome.runtime.lastError) return;
                    chrome.runtime.sendMessage({ type: 'openChatAskAI' });
                } catch { /* context invalidated between set and callback */ }
            });
        } catch { /* extension context invalidated */ }
    }

    // Listen for mouseup to show toolbar
    document.addEventListener('mouseup', (e) => {
        // Don't show on toolbar itself or comment modal
        if (toolbar && toolbar.contains(e.target)) return;
        if (commentModal && commentModal.contains(e.target)) return;

        setTimeout(() => {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.toString().trim().length >= 5) {
                showToolbar(e.clientX, e.clientY);
            } else {
                hideToolbar();
            }
        }, 10);
    });

    document.addEventListener('mousedown', (e) => {
        if (toolbar && !toolbar.contains(e.target)) {
            hideToolbar();
        }
    }, true);

    // ---- Comment Input Modal ----
    function showCommentModal(selectedText, sessionName) {
        return new Promise((resolve) => {
            // Remove existing
            if (commentModal) commentModal.remove();

            commentModal = document.createElement('div');
            commentModal.id = 'cyber-comment-modal';
            commentModal.style.cssText = `
                position:fixed; top:0; left:0; width:100%; height:100%;
                z-index:2147483647; display:flex; align-items:center; justify-content:center;
                background:rgba(0,0,0,0.3);
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            `;

            const card = document.createElement('div');
            card.style.cssText = `
                background:#fff; border-radius:12px; padding:20px 24px;
                box-shadow:0 8px 30px rgba(0,0,0,0.2); max-width:480px; width:90%;
            `;

            const title = document.createElement('div');
            title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:10px;color:#1a1a1a;';
            title.textContent = `Comment to "${sessionName}"`;

            const preview = document.createElement('div');
            preview.style.cssText = 'font-size:12px;color:#888;background:#f5f5f5;padding:8px 10px;border-radius:6px;margin-bottom:10px;max-height:60px;overflow:hidden;text-overflow:ellipsis;';
            preview.textContent = selectedText.substring(0, 150) + (selectedText.length > 150 ? '...' : '');

            const textarea = document.createElement('textarea');
            textarea.style.cssText = `
                width:100%; height:80px; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
                font-family:inherit; font-size:13px; resize:vertical; outline:none;
                transition:border-color 0.15s;
            `;
            textarea.placeholder = S.modal_comment_ph;
            textarea.addEventListener('focus', () => textarea.style.borderColor = '#2196f3');
            textarea.addEventListener('blur', () => textarea.style.borderColor = '#ddd');

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = S.modal_cancel;
            cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;font-size:13px;cursor:pointer;color:#666;';
            cancelBtn.addEventListener('click', () => {
                commentModal.remove();
                commentModal = null;
                resolve({ comment: undefined }); // undefined = cancelled
            });

            const saveBtn = document.createElement('button');
            saveBtn.textContent = S.modal_save;
            saveBtn.style.cssText = 'padding:6px 16px;border:none;border-radius:6px;background:#2196f3;font-size:13px;cursor:pointer;color:#fff;font-weight:500;';
            saveBtn.addEventListener('click', () => {
                const comment = textarea.value.trim();
                commentModal.remove();
                commentModal = null;
                resolve({ comment });
            });

            // Enter to save, Escape to cancel
            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    saveBtn.click();
                }
                if (e.key === 'Escape') cancelBtn.click();
            });

            // Click backdrop to cancel
            commentModal.addEventListener('click', (e) => {
                if (e.target === commentModal) cancelBtn.click();
            });

            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(saveBtn);
            card.appendChild(title);
            card.appendChild(preview);
            card.appendChild(textarea);
            card.appendChild(btnRow);
            commentModal.appendChild(card);
            document.body.appendChild(commentModal);

            setTimeout(() => textarea.focus(), 50);
        });
    }

    // ---- Tag-based Snippet Highlighting ----
    const TAG_COLORS = {
        'data':       { underline: '#2e7d32', bg: 'rgba(46, 125, 50, 0.08)',  badge: '#e8f5e9', text: '#2e7d32' },
        'quote':      { underline: '#e65100', bg: 'rgba(230, 81, 0, 0.08)',   badge: '#fff3e0', text: '#e65100' },
        'opinion':    { underline: '#c62828', bg: 'rgba(198, 40, 40, 0.08)',   badge: '#fce4ec', text: '#c62828' },
        'reference':  { underline: '#1565c0', bg: 'rgba(21, 101, 192, 0.08)', badge: '#e3f2fd', text: '#1565c0' },
        'key-point':  { underline: '#7b1fa2', bg: 'rgba(123, 31, 162, 0.08)', badge: '#f3e5f5', text: '#7b1fa2' },
        'definition': { underline: '#00838f', bg: 'rgba(0, 131, 143, 0.08)',  badge: '#e0f7fa', text: '#00838f' },
        'example':    { underline: '#f57f17', bg: 'rgba(245, 127, 23, 0.08)', badge: '#fff8e1', text: '#f57f17' },
        'default':    { underline: '#616161', bg: 'rgba(97, 97, 97, 0.08)',   badge: '#f5f5f5', text: '#616161' },
    };

    function highlightSnippetsOnPage(snippets) {
        // Inject styles once
        if (!document.getElementById('cyber-snippet-hl-styles')) {
            const style = document.createElement('style');
            style.id = 'cyber-snippet-hl-styles';
            style.textContent = `
                [data-cyber-snippet-hl] {
                    position: relative;
                    padding: 1px 0;
                    border-radius: 2px;
                    transition: background 0.15s;
                }
                [data-cyber-snippet-hl]:hover {
                    filter: brightness(0.96);
                }
                .cyber-tag-badge {
                    position: absolute;
                    top: -8px;
                    right: -2px;
                    font-size: 9px;
                    font-weight: 600;
                    line-height: 1;
                    padding: 2px 5px;
                    border-radius: 3px;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    white-space: nowrap;
                    pointer-events: none;
                    z-index: 1000;
                    opacity: 0;
                    transition: opacity 0.15s;
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }
                [data-cyber-snippet-hl]:hover .cyber-tag-badge {
                    opacity: 1;
                }
            `;
            document.head.appendChild(style);
        }

        let highlighted = 0;

        for (const snippet of snippets) {
            if (snippet.type !== 'text' || !snippet.content || snippet.content.trim().length < 8) continue;

            const tag = (snippet.tags && snippet.tags[0]) || 'default';
            const tc = TAG_COLORS[tag] || TAG_COLORS['default'];
            const found = findAndHighlightSnippetText(
                snippet.content.trim(), tc.underline, tc.bg,
                snippet.id, snippet.tags || [], tc.badge, tc.text
            );
            if (found) highlighted++;
        }

        return { highlighted, total: snippets.length };
    }

    function findAndHighlightSnippetText(searchText, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText) {
        const normalizedSearch = searchText.replace(/\s+/g, ' ').trim();
        if (!normalizedSearch || normalizedSearch.length < 8) return false;

        // Use first 200 chars for matching long content
        const matchText = normalizedSearch.length > 200
            ? normalizedSearch.substring(0, 200) : normalizedSearch;

        const walker = document.createTreeWalker(
            document.body, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    if (['SCRIPT','STYLE','NOSCRIPT','IFRAME'].includes(parent.tagName))
                        return NodeFilter.FILTER_REJECT;
                    if (parent.closest('[data-cyber-snippet-hl]') || parent.closest('[data-cyber-highlight]'))
                        return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        // Strategy 1: single text node
        for (const textNode of textNodes) {
            const nodeText = textNode.textContent;
            const normalizedNode = nodeText.replace(/\s+/g, ' ');
            const idx = normalizedNode.toLowerCase().indexOf(matchText.toLowerCase());
            if (idx === -1) continue;
            const matchStart = mapNormIdx(nodeText, idx);
            const matchEnd = mapNormIdx(nodeText, idx + matchText.length);
            return wrapSnippetRange(textNode, matchStart, matchEnd, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
        }

        // Strategy 2: cross-node
        const fullText = textNodes.map(n => n.textContent).join('');
        const normalizedFull = fullText.replace(/\s+/g, ' ');
        const fullIdx = normalizedFull.toLowerCase().indexOf(matchText.toLowerCase());
        if (fullIdx === -1) return false;

        let charOffset = 0;
        let startNode = null, startOffset = 0;
        let endNode = null, endOffset = 0;
        const normalizedLens = textNodes.map(n => n.textContent.replace(/\s+/g, ' ').length);

        for (let i = 0; i < textNodes.length; i++) {
            const nLen = normalizedLens[i];
            if (!startNode && charOffset + nLen > fullIdx) {
                startNode = textNodes[i];
                startOffset = mapNormIdx(startNode.textContent, fullIdx - charOffset);
            }
            if (startNode && charOffset + nLen >= fullIdx + matchText.length) {
                endNode = textNodes[i];
                endOffset = mapNormIdx(endNode.textContent, fullIdx + matchText.length - charOffset);
                break;
            }
            charOffset += nLen;
        }

        if (!startNode || !endNode) return false;
        if (startNode === endNode) {
            return wrapSnippetRange(startNode, startOffset, endOffset, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
        }

        try {
            const range = document.createRange();
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);
            const span = makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
            range.surroundContents(span);
            return true;
        } catch (e) {
            return wrapSnippetRange(startNode, startOffset, startNode.textContent.length, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
        }
    }

    function makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText) {
        const span = document.createElement('span');
        span.setAttribute('data-cyber-snippet-hl', 'true');
        span.setAttribute('data-cyber-snippet-id', snippetId);
        span.setAttribute('data-cyber-tags', (tags || []).join(','));
        span.style.cssText = `background:${bgColor};border-bottom:2px solid ${underlineColor};padding:1px 0;border-radius:2px;position:relative;`;

        if (tags && tags.length > 0) {
            const badge = document.createElement('span');
            badge.className = 'cyber-tag-badge';
            badge.textContent = tags.slice(0, 2).join(' \u00b7 ');
            badge.style.cssText += `background:${badgeBg};color:${badgeText};`;
            span.appendChild(badge);
        }

        return span;
    }

    function wrapSnippetRange(textNode, start, end, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText) {
        if (start >= end || start < 0) return false;
        try {
            const range = document.createRange();
            range.setStart(textNode, Math.min(start, textNode.textContent.length));
            range.setEnd(textNode, Math.min(end, textNode.textContent.length));
            const span = makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
            range.surroundContents(span);
            return true;
        } catch (e) { return false; }
    }

    function mapNormIdx(original, normalizedIdx) {
        let ni = 0, inSpace = false;
        for (let i = 0; i < original.length; i++) {
            if (ni >= normalizedIdx) return i;
            if (/\s/.test(original[i])) { if (!inSpace) { ni++; inSpace = true; } }
            else { ni++; inSpace = false; }
        }
        return original.length;
    }

    // ---- Message Listener ----
    if (!contextValid()) return;
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'showToast') {
            showToast(message.title, message.text);
            sendResponse({ ok: true });
            return false;
        }

        if (message.type === 'showCommentInput') {
            showCommentModal(message.selectedText, message.sessionName).then(result => {
                sendResponse(result);
            });
            return true; // async response
        }

        if (message.type === 'highlightSnippets') {
            const result = highlightSnippetsOnPage(message.snippets || []);
            sendResponse(result);
            return false;
        }

        if (message.type === 'runQuickAction') {
            // Triggered from the context menu — use the live selection.
            const sel = window.getSelection();
            cachedSelection = sel ? sel.toString().trim() : '';
            const spec = QUICK_ACTIONS.find((a) => a.id === message.action);
            runQuickAction(message.action, spec ? spec.label : 'Weft');
            sendResponse({ ok: true });
            return false;
        }

        if (message.type === 'highlightSnippet') {
            // Single-snippet highlight used by citation jump-to-source.
            const result = highlightSnippetsOnPage([message.snippet]);
            // Scroll the first match into view if we highlighted anything.
            if (result.highlighted > 0) {
                const el = document.querySelector('[data-cyber-snippet-hl], [data-cyber-highlight]');
                if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            sendResponse({ found: result.highlighted > 0 });
            return false;
        }
    });

    // ---- Toast (moved from toast.js integration) ----
    function showToast(title, text) {
        const existing = document.getElementById('cyber-assistant-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'cyber-assistant-toast';
        Object.assign(toast.style, {
            position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
            background: '#323232', color: '#fff', padding: '10px 18px', borderRadius: '8px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: '13px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxWidth: '320px',
            opacity: '0', transform: 'translateY(-8px)', transition: 'opacity 0.3s, transform 0.3s',
            lineHeight: '1.4', pointerEvents: 'none'
        });

        const titleEl = document.createElement('strong');
        titleEl.style.cssText = 'display:block;margin-bottom:2px;font-size:12px;opacity:0.85;';
        titleEl.textContent = title;

        const textEl = document.createElement('span');
        textEl.textContent = text;

        toast.appendChild(titleEl);
        toast.appendChild(textEl);
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-8px)';
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }
})();
