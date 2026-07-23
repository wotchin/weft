/**
 * Side Panel — passive knowledge building + quick access.
 *
 * Features:
 * - Auto-extract current page metadata (title, description, key terms)
 * - One-click save page summary to session
 * - AI-powered summary generation
 * - Auto-capture mode (save summaries as you browse)
 * - Related pages discovery (cross-page connections within session)
 * - Compact session snippet list
 */
(async () => {
    // DOM refs
    const sessionSelect = document.getElementById('sessionSelect');
    const snippetCount = document.getElementById('snippetCount');
    const pageCard = document.getElementById('pageCard');
    const keyTermsSection = document.getElementById('keyTermsSection');
    const keyTerms = document.getElementById('keyTerms');
    const snippetList = document.getElementById('snippetList');
    const relatedSection = document.getElementById('relatedSection');
    const relatedList = document.getElementById('relatedList');
    const autoCaptureToggle = document.getElementById('autoCapture');
    const saveSummaryBtn = document.getElementById('saveSummary');
    const aiSummaryBtn = document.getElementById('aiSummary');
    const refreshPageBtn = document.getElementById('refreshPage');

    let currentSession = null;
    let sessions = {};
    let currentPageInfo = null;
    let lastExtractedTabId = null;

    // ---- Init ----
    const stored = await chrome.storage.local.get(['sessions', 'currentSession', 'autoCapture']);
    sessions = stored.sessions || {};
    currentSession = stored.currentSession || Object.keys(sessions)[0] || 'default';
    autoCaptureToggle.checked = !!stored.autoCapture;

    if (Object.keys(sessions).length === 0) {
        sessions['default'] = [];
        await chrome.storage.local.set({ sessions });
    }

    populateSessionSelect();
    renderSnippets();
    extractCurrentPage();

    // ---- Session selector ----
    function populateSessionSelect() {
        sessionSelect.innerHTML = '';
        for (const name of Object.keys(sessions)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === currentSession) opt.selected = true;
            sessionSelect.appendChild(opt);
        }
    }

    sessionSelect.addEventListener('change', () => {
        currentSession = sessionSelect.value;
        chrome.storage.local.set({ currentSession });
        renderSnippets();
        findRelatedPages();
    });

    // ---- Page extraction (local, no LLM) ----
    async function extractCurrentPage() {
        pageCard.innerHTML = '<div class="sp-page-loading">Analyzing page...</div>';

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.id || tab.url?.startsWith('chrome://')) {
                pageCard.innerHTML = '<div class="sp-page-loading">Cannot analyze this page</div>';
                return;
            }

            lastExtractedTabId = tab.id;

            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const title = document.title || '';
                    const desc = document.querySelector('meta[name="description"]')?.content ||
                                 document.querySelector('meta[property="og:description"]')?.content || '';
                    const url = location.href;

                    // Extract first meaningful paragraph
                    const mainSelectors = ['article', 'main', '[role="main"]', '.content', '.post-content', '#content'];
                    let mainEl = null;
                    for (const sel of mainSelectors) {
                        mainEl = document.querySelector(sel);
                        if (mainEl) break;
                    }
                    if (!mainEl) mainEl = document.body;

                    const paragraphs = mainEl.querySelectorAll('p');
                    let excerpt = '';
                    for (const p of paragraphs) {
                        const text = p.textContent.trim();
                        if (text.length > 50) { excerpt = text; break; }
                    }

                    // Word count
                    const bodyText = mainEl.innerText || '';
                    const wordCount = bodyText.split(/\s+/).filter(w => w.length > 0).length;

                    // Extract headings as structure
                    const headings = [];
                    mainEl.querySelectorAll('h1, h2, h3').forEach(h => {
                        const t = h.textContent.trim();
                        if (t.length > 2 && t.length < 200) headings.push(t);
                    });

                    return { title, desc, url, excerpt, wordCount, headings: headings.slice(0, 10), bodyText: bodyText.substring(0, 3000) };
                },
            });

            const page = results?.[0]?.result;
            if (!page) {
                pageCard.innerHTML = '<div class="sp-page-loading">Could not extract page</div>';
                return;
            }

            currentPageInfo = page;

            // Extract key terms locally
            const terms = GraphBuilder.extractKeywords(page.bodyText, 12);

            // Render page card
            let html = `<div class="sp-page-title">${esc(page.title)}</div>`;
            html += `<div class="sp-page-url">${esc(page.url)}</div>`;
            if (page.desc || page.excerpt) {
                html += `<div class="sp-page-desc">${esc(page.desc || page.excerpt)}</div>`;
            }
            html += `<div class="sp-page-meta">`;
            html += `<span>${page.wordCount.toLocaleString()} words</span>`;
            if (page.headings.length > 0) html += `<span>${page.headings.length} sections</span>`;
            html += `</div>`;

            pageCard.innerHTML = html;

            // Show key terms
            if (terms.length > 0) {
                keyTermsSection.style.display = '';
                keyTerms.innerHTML = terms.map(t => `<span class="sp-term">${esc(t)}</span>`).join('');
            }

            // Find related pages in session
            findRelatedPages();

            // Auto-capture if enabled
            if (autoCaptureToggle.checked) {
                autoCapturePage(page);
            }

        } catch (e) {
            console.warn('Page extraction failed:', e);
            pageCard.innerHTML = '<div class="sp-page-loading">Cannot analyze this page</div>';
        }
    }

    // ---- Auto capture ----
    async function autoCapturePage(page) {
        if (!page || !page.title || !currentSession) return;

        const snippets = sessions[currentSession] || [];
        // Don't save duplicate URLs
        const normalizedUrl = normalizeUrl(page.url);
        const alreadySaved = snippets.some(s => normalizeUrl(s.sourceUrl) === normalizedUrl);
        if (alreadySaved) return;

        // Create a compact auto-summary snippet
        let summaryText = page.title;
        if (page.desc) summaryText += '\n' + page.desc;
        else if (page.excerpt) summaryText += '\n' + page.excerpt.substring(0, 300);
        if (page.headings.length > 0) {
            summaryText += '\n\nKey sections: ' + page.headings.slice(0, 5).join(', ');
        }

        const snippet = {
            id: generateId(),
            type: 'text',
            content: summaryText,
            sourceUrl: page.url,
            sourceTitle: page.title,
            timestamp: Date.now(),
            tags: ['auto-summary'],
            autoCapture: true,
        };

        if (!sessions[currentSession]) sessions[currentSession] = [];
        sessions[currentSession].push(snippet);
        await chrome.storage.local.set({ sessions });

        renderSnippets();
        showToast('Auto-captured: ' + page.title.substring(0, 40));
    }

    autoCaptureToggle.addEventListener('change', () => {
        chrome.storage.local.set({ autoCapture: autoCaptureToggle.checked });
    });

    // ---- Save summary to session ----
    saveSummaryBtn.addEventListener('click', async () => {
        if (!currentPageInfo) return;
        saveSummaryBtn.disabled = true;

        const page = currentPageInfo;
        let summaryText = page.title;
        if (page.desc) summaryText += '\n' + page.desc;
        else if (page.excerpt) summaryText += '\n' + page.excerpt.substring(0, 500);
        if (page.headings.length > 0) {
            summaryText += '\n\nSections:\n' + page.headings.map((h, i) => `${i + 1}. ${h}`).join('\n');
        }

        const snippet = {
            id: generateId(),
            type: 'text',
            content: summaryText,
            sourceUrl: page.url,
            sourceTitle: page.title,
            timestamp: Date.now(),
            tags: ['page-summary'],
        };

        if (!sessions[currentSession]) sessions[currentSession] = [];
        sessions[currentSession].push(snippet);
        await chrome.storage.local.set({ sessions });

        renderSnippets();
        saveSummaryBtn.textContent = 'Saved!';
        setTimeout(() => { saveSummaryBtn.textContent = 'Save to Session'; saveSummaryBtn.disabled = false; }, 1500);
    });

    // ---- AI Summary ----
    aiSummaryBtn.addEventListener('click', async () => {
        if (!currentPageInfo) return;
        aiSummaryBtn.disabled = true;
        aiSummaryBtn.textContent = 'Generating...';

        try {
            const { apiKey, apiBaseUrl = 'https://api.openai.com', modelName = 'gpt-4o-mini' } =
                await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'modelName']);

            if (!apiKey) {
                showToast('API key required. Set it in Settings.');
                return;
            }

            const page = currentPageInfo;
            const cjk = (page.bodyText.match(/[\u4e00-\u9fff]/g) || []).length;
            const lang = cjk / page.bodyText.length > 0.15 ? '中文' : 'English';

            const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: modelName,
                    messages: [{
                        role: 'user',
                        content: `Summarize this webpage in ${lang}. Be concise (3-5 sentences). Include: main topic, key arguments, notable data.\n\nTitle: ${page.title}\nURL: ${page.url}\n\n${page.bodyText.substring(0, 5000)}`
                    }],
                    max_tokens: 500,
                    temperature: 0.3,
                }),
            });

            const data = await response.json();
            const summary = data.choices?.[0]?.message?.content || 'Could not generate summary.';

            // Show summary in page card
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'sp-page-summary';
            summaryDiv.innerHTML = `<div class="sp-page-summary-label">AI Summary</div>${esc(summary)}`;
            pageCard.appendChild(summaryDiv);

            // Store for potential saving
            currentPageInfo.aiSummary = summary;

        } catch (e) {
            showToast('Summary failed: ' + e.message);
        } finally {
            aiSummaryBtn.disabled = false;
            aiSummaryBtn.textContent = 'AI Summary';
        }
    });

    // ---- Refresh ----
    refreshPageBtn.addEventListener('click', () => extractCurrentPage());

    // ---- Render snippets ----
    function renderSnippets() {
        const snippets = sessions[currentSession] || [];
        snippetCount.textContent = snippets.length;

        if (snippets.length === 0) {
            snippetList.innerHTML = '<div class="sp-empty">No snippets yet</div>';
            return;
        }

        snippetList.innerHTML = '';
        // Show last 20, newest first
        const recent = snippets.slice(-20).reverse();
        for (const s of recent) {
            const div = document.createElement('div');
            div.className = 'sp-snippet-item';
            let html = '';
            if (s.tags && s.tags.length > 0) {
                html += '<span class="sp-snippet-tags">';
                s.tags.forEach(t => { html += `<span class="sp-snippet-tag">${esc(t)}</span>`; });
                html += '</span> ';
            }
            html += esc((s.content || '').substring(0, 120));
            div.innerHTML = html;
            snippetList.appendChild(div);
        }
    }

    // ---- Related pages ----
    function findRelatedPages() {
        const snippets = sessions[currentSession] || [];
        if (!currentPageInfo || snippets.length < 2) {
            relatedSection.style.display = 'none';
            return;
        }

        const currentUrl = normalizeUrl(currentPageInfo.url);
        const pageTerms = new Set(GraphBuilder.extractKeywords(currentPageInfo.bodyText || '', 15));

        // Group snippets by source page
        const pageGroups = new Map();
        for (const s of snippets) {
            if (!s.sourceUrl) continue;
            const key = normalizeUrl(s.sourceUrl);
            if (key === currentUrl) continue; // skip current page
            if (!pageGroups.has(key)) pageGroups.set(key, { title: s.sourceTitle, url: s.sourceUrl, snippets: [] });
            pageGroups.get(key).snippets.push(s);
        }

        // Find shared terms
        const related = [];
        for (const [, group] of pageGroups) {
            const groupText = group.snippets.map(s => s.content || '').join(' ');
            const groupTerms = GraphBuilder.extractKeywords(groupText, 10);
            const shared = groupTerms.filter(t => pageTerms.has(t));
            if (shared.length > 0) {
                related.push({ ...group, sharedTerms: shared, score: shared.length });
            }
        }

        related.sort((a, b) => b.score - a.score);

        if (related.length === 0) {
            relatedSection.style.display = 'none';
            return;
        }

        relatedSection.style.display = '';
        relatedList.innerHTML = related.slice(0, 5).map(r => `
            <div class="sp-related-item">
                <span class="sp-related-dot"></span>
                <span class="sp-related-title" data-url="${esc(r.url)}">${esc(r.title || r.url)}</span>
                <span class="sp-related-kws">${r.sharedTerms.slice(0, 3).join(', ')}</span>
            </div>
        `).join('');

        relatedList.querySelectorAll('.sp-related-title').forEach(el => {
            el.addEventListener('click', () => {
                const url = el.dataset.url;
                if (url) chrome.tabs.create({ url });
            });
        });
    }

    // ---- Navigation buttons ----
    document.getElementById('openPopup').addEventListener('click', () => {
        chrome.action.openPopup();
    });

    document.getElementById('openChat').addEventListener('click', () => {
        chrome.storage.local.set({ currentSession }, () => {
            chrome.windows.create({ url: chrome.runtime.getURL('chat.html'), type: 'popup', width: 900, height: 700 });
        });
    });

    document.getElementById('openGraph').addEventListener('click', () => {
        chrome.storage.local.set({ currentSession }, () => {
            chrome.windows.create({ url: chrome.runtime.getURL('graph.html'), type: 'popup', width: 1100, height: 750 });
        });
    });

    // ---- Listen for tab changes to refresh ----
    chrome.tabs.onActivated.addListener(() => {
        setTimeout(extractCurrentPage, 300);
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.status === 'complete' && tabId === lastExtractedTabId) {
            setTimeout(extractCurrentPage, 500);
        }
    });

    // ---- Listen for storage changes ----
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.sessions) {
            sessions = changes.sessions.newValue || {};
            renderSnippets();
        }
    });

    // ---- Helpers ----
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    function normalizeUrl(url) {
        try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function showToast(msg) {
        let toast = document.querySelector('.sp-auto-saved');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'sp-auto-saved';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
    }
})();
