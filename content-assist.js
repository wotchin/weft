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
