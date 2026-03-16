document.addEventListener('DOMContentLoaded', async () => {
    const apiBaseUrlInput = document.getElementById('apiBaseUrl');
    const apiKeyInput = document.getElementById('apiKey');
    const modelNameInput = document.getElementById('modelName');
    const maxTokensInput = document.getElementById('maxTokens');
    const temperatureInput = document.getElementById('temperature');
    const saveButton = document.getElementById('saveSettings');
    const testButton = document.getElementById('testConnection');
    const statusMessage = document.getElementById('statusMessage');
    const presetButtons = document.querySelectorAll('.preset-btn');

    // Load saved settings
    const settings = await chrome.storage.local.get([
        'apiBaseUrl', 'apiKey', 'modelName', 'maxTokens', 'temperature', 'provider'
    ]);

    if (settings.apiBaseUrl) apiBaseUrlInput.value = settings.apiBaseUrl;
    if (settings.apiKey) apiKeyInput.value = settings.apiKey;
    if (settings.modelName) modelNameInput.value = settings.modelName;
    if (settings.maxTokens) maxTokensInput.value = settings.maxTokens;
    if (settings.temperature !== undefined) temperatureInput.value = settings.temperature;

    // Highlight active provider preset
    updatePresetHighlight(settings.provider || '');

    // Preset button handling
    presetButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const provider = btn.dataset.provider;
            const url = btn.dataset.url;
            const model = btn.dataset.model;

            if (provider !== 'custom') {
                apiBaseUrlInput.value = url;
                modelNameInput.value = model;
            } else {
                apiBaseUrlInput.value = '';
                modelNameInput.value = '';
                apiBaseUrlInput.focus();
            }
            updatePresetHighlight(provider);
        });
    });

    function updatePresetHighlight(provider) {
        presetButtons.forEach(b => {
            b.classList.toggle('active', b.dataset.provider === provider);
        });
    }

    function showStatus(message, type = 'success') {
        statusMessage.textContent = message;
        statusMessage.className = `status-message ${type}`;
        statusMessage.style.display = 'block';
        if (type !== 'info') {
            setTimeout(() => {
                statusMessage.style.display = 'none';
            }, 4000);
        }
    }

    // Save settings
    saveButton.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const apiBaseUrl = apiBaseUrlInput.value.trim();
        const modelName = modelNameInput.value.trim();
        const maxTokens = parseInt(maxTokensInput.value) || 2000;
        const temperature = parseFloat(temperatureInput.value);

        if (!apiKey) {
            showStatus('Please enter an API key.', 'error');
            return;
        }
        if (!apiBaseUrl) {
            showStatus('Please enter an API Base URL.', 'error');
            return;
        }
        if (!modelName) {
            showStatus('Please enter a model name.', 'error');
            return;
        }

        // Determine provider from URL
        let provider = 'custom';
        if (apiBaseUrl.includes('openai.com')) provider = 'openai';
        else if (apiBaseUrl.includes('anthropic.com')) provider = 'anthropic';
        else if (apiBaseUrl.includes('deepseek.com')) provider = 'deepseek';

        try {
            await chrome.storage.local.set({
                apiKey,
                apiBaseUrl,
                modelName,
                maxTokens,
                temperature: isNaN(temperature) ? 0.7 : temperature,
                provider
            });
            showStatus('Settings saved successfully!', 'success');
        } catch (error) {
            showStatus('Error saving settings: ' + error.message, 'error');
        }
    });

    // Test connection
    testButton.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const apiBaseUrl = apiBaseUrlInput.value.trim();
        const modelName = modelNameInput.value.trim();

        if (!apiKey || !apiBaseUrl || !modelName) {
            showStatus('Please fill in all required fields first.', 'error');
            return;
        }

        showStatus('Testing connection...', 'info');
        testButton.disabled = true;

        try {
            const baseUrl = apiBaseUrl.replace(/\/+$/, '');
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: [{ role: 'user', content: 'Hello' }],
                    max_tokens: 10
                })
            });

            if (response.ok) {
                const data = await response.json();
                const reply = data.choices?.[0]?.message?.content || 'OK';
                showStatus(`Connection successful! Model responded: "${reply.substring(0, 50)}"`, 'success');
            } else {
                const errorData = await response.json().catch(() => ({}));
                const errorMsg = errorData.error?.message || `HTTP ${response.status}`;
                showStatus(`Connection failed: ${errorMsg}`, 'error');
            }
        } catch (error) {
            showStatus(`Connection error: ${error.message}`, 'error');
        } finally {
            testButton.disabled = false;
        }
    });
});
