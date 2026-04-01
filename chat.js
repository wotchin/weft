document.addEventListener('DOMContentLoaded', async function() {
    const chatMessages = document.getElementById('chatMessages');
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendMessage');
    const clearButton = document.getElementById('clearChat');
    const exportBtn = document.getElementById('exportBtn');
    const sessionBadge = document.getElementById('sessionBadge');
    const contextPanel = document.getElementById('contextPanel');
    const contextBody = document.getElementById('contextBody');
    const toggleContext = document.getElementById('toggleContext');
    const templateSelect = document.getElementById('templateSelect');

    const askPageBtn = document.getElementById('askPageBtn');
    const takeawaysBtn = document.getElementById('takeawaysBtn');
    const deepSearchBtn = document.getElementById('deepSearchBtn');
    const drawDiagramBtn = document.getElementById('drawDiagramBtn');
    const diagramSelector = document.getElementById('diagramSelector');
    const diagramTypeGrid = document.getElementById('diagramTypeGrid');
    const diagramQuery = document.getElementById('diagramQuery');
    const diagramSource = document.getElementById('diagramSource');
    const cancelDiagramBtn = document.getElementById('cancelDiagram');
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
    let pageContent = null; // cached page extraction result
    let pendingSearchPlan = null; // LLM-generated search plan awaiting confirmation

    // Prompt templates
    const promptTemplates = {
        summarize: "Please summarize the following collected information into a concise, well-structured overview. Highlight the key themes and main takeaways.",
        report: "Based on the following collected information, generate a detailed analysis report in HTML format. Include: an executive summary, key findings with supporting data, analysis of trends or patterns, and conclusions with recommendations. Use tables and lists where appropriate. Wrap the entire report in styled HTML.",
        compare: "Compare and contrast the different perspectives, data points, or viewpoints found in the following collected information. Present the comparison in a clear, structured format with a table if applicable.",
        extract: "Extract and list the key points, important facts, and critical data from the following collected information. Organize them by topic or category.",
        table: "Organize the following collected information into a well-structured table (HTML format). Identify appropriate column headers based on the data patterns.",
        translate_zh: "Please translate the following collected information into Chinese. Maintain the original structure and meaning.",
        translate_en: "Please translate the following collected information into English. Maintain the original structure and meaning.",
    };

    // Load session context
    const { currentSession: savedSession } = await chrome.storage.local.get(['currentSession']);
    currentSession = savedSession;

    if (currentSession) {
        sessionBadge.textContent = currentSession;
        const { sessions } = await chrome.storage.local.get(['sessions']);
        if (sessions && sessions[currentSession]) {
            sessionSnippets = sessions[currentSession];
            renderContextPanel();
            // Try to re-cache any images that are missing base64 data
            reCacheMissingImages();
        }
    }

    // Ask background script to re-fetch images without cached base64 data
    async function reCacheMissingImages() {
        const hasMissing = sessionSnippets.some(s => s.type === 'image' && !s.cachedDataUrl);
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
        if (sessionSnippets.length === 0) {
            contextBody.innerHTML = '<div class="context-empty">No snippets in this session</div>';
            return;
        }
        sessionSnippets.forEach((snippet, index) => {
            const item = document.createElement('div');
            item.className = 'context-item';

            const num = document.createElement('span');
            num.className = 'context-num';
            num.textContent = `#${index + 1}`;

            item.appendChild(num);

            if (snippet.type === 'image') {
                const img = document.createElement('img');
                img.className = 'context-image';
                img.src = snippet.cachedDataUrl || snippet.imageUrl || '';
                img.alt = 'image snippet';
                img.style.maxWidth = '80px';
                img.style.maxHeight = '60px';
                img.style.borderRadius = '4px';
                img.style.verticalAlign = 'middle';
                item.appendChild(img);

                // Cache status indicator
                const status = document.createElement('span');
                status.style.cssText = 'font-size:10px; margin-left:4px; vertical-align:middle;';
                if (snippet.cachedDataUrl) {
                    status.textContent = '[cached]';
                    status.style.color = '#4caf50';
                    status.title = 'Image cached as base64 — will be sent to AI';
                } else {
                    status.textContent = '[not cached]';
                    status.style.color = '#f44336';
                    status.title = 'Image not cached — AI will not be able to see this image';
                }
                item.appendChild(status);

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
                snippet.tags.forEach(t => {
                    const tag = document.createElement('span');
                    tag.className = 'context-tag';
                    tag.textContent = t;
                    item.appendChild(tag);
                });
            }

            contextBody.appendChild(item);
        });
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
        const { visionMode = 'auto', modelName = '' } = await chrome.storage.local.get(['visionMode', 'modelName']);
        if (visionMode === 'enabled') return true;
        if (visionMode === 'disabled') return false;
        // auto: 根据模型名匹配
        return VISION_CAPABLE_PATTERNS.some(pattern => pattern.test(modelName));
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
                        text += `\n[Snippet ${i + 1}] (image — embedded in the conversation)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n`;
                    } else {
                        text += `\n[Snippet ${i + 1}] (image, not displayed - model does not support vision)${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\nImage URL: ${snippet.imageUrl || '(no url)'}\nNote: This is an image snippet. The image cannot be displayed to you because the current model does not support vision/multimodal input. The user saved this image from the webpage above.\n`;
                    }
                } else {
                    text += `\n[Snippet ${i + 1}]${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n${content}\n`;
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

        let intro = "You are a helpful AI assistant for Cyber Assistant, a browser extension that collects information snippets from web pages. ";
        intro += "The user has collected the following information snippets in their current session. Use them as context when responding.\n\n";
        intro += "When generating reports or structured content, you may use HTML formatting including tables, lists, headings, and SVG charts.\n\n";

        const snippetsText = ragResult
            ? RAGEngine.buildFilteredSnippetsText(ragResult, visionEnabled)
            : buildSnippetsText(visionEnabled);

        return { role: "system", content: intro + snippetsText };
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

        sessionSnippets.forEach((snippet, i) => {
            if (snippet.type === 'image') {
                if (snippet.cachedDataUrl) {
                    const source = snippet.sourceTitle || snippet.sourceUrl || 'unknown source';
                    const tags = (snippet.tags || []).join(', ');
                    contentParts.push({
                        type: "text",
                        text: `[Image ${i + 1}]${tags ? ` (${tags})` : ''} from: ${source}`
                    });
                    contentParts.push({
                        type: "image_url",
                        image_url: { url: snippet.cachedDataUrl, detail: "auto" }
                    });
                    imageCount++;
                } else {
                    contentParts.push({
                        type: "text",
                        text: `[Image ${i + 1}] (could not load — original URL: ${snippet.imageUrl || 'unknown'})`
                    });
                }
            }
        });

        if (imageCount === 0) return null;

        // Brief intro at the top
        contentParts.unshift({ type: "text", text: "Images from collected snippets:" });
        return contentParts;
    }

    // Template selection
    templateSelect.addEventListener('change', () => {
        const value = templateSelect.value;
        if (value === 'custom') {
            userInput.value = '';
            userInput.placeholder = 'Enter your custom prompt...';
            userInput.focus();
        } else if (value && promptTemplates[value]) {
            userInput.value = promptTemplates[value];
            userInput.style.height = 'auto';
            userInput.style.height = userInput.scrollHeight + 'px';
        }
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

    // Send message with streaming
    async function sendMessageToAPI(userMessage) {
        const {
            apiKey,
            apiBaseUrl = 'https://api.openai.com',
            modelName = 'gpt-4o-mini',
            maxTokens = 2000,
            temperature = 0.7
        } = await chrome.storage.local.get([
            'apiKey', 'apiBaseUrl', 'modelName', 'maxTokens', 'temperature'
        ]);

        if (!apiKey) {
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
        // so the LLM sees images + query together (standard OpenAI multimodal format).
        // For follow-up messages, images are already in conversation history.
        const isFirstUserMessage = conversationHistory.length === 1; // only system msg
        const imageParts = isFirstUserMessage ? await buildImageContentParts() : null;

        if (imageParts) {
            // Multimodal message: images + user text in ONE content array
            conversationHistory.push({
                role: "user",
                content: [
                    ...imageParts,
                    { type: "text", text: userMessage }
                ]
            });
        } else {
            // Plain text message (no images, or follow-up turn)
            conversationHistory.push({ role: "user", content: userMessage });
        }

        const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: conversationHistory,
                temperature: parseFloat(temperature),
                max_tokens: parseInt(maxTokens),
                stream: true
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errMsg = errorData.error?.message || 'Unknown error';
            let hint = '';
            if (response.status === 401 || response.status === 403) {
                hint = '\nPlease check: 1) API key is valid; 2) API Base URL matches your provider; 3) The model name is accessible with your key.';
            }
            throw new Error(`API Error: ${response.status} - ${errMsg}${hint}`);
        }

        return response;
    }

    // Process streaming response
    async function processStream(response, messageContentEl) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]') break;

                    try {
                        const json = JSON.parse(data);
                        const delta = json.choices?.[0]?.delta?.content;
                        if (delta) {
                            fullContent += delta;
                            // Live render markdown
                            messageContentEl.innerHTML = renderMarkdown(fullContent);
                            chatMessages.scrollTop = chatMessages.scrollHeight;
                        }
                    } catch (e) {
                        // Skip malformed chunks
                    }
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') throw error;
        }

        // Final render
        messageContentEl.innerHTML = renderMarkdown(fullContent);

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

            const btnRow = document.createElement('div');
            btnRow.className = 'message-actions';
            btnRow.appendChild(copyBtn);
            btnRow.appendChild(copyHtmlBtn);
            messageDiv.appendChild(btnRow);
        }

        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return contentDiv;
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
    async function handleSend() {
        const message = userInput.value.trim();
        if (!message || isStreaming) return;

        isStreaming = true;
        sendButton.disabled = true;

        // Add user message to UI
        appendMessage(message, 'user');
        userInput.value = '';
        userInput.style.height = 'auto';
        templateSelect.value = '';

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
            appendMessage(`Error: ${error.message}`, 'assistant');
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

        let intro = "You are a helpful AI assistant for Cyber Assistant, a browser extension that collects information snippets from web pages. ";
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

        return { role: "system", content: intro + snippetsText + pageText };
    }

    // Send a message with page context (used by quick action buttons)
    async function sendWithPageContext(userMessage, page) {
        if (isStreaming) return;
        isStreaming = true;
        sendButton.disabled = true;
        setQuickActionsEnabled(false);

        appendMessage(userMessage, 'user');
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

            const {
                apiKey,
                apiBaseUrl = 'https://api.openai.com',
                modelName = 'gpt-4o-mini',
                maxTokens = 2000,
                temperature = 0.7
            } = await chrome.storage.local.get([
                'apiKey', 'apiBaseUrl', 'modelName', 'maxTokens', 'temperature'
            ]);

            if (!apiKey) throw new Error('API key not found. Please configure it in Settings.');

            const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: conversationHistory,
                    temperature: parseFloat(temperature),
                    max_tokens: parseInt(maxTokens),
                    stream: true
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`API Error: ${response.status} - ${errorData.error?.message || 'Unknown'}`);
            }

            removeTypingIndicator();
            const contentDiv = appendMessage('', 'assistant', true);
            await processStream(response, contentDiv);
        } catch (error) {
            console.error('Error:', error);
            removeTypingIndicator();
            appendMessage(`Error: ${error.message}`, 'assistant');
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
    }

    // "Ask about this page" handler
    askPageBtn.addEventListener('click', async () => {
        try {
            askPageBtn.disabled = true;
            askPageBtn.textContent = 'Extracting...';
            const page = await extractCurrentPage();
            askPageBtn.textContent = 'Ask about this page';

            // Show page info in context panel
            showPageIndicator(page);

            const question = userInput.value.trim() || 'Please analyze this webpage content and provide a comprehensive summary. What is the main topic, key arguments, and important details?';
            userInput.value = '';
            await sendWithPageContext(question, page);
        } catch (e) {
            askPageBtn.textContent = 'Ask about this page';
            askPageBtn.disabled = false;
            appendMessage(`Error extracting page: ${e.message}`, 'assistant');
        }
    });

    // "Key Takeaways" handler — structured JSON with source quotes + highlights
    takeawaysBtn.addEventListener('click', async () => {
        if (isStreaming) return;
        try {
            takeawaysBtn.disabled = true;
            takeawaysBtn.textContent = 'Extracting...';
            const page = await extractCurrentPage();

            showPageIndicator(page);
            takeawaysBtn.textContent = 'Analyzing...';

            // Clear previous highlights
            try { await Highlighter.clearAll(); } catch (e) { /* ok */ }

            // Phase 1: Ask LLM for structured takeaways with source quotes
            const takeawaysData = await requestStructuredTakeaways(page);

            if (!takeawaysData || !takeawaysData.takeaways || takeawaysData.takeaways.length === 0) {
                // Fallback: do a normal text-based takeaway
                takeawaysBtn.textContent = 'Key Takeaways';
                const fallbackPrompt = `Based on the current webpage content, extract the key takeaways and main insights. Please organize them as:\n\n1. **Main Topic/Theme**: What is this page about?\n2. **Key Points**: List the most important points (5-10 bullet points)\n3. **Key Data/Facts**: Any specific numbers, statistics, or factual claims\n4. **Author's Perspective**: What viewpoint or argument is being made?\n5. **Actionable Insights**: What can the reader do with this information?\n\nBe concise but thorough.`;
                await sendWithPageContext(fallbackPrompt, page);
                return;
            }

            // Phase 2: Inject highlights into the webpage
            takeawaysBtn.textContent = 'Highlighting...';
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
            appendMessage(`Error: ${e.message}`, 'assistant');
        } finally {
            takeawaysBtn.textContent = 'Key Takeaways';
            takeawaysBtn.disabled = false;
        }
    });

    /**
     * Ask LLM to return structured takeaways with exact source quotes.
     * Non-streaming call that returns parsed JSON.
     */
    async function requestStructuredTakeaways(page) {
        const {
            apiKey,
            apiBaseUrl = 'https://api.openai.com',
            modelName = 'gpt-4o-mini',
            temperature = 0.3,
        } = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'modelName', 'temperature']);

        if (!apiKey) throw new Error('API key not configured');

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

        const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Analyze the following webpage content and extract structured key takeaways with exact source quotes.\n\nTitle: ${page.title}\nURL: ${page.url}\n\n${page.content.substring(0, 40000)}` }
                ],
                temperature: parseFloat(temperature),
                max_tokens: 3000,
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        // Parse JSON (handle markdown code fences)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('No JSON found in LLM response:', content);
            return null;
        }

        try {
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.warn('Failed to parse takeaways JSON:', e, content);
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
        const {
            apiKey,
            apiBaseUrl = 'https://api.openai.com',
            modelName = 'gpt-4o-mini',
            temperature = 0.3,
        } = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'modelName', 'temperature']);

        if (!apiKey) throw new Error('API key not configured');

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

        const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `${highlightDesc}\n\n=== FULL PAGE CONTENT ===\nTitle: ${page.title}\nURL: ${page.url}\n\n${page.content.substring(0, 35000)}` }
                ],
                temperature: parseFloat(temperature),
                max_tokens: 3000,
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        try { return JSON.parse(jsonMatch[0]); }
        catch (e) { console.warn('Regen parse failed:', e); return null; }
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
            appendMessage('Please enter a question or topic in the input field, then click Deep Search.', 'assistant');
            return;
        }

        try {
            deepSearchBtn.disabled = true;
            deepSearchBtn.textContent = 'Planning...';

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
            deepSearchBtn.textContent = 'Deep Search';
            deepSearchBtn.disabled = false;
        }
    });

    // Ask LLM to generate search queries
    async function generateSearchPlan(userQuery, page) {
        const {
            apiKey,
            apiBaseUrl = 'https://api.openai.com',
            modelName = 'gpt-4o-mini',
        } = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'modelName']);

        if (!apiKey) throw new Error('API key not configured');

        let contextHint = '';
        if (page) {
            contextHint = `\n\nThe user is currently on a webpage titled "${page.title}" (${page.url}).`;
            contextHint += `\nPage description: ${page.description || 'N/A'}`;
            contextHint += `\nPage excerpt: ${page.content.substring(0, 1000)}...`;
        }
        if (sessionSnippets.length > 0) {
            contextHint += `\n\nThe user has ${sessionSnippets.length} collected snippets in their session.`;
        }

        const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [
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
                ],
                temperature: 0.3,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        // Parse JSON from response (handle markdown code blocks)
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
            div.innerHTML = `
                <span class="plan-item-num">${i + 1}.</span>
                <div>
                    <div class="plan-item-query">${item.query}</div>
                    <div class="plan-item-reason">${item.reason}</div>
                </div>
            `;
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
            // Execute search plan
            const searchResults = await WebSearcher.executePlan(plan, (step, total, msg) => {
                const pct = Math.round((step / total) * 100);
                progressFill.style.width = pct + '%';
                progressText.textContent = `(${step}/${total}) ${msg}`;
            });

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
            let intro = "You are a helpful AI assistant for Cyber Assistant. ";
            intro += "The user has asked a question. Below is context from their session snippets, the current webpage, and web search results gathered to help answer the question.\n";
            intro += "Synthesize all available information to provide a comprehensive, well-structured answer. Cite sources when possible.\n\n";

            const snippetsText = buildSnippetsText(visionEnabled);
            let pageText = '';
            if (page && page.content) {
                pageText += "\n=== CURRENT PAGE CONTENT ===\n";
                pageText += `Title: ${page.title}\nURL: ${page.url}\n`;
                pageText += page.content.substring(0, 30000) + '\n';
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

            const {
                apiKey,
                apiBaseUrl = 'https://api.openai.com',
                modelName = 'gpt-4o-mini',
                maxTokens = 2000,
                temperature = 0.7
            } = await chrome.storage.local.get([
                'apiKey', 'apiBaseUrl', 'modelName', 'maxTokens', 'temperature'
            ]);

            if (!apiKey) throw new Error('API key not configured');

            const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: conversationHistory,
                    temperature: parseFloat(temperature),
                    max_tokens: parseInt(maxTokens),
                    stream: true
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`API Error: ${response.status} - ${errorData.error?.message || 'Unknown'}`);
            }

            removeTypingIndicator();
            const contentDiv = appendMessage('', 'assistant', true);
            await processStream(response, contentDiv);
        } catch (error) {
            console.error('Error:', error);
            removeTypingIndicator();
            appendMessage(`Error: ${error.message}`, 'assistant');
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
<html><head><meta charset="UTF-8"><title>Cyber Assistant Export</title>
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

    // Listen for snippet changes from background.js to invalidate RAG cache
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'snippetsChanged') {
            RAGEngine.invalidateCache(msg.sessionName || currentSession);
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
        svgDiv.innerHTML = result.svg;
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
                    'Diagram — Cyber Assistant',
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
            if (!askAIContext || !askAIContext.selectedText) return;

            // Clear the context so it's not re-used on next open
            await chrome.storage.local.remove('askAIContext');

            const { selectedText, question, questionType, sourceUrl, sourceTitle } = askAIContext;

            // Diagram mode: auto-generate a diagram from the selected text
            if (questionType === 'diagram') {
                appendMessage(`[Generate diagram for selected text from ${sourceTitle || sourceUrl || 'page'}]`, 'user');
                showTypingIndicator();

                try {
                    const cjk = (selectedText.match(/[\u4e00-\u9fff]/g) || []).length;
                    const lang = cjk / selectedText.length > 0.15 ? 'zh' : 'en';

                    const result = await DiagramGenerator.generateAndRender(selectedText, {
                        diagramType: 'auto',
                        language: lang,
                    });

                    removeTypingIndicator();
                    renderDiagramInChat(result, selectedText);
                } catch (e) {
                    removeTypingIndicator();
                    appendMessage(`Error generating diagram: ${e.message}`, 'assistant');
                }
                return;
            }

            // If freeform, pre-fill the input and let user type
            if (questionType === 'freeform' || !question) {
                // Show the selected text as context
                appendMessage(`[Selected text from ${sourceTitle || sourceUrl || 'page'}]:\n"${selectedText}"`, 'user');
                userInput.placeholder = 'Type your question about this text...';
                userInput.focus();

                // Store context so when user sends, we include it
                window._askAISelectedText = selectedText;
                window._askAISource = { url: sourceUrl, title: sourceTitle };
                return;
            }

            // Auto-send with the pre-defined question
            const fullMessage = `Regarding this text from "${sourceTitle || sourceUrl || 'a webpage'}":\n\n"${selectedText}"\n\n${question}`;

            // Build system message with session context
            conversationHistory = [];
            conversationHistory.push(await buildSystemMessage());

            conversationHistory.push({ role: "user", content: fullMessage });

            appendMessage(`"${selectedText.substring(0, 200)}${selectedText.length > 200 ? '...' : ''}"`, 'user');
            appendMessage(getQuestionLabel(questionType), 'user');
            showTypingIndicator();

            try {
                const {
                    apiKey,
                    apiBaseUrl = 'https://api.openai.com',
                    modelName = 'gpt-4o-mini',
                    maxTokens = 2000,
                    temperature = 0.7
                } = await chrome.storage.local.get([
                    'apiKey', 'apiBaseUrl', 'modelName', 'maxTokens', 'temperature'
                ]);

                if (!apiKey) throw new Error('API key not configured');

                const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
                const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: modelName,
                        messages: conversationHistory,
                        temperature: parseFloat(temperature),
                        max_tokens: parseInt(maxTokens),
                        stream: true
                    })
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(`API Error: ${response.status} - ${err.error?.message || 'Unknown'}`);
                }

                removeTypingIndicator();
                const contentDiv = appendMessage('', 'assistant', true);
                await processStream(response, contentDiv);
            } catch (error) {
                removeTypingIndicator();
                appendMessage(`Error: ${error.message}`, 'assistant');
            }
        })();
    }

    function getQuestionLabel(type) {
        const labels = {
            'reliability': 'Check reliability & sources',
            'similar': 'Find similar viewpoints',
            'opposing': 'Find opposing viewpoints',
            'explain': 'Explain in simple terms',
            'factcheck': 'Fact-check this claim',
        };
        return labels[type] || 'Ask AI';
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

                // Detect language
                const cjk = (content.match(/[\u4e00-\u9fff]/g) || []).length;
                const language = cjk / content.length > 0.15 ? 'zh' : 'en';

                // Generate diagram via LLM
                const result = await DiagramGenerator.generateAndRender(content, {
                    diagramType,
                    userQuery,
                    language,
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
