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

    let currentSession = null;
    let sessionSnippets = [];
    let conversationHistory = [];
    let isStreaming = false;

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

            const text = document.createElement('span');
            text.className = 'context-text';
            text.textContent = snippet.content || snippet;
            text.title = snippet.content || snippet;

            item.appendChild(num);
            item.appendChild(text);

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

    // Build system prompt with session context
    function buildSystemPrompt() {
        let systemPrompt = "You are a helpful AI assistant for Cyber Assistant, a browser extension that collects information snippets from web pages. ";
        systemPrompt += "The user has collected the following information snippets in their current session. Use them as context when responding.\n\n";
        systemPrompt += "When generating reports or structured content, you may use HTML formatting including tables, lists, headings, and SVG charts.\n\n";

        if (sessionSnippets.length > 0) {
            systemPrompt += "=== COLLECTED SNIPPETS ===\n";
            sessionSnippets.forEach((snippet, i) => {
                const content = snippet.content || snippet;
                const source = snippet.sourceTitle || snippet.sourceUrl || '';
                const tags = (snippet.tags || []).join(', ');
                systemPrompt += `\n[Snippet ${i + 1}]${tags ? ` (${tags})` : ''}${source ? ` from: ${source}` : ''}\n${content}\n`;
            });
            systemPrompt += "\n=== END SNIPPETS ===\n";
        }

        return systemPrompt;
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

    // Simple markdown to HTML converter
    function renderMarkdown(text) {
        // Detect if the response contains HTML tags (for reports/tables)
        if (/<(table|div|h[1-6]|ul|ol|svg|style|html|body|head)\b/i.test(text)) {
            // Extract HTML content, possibly wrapped in ```html code blocks
            let html = text.replace(/```html\s*([\s\S]*?)```/g, '$1');
            // If there's still remaining markdown-like text mixed in, keep it
            return html;
        }

        let html = text;
        // Code blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bold
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Italic
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // Headers
        html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
        // Unordered lists
        html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
        // Ordered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
        // Line breaks for remaining plain text
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');

        return `<p>${html}</p>`;
    }

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

        // Add to conversation history
        if (conversationHistory.length === 0) {
            conversationHistory.push({ role: "system", content: buildSystemPrompt() });
        }
        conversationHistory.push({ role: "user", content: userMessage });

        const baseUrl = apiBaseUrl.replace(/\/+$/, '');
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
            throw new Error(`API Error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
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
});
