document.addEventListener('DOMContentLoaded', async function() {
    // Resolve the interface language before any string is read or rendered.
    await I18N.init();
    I18N.apply();

    // Entry mode: 'panel' (side panel), 'askAI' (popup window), or full page.
    const chatMode = new URLSearchParams(location.search).get('mode') || 'full';
    if (chatMode === 'panel') {
        document.body.classList.add('mode-panel');
        // Offer an "expand to full window" affordance from the narrow panel.
        const expandBtn = document.getElementById('expandBtn');
        if (expandBtn) {
            expandBtn.style.display = '';
            expandBtn.addEventListener('click', () => {
                chrome.windows.create({
                    url: chrome.runtime.getURL('chat.html'),
                    type: 'popup', width: 960, height: 760,
                });
            });
        }
    }

    const chatMessages = document.getElementById('chatMessages');
    // Citation chips ([S1] → clickable) jump back to the source page.
    if (typeof Citations !== 'undefined') Citations.bindClicks(chatMessages);
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendMessage');
    const clearButton = document.getElementById('clearChat');
    const exportBtn = document.getElementById('exportBtn');
    const contextPanel = document.getElementById('contextPanel');
    const contextBody = document.getElementById('contextBody');
    const toggleContext = document.getElementById('toggleContext');
    const sessionSelect = document.getElementById('sessionSelect');
    const snippetSearch = document.getElementById('snippetSearch');
    const snippetCount = document.getElementById('snippetCount');

    const askPageBtn = document.getElementById('askPageBtn');
    const takeawaysBtn = document.getElementById('takeawaysBtn');
    const deepSearchBtn = document.getElementById('deepSearchBtn');
    // Deep Search uses a pluggable, BYOK search provider (Tavily/Brave/SearXNG).
    // Only show it once the user has configured one in Settings.
    if (deepSearchBtn) {
        deepSearchBtn.style.display = 'none';
        SearchProvider.isEnabled().then((on) => {
            if (on) deepSearchBtn.style.display = '';
        }).catch(() => {});
    }
    const drawDiagramBtn = document.getElementById('drawDiagramBtn');
    const diagramSelector = document.getElementById('diagramSelector');
    const diagramTypeGrid = document.getElementById('diagramTypeGrid');
    const diagramQuery = document.getElementById('diagramQuery');
    const diagramSource = document.getElementById('diagramSource');
    const cancelDiagramBtn = document.getElementById('cancelDiagram');
    const generateDiagramBtn = document.getElementById('generateDiagramBtn');
    const searchPlanPanel = document.getElementById('searchPlanPanel');
    const searchPlanBody = document.getElementById('searchPlanBody');
    const confirmPlanBtn = document.getElementById('confirmPlan');
    const cancelPlanBtn = document.getElementById('cancelPlan');
    const searchProgress = document.getElementById('searchProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    let currentSession = null;
    let sessionSnippets = [];
    let conversationHistory = [];
    let isStreaming = false;
    // Citation index map for the current turn (S1→snippet). Null when RAG filters
    // the context (marker numbering would not align with the full snippet list).
    let activeIndexMap = null;
    let pageContent = null; // cached page extraction result
    let pendingSearchPlan = null; // LLM-generated search plan awaiting confirmation

    // Prompt templates
    const promptTemplates = {
        // Core scenario: Report
        report: "Based on the collected snippets, write an integrated analysis report in markdown. Structure it as: Summary, Key Findings, Points of Disagreement (if any), and Conclusion. Cite every factual claim with its source marker, e.g. [S1].",
        // Core scenario: Verify (cross-check across sources)
        verify: "Cross-check the claims in the collected snippets against each other. Produce: (1) a consistency assessment noting where sources agree or conflict, (2) a confidence rating for each key claim, and (3) an explicit list of claims that cannot be verified from the provided sources. Cite sources with markers like [S1]. Do not fabricate agreement.",
        // Core scenario: Rewrite (style is prepended by the Rewrite control)
        rewrite: "Rewrite and integrate the collected snippets into a single coherent piece. Preserve the key facts and keep source markers like [S1] where a claim comes from a specific snippet.",
        summarize: "Please summarize the collected snippets into a concise, well-structured overview. Highlight the key themes and main takeaways. Cite sources with markers like [S1].",
        compare: "Compare and contrast the different perspectives, data points, or viewpoints found in the collected snippets. Present the comparison as a markdown table where applicable, citing sources with markers like [S1].",
        extract: "Extract and list the key points, important facts, and critical data from the collected snippets. Organize them by topic or category, citing sources with markers like [S1].",
        table: "Organize the collected snippets into a well-structured markdown table. Identify appropriate column headers based on the data patterns. Cite sources with markers like [S1].",
        translate_zh: "Please translate the collected snippets into Chinese. Maintain the original structure and meaning.",
        translate_en: "Please translate the collected snippets into English. Maintain the original structure and meaning.",
    };

    // Rewrite style presets, prepended to the rewrite template when chosen.
    const rewriteStyles = {
        formal: "Use a formal, professional tone. ",
        casual: "Use a casual, conversational tone. ",
        news: "Write in a neutral news-report style with an inverted-pyramid structure. ",
        academic: "Write in an academic tone with precise, measured language. ",
        thread: "Format as a concise social-media thread of short numbered posts. ",
    };
    void rewriteStyles;

    // ---- Session management (the workbench owns this; the popup is just a launcher) ----

    /** Populate the session dropdown and load the active session's snippets. */
    async function loadSessions(preferred) {
        const sessions = await Store.getSessions();
        const names = Object.keys(sessions);
        const saved = preferred || (await Store.getCurrentSession());

        currentSession = names.includes(saved) ? saved : names[0] || null;

        sessionSelect.innerHTML = '';
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} (${sessions[name].length})`;
            sessionSelect.appendChild(opt);
        }
        if (currentSession) {
            sessionSelect.value = currentSession;
            await Store.setCurrentSession(currentSession);
            sessionSnippets = sessions[currentSession] || [];
        } else {
            sessionSnippets = [];
        }
        renderContextPanel();
        reCacheMissingImages();
    }

    await loadSessions();

    sessionSelect.addEventListener('change', async () => {
        // Switching sessions invalidates the current conversation context.
        conversationHistory = [];
        activeIndexMap = null;
        await loadSessions(sessionSelect.value);
    });

    if (snippetSearch) snippetSearch.addEventListener('input', renderContextPanel);

    document.getElementById('newSessionBtn').addEventListener('click', async () => {
        const name = await promptText(t('wb_new_session'), '');
        if (!name) return;
        const sessions = await Store.getSessions();
        if (sessions[name]) { Citations.notify(t('wb_session_exists')); return; }
        sessions[name] = [];
        await Store.setSessions(sessions);
        await loadSessions(name);
    });

    document.getElementById('renameSessionBtn').addEventListener('click', async () => {
        if (!currentSession) return;
        const name = await promptText(t('wb_rename_session'), currentSession);
        if (!name || name === currentSession) return;
        const sessions = await Store.getSessions();
        if (sessions[name]) { Citations.notify(t('wb_session_exists')); return; }
        sessions[name] = sessions[currentSession];
        delete sessions[currentSession];
        await Store.setSessions(sessions);
        await loadSessions(name);
    });

    document.getElementById('deleteSessionBtn').addEventListener('click', async () => {
        if (!currentSession) return;
        const confirmed = await promptText(
            t('wb_delete_confirm').replace('%s', currentSession), '', { confirmWord: 'DELETE' }
        );
        if (confirmed === null) return;
        const sessions = await Store.getSessions();
        delete sessions[currentSession];
        await Store.setSessions(sessions);
        conversationHistory = [];
        await loadSessions();
    });

    document.getElementById('showOnPageBtn').addEventListener('click', () => {
        if (!currentSession) return;
        chrome.runtime.sendMessage({ type: 'highlightSessionOnPage', sessionName: currentSession }, (res) => {
            if (chrome.runtime.lastError) return;
            Citations.notify(
                res && res.highlighted > 0
                    ? t('wb_highlighted').replace('%s', res.highlighted)
                    : t('wb_highlight_none')
            );
        });
    });

    document.getElementById('openSettingsBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });

    /**
     * Inline prompt. Extension pages can't use window.prompt(), and the side
     * panel is too narrow for a full dialog, so this is a minimal replacement.
     * Resolves to the entered string, or null when cancelled.
     */
    function promptText(title, defaultValue = '', opts = {}) {
        const modal = document.getElementById('wbModal');
        const titleEl = document.getElementById('wbModalTitle');
        const input = document.getElementById('wbModalInput');
        const errEl = document.getElementById('wbModalError');
        const okBtn = document.getElementById('wbModalOk');
        const cancelBtn = document.getElementById('wbModalCancel');

        titleEl.textContent = title;
        errEl.textContent = '';
        input.value = defaultValue;
        input.placeholder = opts.confirmWord ? opts.confirmWord : '';
        modal.classList.remove('hidden');
        input.focus();
        input.select();

        return new Promise((resolve) => {
            function cleanup(result) {
                modal.classList.add('hidden');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                input.removeEventListener('keydown', onKey);
                resolve(result);
            }
            function onOk() {
                const val = input.value.trim();
                if (opts.confirmWord && val !== opts.confirmWord) {
                    errEl.textContent = t('wb_type_to_confirm').replace('%s', opts.confirmWord);
                    return;
                }
                cleanup(val);
            }
            function onCancel() { cleanup(null); }
            function onKey(e) {
                if (e.key === 'Enter') { e.preventDefault(); onOk(); }
                if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            input.addEventListener('keydown', onKey);
        });
    }

    // Ask background script to re-fetch images without cached base64 data
    async function reCacheMissingImages() {
        const hasMissing = sessionSnippets.some(s => s.type === 'image' && !s.cachedDataUrl && !s.hasCachedImage);
        if (!hasMissing) return;

        try {
            const result = await chrome.runtime.sendMessage({
                type: 'reCacheImages',
                sessionName: currentSession
            });
            if (result && result.updated > 0) {
                // Reload snippets from storage to get the updated cachedDataUrl
                const { sessions } = await chrome.storage.local.get(['sessions']);
                if (sessions && sessions[currentSession]) {
                    sessionSnippets = sessions[currentSession];
                    renderContextPanel();
                }
            }
        } catch (e) {
            console.warn('Re-cache failed:', e);
        }
    }

    function renderContextPanel() {
        contextBody.innerHTML = '';

        const q = (snippetSearch && snippetSearch.value.trim().toLowerCase()) || '';
        const visible = sessionSnippets
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => {
                if (!q) return true;
                return [s.content, s.sourceTitle, s.sourceUrl, s.comment, (s.tags || []).join(' ')]
                    .some((v) => (v || '').toLowerCase().includes(q));
            });

        if (snippetCount) {
            snippetCount.textContent = q
                ? `${visible.length}/${sessionSnippets.length}`
                : `${sessionSnippets.length}`;
        }

        if (visible.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'context-empty';
            empty.textContent = sessionSnippets.length === 0
                ? t('wb_no_snippets') : t('wb_no_matches');
            contextBody.appendChild(empty);
            return;
        }

        visible.forEach(({ s: snippet, i: index }) => {
            const item = document.createElement('div');
            item.className = 'context-item';
            item.style.flexWrap = 'wrap';

            const num = document.createElement('span');
            num.className = 'context-num';
            num.textContent = `#${index + 1}`;

            item.appendChild(num);

            if (snippet.type === 'image') {
                const img = document.createElement('img');
                img.className = 'context-image';
                img.src = snippet.imageUrl || '';
                img.alt = 'image snippet';
                img.style.maxWidth = '80px';
                img.style.maxHeight = '60px';
                img.style.borderRadius = '4px';
                img.style.verticalAlign = 'middle';
                item.appendChild(img);

                // Cache status indicator
                const status = document.createElement('span');
                status.style.cssText = 'font-size:10px; margin-left:4px; vertical-align:middle;';
                const cached = !!(snippet.cachedDataUrl || snippet.hasCachedImage);
                if (cached) {
                    status.textContent = '[cached]';
                    status.style.color = '#4caf50';
                    status.title = 'Image cached — will be sent to AI';
                } else {
                    status.textContent = '[not cached]';
                    status.style.color = '#f44336';
                    status.title = 'Image not cached — AI will not be able to see this image';
                }
                item.appendChild(status);

                // Resolve the cached data URL (inline legacy or IDB) for the thumbnail.
                Store.resolveImage(snippet).then((dataUrl) => {
                    if (dataUrl) img.src = dataUrl;
                }).catch(() => {});

                const urlText = document.createElement('span');
                urlText.className = 'context-text';
                urlText.textContent = snippet.imageUrl || '(image)';
                urlText.title = snippet.imageUrl || '';
                item.appendChild(urlText);
            } else {
                const text = document.createElement('span');
                text.className = 'context-text';
                text.textContent = snippet.content || snippet;
                text.title = snippet.content || snippet;
                item.appendChild(text);
            }

            if (snippet.tags && snippet.tags.length > 0) {
                snippet.tags.forEach((tg) => {
                    const tag = document.createElement('span');
                    tag.className = 'context-tag';
                    tag.textContent = tg;
                    item.appendChild(tag);
                });
            }

            // Per-snippet actions: open source, tag, comment, delete.
            const actions = document.createElement('div');
            actions.className = 'context-actions';

            if (snippet.sourceUrl) {
                const open = document.createElement('button');
                open.className = 'context-act';
                open.textContent = '↗';
                open.title = t('wb_open_source');
                open.addEventListener('click', () => chrome.tabs.create({ url: snippet.sourceUrl }));
                actions.appendChild(open);
            }

            const tagBtn = document.createElement('button');
            tagBtn.className = 'context-act';
            tagBtn.textContent = '#';
            tagBtn.title = t('wb_edit_tags');
            tagBtn.addEventListener('click', async () => {
                const val = await promptText(t('wb_edit_tags'), (snippet.tags || []).join(', '));
                if (val === null) return;
                snippet.tags = val.split(',').map((x) => x.trim()).filter(Boolean);
                await persistSnippets();
            });
            actions.appendChild(tagBtn);

            const noteBtn = document.createElement('button');
            noteBtn.className = 'context-act';
            noteBtn.textContent = '✎';
            noteBtn.title = t('wb_edit_comment');
            noteBtn.addEventListener('click', async () => {
                const val = await promptText(t('wb_edit_comment'), snippet.comment || '');
                if (val === null) return;
                snippet.comment = val;
                await persistSnippets();
            });
            actions.appendChild(noteBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'context-act danger';
            delBtn.textContent = '×';
            delBtn.title = t('wb_delete_snippet');
            delBtn.addEventListener('click', async () => {
                await Store.removeSnippet(currentSession, snippet.id);
                sessionSnippets = await Store.getSession(currentSession);
                renderContextPanel();
            });
            actions.appendChild(delBtn);

            item.appendChild(actions);

            if (snippet.comment) {
                const c = document.createElement('div');
                c.className = 'context-comment';
                c.textContent = '💬 ' + snippet.comment;
                item.appendChild(c);
            }

            contextBody.appendChild(item);
        });
    }

    // Write the in-memory snippet list back to storage, then re-render.
    async function persistSnippets() {
        const sessions = await Store.getSessions();
        sessions[currentSession] = sessionSnippets;
        await Store.setSessions(sessions);
        renderContextPanel();
    }

    // 已知支持 Vision（多模态图片）的模型前缀/关键词
    const VISION_CAPABLE_PATTERNS = [
        /^gpt-4o/i,              // OpenAI gpt-4o, gpt-4o-mini
        /^gpt-4-turbo/i,         // OpenAI gpt-4-turbo
        /^gpt-4\.1/i,            // OpenAI gpt-4.1 系列
        /^chatgpt-4o/i,          // OpenAI chatgpt-4o-latest
        /^o1/i, /^o3/i, /^o4/i,  // OpenAI reasoning models with vision
        /^claude-/i,             // Anthropic Claude 3+ (via compatible endpoint)
        /^gemini/i,              // Google Gemini (via compatible endpoint)
        /^llava/i,               // Ollama llava
        /^bakllava/i,            // Ollama bakllava
        /^llama.*vision/i,       // Llama vision variants
        /^qwen.*vl/i,            // Qwen-VL 系列
        /^qwen2\.5-vl/i,         // Qwen2.5-VL
        /^glm-4v/i,              // GLM-4V (智谱)
        /^yi-vision/i,           // Yi-Vision
        /^internvl/i,            // InternVL
        /^cogvlm/i,              // CogVLM
        /^minicpm.*v/i,          // MiniCPM-V
        /^step-.*v/i,            // StepFun vision models
    ];

    // 判断当前模型是否支持 vision
    async function isVisionSupported() {
        const cfg = await Store.getLlmConfig();
        const visionMode = cfg.visionMode || 'auto';
        if (visionMode === 'on' || visionMode === 'enabled') return true;
        if (visionMode === 'off' || visionMode === 'disabled') return false;
        // auto: match by model name
        return VISION_CAPABLE_PATTERNS.some(pattern => pattern.test(cfg.model || ''));
    }

    // 检查 session 中是否有图片 snippet
    function hasImageSnippets() {
        return sessionSnippets.some(s => s.type === 'image');
    }

    // 构建 snippet 描述的文本部分（text-only 和 multimodal 共用）
    function buildSnippetsText(visionEnabled) {
        let text = '';
        if (sessionSnippets.length > 0) {
            text += "=== COLLECTED SNIPPETS ===\n";
            sessionSnippets.forEach((snippet, i) => {
                const content = snippet.content || snippet;
                const source = snippet.sourceTitle || snippet.sourceUrl || '';
                const tags = (snippet.tags || []).join(', ');
                const comment = snippet.comment || '';
                if (snippet.type === 'image') {
                    if (visionEnabled) {
                        text += `\n[S${i + 1}] (image — embedded in the conversation)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n`;
                    } else {
                        text += `\n[S${i + 1}] (image, not displayed - model does not support vision)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\nImage URL: ${snippet.imageUrl || '(no url)'}\nNote: This is an image snippet. The image cannot be displayed to you because the current model does not support vision/multimodal input. The user saved this image from the webpage above.\n`;
                    }
                } else {
                    text += `\n[S${i + 1}]${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n${content}\n`;
                }
                if (comment) {
                    text += `[User's comment]: ${comment}\n`;
                }
            });
            text += "\n=== END SNIPPETS ===\n";
        }
        return text;
    }

    // Build system message (always text-only).
    // If ragResult is provided, uses RAGEngine's filtered text instead of all snippets.
    async function buildSystemMessage(ragResult) {
        const visionEnabled = await isVisionSupported();

        let intro = "You are a helpful AI assistant for Weft, a browser extension that collects information snippets from web pages. ";
        intro += "The user has collected the following information snippets in their current session. Use them as context when responding.\n\n";
        intro += "When generating reports or structured content, you may use markdown including tables, lists and headings.\n";
        intro += Citations.CONTRACT + "\n\n";

        const snippetsText = ragResult
            ? RAGEngine.buildFilteredSnippetsText(ragResult, visionEnabled)
            : buildSnippetsText(visionEnabled);

        // Citation markers only align with the full snippet list; disable when RAG filters.
        activeIndexMap = ragResult ? null : Citations.buildContext(sessionSnippets).indexMap;

        return { role: "system", content: intro + snippetsText + "\n" + I18N.promptLanguageInstruction() };
    }

    // Build image content parts for vision-capable models.
    // Returns an array of content parts (text labels + image_url objects) to be merged
    // into the user's message. Returns null if no images or vision not supported.
    // IMPORTANT: Only uses cachedDataUrl (base64). Never sends HTTP URLs.
    async function buildImageContentParts() {
        const visionEnabled = await isVisionSupported();
        if (!visionEnabled || !hasImageSnippets()) return null;

        const contentParts = [];
        let imageCount = 0;

        for (let i = 0; i < sessionSnippets.length; i++) {
            const snippet = sessionSnippets[i];
            if (snippet.type !== 'image') continue;
            // Resolve from inline (legacy) or IndexedDB.
            const dataUrl = await Store.resolveImage(snippet);
            if (dataUrl) {
                const source = snippet.sourceTitle || snippet.sourceUrl || 'unknown source';
                const tags = (snippet.tags || []).join(', ');
                contentParts.push({
                    type: "text",
                    text: `[Image ${i + 1}]${tags ? ` (${tags})` : ''} from: ${source}`
                });
                contentParts.push({
                    type: "image_url",
                    image_url: { url: dataUrl, detail: "auto" }
                });
                imageCount++;
            } else {
                contentParts.push({
                    type: "text",
                    text: `[Image ${i + 1}] (could not load — original URL: ${snippet.imageUrl || 'unknown'})`
                });
            }
        }

        if (imageCount === 0) return null;

        // Brief intro at the top
        contentParts.unshift({ type: "text", text: "Images from collected snippets:" });
        return contentParts;
    }

    // Template selection
    // Scenario chips run immediately. The prompt itself is never shown to the
    // user — the transcript records the intent ("Report"), not the instruction.
    const SCENARIO_LABELS = {
        report: '📄 ' + t('sc_report'),
        rewrite: '✍️ ' + t('sc_rewrite'),
        verify: '🔍 ' + t('sc_verify'),
        summarize: '📝 ' + t('sc_summarize'),
        compare: t('sc_compare'),
        extract: t('sc_extract'),
        table: t('sc_table'),
        translate_zh: t('sc_to_zh'),
        translate_en: t('sc_to_en'),
    };

    async function runScenario(id) {
        if (isStreaming) return;
        const prompt = promptTemplates[id];
        if (!prompt) return;

        if (sessionSnippets.length === 0) {
            Citations.notify(t('wb_need_snippets'));
            return;
        }

        isStreaming = true;
        sendButton.disabled = true;
        setQuickActionsEnabled(false);

        // Friendly, intent-level transcript entry.
        appendMessage(
            `${SCENARIO_LABELS[id] || id} · ${t('wb_using_snippets').replace('%s', sessionSnippets.length)}`,
            'user'
        );
        showTypingIndicator();

        try {
            conversationHistory = [];
            conversationHistory.push(await buildSystemMessage());
            conversationHistory.push({ role: 'user', content: prompt });

            removeTypingIndicator();
            const contentDiv = appendMessage('', 'assistant', true);
            await processStream(conversationHistory, contentDiv);
        } catch (error) {
            removeTypingIndicator();
            appendError(error);
        } finally {
            isStreaming = false;
            sendButton.disabled = false;
            setQuickActionsEnabled(true);
        }
    }

    document.getElementById('scenarioChips').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-scenario]');
        if (chip) runScenario(chip.dataset.scenario);
    });

    const moreScenarios = document.getElementById('moreScenarios');
    moreScenarios.addEventListener('change', () => {
        const v = moreScenarios.value;
        moreScenarios.value = '';
        if (v) runScenario(v);
    });

    // Toggle context panel
    let contextVisible = true;
    toggleContext.addEventListener('click', () => {
        contextVisible = !contextVisible;
        contextBody.style.display = contextVisible ? 'block' : 'none';
        toggleContext.textContent = contextVisible ? 'Hide' : 'Show';
    });

    // Auto-adjust textarea height
    userInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 150) + 'px';
    });

    // Markdown rendering is provided by markdown.js (loaded before chat.js)
    // renderMarkdown(text) is available as a global function

    // Assemble the conversation turn (system context + user message).
    // Returns the message list; streaming is driven by processStream().
    async function sendMessageToAPI(userMessage) {
        const cfg = await Store.getLlmConfig();
        if (getProvider(cfg.provider).needsKey && !cfg.apiKey) {
            throw new Error('API key not found. Please configure it in Settings.');
        }

        // Add to conversation history (with optional RAG filtering)
        if (conversationHistory.length === 0) {
            let ragResult = null;
            try {
                const { ragEnabled, ragTokenBudget } = await chrome.storage.local.get(['ragEnabled', 'ragTokenBudget']);
                if (ragEnabled && sessionSnippets.length > 0) {
                    ragResult = await RAGEngine.retrieve(
                        userMessage, currentSession, sessionSnippets, { ragTokenBudget }
                    );
                    console.log(`[RAG] mode=${ragResult.method}, ${ragResult.returnedCount}/${ragResult.totalCount} snippets, ~${ragResult.usedTokens} tokens`);
                }
            } catch (e) {
                console.warn('[RAG] retrieval failed, falling back to full context:', e);
            }
            conversationHistory.push(await buildSystemMessage(ragResult));
        }

        // For the first user message, merge image content parts into the same message
        // so the LLM sees images + query together (standard multimodal format).
        // For follow-up messages, images are already in conversation history.
        const isFirstUserMessage = conversationHistory.length === 1; // only system msg
        const imageParts = isFirstUserMessage ? await buildImageContentParts() : null;

        if (imageParts) {
            conversationHistory.push({
                role: "user",
                content: [...imageParts, { type: "text", text: userMessage }]
            });
        } else {
            conversationHistory.push({ role: "user", content: userMessage });
        }

        return conversationHistory;
    }

    // Process streaming response via the unified LLMClient.
    async function processStream(messages, messageContentEl) {
        let fullContent = '';
        let dirty = false;            // new content since last render
        let renderTimer = null;
        const RENDER_INTERVAL = 80;   // ms — throttle markdown re-renders

        function scheduleRender() {
            if (renderTimer) return;   // already scheduled
            renderTimer = setTimeout(() => {
                renderTimer = null;
                if (dirty) {
                    dirty = false;
                    messageContentEl.innerHTML = Render.markdown(fullContent, { indexMap: activeIndexMap });
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
            }, RENDER_INTERVAL);
        }

        try {
            await LLMClient.chat(messages, {
                stream: true,
                onDelta: (delta) => {
                    if (delta) {
                        fullContent += delta;
                        dirty = true;
                        scheduleRender();
                    }
                },
            });
        } catch (error) {
            if (error.name !== 'AbortError' && error.kind !== 'abort') {
                if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
                // Nothing was streamed: drop the placeholder bubble so the caller's
                // error message stands alone instead of trailing an empty reply.
                if (!fullContent) {
                    const bubble = messageContentEl.closest('.message');
                    if (bubble) bubble.remove();
                }
                throw error;
            }
        }

        // Cancel pending timer and do final render
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        messageContentEl.innerHTML = Render.markdown(fullContent, { indexMap: activeIndexMap });
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Add to conversation history
        conversationHistory.push({ role: "assistant", content: fullContent });

        return fullContent;
    }

    // Append message to UI
    function appendMessage(content, sender, isHtml = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        if (isHtml) {
            contentDiv.innerHTML = content;
        } else {
            contentDiv.textContent = content;
        }

        messageDiv.appendChild(contentDiv);

        // Add copy button for assistant messages
        if (sender === 'assistant') {
            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', () => {
                const text = contentDiv.innerText;
                navigator.clipboard.writeText(text).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
                });
            });

            const copyHtmlBtn = document.createElement('button');
            copyHtmlBtn.className = 'copy-btn';
            copyHtmlBtn.textContent = 'Copy HTML';
            copyHtmlBtn.addEventListener('click', () => {
                const html = contentDiv.innerHTML;
                navigator.clipboard.writeText(html).then(() => {
                    copyHtmlBtn.textContent = 'Copied!';
                    setTimeout(() => { copyHtmlBtn.textContent = 'Copy HTML'; }, 1500);
                });
            });

            const exportHtmlBtn = document.createElement('button');
            exportHtmlBtn.className = 'copy-btn';
            exportHtmlBtn.textContent = 'Export HTML';
            exportHtmlBtn.addEventListener('click', () => {
                const doc = `<!DOCTYPE html><meta charset="utf-8"><title>Weft export</title>` +
                    `<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.6;">` +
                    contentDiv.innerHTML + `</body>`;
                const blob = new Blob([doc], { type: 'text/html' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'weft-export.html';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            });

            const saveSnippetBtn = document.createElement('button');
            saveSnippetBtn.className = 'copy-btn';
            saveSnippetBtn.textContent = 'Save as snippet';
            saveSnippetBtn.addEventListener('click', async () => {
                if (!currentSession) { saveSnippetBtn.textContent = 'No session'; return; }
                try {
                    await Store.addSnippet(currentSession, {
                        id: 'gen-' + Date.now().toString(36),
                        type: 'text',
                        content: contentDiv.innerText,
                        sourceUrl: '', sourceTitle: 'Weft output',
                        timestamp: Date.now(), tags: ['generated'],
                    });
                    saveSnippetBtn.textContent = 'Saved!';
                    setTimeout(() => { saveSnippetBtn.textContent = 'Save as snippet'; }, 1500);
                } catch (e) {
                    saveSnippetBtn.textContent = 'Failed';
                }
            });

            const btnRow = document.createElement('div');
            btnRow.className = 'message-actions';
            btnRow.appendChild(copyBtn);
            btnRow.appendChild(copyHtmlBtn);
            btnRow.appendChild(exportHtmlBtn);
            btnRow.appendChild(saveSnippetBtn);
            messageDiv.appendChild(btnRow);
        }

        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return contentDiv;
    }

    /**
     * Update a quick-action button's label without destroying its icon.
     * These buttons are `<svg> + <span>`, so assigning textContent would wipe
     * the icon. Pass null to restore the original label.
     */
    function setBtnLabel(btn, text) {
        const span = btn.querySelector('span');
        if (!span) { btn.textContent = text; return; }
        if (!span.dataset.original) span.dataset.original = span.textContent;
        span.textContent = text == null ? span.dataset.original : text;
    }

    // Render an error as a chat message, appending the actionable hint that
    // LLMError carries (bad key, rate limit, context too long, …).
    function appendError(err) {
        const hint = err && err.hint ? ` ${err.hint}` : '';
        appendMessage(`${t('wb_error_prefix')}: ${err.message}${hint}`, 'assistant');
    }

    // Show typing indicator
    function showTypingIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'message assistant';
        indicator.innerHTML = `
            <div class="typing-indicator">
                <span></span><span></span><span></span>
            </div>
        `;
        indicator.id = 'typingIndicator';
        chatMessages.appendChild(indicator);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function removeTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) indicator.remove();
    }

    // Handle send
    // Web-search toggle: visible only when a search provider is configured.
    const webSearchToggle = document.getElementById('webSearchToggle');
    const webSearchToggleLabel = document.getElementById('webSearchToggleLabel');
    if (webSearchToggleLabel) {
        SearchProvider.isEnabled().then((on) => {
            if (on) webSearchToggleLabel.style.display = '';
        }).catch(() => {});
    }

    async function handleSend() {
        const message = userInput.value.trim();
        if (!message || isStreaming) return;

        // Web-augmented path: plan → search → answer with the evidence folded in.
        // Works for any scenario (report/verify/etc.) — this is the online
        // cross-check mode. Delegates lifecycle to sendWithSearchResults.
        if (webSearchToggle && webSearchToggle.checked && await SearchProvider.isEnabled()) {
            userInput.value = '';
            userInput.style.height = 'auto';
            sendButton.disabled = true;
            showTypingIndicator();
            let plan = [];
            try { plan = await generateSearchPlan(message, null); } catch (e) { /* fall through */ }
            const results = [];
            for (const item of (plan || [])) {
                try { results.push({ query: item.query, results: await SearchProvider.search(item.query, 6) }); }
                catch (err) { results.push({ query: item.query, results: [], error: err.message }); }
            }
            removeTypingIndicator();
            sendButton.disabled = false;
            // sendWithSearchResults appends the user bubble + manages streaming.
            await sendWithSearchResults(message, null, results);
            return;
        }

        isStreaming = true;
        sendButton.disabled = true;

        // Add user message to UI
        appendMessage(message, 'user');
        userInput.value = '';
        userInput.style.height = 'auto';

        // Show typing indicator
        showTypingIndicator();

        try {
            const response = await sendMessageToAPI(message);
            removeTypingIndicator();

            // Create assistant message container for streaming
            const contentDiv = appendMessage('', 'assistant', true);
            await processStream(response, contentDiv);
        } catch (error) {
            console.error('Error:', error);
            removeTypingIndicator();
            appendError(error);
        } finally {
            isStreaming = false;
            sendButton.disabled = false;
        }
    }

    // ======== Page Extraction & Quick Actions ========

    // Extract current page content (with caching)
    async function extractCurrentPage() {
        if (pageContent) return pageContent;
        try {
            pageContent = await PageExtractor.extract();
            return pageContent;
        } catch (e) {
            console.error('Page extraction failed:', e);
            throw e;
        }
    }

    // Build system message with page content included
    async function buildSystemMessageWithPage(page, ragResult) {
        const visionEnabled = await isVisionSupported();
        // Page-context mode mixes live page text with snippets, so [S] markers
        // wouldn't map cleanly — disable citation decoration for this turn.
        activeIndexMap = null;

        let intro = "You are a helpful AI assistant for Weft, a browser extension that collects information snippets from web pages. ";
        intro += "The user has collected the following information snippets in their current session. Use them as context when responding.\n\n";
        intro += "When generating reports or structured content, you may use HTML formatting including tables, lists, headings, and SVG charts.\n\n";

        const snippetsText = ragResult
            ? RAGEngine.buildFilteredSnippetsText(ragResult, visionEnabled)
            : buildSnippetsText(visionEnabled);

        // Append page content
        let pageText = '';
        if (page && page.content) {
            pageText += "\n=== CURRENT PAGE CONTENT ===\n";
            pageText += `Title: ${page.title}\n`;
            pageText += `URL: ${page.url}\n`;
            if (page.description) pageText += `Description: ${page.description}\n`;
            pageText += `\n${page.content.substring(0, 50000)}\n`;
            pageText += "=== END PAGE CONTENT ===\n";
        }

        return { role: "system", content: intro + snippetsText + pageText + "\n" + I18N.promptLanguageInstruction() };
    }

    const DEFAULT_PAGE_QUESTION =
        'Analyze this webpage: what is the main topic, the key arguments, and the details that matter? Be concise and well structured.';

    // Send a message with page context (used by quick action buttons).
    // `displayLabel` lets callers show the user's intent instead of the raw
    // instruction sent to the model.
    async function sendWithPageContext(userMessage, page, displayLabel) {
        if (isStreaming) return;
        isStreaming = true;
        sendButton.disabled = true;
        setQuickActionsEnabled(false);

        appendMessage(displayLabel || userMessage, 'user');
        showTypingIndicator();

        try {
            // Reset conversation for page-context queries
            conversationHistory = [];
            conversationHistory.push(await buildSystemMessageWithPage(page));

            const imageParts = await buildImageContentParts();
            if (imageParts) {
                conversationHistory.push({
                    role: "user",
                    content: [...imageParts, { type: "text", text: userMessage }]
                });
            } else {
                conversationHistory.push({ role: "user", content: userMessage });
            }

            removeTypingIndicator();
            const contentDiv = appendMessage('', 'assistant', true);
            await processStream(conversationHistory, contentDiv);
        } catch (error) {
            console.error('Error:', error);
            removeTypingIndicator();
            appendError(error);
        } finally {
            isStreaming = false;
            sendButton.disabled = false;
            setQuickActionsEnabled(true);
        }
    }

    function setQuickActionsEnabled(enabled) {
        askPageBtn.disabled = !enabled;
        takeawaysBtn.disabled = !enabled;
        deepSearchBtn.disabled = !enabled;
        drawDiagramBtn.disabled = !enabled;
        if (enabled) refreshPageActionAvailability();
    }

    // Page-based actions only work on normal web pages. Disable them (with a
    // reason in the tooltip) when the active tab is a browser-internal page,
    // rather than letting the click fail.
    async function refreshPageActionAvailability() {
        if (isStreaming) return;
        let ok = true;
        try {
            ok = (await PageExtractor.canExtractActiveTab()).ok;
        } catch { ok = true; } // if we can't tell, leave the buttons usable
        const reason = ok ? '' : t('wb_page_unavailable');
        for (const btn of [askPageBtn, takeawaysBtn]) {
            btn.disabled = !ok;
            btn.title = reason || btn.dataset.titleOriginal || btn.title;
            if (ok && btn.dataset.titleOriginal) btn.title = btn.dataset.titleOriginal;
        }
        // Page context is optional for these two, so keep them enabled.
        pageContent = ok ? pageContent : null;
    }

    // Remember original tooltips so they can be restored.
    for (const btn of [askPageBtn, takeawaysBtn]) {
        if (btn && btn.title) btn.dataset.titleOriginal = btn.title;
    }
    refreshPageActionAvailability();
    // Re-check when the user switches tabs or navigates.
    chrome.tabs.onActivated.addListener(() => { pageContent = null; refreshPageActionAvailability(); });
    chrome.tabs.onUpdated.addListener((_id, info) => {
        if (info.status === 'complete') { pageContent = null; refreshPageActionAvailability(); }
    });

    // "Ask about this page" handler
    askPageBtn.addEventListener('click', async () => {
        try {
            askPageBtn.disabled = true;
            setBtnLabel(askPageBtn, t('wb_reading_page'));
            const page = await extractCurrentPage();
            setBtnLabel(askPageBtn, null);

            // Show page info in context panel
            showPageIndicator(page);

            // If the user typed a question, use it verbatim; otherwise run the
            // default analysis but show the intent, not the instruction.
            const typed = userInput.value.trim();
            const question = typed || DEFAULT_PAGE_QUESTION;
            userInput.value = '';
            await sendWithPageContext(question, page, typed || `📄 ${t('wb_analyse_page')}`);
        } catch (e) {
            setBtnLabel(askPageBtn, null);
            askPageBtn.disabled = false;
            appendError(e);
        }
    });

    // "Key Takeaways" handler — structured JSON with source quotes + highlights
    takeawaysBtn.addEventListener('click', async () => {
        if (isStreaming) return;
        try {
            takeawaysBtn.disabled = true;
            setBtnLabel(takeawaysBtn, t('wb_reading_page'));
            const page = await extractCurrentPage();

            showPageIndicator(page);
            setBtnLabel(takeawaysBtn, t('wb_analysing'));

            // Clear previous highlights
            try { await Highlighter.clearAll(); } catch (e) { /* ok */ }

            // Phase 1: Ask LLM for structured takeaways with source quotes
            const takeawaysData = await requestStructuredTakeaways(page);

            if (!takeawaysData || !takeawaysData.takeaways || takeawaysData.takeaways.length === 0) {
                // Fallback: do a normal text-based takeaway
                setBtnLabel(takeawaysBtn, null);
                const fallbackPrompt = `Based on the current webpage content, extract the key takeaways and main insights. Please organize them as:\n\n1. **Main Topic/Theme**: What is this page about?\n2. **Key Points**: List the most important points (5-10 bullet points)\n3. **Key Data/Facts**: Any specific numbers, statistics, or factual claims\n4. **Author's Perspective**: What viewpoint or argument is being made?\n5. **Actionable Insights**: What can the reader do with this information?\n\nBe concise but thorough.`;
                await sendWithPageContext(fallbackPrompt, page);
                return;
            }

            // Phase 2: Inject highlights into the webpage
            setBtnLabel(takeawaysBtn, t('wb_highlighting'));
            const hlGroups = takeawaysData.takeaways.map((t, i) => ({
                groupIndex: i,
                quotes: t.quotes || [],
            }));

            let hlResult = { highlighted: 0, total: 0 };
            try {
                hlResult = await Highlighter.highlightGroups(hlGroups);
                console.log(`[Highlight] ${hlResult.highlighted}/${hlResult.total} quotes highlighted`);
            } catch (e) {
                console.warn('Highlighting failed:', e);
            }

            // Phase 3: Enable selection toolbar so user can adjust highlights
            try {
                const groupTitles = takeawaysData.takeaways.map(t => t.title);
                await Highlighter.enableSelectionMode(takeawaysData.takeaways.length, groupTitles);
            } catch (e) {
                console.warn('Selection mode failed:', e);
            }

            // Phase 4: Render rich takeaway cards in chat
            renderTakeawayCards(takeawaysData, hlResult);

        } catch (e) {
            console.error('Key takeaways error:', e);
            appendError(e);
        } finally {
            setBtnLabel(takeawaysBtn, null);
            takeawaysBtn.disabled = false;
        }
    });

    /**
     * Ask LLM to return structured takeaways with exact source quotes.
     * Non-streaming call that returns parsed JSON.
     */
    async function requestStructuredTakeaways(page) {
        const systemPrompt = `You are an expert analyst. Given a webpage's content, extract the key takeaways. For EACH takeaway, provide exact quotes from the original text that support it.

IMPORTANT: The "quotes" field must contain EXACT substrings copied from the provided page content. These will be used to locate and highlight the text in the original webpage. Each quote should be 15-100 characters long — long enough to be unique but not entire paragraphs. Extract 2-5 quotes per takeaway.

Output ONLY valid JSON in this exact format:
{
  "topic": "Brief description of the page's main topic",
  "takeaways": [
    {
      "title": "Short title for this takeaway",
      "summary": "1-2 sentence explanation of this point",
      "quotes": ["exact quote from page text", "another exact quote supporting this point"]
    }
  ]
}

Generate 3-7 takeaways. Each must have at least 1 quote.`;

        try {
            return await LLMClient.completeJSON([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analyze the following webpage content and extract structured key takeaways with exact source quotes.\n\nTitle: ${page.title}\nURL: ${page.url}\n\n${page.content.substring(0, 40000)}` }
            ], { temperature: 0.3, maxTokens: 3000 });
        } catch (e) {
            // Configuration / transport problems must surface to the user — only a
            // malformed JSON reply is worth silently falling back from.
            if (e instanceof LLMError) throw e;
            console.warn('Takeaways: model did not return valid JSON, falling back.', e);
            return null;
        }
    }

    /**
     * Render rich takeaway cards in the chat area with color indicators,
     * clickable source references, editing hint, and regenerate button.
     */
    function renderTakeawayCards(data, hlResult) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content takeaway-content';

        // Topic header
        let html = `<div class="takeaway-header">
            <h3>Key Takeaways</h3>
            <span class="takeaway-topic">${escapeHtml(data.topic || '')}</span>`;
        if (hlResult.highlighted > 0) {
            html += `<span class="takeaway-hl-badge">${hlResult.highlighted} passages highlighted in page</span>`;
        }
        html += `</div>`;

        // Hint: user can edit highlights
        html += `<div class="takeaway-edit-hint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            You can select text on the page to adjust highlights — assign to a group or remove. Click <strong>Regenerate</strong> to update takeaways based on your changes.
        </div>`;

        // Takeaway cards
        data.takeaways.forEach((t, i) => {
            const color = Highlighter.getColor(i);
            const colorDot = `<span class="takeaway-color-dot" style="background:${color.border};" title="Click to locate in page"></span>`;
            const quotesHtml = (t.quotes || []).map(q =>
                `<span class="takeaway-quote" data-group="${i}" title="Click to locate in page">"${escapeHtml(q)}"</span>`
            ).join(' ');

            html += `<div class="takeaway-card" data-group="${i}">
                <div class="takeaway-card-header">
                    ${colorDot}
                    <strong>${escapeHtml(t.title)}</strong>
                </div>
                <div class="takeaway-card-summary">${escapeHtml(t.summary)}</div>
                ${quotesHtml ? `<div class="takeaway-card-quotes">
                    <span class="quotes-label">Sources:</span> ${quotesHtml}
                </div>` : ''}
            </div>`;
        });

        // Footer with action buttons
        html += `<div class="takeaway-footer">
            <button class="takeaway-regen-btn" data-action="regenerate">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                Regenerate
            </button>
            <button class="takeaway-clear-btn" data-action="clear">Clear highlights</button>
        </div>`;

        contentDiv.innerHTML = html;
        messageDiv.appendChild(contentDiv);

        // Copy button row
        const btnRow = document.createElement('div');
        btnRow.className = 'message-actions';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(contentDiv.innerText).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            });
        });
        btnRow.appendChild(copyBtn);
        messageDiv.appendChild(btnRow);

        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Attach event: click quote to scroll in page
        contentDiv.querySelectorAll('.takeaway-quote').forEach(el => {
            el.addEventListener('click', () => {
                const groupIdx = parseInt(el.dataset.group);
                Highlighter.scrollToGroup(groupIdx);
            });
        });

        // Attach event: click card header color dot to scroll
        contentDiv.querySelectorAll('.takeaway-card').forEach(el => {
            el.querySelector('.takeaway-color-dot')?.addEventListener('click', () => {
                const groupIdx = parseInt(el.dataset.group);
                Highlighter.scrollToGroup(groupIdx);
            });
        });

        // Clear highlights button
        contentDiv.querySelector('[data-action="clear"]')?.addEventListener('click', async () => {
            try {
                await Highlighter.clearAll();
                const btn = contentDiv.querySelector('[data-action="clear"]');
                if (btn) { btn.textContent = 'Cleared!'; btn.disabled = true; }
                const regenBtn = contentDiv.querySelector('[data-action="regenerate"]');
                if (regenBtn) { regenBtn.disabled = true; regenBtn.title = 'Highlights cleared'; }
            } catch (e) { console.warn('Clear failed:', e); }
        });

        // Regenerate button — collect current highlights from page, re-ask LLM
        contentDiv.querySelector('[data-action="regenerate"]')?.addEventListener('click', async () => {
            await handleRegenerate(contentDiv);
        });

        // Add to conversation history for context
        const textSummary = data.takeaways.map((t, i) =>
            `${i + 1}. ${t.title}: ${t.summary}`
        ).join('\n');
        conversationHistory.push({ role: 'assistant', content: `Key Takeaways for "${data.topic}":\n${textSummary}` });
    }

    /**
     * Regenerate takeaways based on user-adjusted highlights.
     * 1. Collect current highlights from page (user may have added/removed/reassigned)
     * 2. Send highlighted excerpts + page content to LLM
     * 3. Get updated takeaways, re-highlight, and render new cards
     */
    async function handleRegenerate(prevContentDiv) {
        if (isStreaming) return;

        const regenBtn = prevContentDiv.querySelector('[data-action="regenerate"]');
        if (regenBtn) {
            regenBtn.disabled = true;
            regenBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg> Regenerating...';
        }

        try {
            // Step 1: Collect current highlight state from the page
            const currentGroups = await Highlighter.collectHighlights();
            const page = pageContent;
            if (!page) throw new Error('Page content not available');

            // Step 2: Ask LLM to regenerate based on user-curated highlights
            const updatedData = await requestRegeneratedTakeaways(page, currentGroups);

            if (!updatedData || !updatedData.takeaways || updatedData.takeaways.length === 0) {
                appendMessage('Could not regenerate takeaways. The highlighted content may be insufficient.', 'assistant');
                return;
            }

            // Step 3: Re-highlight the page with updated quotes
            try { await Highlighter.clearAll(); } catch (e) { /* ok */ }

            const hlGroups = updatedData.takeaways.map((t, i) => ({
                groupIndex: i,
                quotes: t.quotes || [],
            }));

            let hlResult = { highlighted: 0, total: 0 };
            try {
                hlResult = await Highlighter.highlightGroups(hlGroups);
            } catch (e) { console.warn('Re-highlight failed:', e); }

            // Re-enable selection mode with new group titles
            try {
                const groupTitles = updatedData.takeaways.map(t => t.title);
                await Highlighter.enableSelectionMode(updatedData.takeaways.length, groupTitles);
            } catch (e) { /* ok */ }

            // Step 4: Render new takeaway cards
            renderTakeawayCards(updatedData, hlResult);

        } catch (e) {
            console.error('Regenerate error:', e);
            appendMessage(`Regenerate failed: ${e.message}`, 'assistant');
        } finally {
            if (regenBtn) {
                regenBtn.disabled = false;
                regenBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg> Regenerate';
            }
        }
    }

    /**
     * Ask LLM to regenerate takeaways based on user-curated highlights.
     * The highlights represent what the user considers important — the LLM
     * should organize them into coherent takeaways.
     */
    async function requestRegeneratedTakeaways(page, currentGroups) {
        // Build a description of what's currently highlighted
        let highlightDesc = 'The user has reviewed and adjusted the highlighted passages on the webpage. Here are the current highlights organized by color group:\n\n';
        if (currentGroups.length === 0) {
            highlightDesc += '(No highlights remaining — the user may have removed all of them. Generate fresh takeaways from the page content.)\n';
        } else {
            currentGroups.forEach(g => {
                const color = Highlighter.getColor(g.groupIndex);
                highlightDesc += `Group ${g.groupIndex + 1} (${color.name}):\n`;
                g.quotes.forEach(q => { highlightDesc += `  - "${q}"\n`; });
                highlightDesc += '\n';
            });
        }

        const systemPrompt = `You are an expert analyst. The user has used a highlighting tool to mark important passages on a webpage. Some highlights may have been auto-generated and then adjusted by the user (added, removed, or reassigned to different groups).

Your task: Based on the user's curated highlights AND the full page content, generate updated key takeaways. Respect the user's highlight choices — they indicate what the user finds important. Organize the takeaways around the highlighted content, but you may refine groupings and add relevant quotes the user may have missed.

IMPORTANT: The "quotes" field must contain EXACT substrings from the page content, 15-100 characters each, for re-highlighting.

Output ONLY valid JSON:
{
  "topic": "Brief topic description",
  "takeaways": [
    {
      "title": "Short title",
      "summary": "1-2 sentence explanation",
      "quotes": ["exact quote from page"]
    }
  ]
}

Generate 3-7 takeaways.`;

        try {
            return await LLMClient.completeJSON([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${highlightDesc}\n\n=== FULL PAGE CONTENT ===\nTitle: ${page.title}\nURL: ${page.url}\n\n${page.content.substring(0, 35000)}` }
            ], { temperature: 0.3, maxTokens: 3000 });
        } catch (e) {
            if (e instanceof LLMError) throw e;
            console.warn('Regenerate: model did not return valid JSON.', e);
            return null;
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Show page indicator in context panel
    function showPageIndicator(page) {
        // Remove existing indicator
        const existing = contextBody.querySelector('.context-page-indicator');
        if (existing) existing.remove();

        const indicator = document.createElement('div');
        indicator.className = 'context-page-indicator';
        indicator.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${page.title} (${page.wordCount} words)</span>
        `;
        contextBody.insertBefore(indicator, contextBody.firstChild);
    }

    // ======== Deep Search / Search Planning ========

    // "Deep Search" handler — ask LLM to generate a search plan
    deepSearchBtn.addEventListener('click', async () => {
        if (isStreaming) return;

        const userQuery = userInput.value.trim();
        if (!userQuery) {
            // Focus input with contextual placeholder instead of showing error
            userInput.placeholder = 'What do you want to research? Type here then click Deep Search again...';
            userInput.focus();
            userInput.classList.add('input-highlight');
            deepSearchBtn.classList.add('btn-waiting');
            setTimeout(() => {
                userInput.classList.remove('input-highlight');
                deepSearchBtn.classList.remove('btn-waiting');
            }, 3000);
            return;
        }

        try {
            deepSearchBtn.disabled = true;
            setBtnLabel(deepSearchBtn, t('wb_planning'));
            userInput.placeholder = 'Type your message or select a template above...';

            // Optionally extract page for context
            let page = pageContent;
            try { page = await extractCurrentPage(); } catch (e) { /* no page context is OK */ }

            // Ask LLM to generate a search plan
            const plan = await generateSearchPlan(userQuery, page);
            if (plan && plan.length > 0) {
                pendingSearchPlan = { query: userQuery, plan, page };
                showSearchPlan(plan);
            } else {
                appendMessage('Could not generate a search plan. Try rephrasing your question.', 'assistant');
            }
        } catch (e) {
            console.error('Search plan error:', e);
            appendMessage(`Error generating search plan: ${e.message}`, 'assistant');
        } finally {
            setBtnLabel(deepSearchBtn, null);
            deepSearchBtn.disabled = false;
        }
    });

    // Ask LLM to generate search queries
    async function generateSearchPlan(userQuery, page) {
        let contextHint = '';
        if (page && page.content) {
            contextHint = `\n\nThe user is currently on a webpage titled "${page.title}" (${page.url}).`;
            if (page.description) contextHint += `\nPage description: ${page.description}`;
            contextHint += `\nPage excerpt: ${page.content.substring(0, 1000)}...`;
        }
        if (sessionSnippets.length > 0) {
            contextHint += `\n\nThe user has ${sessionSnippets.length} collected snippets in their session.`;
        }

        const { text: content } = await LLMClient.chat([
            {
                role: "system",
                content: `You are a search planning assistant. Given a user's question and context, generate a list of web search queries that would help find the missing information needed to answer the question comprehensively.

Output ONLY a JSON array of objects, each with "query" (the search query string) and "reason" (brief explanation of why this search is needed). Generate 2-5 search queries. Be specific and targeted.

Example output:
[{"query": "React server components vs client components performance comparison 2024", "reason": "Compare performance characteristics"}, {"query": "Next.js app router migration guide best practices", "reason": "Find migration best practices"}]`
            },
            {
                role: "user",
                content: `Question: ${userQuery}${contextHint}\n\nGenerate search queries to find information needed to answer this question comprehensively.`
            }
        ], { stream: false, temperature: 0.3, maxTokens: 500 });

        // Parse JSON array from response (handle markdown code blocks)
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.warn('Failed to parse search plan JSON:', content);
            return [];
        }
    }

    // Display search plan for user confirmation
    function showSearchPlan(plan) {
        searchPlanBody.innerHTML = '';
        plan.forEach((item, i) => {
            const div = document.createElement('div');
            div.className = 'plan-item';
            const num = document.createElement('span');
            num.className = 'plan-item-num';
            num.textContent = `${i + 1}.`;
            const body = document.createElement('div');
            const q = document.createElement('div');
            q.className = 'plan-item-query';
            q.textContent = item.query || '';
            const r = document.createElement('div');
            r.className = 'plan-item-reason';
            r.textContent = item.reason || '';
            body.appendChild(q); body.appendChild(r);
            div.appendChild(num); div.appendChild(body);
            searchPlanBody.appendChild(div);
        });
        searchProgress.style.display = 'none';
        searchPlanPanel.style.display = 'block';
    }

    // Confirm search plan
    confirmPlanBtn.addEventListener('click', async () => {
        if (!pendingSearchPlan) return;
        const { query, plan, page } = pendingSearchPlan;
        pendingSearchPlan = null;

        confirmPlanBtn.disabled = true;
        cancelPlanBtn.disabled = true;
        searchProgress.style.display = 'block';

        try {
            // Execute the plan through the user's configured search provider.
            const total = plan.length;
            const searchResults = [];
            for (let i = 0; i < total; i++) {
                const item = plan[i];
                const pct = Math.round((i / total) * 100);
                progressFill.style.width = pct + '%';
                progressText.textContent = `(${i + 1}/${total}) ${item.query}`;
                try {
                    const results = await SearchProvider.search(item.query, 6);
                    searchResults.push({ query: item.query, results });
                } catch (err) {
                    searchResults.push({ query: item.query, results: [], error: err.message });
                }
            }

            progressFill.style.width = '100%';
            progressText.textContent = 'Searches complete. Generating answer...';

            // Build augmented context and send to LLM
            await sendWithSearchResults(query, page, searchResults);
        } catch (e) {
            appendMessage(`Search execution error: ${e.message}`, 'assistant');
        } finally {
            searchPlanPanel.style.display = 'none';
            confirmPlanBtn.disabled = false;
            cancelPlanBtn.disabled = false;
        }
    });

    // Cancel search plan
    cancelPlanBtn.addEventListener('click', () => {
        pendingSearchPlan = null;
        searchPlanPanel.style.display = 'none';
    });

    // Send user's question with search results as augmented context
    async function sendWithSearchResults(userQuery, page, searchResults) {
        if (isStreaming) return;
        isStreaming = true;
        sendButton.disabled = true;
        setQuickActionsEnabled(false);

        appendMessage(userQuery, 'user');
        showTypingIndicator();

        try {
            // Build search context text
            let searchContext = "\n=== WEB SEARCH RESULTS ===\n";
            for (const sr of searchResults) {
                searchContext += `\nSearch query: "${sr.query}"\n`;
                if (sr.error) {
                    searchContext += `(Search failed: ${sr.error})\n`;
                    continue;
                }
                for (const r of sr.results) {
                    searchContext += `\n--- ${r.title} ---\nURL: ${r.url}\n`;
                    if (r.content) {
                        searchContext += r.content.substring(0, 3000) + '\n';
                    } else if (r.snippet) {
                        searchContext += r.snippet + '\n';
                    }
                }
            }
            searchContext += "\n=== END SEARCH RESULTS ===\n";

            // Build system message with page + search results
            const visionEnabled = await isVisionSupported();
            let intro = "You are a helpful AI assistant for Weft. ";
            intro += "The user has asked a question. Below is context from their session snippets, the current webpage, and web search results gathered to help answer the question.\n";
            intro += "Synthesize all available information to provide a comprehensive, well-structured answer. Cite sources when possible.\n\n";

            const snippetsText = buildSnippetsText(visionEnabled);
            // Snippet [S] markers decorate as citations; web results are cited by URL inline.
            activeIndexMap = page ? null : Citations.buildContext(sessionSnippets).indexMap;
            intro += Citations.CONTRACT + '\n' + I18N.promptLanguageInstruction() + '\n\n';
            let pageText = '';
            if (page && page.content) {
                pageText += "\n=== CURRENT PAGE CONTENT ===\n";
                pageText += `Title: ${page.title}\nURL: ${page.url}\n`;
                pageText += page.content.substring(0, 15000) + '\n';
                pageText += "=== END PAGE CONTENT ===\n";
            }

            conversationHistory = [];
            conversationHistory.push({
                role: "system",
                content: intro + snippetsText + pageText + searchContext
            });

            const imageParts = await buildImageContentParts();
            if (imageParts) {
                conversationHistory.push({
                    role: "user",
                    content: [...imageParts, { type: "text", text: userQuery }]
                });
            } else {
                conversationHistory.push({ role: "user", content: userQuery });
            }

            removeTypingIndicator();
            const contentDiv = appendMessage('', 'assistant', true);
            await processStream(conversationHistory, contentDiv);
        } catch (error) {
            console.error('Error:', error);
            removeTypingIndicator();
            appendError(error);
        } finally {
            isStreaming = false;
            sendButton.disabled = false;
            setQuickActionsEnabled(true);
        }
    }

    // ======== Event Listeners ========

    // Event listeners
    sendButton.addEventListener('click', handleSend);

    userInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    // Clear chat
    clearButton.addEventListener('click', () => {
        if (!confirm('Clear chat history?')) return;
        chatMessages.innerHTML = '';
        conversationHistory = [];
        pageContent = null;
        pendingSearchPlan = null;
        searchPlanPanel.style.display = 'none';
        // Remove page indicator
        const indicator = contextBody.querySelector('.context-page-indicator');
        if (indicator) indicator.remove();
        // Clear any page highlights and selection toolbar
        try { Highlighter.clearAll(); } catch (e) { /* ok */ }
    });

    // Export
    exportBtn.addEventListener('click', () => {
        // Find the last assistant message
        const messages = chatMessages.querySelectorAll('.message.assistant .message-content');
        if (messages.length === 0) {
            alert('No AI responses to export.');
            return;
        }
        const lastContent = messages[messages.length - 1].innerHTML;
        const htmlDoc = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Weft Export</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:40px auto;padding:20px;color:#333;line-height:1.6}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f5f5f5}
pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto}code{font-size:13px}
h1,h2,h3,h4{margin-top:1.2em;margin-bottom:0.6em}
</style></head><body>${lastContent}</body></html>`;

        const blob = new Blob([htmlDoc], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cyber-assistant-export-${new Date().toISOString().slice(0, 10)}.html`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // Snippets can be added from the page (context menu / selection toolbar)
    // while the workbench is open — refresh the list and drop the stale index.
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'snippetsChanged') {
            RAGEngine.invalidateCache(msg.sessionName || currentSession);
            loadSessions(currentSession).catch(() => {});
        }
    });

    // ======== Diagram Rendering Helper ========
    function renderDiagramInChat(result, sourceContent) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        const container = document.createElement('div');
        container.className = 'diagram-container';

        const svgDiv = document.createElement('div');
        svgDiv.className = 'diagram-svg';
        svgDiv.innerHTML = Render.svg(result.svg);
        container.appendChild(svgDiv);

        const codeBlock = document.createElement('div');
        codeBlock.className = 'diagram-code-block';
        codeBlock.textContent = result.code;
        container.appendChild(codeBlock);

        const actions = document.createElement('div');
        actions.className = 'diagram-actions';

        const toggleCodeBtn = document.createElement('button');
        toggleCodeBtn.textContent = 'Show Code';
        toggleCodeBtn.addEventListener('click', () => {
            const isShown = codeBlock.classList.toggle('show');
            toggleCodeBtn.textContent = isShown ? 'Hide Code' : 'Show Code';
        });
        actions.appendChild(toggleCodeBtn);

        const copyCodeBtn = document.createElement('button');
        copyCodeBtn.textContent = 'Copy Code';
        copyCodeBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(result.code).then(() => {
                copyCodeBtn.textContent = 'Copied!';
                setTimeout(() => { copyCodeBtn.textContent = 'Copy Code'; }, 1500);
            });
        });
        actions.appendChild(copyCodeBtn);

        const copySvgBtn = document.createElement('button');
        copySvgBtn.textContent = 'Copy SVG';
        copySvgBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(result.svg).then(() => {
                copySvgBtn.textContent = 'Copied!';
                setTimeout(() => { copySvgBtn.textContent = 'Copy SVG'; }, 1500);
            });
        });
        actions.appendChild(copySvgBtn);

        if (typeof DiagramGenerator !== 'undefined') {
            const expBtn = document.createElement('button');
            expBtn.textContent = 'Export HTML';
            expBtn.addEventListener('click', () => {
                const html = DiagramGenerator.exportAsHtml(
                    'Diagram — Weft',
                    result.svg,
                    result.type !== 'svg' ? result.code : '',
                    sourceContent?.substring(0, 500) || ''
                );
                const blob = new Blob([html], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'diagram.html';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
            });
            actions.appendChild(expBtn);
        }

        container.appendChild(actions);
        contentDiv.appendChild(container);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ======== Ask AI Mode ========
    // If opened with ?mode=askAI, load the selected text context and auto-send
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('mode') === 'askAI') {
        (async () => {
            const { askAIContext } = await chrome.storage.local.get(['askAIContext']);
            if (!askAIContext) return;

            // Clear the context so it's not re-used on next open
            await chrome.storage.local.remove('askAIContext');

            const { selectedText, questionType, sourceUrl, sourceTitle } = askAIContext;

            // ---- Page Insight mode: full-page AI analysis with RAG + graph ----
            if (questionType === 'page-insight') {
                const pageData = askAIContext.pageData || {};
                const title = pageData.title || sourceTitle || 'this page';

                appendMessage(`Analyzing: **${title}**`, 'user');
                showTypingIndicator();

                try {
                    // Build rich context: session snippets (RAG) + page content + graph connections
                    conversationHistory = [];

                    // Construct enhanced system prompt with all available intelligence
                    let sysContent = "You are a powerful AI research assistant integrated into the Weft browser extension. ";
                    sysContent += "You have access to the user's knowledge base (saved snippets from their research sessions) and the full content of the webpage they are currently viewing.\n\n";
                    sysContent += "Your task: provide a comprehensive, insightful analysis of this webpage. Combine the page content with the user's existing knowledge base to deliver maximum value.\n\n";

                    // Include session snippets via RAG if available
                    let ragInfo = '';
                    if (typeof RAGEngine !== 'undefined' && sessionSnippets.length > 0) {
                        try {
                            const ragQuery = (pageData.title || '') + ' ' + (pageData.description || '') + ' ' + (pageData.headings || []).join(' ');
                            const ragResult = await RAGEngine.retrieve(ragQuery, currentSession, sessionSnippets, { ragTokenBudget: 3000 });
                            if (ragResult && ragResult.snippets && ragResult.snippets.length > 0) {
                                const visionEnabled = await isVisionSupported();
                                ragInfo = RAGEngine.buildFilteredSnippetsText(ragResult, visionEnabled);
                                sysContent += "=== USER'S RELATED KNOWLEDGE BASE ===\n" + ragInfo + "\n=== END KNOWLEDGE BASE ===\n\n";
                            }
                        } catch (e) { console.warn('RAG for page insight:', e); }
                    }

                    // Include page content (capped to avoid token limit / timeout)
                    const pageText = (pageData.content || '').substring(0, 15000);
                    sysContent += "=== CURRENT WEBPAGE ===\n";
                    sysContent += `Title: ${pageData.title || ''}\n`;
                    sysContent += `URL: ${pageData.url || sourceUrl || ''}\n`;
                    if (pageData.description) sysContent += `Description: ${pageData.description}\n`;
                    if (pageData.headings && pageData.headings.length > 0) {
                        sysContent += `Structure: ${pageData.headings.join(' > ')}\n`;
                    }
                    sysContent += `\n${pageText}\n`;
                    sysContent += "=== END WEBPAGE ===\n";

                    conversationHistory.push({ role: "system", content: sysContent });

                    // Build user prompt — with selected text focus if available
                    let userPrompt = "Please analyze this webpage and provide:\n";
                    userPrompt += "1. **Key Insights** — the most important points and takeaways\n";
                    userPrompt += "2. **Connections** — how this page relates to my existing knowledge base (if any relevant snippets found)\n";
                    userPrompt += "3. **Critical Assessment** — reliability, potential biases, missing perspectives\n";
                    userPrompt += "4. **Action Items** — suggested follow-up research or actions\n";

                    if (selectedText) {
                        userPrompt += `\nPay special attention to this selected passage:\n"${selectedText.substring(0, 2000)}"\n`;
                    }

                    // Detect language from page content
                    const cjk = ((pageData.content || '').match(/[\u4e00-\u9fff]/g) || []).length;
                    const totalLen = (pageData.content || ' ').length;
                    if (cjk / totalLen > 0.15) {
                        userPrompt += "\nPlease respond in 中文.";
                    }

                    conversationHistory.push({ role: "user", content: userPrompt });

                    removeTypingIndicator();
                    const contentDiv = appendMessage('', 'assistant', true);
                    await processStream(conversationHistory, contentDiv);
                } catch (e) {
                    removeTypingIndicator();
                    appendError(e);
                }
                return;
            }

            if (!selectedText) return;

            // Diagram mode: auto-generate a diagram from the selected text
            if (questionType === 'diagram') {
                appendMessage(`[Generate diagram for selected text from ${sourceTitle || sourceUrl || 'page'}]`, 'user');
                showTypingIndicator();

                try {
                    const result = await DiagramGenerator.generateAndRender(selectedText, {
                        diagramType: 'auto',
                        language: I18N.outputLanguageName(),
                    });

                    removeTypingIndicator();
                    renderDiagramInChat(result, selectedText);
                } catch (e) {
                    removeTypingIndicator();
                    appendMessage(`Error generating diagram: ${e.message}`, 'assistant');
                }
                return;
            }

            // Free-form: show the passage as context and let the user type.
            // (Quick analyses never reach here — they answer inline on the page.)
            appendMessage(`“${selectedText}”`, 'user');
            userInput.placeholder = t('wb_ask_about_selection');
            userInput.focus();

            // Kept so the next send can include the passage.
            window._askAISelectedText = selectedText;
            window._askAISource = { url: sourceUrl, title: sourceTitle };
        })();
    }

    // Override handleSend to include askAI context if present
    const _origHandleSend = handleSend;
    // (Already defined handleSend above; we patch the input handling for freeform Ask AI)
    const origSendClick = sendButton.onclick;
    function handleAskAISend() {
        if (window._askAISelectedText && userInput.value.trim()) {
            const q = userInput.value.trim();
            const src = window._askAISource || {};
            userInput.value = `Regarding this text from "${src.title || src.url || 'a webpage'}":\n\n"${window._askAISelectedText}"\n\n${q}`;
            window._askAISelectedText = null;
            window._askAISource = null;
        }
    }
    sendButton.addEventListener('click', handleAskAISend, true);
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) handleAskAISend();
    }, true);

    // ======== Draw Diagram ========

    // Populate diagram type grid
    if (typeof DiagramGenerator !== 'undefined' && diagramTypeGrid) {
        let selectedDiagramType = 'auto';

        DiagramGenerator.DIAGRAM_TYPES.forEach(dt => {
            const btn = document.createElement('button');
            btn.className = 'diagram-type-btn' + (dt.id === 'auto' ? ' selected' : '');
            btn.textContent = dt.label;
            btn.title = dt.desc;
            btn.dataset.type = dt.id;
            btn.addEventListener('click', () => {
                diagramTypeGrid.querySelectorAll('.diagram-type-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedDiagramType = dt.id;
            });
            diagramTypeGrid.appendChild(btn);
        });

        // Show/hide diagram selector
        drawDiagramBtn.addEventListener('click', () => {
            const isVisible = diagramSelector.style.display !== 'none';
            diagramSelector.style.display = isVisible ? 'none' : 'block';
        });

        cancelDiagramBtn.addEventListener('click', () => {
            diagramSelector.style.display = 'none';
        });

        // Handle Enter key in diagram query input → generate
        diagramQuery.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                executeDiagramGeneration(selectedDiagramType);
            }
        });

        // Also detect double-click on a type button as "generate now"
        diagramTypeGrid.addEventListener('dblclick', (e) => {
            const btn = e.target.closest('.diagram-type-btn');
            if (btn) executeDiagramGeneration(btn.dataset.type);
        });

        // Generate button (explicit action)
        if (generateDiagramBtn) {
            generateDiagramBtn.addEventListener('click', () => {
                executeDiagramGeneration(selectedDiagramType);
            });
        }

        async function executeDiagramGeneration(diagramType) {
            if (isStreaming) return;

            diagramSelector.style.display = 'none';
            const userQuery = diagramQuery.value.trim();
            const source = diagramSource.value;
            diagramQuery.value = '';

            isStreaming = true;
            setQuickActionsEnabled(false);
            drawDiagramBtn.textContent = 'Generating...';

            const label = userQuery || 'Generate diagram';
            appendMessage(`Draw Diagram: ${label} [${diagramType}]`, 'user');
            showTypingIndicator();

            try {
                // Gather content based on source selection
                let content = '';
                let page = null;

                if (source === 'page' || source === 'both') {
                    try {
                        page = await extractCurrentPage();
                        content += `Page: ${page.title}\n${page.content.substring(0, 10000)}\n\n`;
                    } catch (e) {
                        content += '(Could not extract page content)\n\n';
                    }
                }

                if (source === 'session' || source === 'both') {
                    if (sessionSnippets.length > 0) {
                        content += 'Session Snippets:\n';
                        sessionSnippets.forEach((s, i) => {
                            if (s.type === 'text' && s.content) {
                                const tags = (s.tags || []).join(', ');
                                content += `[${i + 1}]${tags ? ` (${tags})` : ''} ${s.content.substring(0, 500)}\n`;
                            }
                        });
                    }
                }

                if (!content.trim()) {
                    removeTypingIndicator();
                    appendMessage('No content available to generate a diagram. Try extracting a page first or adding snippets to the session.', 'assistant');
                    return;
                }

                // Generate diagram via LLM, labelled in the user's language.
                const result = await DiagramGenerator.generateAndRender(content, {
                    diagramType,
                    userQuery,
                    language: I18N.outputLanguageName(),
                });

                removeTypingIndicator();

                // Display the diagram in chat
                renderDiagramInChat(result, content);

            } catch (e) {
                console.error('Diagram generation error:', e);
                removeTypingIndicator();
                appendMessage(`Error generating diagram: ${e.message}`, 'assistant');
            } finally {
                isStreaming = false;
                setQuickActionsEnabled(true);
                drawDiagramBtn.textContent = 'Draw Diagram';
            }
        }

    }
});
