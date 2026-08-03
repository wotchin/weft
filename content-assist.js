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
        modal_comment_title: 'Comment to “%s”',
        card_elapsed: '%s s',
        card_stats: '%s s · %t tokens',
        llm_error_auth: 'Your API key is missing or was rejected. Check Settings and try again.',
        llm_error_rate_limit: 'The model is busy or its usage limit was reached. Wait a moment and try again.',
        llm_error_context_length: 'This selection is too long for the configured model.',
        llm_error_network: 'Weft could not reach the model provider. Check your connection and endpoint.',
        llm_error_timeout: 'The model took too long to respond. Please try again.',
        llm_error_abort: 'The request was cancelled.',
        llm_error_server: 'The model provider returned an error. Please try again.',
        llm_error_bad_request: 'The model could not process this request. Check your model settings.',
        llm_error_empty_response: 'The model returned an empty response.',
        llm_error_output_limit: 'The model reached its output limit before completing the answer.',
        llm_error_unknown: 'Something went wrong while generating the answer. Please try again.',
        quick_error_unknown_action: 'This action is not available.',
        quick_error_no_selection: 'Select some text first.',
        tag_quote: 'quote', tag_data: 'data', tag_opinion: 'opinion',
        tag_reference: 'reference', tag_key_point: 'key point',
        tag_stats: 'stats', tag_market: 'market', tag_counterpoint: 'counterpoint',
        tag_generated: 'generated', tag_analysed: 'analysed',
    };

    let toolbar = null;
    let card = null;
    let commentModal = null;
    let cachedSelection = ''; // captured when toolbar shows, before click clears it

    function formatString(template, replacements = {}) {
        let result = template || '';
        for (const [token, value] of Object.entries(replacements)) {
            result = result.replaceAll(`%${token}`, String(value));
        }
        return result;
    }

    function applyLoadedStrings() {
        for (const root of [toolbar, card, commentModal]) {
            if (!root) continue;
            root.querySelectorAll('[data-weft-i18n]').forEach((element) => {
                const value = S[element.dataset.weftI18n];
                if (value) element.textContent = value;
            });
            root.querySelectorAll('[data-weft-i18n-title]').forEach((element) => {
                const value = S[element.dataset.weftI18nTitle];
                if (value) element.title = value;
            });
        }
        const modalTitle = commentModal?.querySelector('[data-weft-comment-session]');
        if (modalTitle) {
            modalTitle.textContent = formatString(S.modal_comment_title, {
                s: modalTitle.dataset.weftCommentSession,
            });
        }
        const modalInput = commentModal?.querySelector('textarea');
        if (modalInput) modalInput.placeholder = S.modal_comment_ph;
        card?.querySelectorAll('[data-weft-elapsed]').forEach((element) => {
            element.textContent = formatString(S.card_elapsed, { s: element.dataset.weftElapsed });
        });
        card?.querySelectorAll('[data-weft-stats-tokens]').forEach((element) => {
            element.textContent = formatString(S.card_stats, {
                s: element.dataset.weftStatsSeconds,
                t: element.dataset.weftStatsTokens,
            });
        });
    }

    function loadUiStrings() {
        try {
            chrome.runtime.sendMessage({ type: 'getUiStrings' }, (res) => {
            if (chrome.runtime.lastError || !res) return;
            S = { ...S, ...res };
            // Rebuild the toolbar so it picks up the new language.
            if (toolbar) { toolbar.remove(); toolbar = null; }
                applyLoadedStrings();
            });
        } catch { /* extension context invalidated */ }
    }

    loadUiStrings();

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
    // then the answer itself. Text is inserted with text-node APIs, never HTML.

    let activeCardRun = null;
    const STREAM_SCROLL_SLOP = 48;

    function cancelCardRender(run) {
        if (!run || run.renderFrame === null) return;
        window.cancelAnimationFrame(run.renderFrame);
        run.renderFrame = null;
    }

    function flushCardDeltas(run) {
        if (!run) return;
        run.renderFrame = null;
        if (activeCardRun !== run || run.cancelled || !run.pendingDelta) return;

        const shouldFollowOutput = run.body.scrollHeight - run.body.scrollTop - run.body.clientHeight
            <= STREAM_SCROLL_SLOP;
        const delta = run.pendingDelta;
        run.pendingDelta = '';

        if (!run.answerNode) {
            run.status?.remove();
            run.answerNode = document.createTextNode('');
            run.body.appendChild(run.answerNode);
        }
        run.answerNode.appendData(delta);
        if (shouldFollowOutput) run.body.scrollTop = run.body.scrollHeight;
    }

    function scheduleCardRender(run) {
        if (!run || run.renderFrame !== null || run.cancelled) return;
        run.renderFrame = window.requestAnimationFrame(() => flushCardDeltas(run));
    }

    function releaseCardRun(run, { disconnect = true, discardPending = false } = {}) {
        if (!run) return;
        if (run.ticker !== null) {
            clearInterval(run.ticker);
            run.ticker = null;
        }
        if (discardPending) {
            cancelCardRender(run);
            run.pendingDelta = '';
        }
        run.progress?.remove();

        const port = run.port;
        run.port = null;
        if (disconnect && port) {
            try { port.disconnect(); } catch { /* already gone */ }
        }
        if (activeCardRun === run) activeCardRun = null;
    }

    function closeCard() {
        if (activeCardRun) {
            activeCardRun.cancelled = true;
            activeCardRun.settled = true;
            releaseCardRun(activeCardRun, { discardPending: true });
        }
        if (card) { card.remove(); card = null; }
    }

    function createCard(title, anchorRect, titleKey = '') {
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
        if (titleKey) titleEl.dataset.weftI18n = titleKey;
        titleEl.textContent = title;
        const close = document.createElement('button');
        close.className = 'weft-card-x';
        close.textContent = '×';
        close.dataset.weftI18nTitle = 'card_close';
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
        status.dataset.weftI18n = 'card_thinking';
        status.textContent = S.card_thinking;
        body.appendChild(status);

        const foot = document.createElement('div');
        foot.className = 'weft-card-foot';
        const stats = document.createElement('span');
        stats.className = 'weft-stats';
        stats.dataset.weftElapsed = '0.0';
        stats.textContent = formatString(S.card_elapsed, { s: '0.0' });
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

        const actionSpec = QUICK_ACTIONS.find((item) => item.id === actionId);
        const titleKey = actionSpec ? `tb_${actionSpec.key}` : '';
        const { body, stats, progress, foot } = createCard(label, anchorRect, titleKey);

        const run = {
            card,
            body,
            status: card._status,
            progress,
            foot,
            port: null,
            ticker: null,
            renderFrame: null,
            pendingDelta: '',
            answerChunks: [],
            answerNode: null,
            hasAnswer: false,
            settled: false,
            cancelled: false,
        };
        activeCardRun = run;

        const started = Date.now();
        run.ticker = setInterval(() => {
            stats.dataset.weftElapsed = ((Date.now() - started) / 1000).toFixed(1);
            stats.textContent = formatString(S.card_elapsed, {
                s: stats.dataset.weftElapsed,
            });
        }, 500);

        let port;
        try {
            port = chrome.runtime.connect({ name: 'weft-quick' });
        } catch {
            run.settled = true;
            releaseCardRun(run, { disconnect: false, discardPending: true });
            body.dataset.weftI18n = 'card_reload';
            body.textContent = S.card_reload;
            return;
        }
        run.port = port;

        // If the worker goes away mid-flight, don't leave the card spinning.
        port.onDisconnect.addListener(() => {
            if (run.settled || run.cancelled) return;
            cancelCardRender(run);
            flushCardDeltas(run);
            run.settled = true;
            releaseCardRun(run, { disconnect: false });
            if (card === run.card && !run.hasAnswer) {
                run.status.dataset.weftI18n = 'card_disconnected';
                run.status.textContent = S.card_disconnected;
                run.status.classList.add('weft-err');
            }
        });

        port.onMessage.addListener((msg) => {
            if (!msg || activeCardRun !== run || run.cancelled || run.settled) return;

            if (msg.type === 'reasoning') {
                if (!run.hasAnswer) {
                    run.status.dataset.weftI18n = 'card_reasoning';
                    run.status.textContent = S.card_reasoning;
                }
                return;
            }

            if (msg.type === 'delta') {
                const delta = typeof msg.delta === 'string' ? msg.delta : '';
                if (!delta) return;
                run.hasAnswer = true;
                run.answerChunks.push(delta);
                run.pendingDelta += delta;
                scheduleCardRender(run);
                return;
            }

            if (msg.type === 'done') {
                if (!run.hasAnswer && typeof msg.text === 'string' && msg.text) {
                    run.hasAnswer = true;
                    run.answerChunks.push(msg.text);
                    run.pendingDelta += msg.text;
                }
                cancelCardRender(run);
                flushCardDeltas(run);
                const answer = run.answerChunks.join('');
                run.settled = true;
                const secs = (msg.elapsed / 1000).toFixed(1);
                const tok = (msg.promptTokens || 0) + (msg.completionTokens || 0);
                delete stats.dataset.weftElapsed;
                stats.dataset.weftStatsSeconds = secs;
                stats.dataset.weftStatsTokens = `${msg.estimated ? '~' : ''}${tok}`;
                stats.textContent = formatString(S.card_stats, {
                    s: secs,
                    t: stats.dataset.weftStatsTokens,
                });
                if (answer.trim()) addCardActions(foot, msg.text || answer, selectedText);
                releaseCardRun(run);
                return;
            }

            if (msg.type === 'error') {
                run.settled = true;
                releaseCardRun(run, { discardPending: true });
                delete stats.dataset.weftElapsed;
                delete stats.dataset.weftStatsSeconds;
                delete stats.dataset.weftStatsTokens;
                stats.textContent = '';
                const errorKey = ({
                    unknown_action: 'quick_error_unknown_action',
                    no_selection: 'quick_error_no_selection',
                    auth: 'llm_error_auth',
                    rate_limit: 'llm_error_rate_limit',
                    context_length: 'llm_error_context_length',
                    network: 'llm_error_network',
                    timeout: 'llm_error_timeout',
                    abort: 'llm_error_abort',
                    server: 'llm_error_server',
                    bad_request: 'llm_error_bad_request',
                    empty_response: 'llm_error_empty_response',
                    output_limit: 'llm_error_output_limit',
                })[msg.kind] || 'llm_error_unknown';
                body.dataset.weftI18n = errorKey;
                body.textContent = S[errorKey] || S.llm_error_unknown;
                body.classList.add('weft-err');
            }
        });

        try {
            port.postMessage({
                type: 'run',
                action: actionId,
                text: selectedText,
                url: location.href,
                title: document.title,
            });
        } catch {
            run.settled = true;
            releaseCardRun(run, { discardPending: true });
            body.dataset.weftI18n = 'card_disconnected';
            body.textContent = S.card_disconnected;
            body.classList.add('weft-err');
        }
    }

    function addCardActions(foot, resultText, selectedText) {
        const copy = document.createElement('button');
        copy.className = 'weft-act';
        copy.dataset.weftI18n = 'card_copy';
        copy.textContent = S.card_copy;
        copy.addEventListener('click', () => {
            navigator.clipboard.writeText(resultText).then(() => {
                copy.textContent = S.card_copied;
                setTimeout(() => { copy.textContent = S.card_copy; }, 1400);
            }).catch(() => { copy.textContent = S.card_failed; });
        });

        const save = document.createElement('button');
        save.className = 'weft-act';
        save.dataset.weftI18n = 'card_save';
        save.dataset.weftI18nTitle = 'card_save_hint';
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
            title.dataset.weftCommentSession = sessionName;
            title.textContent = formatString(S.modal_comment_title, { s: sessionName });

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
            cancelBtn.dataset.weftI18n = 'modal_cancel';
            cancelBtn.textContent = S.modal_cancel;
            cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;font-size:13px;cursor:pointer;color:#666;';
            cancelBtn.addEventListener('click', () => {
                commentModal.remove();
                commentModal = null;
                resolve({ comment: undefined }); // undefined = cancelled
            });

            const saveBtn = document.createElement('button');
            saveBtn.dataset.weftI18n = 'modal_save';
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

    const SNIPPET_HIGHLIGHT_LIMITS = Object.freeze({
        snippets: 24,
        characters: 250000,
        textNodes: 8000,
        linkAnchors: 8000,
        restoreWaitMs: 900,
    });
    const HIGHLIGHT_IGNORED_SELECTOR = [
        'script', 'style', 'noscript', 'iframe', 'template', 'nav', 'footer',
        '[hidden]', '[aria-hidden="true"]', '[role="navigation"]', '[role="dialog"]',
        '[data-cyber-snippet-hl]', '[data-cyber-highlight]',
        '#weft-toolbar', '#weft-card', '#cyber-comment-modal',
    ].join(',');
    let highlightJobVersion = 0;
    let pageAnnotationQueue = Promise.resolve();
    let pageAnnotationState = null;

    const ANNOTATION_TRACKING_PARAM_RE = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|gbraid|wbraid|yclid|twclid|mc_cid|mc_eid|vero_(?:id|conv)|_hsenc|_hsmi|hscid|hsctatracking|mkt_tok|igshid)$/i;

    function comparableAnnotationUrl(value) {
        try {
            const parsed = new URL(value || location.href, location.href);
            parsed.hash = '';
            const params = [];
            parsed.searchParams.forEach((paramValue, key) => {
                if (!ANNOTATION_TRACKING_PARAM_RE.test(key)) params.push([key, paramValue]);
            });
            params.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
            parsed.search = '';
            params.forEach(([key, paramValue]) => parsed.searchParams.append(key, paramValue));
            return parsed.href;
        } catch {
            return String(value || location.href || '').split('#')[0];
        }
    }

    function enqueuePageAnnotationTask(task) {
        const operation = pageAnnotationQueue.then(task, task);
        pageAnnotationQueue = operation.catch(() => {});
        return operation;
    }

    function hasAnnotationSet(setKey, pageKey = comparableAnnotationUrl(location.href)) {
        if (!setKey || pageKey !== comparableAnnotationUrl(location.href)) return false;
        return Array.from(document.querySelectorAll('[data-cyber-snippet-hl]')).some((element) =>
            element.dataset.weftSetKey === setKey
                && element.dataset.weftPageKey === pageKey
        );
    }

    function highlightJobCancelled(jobId, sharedJobId, expectedPageKey = '') {
        return jobId !== highlightJobVersion
            || sharedJobId !== window.__cyberHighlightJobId
            || Boolean(expectedPageKey && comparableAnnotationUrl(location.href) !== expectedPageKey);
    }

    function yieldHighlightWork() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    function normalizeHighlightText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeHighlightLink(value) {
        try {
            const parsed = new URL(value, location.href);
            parsed.hash = '';
            const params = [];
            parsed.searchParams.forEach((paramValue, key) => {
                if (!ANNOTATION_TRACKING_PARAM_RE.test(key)) params.push([key, paramValue]);
            });
            params.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
            parsed.search = '';
            params.forEach(([key, paramValue]) => parsed.searchParams.append(key, paramValue));
            return parsed.href;
        } catch {
            return '';
        }
    }

    function normalizeHighlightLinkPath(value) {
        try {
            const parsed = new URL(value, location.href);
            const pathname = parsed.pathname.length > 1
                ? parsed.pathname.replace(/\/+$/u, '')
                : parsed.pathname;
            return `${parsed.origin}${pathname}`;
        } catch {
            return '';
        }
    }

    function smartReadTextAnchors(text) {
        if (text.length < 96) return [];
        const width = Math.min(120, Math.max(64, Math.floor(text.length * 0.55)));
        const maxStart = Math.max(0, text.length - width);
        const starts = [0, Math.round(maxStart / 2), maxStart];
        const anchors = [];

        for (let start of starts) {
            let end = Math.min(text.length, start + width);
            if (start > 0) {
                const nextSpace = text.indexOf(' ', start);
                if (nextSpace >= 0 && nextSpace - start <= 24) start = nextSpace + 1;
            }
            if (end < text.length) {
                const previousSpace = text.lastIndexOf(' ', end);
                if (previousSpace > start + 48) end = previousSpace;
            }
            const anchor = text.slice(start, end).trim();
            if (anchor.length >= 48 && !anchors.includes(anchor)) anchors.push(anchor);
        }
        return anchors;
    }

    function makeHighlightDescriptor(snippet) {
        if (!snippet || typeof snippet !== 'object') return null;
        const isArticleText = snippet.type === 'text';
        const isIndexLink = snippet.type === 'link' && snippet.smartReadPageType === 'index';
        const minLength = isIndexLink ? 2 : 8;
        if (!isArticleText && !isIndexLink) return null;

        const normalizedText = normalizeHighlightText(snippet.content);
        if (normalizedText.length < minLength) return null;
        const linkKey = isIndexLink
            ? normalizeHighlightLink(snippet.linkUrl || snippet.sourceUrl || '')
            : '';
        if (isIndexLink && !linkKey) return null;

        const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
        const tag = tags[0] || 'default';
        const tc = TAG_COLORS[tag] || TAG_COLORS['default'];
        const matchText = normalizedText.substring(0, 200);
        const isSmartReadArticle = isArticleText
            && (snippet.smartReadPageType === 'article' || tags.includes('smart-read'));
        return {
            snippetId: String(snippet.id || ''),
            tags,
            underlineColor: tc.underline,
            bgColor: tc.bg,
            badgeBg: tc.badge,
            badgeText: tc.text,
            matchText,
            matchLower: matchText.toLowerCase(),
            linkKey,
            linkPathKey: isIndexLink
                ? normalizeHighlightLinkPath(snippet.linkUrl || snippet.sourceUrl || '')
                : '',
            matchAnchors: isSmartReadArticle
                ? smartReadTextAnchors(normalizedText)
                    .filter(anchor => anchor !== matchText)
                    .map(anchor => ({ matchText: anchor, matchLower: anchor.toLowerCase() }))
                : [],
        };
    }

    async function clearExistingPageHighlights(jobId, sharedJobId, expectedPageKey) {
        const badges = document.querySelectorAll('.cyber-tag-badge');
        for (let index = 0; index < badges.length; index++) {
            badges[index].remove();
            if ((index + 1) % 100 === 0) {
                await yieldHighlightWork();
                if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) return false;
            }
        }

        const parents = new Set();
        const wrappers = document.querySelectorAll('[data-cyber-highlight],[data-cyber-snippet-hl]');
        for (let index = 0; index < wrappers.length; index++) {
            const element = wrappers[index];
            const parent = element.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(element.textContent), element);
                parents.add(parent);
            }
            if ((index + 1) % 80 === 0) {
                await yieldHighlightWork();
                if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) return false;
            }
        }
        let normalized = 0;
        for (const parent of parents) {
            parent.normalize();
            normalized++;
            if (normalized % 80 === 0) {
                await yieldHighlightWork();
                if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) return false;
            }
        }
        return !highlightJobCancelled(jobId, sharedJobId, expectedPageKey);
    }

    async function buildHighlightLinkLookup(descriptors, jobId, sharedJobId, expectedPageKey) {
        const expectedLinks = new Set(descriptors.map(item => item.linkKey).filter(Boolean));
        const expectedPaths = new Set(descriptors.map(item => item.linkPathKey).filter(Boolean));
        const anchorsByLink = new Map();
        const anchorsByPath = new Map();
        const relevantAnchors = new Set();
        let limited = false;
        if (!expectedLinks.size && !expectedPaths.size) {
            return { anchorsByLink, anchorsByPath, relevantAnchors, limited };
        }

        const anchors = document.querySelectorAll('a[href]');
        for (let index = 0; index < anchors.length; index++) {
            if (index >= SNIPPET_HIGHLIGHT_LIMITS.linkAnchors) {
                limited = true;
                break;
            }
            const anchor = anchors[index];
            const linkKey = normalizeHighlightLink(anchor.href);
            const pathKey = normalizeHighlightLinkPath(anchor.href);
            if (expectedLinks.has(linkKey) && anchor.getClientRects().length > 0) {
                if (!anchorsByLink.has(linkKey)) anchorsByLink.set(linkKey, []);
                anchorsByLink.get(linkKey).push(anchor);
                relevantAnchors.add(anchor);
            }
            if (expectedPaths.has(pathKey) && anchor.getClientRects().length > 0) {
                if (!anchorsByPath.has(pathKey)) anchorsByPath.set(pathKey, []);
                anchorsByPath.get(pathKey).push(anchor);
                relevantAnchors.add(anchor);
            }
            if ((index + 1) % 250 === 0) {
                await yieldHighlightWork();
                if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) {
                    return { anchorsByLink, anchorsByPath, relevantAnchors, limited: true, cancelled: true };
                }
            }
        }
        return { anchorsByLink, anchorsByPath, relevantAnchors, limited };
    }

    function createHighlightTextIndex() {
        return { parts: [], segments: [], length: 0, text: '', lower: '' };
    }

    function appendHighlightIndexNode(index, node, normalizedText, nodeOrder, maxCharacters) {
        const separatorLength = index.length > 0 ? 1 : 0;
        const available = maxCharacters - index.length - separatorLength;
        if (available <= 0) return { complete: false, segment: null };

        const text = normalizedText.substring(0, available);
        if (!text) return { complete: false, segment: null };
        if (separatorLength) {
            index.parts.push(' ');
            index.length++;
        }
        const start = index.length;
        index.parts.push(text);
        index.length += text.length;

        const original = node.textContent || '';
        const firstTextOffset = original.search(/\S/);
        const sourceStart = firstTextOffset < 0 ? 0 : firstTextOffset;
        const sourceText = original.slice(sourceStart).replace(/\s+$/, '');
        const segment = {
            node,
            nodeOrder,
            start,
            end: index.length,
            sourceStart,
            sourceText,
        };
        index.segments.push(segment);
        return { complete: text.length === normalizedText.length, segment };
    }

    function finalizeHighlightTextIndex(index) {
        index.text = index.parts.join('');
        index.lower = index.text.toLowerCase();
        index.parts = [];
        return index;
    }

    async function buildHighlightTextIndexes(linkLookup, jobId, sharedJobId, expectedPageKey) {
        const pageIndex = createHighlightTextIndex();
        const anchorIndexes = new Map();
        const visibilityCache = new WeakMap();
        const anchorCache = new WeakMap();
        let inspectedNodes = 0;
        let acceptedNodes = 0;
        let limited = false;

        function isVisibleTextParent(parent) {
            if (!parent) return false;
            if (visibilityCache.has(parent)) return visibilityCache.get(parent);
            let visible = !parent.closest(HIGHLIGHT_IGNORED_SELECTOR);
            if (visible) {
                const style = window.getComputedStyle(parent);
                visible = style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && style.visibility !== 'collapse'
                    && Number(style.opacity) > 0.01
                    && parent.getClientRects().length > 0;
            }
            visibilityCache.set(parent, visible);
            return visible;
        }

        function relevantAnchorFor(parent) {
            if (!linkLookup.relevantAnchors.size) return null;
            if (anchorCache.has(parent)) return anchorCache.get(parent);
            const anchor = parent.closest('a[href]');
            const relevant = anchor && linkLookup.relevantAnchors.has(anchor) ? anchor : null;
            anchorCache.set(parent, relevant);
            return relevant;
        }

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            inspectedNodes++;
            if (inspectedNodes > SNIPPET_HIGHLIGHT_LIMITS.textNodes) {
                limited = true;
                break;
            }
            if (inspectedNodes % 250 === 0) {
                await yieldHighlightWork();
                if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) {
                    return { pageIndex, anchorIndexes, limited: true, cancelled: true };
                }
            }
            const parent = node.parentElement;
            if (!isVisibleTextParent(parent)) continue;
            const normalizedText = normalizeHighlightText(node.textContent);
            if (!normalizedText) continue;

            const appended = appendHighlightIndexNode(
                pageIndex,
                node,
                normalizedText,
                acceptedNodes,
                SNIPPET_HIGHLIGHT_LIMITS.characters
            );
            if (!appended.segment) {
                limited = true;
                break;
            }

            const anchor = relevantAnchorFor(parent);
            if (anchor) {
                if (!anchorIndexes.has(anchor)) anchorIndexes.set(anchor, createHighlightTextIndex());
                appendHighlightIndexNode(
                    anchorIndexes.get(anchor),
                    node,
                    normalizedText.substring(0, appended.segment.end - appended.segment.start),
                    acceptedNodes,
                    Number.POSITIVE_INFINITY
                );
            }

            acceptedNodes++;
            if (!appended.complete) {
                limited = true;
                break;
            }
        }

        finalizeHighlightTextIndex(pageIndex);
        anchorIndexes.forEach(finalizeHighlightTextIndex);
        return { pageIndex, anchorIndexes, limited };
    }

    function findHighlightSegment(index, position) {
        let low = 0;
        let high = index.segments.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const segment = index.segments[middle];
            if (position < segment.start) high = middle - 1;
            else if (position >= segment.end) low = middle + 1;
            else return { segment, index: middle };
        }
        return null;
    }

    function mapSegmentOffset(segment, normalizedOffset) {
        return segment.sourceStart + mapNormIdx(segment.sourceText, normalizedOffset);
    }

    function buildHighlightOperations(index, matchStart, matchLength, descriptor, matchId) {
        const startHit = findHighlightSegment(index, matchStart);
        const endHit = findHighlightSegment(index, matchStart + matchLength - 1);
        if (!startHit || !endHit) return [];

        const operations = [];
        for (let segmentIndex = startHit.index; segmentIndex <= endHit.index; segmentIndex++) {
            const segment = index.segments[segmentIndex];
            const normalizedStart = segmentIndex === startHit.index ? matchStart - segment.start : 0;
            const normalizedEnd = segmentIndex === endHit.index
                ? matchStart + matchLength - segment.start
                : segment.end - segment.start;
            const start = mapSegmentOffset(segment, normalizedStart);
            const end = mapSegmentOffset(segment, normalizedEnd);
            if (start >= end || !segment.node.textContent.slice(start, end).trim()) continue;
            operations.push({
                ...descriptor,
                matchId,
                node: segment.node,
                nodeOrder: segment.nodeOrder,
                start,
                end,
                expectedText: segment.node.textContent.slice(start, end),
                showBadge: segmentIndex === startHit.index,
            });
        }
        return operations;
    }

    function reserveHighlightOperations(operations, occupiedByNode) {
        if (!operations.length) return false;
        for (const operation of operations) {
            const occupied = occupiedByNode.get(operation.node) || [];
            if (occupied.some(range => operation.start < range.end && operation.end > range.start)) {
                return false;
            }
        }
        for (const operation of operations) {
            if (!occupiedByNode.has(operation.node)) occupiedByNode.set(operation.node, []);
            occupiedByNode.get(operation.node).push({ start: operation.start, end: operation.end });
        }
        return true;
    }

    function planHighlightInIndex(index, descriptor, matchId, occupiedByNode) {
        if (!index?.lower || !descriptor.matchLower) return [];
        const variants = [
            { matchText: descriptor.matchText, matchLower: descriptor.matchLower },
            ...(Array.isArray(descriptor.matchAnchors) ? descriptor.matchAnchors : []),
        ];
        for (const variant of variants) {
            let fromIndex = 0;
            while (fromIndex < index.lower.length) {
                const matchStart = index.lower.indexOf(variant.matchLower, fromIndex);
                if (matchStart < 0) break;
                const candidate = {
                    ...descriptor,
                    matchText: variant.matchText,
                    matchLower: variant.matchLower,
                };
                const operations = buildHighlightOperations(
                    index,
                    matchStart,
                    variant.matchText.length,
                    candidate,
                    matchId
                );
                if (reserveHighlightOperations(operations, occupiedByNode)) return operations;
                fromIndex = matchStart + 1;
            }
        }
        return [];
    }

    async function highlightSnippetsOnPage(snippets, options = {}) {
        pageAnnotationState = null;
        const sharedJobId = (window.__cyberHighlightJobId || 0) + 1;
        window.__cyberHighlightJobId = sharedJobId;
        const expectedPageKey = options.expectedPageKey
            ? comparableAnnotationUrl(options.expectedPageKey)
            : '';
        const requested = Array.isArray(snippets) ? snippets : [];
        const eligible = requested.map(makeHighlightDescriptor).filter(Boolean);
        const descriptors = eligible.slice(0, SNIPPET_HIGHLIGHT_LIMITS.snippets);
        const total = eligible.length;
        const limitedCount = Math.max(0, total - descriptors.length);
        const jobId = ++highlightJobVersion;

        await yieldHighlightWork();
        if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) {
            return { highlighted: 0, total, processed: 0, limited: true, limitedCount, cancelled: true };
        }

        // Clear any older Weft highlight layer before applying the explicit,
        // persisted session view used by "Show on Page".
        const cleared = await clearExistingPageHighlights(jobId, sharedJobId, expectedPageKey);
        if (!cleared) {
            return { highlighted: 0, total, processed: 0, limited: true, limitedCount, cancelled: true };
        }
        if (!descriptors.length) {
            return { highlighted: 0, total, processed: 0, limited: limitedCount > 0, limitedCount };
        }

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

        const linkLookup = await buildHighlightLinkLookup(
            descriptors, jobId, sharedJobId, expectedPageKey
        );
        if (linkLookup.cancelled || highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) {
            return { highlighted: 0, total, processed: 0, limited: true, limitedCount, cancelled: true };
        }
        const indexes = await buildHighlightTextIndexes(
            linkLookup, jobId, sharedJobId, expectedPageKey
        );
        if (indexes.cancelled || highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) {
            return { highlighted: 0, total, processed: 0, limited: true, limitedCount, cancelled: true };
        }

        const occupiedByNode = new WeakMap();
        const operations = [];
        let matchId = 0;
        for (let index = 0; index < descriptors.length; index++) {
            const descriptor = descriptors[index];
            let planned = [];
            if (descriptor.linkKey) {
                const exactAnchors = linkLookup.anchorsByLink.get(descriptor.linkKey) || [];
                const pathAnchors = linkLookup.anchorsByPath.get(descriptor.linkPathKey) || [];
                const anchorGroups = [
                    exactAnchors,
                    pathAnchors.filter(anchor => !exactAnchors.includes(anchor)),
                ];
                for (const anchors of anchorGroups) {
                    for (const anchor of anchors) {
                        planned = planHighlightInIndex(
                            indexes.anchorIndexes.get(anchor),
                            descriptor,
                            matchId,
                            occupiedByNode
                        );
                        if (planned.length) break;
                    }
                    if (planned.length) break;
                }
            } else {
                planned = planHighlightInIndex(
                    indexes.pageIndex,
                    descriptor,
                    matchId,
                    occupiedByNode
                );
            }
            if (planned.length) {
                operations.push(...planned);
                matchId++;
            }
            if ((index + 1) % 4 === 0) {
                await yieldHighlightWork();
                if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) {
                    return { highlighted: 0, total, processed: index + 1, limited: true, limitedCount, cancelled: true };
                }
            }
        }

        operations.sort((left, right) =>
            right.nodeOrder - left.nodeOrder || right.start - left.start
        );
        const highlightedMatches = new Set();
        for (let index = 0; index < operations.length; index++) {
            if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) {
                return {
                    highlighted: highlightedMatches.size,
                    total,
                    processed: descriptors.length,
                    limited: true,
                    limitedCount,
                    cancelled: true,
                    pageChanged: Boolean(
                        expectedPageKey && comparableAnnotationUrl(location.href) !== expectedPageKey
                    ),
                };
            }
            const operation = operations[index];
            const textIsCurrent = operation.node.textContent.slice(operation.start, operation.end)
                === operation.expectedText;
            const wrapped = textIsCurrent && wrapSnippetRange(
                    operation.node,
                    operation.start,
                    operation.end,
                    operation.underlineColor,
                    operation.bgColor,
                    operation.snippetId,
                    operation.tags,
                    operation.badgeBg,
                    operation.badgeText,
                    operation.showBadge
                );
            if (wrapped) highlightedMatches.add(operation.matchId);
            if ((index + 1) % 32 === 0) {
                await yieldHighlightWork();
                if (highlightJobCancelled(jobId, sharedJobId, expectedPageKey)) {
                    return {
                        highlighted: highlightedMatches.size,
                        total,
                        processed: descriptors.length,
                        limited: true,
                        limitedCount,
                        cancelled: true,
                    };
                }
            }
        }

        return {
            highlighted: highlightedMatches.size,
            total,
            processed: descriptors.length,
            limited: limitedCount > 0 || linkLookup.limited || indexes.limited,
            limitedCount,
        };
    }

    function hasSmartReadRestoreSnippets(snippets) {
        return (Array.isArray(snippets) ? snippets : []).some((snippet) =>
            snippet && typeof snippet === 'object' && (
                snippet.smartReadPageType === 'article'
                || snippet.smartReadPageType === 'index'
                || (Array.isArray(snippet.tags) && snippet.tags.includes('smart-read'))
            )
        );
    }

    function waitForSmartReadRestoreWindow(expectedPageKey) {
        return new Promise((resolve) => {
            const root = document.body || document.documentElement;
            let observer = null;
            let quietTimer = null;
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(hardTimer);
                if (quietTimer) clearTimeout(quietTimer);
                observer?.disconnect();
                resolve(comparableAnnotationUrl(location.href) === expectedPageKey);
            };
            const hardTimer = setTimeout(finish, SNIPPET_HIGHLIGHT_LIMITS.restoreWaitMs);

            if (!root || typeof window.MutationObserver !== 'function') return;
            observer = new window.MutationObserver(() => {
                if (comparableAnnotationUrl(location.href) !== expectedPageKey) {
                    finish();
                    return;
                }
                if (quietTimer) clearTimeout(quietTimer);
                quietTimer = setTimeout(finish, 120);
            });
            observer.observe(root, { childList: true, subtree: true, characterData: true });
        });
    }

    async function restoreSessionHighlights(snippets, expectedPageKey) {
        let result = await highlightSnippetsOnPage(snippets, { expectedPageKey });
        const shouldRetry = result.highlighted === 0
            && result.total > 0
            && !result.cancelled
            && hasSmartReadRestoreSnippets(snippets)
            && comparableAnnotationUrl(location.href) === expectedPageKey;
        if (!shouldRetry) return result;

        const pageStillMatches = await waitForSmartReadRestoreWindow(expectedPageKey);
        if (!pageStillMatches) return result;
        result = await highlightSnippetsOnPage(snippets, { expectedPageKey });
        return result;
    }

    async function toggleSessionHighlights(message) {
        return enqueuePageAnnotationTask(async () => {
            const setKey = typeof message.setKey === 'string' ? message.setKey : '';
            const sessionName = typeof message.sessionName === 'string' ? message.sessionName : '';
            const expectedPageKey = comparableAnnotationUrl(message.expectedUrl || location.href);
            const actualPageKey = comparableAnnotationUrl(location.href);
            if (!setKey || expectedPageKey !== actualPageKey) {
                return {
                    active: false,
                    state: 'hidden',
                    highlighted: 0,
                    total: 0,
                    error: 'TARGET_PAGE_CHANGED',
                    pageKey: actualPageKey,
                    setKey,
                };
            }

            const exactSetIsActive = hasAnnotationSet(setKey, actualPageKey);
            if (message.mode === 'hide') {
                const anyHighlights = Boolean(document.querySelector(
                    '[data-cyber-snippet-hl],[data-cyber-highlight]'
                ));
                const cleared = anyHighlights
                    ? await highlightSnippetsOnPage([], { expectedPageKey: actualPageKey })
                    : { highlighted: 0, total: 0, processed: 0, limited: false };
                pageAnnotationState = null;
                return {
                    ...cleared,
                    active: false,
                    state: 'hidden',
                    highlighted: 0,
                    total: Array.isArray(message.snippets) ? message.snippets.length : 0,
                    cleared: anyHighlights,
                    pageKey: actualPageKey,
                    setKey,
                };
            }

            if (message.mode === 'show' && exactSetIsActive) {
                const matching = Array.from(document.querySelectorAll('[data-cyber-snippet-hl]')).filter(
                    element => element.dataset.weftSetKey === setKey
                        && element.dataset.weftPageKey === actualPageKey
                );
                return {
                    active: true,
                    state: 'shown',
                    highlighted: new Set(matching.map(element => element.dataset.cyberSnippetId)).size,
                    total: Array.isArray(message.snippets) ? message.snippets.length : 0,
                    cleared: false,
                    pageKey: actualPageKey,
                    setKey,
                };
            }

            if (exactSetIsActive) {
                const cleared = await highlightSnippetsOnPage([], { expectedPageKey: actualPageKey });
                pageAnnotationState = null;
                return {
                    ...cleared,
                    active: false,
                    state: 'hidden',
                    cleared: true,
                    pageKey: actualPageKey,
                    setKey,
                };
            }

            const result = await restoreSessionHighlights(message.snippets || [], actualPageKey);
            const pageStillMatches = comparableAnnotationUrl(location.href) === actualPageKey;
            const active = result.highlighted > 0 && !result.cancelled && pageStillMatches;
            if (!pageStillMatches && result.highlighted > 0) {
                await highlightSnippetsOnPage([]);
            }
            if (active) {
                document.querySelectorAll('[data-cyber-snippet-hl]').forEach((element) => {
                    element.dataset.weftSetKey = setKey;
                    element.dataset.weftPageKey = actualPageKey;
                    element.dataset.weftSessionName = sessionName;
                });
                pageAnnotationState = {
                    sessionName,
                    setKey,
                    pageKey: actualPageKey,
                    highlighted: result.highlighted,
                };
            } else {
                pageAnnotationState = null;
            }
            return {
                ...result,
                active,
                state: active ? 'shown' : 'hidden',
                cleared: false,
                pageKey: actualPageKey,
                setKey,
                ...(!pageStillMatches ? { error: 'TARGET_PAGE_CHANGED' } : {}),
            };
        });
    }

    async function getSessionHighlightState(message) {
        const setKey = typeof message.setKey === 'string' ? message.setKey : '';
        const expectedPageKey = comparableAnnotationUrl(message.expectedUrl || location.href);
        const actualPageKey = comparableAnnotationUrl(location.href);
        let wrappers = Array.from(document.querySelectorAll('[data-cyber-snippet-hl]'));
        const stalePageMarks = wrappers.some(element =>
            element.dataset.weftPageKey && element.dataset.weftPageKey !== actualPageKey
        );
        const staleSessionVersion = wrappers.some(element =>
            element.dataset.weftSessionName === message.sessionName
                && element.dataset.weftSetKey !== setKey
        );
        if (stalePageMarks || staleSessionVersion) {
            await highlightSnippetsOnPage([], { expectedPageKey: actualPageKey });
            wrappers = [];
        }
        const matchingWrappers = wrappers.filter((element) =>
            element.dataset.weftSetKey === setKey
                && element.dataset.weftPageKey === actualPageKey
        );
        const active = expectedPageKey === actualPageKey && matchingWrappers.length > 0;
        if (!active && pageAnnotationState?.setKey === setKey) pageAnnotationState = null;
        return {
            active,
            state: active ? 'shown' : 'hidden',
            highlighted: active
                ? new Set(matchingWrappers.map((element) => element.dataset.cyberSnippetId)).size
                : 0,
            pageKey: actualPageKey,
            setKey,
            ...(expectedPageKey === actualPageKey ? {} : { error: 'TARGET_PAGE_CHANGED' }),
        };
    }

    function makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText, showBadge = true) {
        const span = document.createElement('span');
        span.setAttribute('data-cyber-snippet-hl', 'true');
        span.setAttribute('data-cyber-snippet-id', snippetId);
        span.setAttribute('data-cyber-tags', (tags || []).join(','));
        span.style.cssText = `background:${bgColor};border-bottom:2px solid ${underlineColor};padding:1px 0;border-radius:2px;position:relative;`;

        if (showBadge && tags && tags.length > 0) {
            const badge = document.createElement('span');
            badge.className = 'cyber-tag-badge';
            const tagLabels = {
                quote: S.tag_quote,
                data: S.tag_data,
                opinion: S.tag_opinion,
                reference: S.tag_reference,
                'key-point': S.tag_key_point,
                stats: S.tag_stats,
                market: S.tag_market,
                counterpoint: S.tag_counterpoint,
                generated: S.tag_generated,
                analysed: S.tag_analysed,
            };
            badge.textContent = tags.slice(0, 2).map((tag) => tagLabels[tag] || tag).join(' \u00b7 ');
            badge.style.cssText += `background:${badgeBg};color:${badgeText};`;
            span.appendChild(badge);
        }

        return span;
    }

    function wrapSnippetRange(textNode, start, end, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText, showBadge = true) {
        if (start >= end || start < 0) return false;
        try {
            const range = document.createRange();
            range.setStart(textNode, Math.min(start, textNode.textContent.length));
            range.setEnd(textNode, Math.min(end, textNode.textContent.length));
            const span = makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText, showBadge);
            range.surroundContents(span);
            return true;
        } catch { return false; }
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
        if (message.type === 'uiLanguageChanged') {
            loadUiStrings();
            sendResponse({ ok: true });
            return false;
        }

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

        if (message.type === 'toggleSessionHighlights') {
            toggleSessionHighlights(message).then(
                result => sendResponse(result),
                () => sendResponse({
                    active: false, state: 'hidden', highlighted: 0,
                    total: 0, error: 'ANNOTATION_FAILED',
                })
            );
            return true;
        }

        if (message.type === 'getSessionHighlightState') {
            enqueuePageAnnotationTask(() => getSessionHighlightState(message)).then(
                result => sendResponse(result),
                () => sendResponse({
                    active: false, state: 'hidden', highlighted: 0,
                    total: 0, error: 'ANNOTATION_FAILED',
                })
            );
            return true;
        }

        if (message.type === 'highlightSnippets') {
            enqueuePageAnnotationTask(() => highlightSnippetsOnPage(message.snippets || [])).then(
                result => sendResponse(result),
                () => sendResponse({ highlighted: 0, total: 0, processed: 0, limited: false })
            );
            return true;
        }

        if (message.type === 'runQuickAction') {
            // Triggered from the context menu — use the live selection.
            const sel = window.getSelection();
            cachedSelection = sel ? sel.toString().trim() : '';
            const spec = QUICK_ACTIONS.find((a) => a.id === message.action);
            runQuickAction(message.action, spec ? S[`tb_${spec.key}`] : 'Weft');
            sendResponse({ ok: true });
            return false;
        }

        if (message.type === 'highlightSnippet') {
            // Single-snippet highlight used by citation jump-to-source.
            enqueuePageAnnotationTask(() => restoreSessionHighlights(
                [message.snippet], comparableAnnotationUrl(location.href)
            )).then(result => {
                // Scroll the first match into view if we highlighted anything.
                if (result.highlighted > 0) {
                    const el = document.querySelector('[data-cyber-snippet-hl], [data-cyber-highlight]');
                    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                sendResponse({ found: result.highlighted > 0, limited: result.limited });
            }, () => sendResponse({ found: false, limited: false }));
            return true;
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
