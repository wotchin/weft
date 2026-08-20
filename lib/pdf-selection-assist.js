/* exported PDFSelectionAssist */

/**
 * PDF selection action bar.
 *
 * This deliberately reuses the same quick-action port as content-assist.js,
 * while receiving source/page metadata from the trusted Weft PDF reader.
 * It never reads the extension page URL as a document source.
 */
const PDFSelectionAssist = (() => {
    'use strict';

    const ACTIONS = Object.freeze([
        { id: 'verify', icon: '✓', labelKey: 'tb_verify', fallback: 'Verify' },
        { id: 'explain', icon: '?', labelKey: 'tb_explain', fallback: 'Explain' },
        { id: 'key_points', icon: '≡', labelKey: 'tb_points', fallback: 'Points' },
    ]);

    function create(options) {
        const root = options?.root;
        const scrollRoot = options?.scrollRoot || root;
        const capture = options?.capture;
        const translate = typeof options?.message === 'function'
            ? options.message
            : (_key, fallback) => fallback;
        if (!root || typeof capture !== 'function') throw new Error('PDF_SELECTION_ASSIST_INVALID');

        let toolbar = null;
        let card = null;
        let pending = null;
        let activeRun = null;
        let selectionFrame = null;
        let disposed = false;

        const text = (key, fallback) => translate(key, fallback) || fallback;

        function hideToolbar({ clear = true } = {}) {
            if (toolbar) toolbar.style.display = 'none';
            if (clear) pending = null;
        }

        function actionButton(icon, key, fallback, handler, primary = false) {
            const button = document.createElement('button');
            button.type = 'button';
            if (primary) button.className = 'weft-primary';
            button.title = text(`${key}_hint`, fallback);
            const iconElement = document.createElement('span');
            iconElement.className = 'weft-ico';
            iconElement.textContent = icon;
            button.append(iconElement, document.createTextNode(text(key, fallback)));
            button.addEventListener('mousedown', (event) => event.preventDefault());
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const selection = pending;
                hideToolbar({ clear: false });
                if (selection) handler(selection, button);
            });
            return button;
        }

        function ensureToolbar() {
            if (toolbar) return toolbar;
            toolbar = document.createElement('div');
            toolbar.id = 'weft-toolbar';
            toolbar.setAttribute('role', 'toolbar');
            toolbar.setAttribute('aria-label', text('pdf_viewer_selection_actions', 'Selection actions'));
            toolbar.appendChild(actionButton('+', 'tb_save', 'Save', saveSelection, true));
            const separator = document.createElement('span');
            separator.className = 'weft-sep';
            toolbar.appendChild(separator);
            for (const action of ACTIONS) {
                toolbar.appendChild(actionButton(
                    action.icon,
                    action.labelKey,
                    action.fallback,
                    (selection) => runQuickAction(action, selection)
                ));
            }
            toolbar.appendChild(actionButton('✎', 'tb_ask', 'Ask', askSelection));
            document.body.appendChild(toolbar);
            return toolbar;
        }

        function showToolbar(selection) {
            pending = selection;
            const element = ensureToolbar();
            element.style.display = 'block';
            requestAnimationFrame(() => {
                if (pending !== selection || disposed) return;
                const bounds = element.getBoundingClientRect();
                const anchor = selection.rect;
                let left = anchor.left + anchor.width / 2 - bounds.width / 2;
                let top = anchor.top - bounds.height - 12;
                left = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, left));
                if (top < 8) top = Math.min(window.innerHeight - bounds.height - 8, anchor.bottom + 12);
                element.style.left = `${left}px`;
                element.style.top = `${Math.max(8, top)}px`;
            });
        }

        function refreshSelection() {
            if (disposed) return;
            const selection = capture();
            if (!selection || String(selection.text || '').length < 5) {
                hideToolbar();
                return;
            }
            showToolbar(selection);
        }

        async function saveSelection(selection, button) {
            if (button.disabled || typeof options.save !== 'function') return;
            button.disabled = true;
            try {
                await options.save(selection);
                window.getSelection()?.removeAllRanges();
                pending = null;
            } catch (error) {
                options.onError?.(error, 'save');
            } finally {
                button.disabled = false;
            }
        }

        async function askSelection(selection) {
            try {
                await options.ask?.(selection);
            } catch (error) {
                options.onError?.(error, 'ask');
            }
        }

        function cancelRunDeltaFrame(run) {
            if (!run || run.renderFrame == null) return;
            window.cancelAnimationFrame(run.renderFrame);
            run.renderFrame = null;
        }

        function flushRunDelta(run, ui) {
            cancelRunDeltaFrame(run);
            const delta = run?.pendingDelta || '';
            if (!delta || run.cancelled) return;
            run.pendingDelta = '';
            const shouldFollow = ui.body.scrollHeight - ui.body.scrollTop - ui.body.clientHeight <= 48;
            if (!run.answerNode) {
                ui.body.textContent = '';
                run.answerNode = document.createTextNode('');
                ui.body.appendChild(run.answerNode);
            }
            run.answerNode.appendData(delta);
            if (shouldFollow) ui.body.scrollTop = ui.body.scrollHeight;
        }

        function scheduleRunDelta(run, ui) {
            if (run.renderFrame != null) return;
            run.renderFrame = window.requestAnimationFrame(() => {
                run.renderFrame = null;
                flushRunDelta(run, ui);
            });
        }

        function closeCard() {
            if (activeRun) {
                cancelRunDeltaFrame(activeRun);
                activeRun.cancelled = true;
                clearInterval(activeRun.ticker);
                try { activeRun.port?.disconnect?.(); } catch {}
                activeRun = null;
            }
            card?.remove();
            card = null;
        }

        function clampCard(element, left, top) {
            const rect = element.getBoundingClientRect();
            const width = element.offsetWidth || rect.width;
            const height = element.offsetHeight || rect.height;
            element.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, left))}px`;
            element.style.top = `${Math.max(12, Math.min(window.innerHeight - height - 12, top))}px`;
        }

        function enableDrag(element, handle) {
            let drag = null;
            handle.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || event.target.closest('button')) return;
                const rect = element.getBoundingClientRect();
                drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
                element.classList.add('weft-card-dragging');
                try { handle.setPointerCapture(event.pointerId); } catch {}
                event.preventDefault();
            });
            handle.addEventListener('pointermove', (event) => {
                if (!drag || drag.id !== event.pointerId) return;
                clampCard(element, event.clientX - drag.dx, event.clientY - drag.dy);
            });
            const finish = (event) => {
                if (!drag || drag.id !== event.pointerId) return;
                try { handle.releasePointerCapture(event.pointerId); } catch {}
                drag = null;
                element.classList.remove('weft-card-dragging');
            };
            handle.addEventListener('pointerup', finish);
            handle.addEventListener('pointercancel', finish);
        }

        function createCard(title, selection) {
            closeCard();
            card = document.createElement('section');
            card.id = 'weft-card';
            const head = document.createElement('header');
            head.className = 'weft-card-head';
            const brand = document.createElement('span');
            brand.className = 'weft-brand';
            brand.textContent = 'W';
            const heading = document.createElement('strong');
            heading.className = 'weft-card-title';
            heading.textContent = title;
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'weft-card-x';
            close.setAttribute('aria-label', text('card_close', 'Close'));
            close.textContent = '×';
            close.addEventListener('click', closeCard);
            head.append(brand, heading, close);
            const progress = document.createElement('div');
            progress.className = 'weft-progress';
            progress.appendChild(document.createElement('i'));
            const body = document.createElement('div');
            body.className = 'weft-card-body';
            body.textContent = text('card_thinking', 'Thinking…');
            const foot = document.createElement('footer');
            foot.className = 'weft-card-foot';
            const stats = document.createElement('span');
            stats.className = 'weft-stats';
            stats.textContent = text('card_elapsed', '%s s').replace('%s', '0.0');
            foot.appendChild(stats);
            card.append(head, progress, body, foot);
            document.body.appendChild(card);
            const initial = card.getBoundingClientRect();
            const below = selection.rect.bottom + 10;
            const top = below + initial.height <= window.innerHeight - 12
                ? below
                : selection.rect.top - initial.height - 10;
            clampCard(card, selection.rect.left, top);
            enableDrag(card, head);
            return { body, foot, progress, stats };
        }

        function addCardActions(foot, answer, selection) {
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'weft-act';
            copy.textContent = text('card_copy', 'Copy');
            copy.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(answer);
                    copy.textContent = text('card_copied', 'Copied');
                } catch {
                    copy.textContent = text('card_failed', 'Failed');
                }
            });
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'weft-act';
            save.textContent = text('card_save', 'Save');
            save.title = text('card_save_hint', 'Save the passage and this result to your session');
            save.addEventListener('click', async () => {
                if (save.disabled || typeof options.saveAnalysis !== 'function') return;
                save.disabled = true;
                try {
                    await options.saveAnalysis(selection, answer);
                    save.textContent = text('card_saved', 'Saved');
                } catch (error) {
                    save.textContent = text('card_failed', 'Failed');
                    options.onError?.(error, 'save-analysis');
                } finally {
                    save.disabled = false;
                }
            });
            foot.append(copy, save);
        }

        function errorText(kind) {
            const key = ({
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
            })[kind] || 'llm_error_unknown';
            return text(key, 'Something went wrong while generating the answer.');
        }

        function runQuickAction(action, selection) {
            const ui = createCard(text(action.labelKey, action.fallback), selection);
            const run = {
                port: null,
                ticker: null,
                cancelled: false,
                started: Date.now(),
                chunks: [],
                pendingDelta: '',
                renderFrame: null,
                answerNode: null,
            };
            activeRun = run;
            run.ticker = setInterval(() => {
                if (activeRun !== run) return;
                ui.stats.textContent = text('card_elapsed', '%s s')
                    .replace('%s', ((Date.now() - run.started) / 1000).toFixed(1));
            }, 500);
            try {
                run.port = chrome.runtime.connect({ name: 'weft-quick' });
            } catch (error) {
                clearInterval(run.ticker);
                ui.progress.remove();
                ui.body.textContent = text('card_reload', 'Weft was reloaded — reopen the reader and try again.');
                activeRun = null;
                options.onError?.(error, 'quick-connect');
                return;
            }
            run.port.onMessage.addListener((response) => {
                if (activeRun !== run || run.cancelled) return;
                if (response?.type === 'reasoning' && run.chunks.length === 0) {
                    ui.body.textContent = text('card_reasoning', 'Reasoning…');
                    return;
                }
                if (response?.type === 'delta') {
                    const delta = typeof response.delta === 'string' ? response.delta : '';
                    if (!delta) return;
                    run.chunks.push(delta);
                    run.pendingDelta += delta;
                    scheduleRunDelta(run, ui);
                    return;
                }
                clearInterval(run.ticker);
                ui.progress.remove();
                if (response?.type === 'done') {
                    flushRunDelta(run, ui);
                    const answer = run.chunks.join('') || String(response.text || '');
                    if (run.chunks.length === 0) ui.body.textContent = answer;
                    const seconds = Number(response.elapsed || Date.now() - run.started) / 1000;
                    const tokens = Number(response.promptTokens || 0) + Number(response.completionTokens || 0);
                    ui.stats.textContent = text('card_stats', '%s s · %t tokens')
                        .replace('%s', seconds.toFixed(1))
                        .replace('%t', `${response.estimated ? '~' : ''}${tokens}`);
                    if (answer.trim()) addCardActions(ui.foot, answer, selection);
                } else if (response?.type === 'error') {
                    cancelRunDeltaFrame(run);
                    run.pendingDelta = '';
                    ui.body.textContent = errorText(response.kind);
                    ui.body.classList.add('weft-err');
                    ui.stats.textContent = '';
                }
                activeRun = null;
                try { run.port.disconnect(); } catch {}
            });
            run.port.onDisconnect.addListener(() => {
                if (activeRun !== run || run.cancelled) return;
                clearInterval(run.ticker);
                ui.progress.remove();
                if (run.chunks.length === 0) {
                    cancelRunDeltaFrame(run);
                    ui.body.textContent = text('card_disconnected', 'The connection ended before an answer arrived.');
                } else {
                    flushRunDelta(run, ui);
                    const incomplete = document.createElement('div');
                    incomplete.className = 'weft-incomplete';
                    incomplete.textContent = text(
                        'card_disconnected_partial',
                        'The connection ended early. This response is incomplete; try again.'
                    );
                    ui.body.appendChild(incomplete);
                }
                ui.stats.textContent = '';
                activeRun = null;
            });
            try {
                run.port.postMessage({
                    type: 'run',
                    action: action.id,
                    text: selection.text,
                    url: selection.sourceUrl,
                    title: selection.sourceTitle,
                });
            } catch (error) {
                clearInterval(run.ticker);
                cancelRunDeltaFrame(run);
                run.pendingDelta = '';
                ui.progress.remove();
                ui.body.textContent = text('card_reload', 'Weft was reloaded — reopen the reader and try again.');
                activeRun = null;
                try { run.port.disconnect(); } catch {}
                options.onError?.(error, 'quick-start');
            }
        }

        function onMouseUp() {
            setTimeout(refreshSelection, 0);
        }

        function onSelectionChange() {
            window.cancelAnimationFrame(selectionFrame);
            selectionFrame = requestAnimationFrame(() => {
                if (window.getSelection()?.isCollapsed) hideToolbar();
                else refreshSelection();
            });
        }

        function onDocumentMouseDown(event) {
            if (toolbar && !toolbar.contains(event.target)) hideToolbar();
            if (card && !card.contains(event.target) && !toolbar?.contains(event.target)) closeCard();
        }

        function onKeyDown(event) {
            if (event.key !== 'Escape') return;
            hideToolbar();
            closeCard();
        }

        function onScroll() {
            hideToolbar();
        }

        root.addEventListener('mouseup', onMouseUp);
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('mousedown', onDocumentMouseDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        scrollRoot?.addEventListener('scroll', onScroll, { passive: true });

        return Object.freeze({
            refreshSelection,
            dispose() {
                if (disposed) return;
                disposed = true;
                window.cancelAnimationFrame(selectionFrame);
                root.removeEventListener('mouseup', onMouseUp);
                document.removeEventListener('selectionchange', onSelectionChange);
                document.removeEventListener('mousedown', onDocumentMouseDown, true);
                document.removeEventListener('keydown', onKeyDown, true);
                scrollRoot?.removeEventListener('scroll', onScroll);
                hideToolbar();
                closeCard();
                toolbar?.remove();
                toolbar = null;
            },
        });
    }

    return Object.freeze({ create });
})();
