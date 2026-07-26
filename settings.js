/* global PROVIDERS, getProvider, Store, LLMClient, I18N, SearchProvider, t */
document.addEventListener('DOMContentLoaded', async () => {
    await I18N.init();
    I18N.apply();

    // ---- Language ----
    const uiLanguageSelect = document.getElementById('uiLanguage');
    for (const lang of I18N.LANGUAGES) {
        const opt = document.createElement('option');
        opt.value = lang.code;
        opt.textContent = lang.label;
        uiLanguageSelect.appendChild(opt);
    }
    const { uiLanguage } = await chrome.storage.local.get(['uiLanguage']);
    uiLanguageSelect.value = uiLanguage || 'auto';

    // Apply immediately so the change is visible without a save/reload.
    uiLanguageSelect.addEventListener('change', async () => {
        await chrome.storage.local.set({ uiLanguage: uiLanguageSelect.value });
        await I18N.init();
        I18N.apply();
    });

    const providerSelect = document.getElementById('provider');
    const apiBaseUrlInput = document.getElementById('apiBaseUrl');
    const apiKeyInput = document.getElementById('apiKey');
    const apiKeyGroup = document.getElementById('apiKeyGroup');
    const modelNameInput = document.getElementById('modelName');
    const maxTokensInput = document.getElementById('maxTokens');
    const temperatureInput = document.getElementById('temperature');
    const visionModeSelect = document.getElementById('visionMode');
    const ragEnabledInput = document.getElementById('ragEnabled');
    const ragTokenBudgetInput = document.getElementById('ragTokenBudget');
    const searchProviderSelect = document.getElementById('searchProvider');
    const searchApiKeyInput = document.getElementById('searchApiKey');
    const searchKeyGroup = document.getElementById('searchKeyGroup');
    const searchEndpointInput = document.getElementById('searchEndpoint');
    const searchEndpointGroup = document.getElementById('searchEndpointGroup');
    const saveButton = document.getElementById('saveSettings');
    const testButton = document.getElementById('testConnection');
    const statusMessage = document.getElementById('statusMessage');

    // Populate provider dropdown from the preset table
    for (const [id, p] of Object.entries(PROVIDERS)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = p.label;
        providerSelect.appendChild(opt);
    }

    // Normalize legacy vision values to the new vocabulary
    function normalizeVision(v) {
        if (v === 'enabled') return 'on';
        if (v === 'disabled') return 'off';
        return v || 'auto';
    }

    // Load saved config (falls back to legacy keys internally)
    const cfg = await Store.getLlmConfig();
    const { ragEnabled, ragTokenBudget, searchConfig } = await chrome.storage.local.get(['ragEnabled', 'ragTokenBudget', 'searchConfig']);

    // Search provider config
    const sc = searchConfig || { provider: 'none' };
    searchProviderSelect.value = sc.provider || 'none';
    searchApiKeyInput.value = sc.apiKey || '';
    searchEndpointInput.value = sc.endpoint || '';
    applySearchUI(searchProviderSelect.value);
    searchProviderSelect.addEventListener('change', () => applySearchUI(searchProviderSelect.value));

    function applySearchUI(provider) {
        searchKeyGroup.style.display = (provider === 'tavily' || provider === 'brave') ? '' : 'none';
        searchEndpointGroup.style.display = provider === 'searxng' ? '' : 'none';

        const note = document.getElementById('searchProviderNote');
        const testBtn = document.getElementById('testSearch');
        const notes = {
            searxng: t('settings_search_note_self'),
            tavily: t('settings_search_note_tavily'),
            brave: t('settings_search_note_brave'),
        };
        note.textContent = notes[provider] || '';
        note.style.display = notes[provider] ? '' : 'none';
        testBtn.style.display = provider && provider !== 'none' ? '' : 'none';
    }

    providerSelect.value = PROVIDERS[cfg.provider] ? cfg.provider : 'openai';
    apiBaseUrlInput.value = cfg.baseUrl || '';
    apiKeyInput.value = cfg.apiKey || '';
    modelNameInput.value = cfg.model || '';
    maxTokensInput.value = cfg.maxTokens || 2000;
    temperatureInput.value = cfg.temperature != null ? cfg.temperature : 0.7;
    visionModeSelect.value = normalizeVision(cfg.visionMode);
    ragEnabledInput.checked = !!ragEnabled;
    ragTokenBudgetInput.value = ragTokenBudget || 12000;

    applyProviderUI(providerSelect.value, { prefill: false });

    // When provider changes, prefill endpoint + default model and toggle key field
    providerSelect.addEventListener('change', () => {
        applyProviderUI(providerSelect.value, { prefill: true });
    });

    function applyProviderUI(providerId, { prefill }) {
        const p = getProvider(providerId);
        apiKeyGroup.style.display = p.needsKey ? '' : 'none';
        if (prefill) {
            if (p.baseUrl) apiBaseUrlInput.value = p.baseUrl;
            if (p.defaultModel) modelNameInput.value = p.defaultModel;
        }
    }

    function showStatus(message, type = 'success') {
        statusMessage.textContent = message;
        statusMessage.className = `status-message ${type}`;
        statusMessage.style.display = 'block';
        if (type !== 'info') {
            setTimeout(() => { statusMessage.style.display = 'none'; }, 4000);
        }
    }

    function readForm() {
        const provider = providerSelect.value;
        const p = getProvider(provider);
        const temperature = parseFloat(temperatureInput.value);
        return {
            provider,
            apiKey: apiKeyInput.value.trim(),
            baseUrl: apiBaseUrlInput.value.trim() || p.baseUrl,
            model: modelNameInput.value.trim() || p.defaultModel,
            maxTokens: parseInt(maxTokensInput.value, 10) || 2000,
            temperature: isNaN(temperature) ? 0.7 : temperature,
            visionMode: visionModeSelect.value || 'auto',
        };
    }

    // Save settings
    saveButton.addEventListener('click', async () => {
        const cfgOut = readForm();
        const p = getProvider(cfgOut.provider);

        if (p.needsKey && !cfgOut.apiKey) {
            showStatus('Please enter an API key.', 'error');
            return;
        }
        if (!cfgOut.model) {
            showStatus('Please enter a model name.', 'error');
            return;
        }

        try {
            await Store.setLlmConfig(cfgOut);
            await chrome.storage.local.set({
                ragEnabled: ragEnabledInput.checked,
                ragTokenBudget: parseInt(ragTokenBudgetInput.value, 10) || 12000,
                searchConfig: {
                    provider: searchProviderSelect.value,
                    apiKey: searchApiKeyInput.value.trim(),
                    endpoint: searchEndpointInput.value.trim(),
                },
            });
            // Clear any legacy flat keys now that we write the unified config.
            await chrome.storage.local.remove(['apiKey', 'apiBaseUrl', 'modelName']);
            showStatus('Settings saved successfully!', 'success');
        } catch (error) {
            showStatus('Error saving settings: ' + error.message, 'error');
        }
    });

    // Test the search provider (independent of the LLM connection test).
    document.getElementById('testSearch').addEventListener('click', async () => {
        const btn = document.getElementById('testSearch');
        const out = document.getElementById('searchStatus');
        const cfg = {
            provider: searchProviderSelect.value,
            apiKey: searchApiKeyInput.value.trim(),
            endpoint: searchEndpointInput.value.trim(),
        };

        out.className = 'status-message info';
        out.style.display = 'block';
        out.textContent = t('settings_search_testing');
        btn.disabled = true;
        try {
            const res = await SearchProvider.testConnection(cfg);
            out.className = `status-message ${res.ok ? 'success' : 'error'}`;
            out.textContent = res.ok
                ? t('settings_search_ok').replace('%s', res.count)
                : `${t('settings_search_fail')} ${res.error}`;
        } finally {
            btn.disabled = false;
        }
    });

    // Test connection via the unified client
    testButton.addEventListener('click', async () => {
        const cfgOut = readForm();
        const p = getProvider(cfgOut.provider);
        if (p.needsKey && !cfgOut.apiKey) {
            showStatus('Please enter an API key first.', 'error');
            return;
        }
        if (!cfgOut.model) {
            showStatus('Please enter a model name first.', 'error');
            return;
        }

        showStatus('Testing connection...', 'info');
        testButton.disabled = true;
        try {
            const result = await LLMClient.testConnection(cfgOut);
            if (result.ok) {
                showStatus(`Connection successful! Model responded: "${(result.sample || 'OK').substring(0, 50)}"`, 'success');
            } else {
                showStatus(`Connection failed: ${result.error}${result.hint ? ' — ' + result.hint : ''}`, 'error');
            }
        } catch (error) {
            showStatus(`Connection error: ${error.message}`, 'error');
        } finally {
            testButton.disabled = false;
        }
    });
});
