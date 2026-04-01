/**
 * Content Assist — injected into all pages.
 * Provides:
 * 1. Floating "Ask AI" toolbar on text selection
 * 2. Comment input popup when triggered from context menu
 */
(() => {
    // ---- Configuration ----
    const QUICK_QUESTIONS = [
        { id: 'reliability', icon: '\u2714', label: 'Verify', question: 'Please evaluate the reliability and credibility of this information. Identify the likely source, check for potential biases, assess factual accuracy, and rate the trustworthiness. Search the web if needed to verify claims.' },
        { id: 'similar',     icon: '\u2261', label: 'Similar', question: 'What are similar viewpoints, arguments, or perspectives to the one expressed in this text? Search for related opinions and supporting evidence from other sources.' },
        { id: 'opposing',    icon: '\u2194', label: 'Opposing', question: 'What are the main counterarguments or opposing viewpoints to this claim? Search for credible sources that disagree with or challenge this perspective.' },
        { id: 'explain',     icon: '?',      label: 'Explain', question: 'Please explain this content in simple, easy-to-understand terms. Break down any jargon or complex concepts.' },
    ];

    let toolbar = null;
    let commentModal = null;
    let customQuestions = [];

    // Load custom questions from storage
    chrome.storage.local.get(['customAskQuestions'], (data) => {
        customQuestions = data.customAskQuestions || [];
    });

    // Listen for storage changes to update custom questions
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.customAskQuestions) {
            customQuestions = changes.customAskQuestions.newValue || [];
        }
    });

    // ---- Floating Ask AI Toolbar ----
    function createToolbar() {
        if (toolbar) return toolbar;

        toolbar = document.createElement('div');
        toolbar.id = 'cyber-ask-toolbar';
        toolbar.style.cssText = `
            position:fixed; z-index:2147483647; display:none;
            background:#fff; border:1px solid #e0e0e0; border-radius:10px;
            box-shadow:0 4px 20px rgba(0,0,0,0.12); padding:5px 6px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            font-size:12px; line-height:1; white-space:nowrap;
            transition:opacity 0.15s;
        `;

        // Logo/brand
        const brand = document.createElement('span');
        brand.textContent = 'AI';
        brand.style.cssText = `
            display:inline-flex; align-items:center; justify-content:center;
            width:22px; height:22px; border-radius:5px;
            background:linear-gradient(135deg,#2196f3,#1565c0); color:#fff;
            font-size:10px; font-weight:700; margin-right:4px; vertical-align:middle;
        `;
        toolbar.appendChild(brand);

        // Quick question buttons
        QUICK_QUESTIONS.forEach(q => {
            toolbar.appendChild(createToolbarBtn(q.icon, q.label, q.id, () => {
                askAI(q.question, q.id);
            }));
        });

        // "Ask..." button for free-form
        const askBtn = createToolbarBtn('\u270E', 'Ask...', 'freeform', () => {
            askAI('', 'freeform');
        });
        toolbar.appendChild(askBtn);

        // Separator + custom questions
        if (customQuestions.length > 0) {
            const sep = document.createElement('span');
            sep.style.cssText = 'display:inline-block;width:1px;height:16px;background:#e0e0e0;margin:0 3px;vertical-align:middle;';
            toolbar.appendChild(sep);

            customQuestions.forEach((cq, i) => {
                toolbar.appendChild(createToolbarBtn('\u2605', cq.label || `Q${i+1}`, `custom-${i}`, () => {
                    askAI(cq.question, `custom-${i}`);
                }));
            });
        }

        document.body.appendChild(toolbar);
        return toolbar;
    }

    function createToolbarBtn(icon, label, id, onClick) {
        const btn = document.createElement('button');
        btn.dataset.cyberAction = id;
        btn.title = label;
        btn.style.cssText = `
            display:inline-flex; align-items:center; gap:3px;
            padding:4px 8px; border:1px solid #eee; border-radius:6px;
            background:#fafafa; cursor:pointer; font-size:11px; color:#555;
            margin:0 2px; vertical-align:middle;
            transition:all 0.12s; font-family:inherit; line-height:1;
        `;
        btn.innerHTML = `<span style="font-size:12px;">${icon}</span> ${label}`;
        btn.addEventListener('mouseenter', () => {
            btn.style.background = '#e3f2fd';
            btn.style.borderColor = '#2196f3';
            btn.style.color = '#1565c0';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = '#fafafa';
            btn.style.borderColor = '#eee';
            btn.style.color = '#555';
        });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            onClick();
            hideToolbar();
        });
        return btn;
    }

    function showToolbar(x, y) {
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

    /**
     * Send selected text + question to the chat window via background.
     */
    function askAI(question, questionType) {
        const sel = window.getSelection();
        const selectedText = sel ? sel.toString().trim() : '';
        if (!selectedText) return;

        chrome.storage.local.set({
            askAIContext: {
                selectedText,
                question,
                questionType,
                sourceUrl: location.href,
                sourceTitle: document.title,
                timestamp: Date.now(),
            }
        }, () => {
            chrome.runtime.sendMessage({ type: 'openChatAskAI' });
        });
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
            textarea.placeholder = 'Add your comment (optional)...';
            textarea.addEventListener('focus', () => textarea.style.borderColor = '#2196f3');
            textarea.addEventListener('blur', () => textarea.style.borderColor = '#ddd');

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;font-size:13px;cursor:pointer;color:#666;';
            cancelBtn.addEventListener('click', () => {
                commentModal.remove();
                commentModal = null;
                resolve({ comment: undefined }); // undefined = cancelled
            });

            const saveBtn = document.createElement('button');
            saveBtn.textContent = 'Save';
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

    // ---- Message Listener ----
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
