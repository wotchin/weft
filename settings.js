/* global PROVIDERS, getProvider, Store, LLMClient, I18N, SearchProvider, t */
document.addEventListener('DOMContentLoaded', async () => {
    await I18N.init();
    I18N.apply();

    const uiLanguageSelect = document.getElementById('uiLanguage');
    const providerSelect = document.getElementById('provider');
    const apiBaseUrlInput = document.getElementById('apiBaseUrl');
    const apiKeyInput = document.getElementById('apiKey');
    const apiKeyGroup = document.getElementById('apiKeyGroup');
    const modelNameInput = document.getElementById('modelName');
    const maxTokensInput = document.getElementById('maxTokens');
    const temperatureInput = document.getElementById('temperature');
    const reasoningModeSelect = document.getElementById('reasoningMode');
    const visionModeSelect = document.getElementById('visionMode');
    const ragEnabledInput = document.getElementById('ragEnabled');
    const ragTokenBudgetInput = document.getElementById('ragTokenBudget');
    const searchProviderSelect = document.getElementById('searchProvider');
    const searchApiKeyInput = document.getElementById('searchApiKey');
    const searchKeyGroup = document.getElementById('searchKeyGroup');
    const searchEndpointInput = document.getElementById('searchEndpoint');
    const searchEndpointGroup = document.getElementById('searchEndpointGroup');
    const searchProviderNote = document.getElementById('searchProviderNote');
    const searchTestButton = document.getElementById('testSearch');
    const searchStatus = document.getElementById('searchStatus');
    const saveButton = document.getElementById('saveSettings');
    const testButton = document.getElementById('testConnection');
    const statusMessage = document.getElementById('statusMessage');
    let statusTimer = null;

    function localized(key, fallback = '') {
        const message = t(key);
        return message === key ? fallback : message;
    }

    function formatMessage(key, params = {}) {
        let message = t(key);
        for (const [name, rawValue] of Object.entries(params)) {
            const value = typeof rawValue === 'function' ? rawValue() : rawValue;
            message = message.replaceAll(`{{${name}}}`, String(value ?? ''));
            if (name === 's') message = message.replace('%s', String(value ?? ''));
        }
        return message;
    }

    function renderStatus(element) {
        const spec = element._weftI18nStatus;
        if (!spec) return;
        element.textContent = formatMessage(spec.key, spec.params);
        element.className = `status-message ${spec.type}`;
        element.style.display = 'block';
    }

    function setStatus(element, key, type, params = {}) {
        element._weftI18nStatus = { key, type, params };
        renderStatus(element);
    }

    function showStatus(key, type = 'success', params = {}) {
        if (statusTimer) clearTimeout(statusTimer);
        setStatus(statusMessage, key, type, params);
        if (type !== 'info') {
            statusTimer = setTimeout(() => {
                statusMessage.style.display = 'none';
                statusMessage._weftI18nStatus = null;
                statusTimer = null;
            }, 4000);
        }
    }

    function rebuildLanguageOptions(selectedValue = uiLanguageSelect.value || 'auto') {
        // Every language is selectable. Those with a shipped interface bundle
        // (ui: true) also translate the interface; the rest keep the English
        // interface and only change the language the AI answers in — which is
        // what the field's hint text tells the user. I18N.init() already falls
        // back to the English bundle for them.
        const selectable = I18N.LANGUAGES;
        uiLanguageSelect.replaceChildren();
        for (const lang of selectable) {
            const opt = document.createElement('option');
            opt.value = lang.code;
            opt.textContent = localized(lang.labelKey, lang.label);
            if (!lang.ui && lang.code !== 'auto') opt.dataset.aiOnly = 'true';
            uiLanguageSelect.appendChild(opt);
        }
        // Fall back to 'auto' if the stored value is not a language we know.
        uiLanguageSelect.value = selectable.some((l) => l.code === selectedValue)
            ? selectedValue
            : 'auto';
    }

    function rebuildProviderOptions(selectedValue = providerSelect.value || 'openai') {
        providerSelect.replaceChildren();
        for (const [id, provider] of Object.entries(PROVIDERS)) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = localized(provider.labelKey, provider.label);
            providerSelect.appendChild(opt);
        }
        providerSelect.value = selectedValue;
    }

    // ---- Language ----
    const { uiLanguage } = await chrome.storage.local.get(['uiLanguage']);
    rebuildLanguageOptions(uiLanguage || 'auto');
    rebuildProviderOptions();

    function normalizeReasoning(v) {
        return v === 'on' || v === 'off' ? v : 'auto';
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

        const notes = {
            searxng: t('settings_search_note_self'),
            tavily: t('settings_search_note_tavily'),
            brave: t('settings_search_note_brave'),
        };
        searchProviderNote.textContent = notes[provider] || '';
        searchProviderNote.style.display = notes[provider] ? '' : 'none';
        searchTestButton.style.display = provider && provider !== 'none' ? '' : 'none';
    }

    function refreshDynamicCopy() {
        rebuildLanguageOptions(uiLanguageSelect.value);
        rebuildProviderOptions(providerSelect.value);
        applySearchUI(searchProviderSelect.value);
        renderStatus(statusMessage);
        renderStatus(searchStatus);
    }

    // Apply immediately so the change is visible without a save/reload.
    uiLanguageSelect.addEventListener('change', async () => {
        const selectedLanguage = uiLanguageSelect.value;
        await chrome.storage.local.set({ uiLanguage: selectedLanguage });
        await I18N.init();
        I18N.apply();
        refreshDynamicCopy();
    });

    providerSelect.value = PROVIDERS[cfg.provider] ? cfg.provider : 'openai';
    apiBaseUrlInput.value = cfg.baseUrl || '';
    apiKeyInput.value = cfg.apiKey || '';
    modelNameInput.value = cfg.model || '';
    maxTokensInput.value = cfg.maxTokens || 2000;
    temperatureInput.value = cfg.temperature != null ? cfg.temperature : 0.7;
    reasoningModeSelect.value = normalizeReasoning(cfg.reasoning);
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
            reasoning: normalizeReasoning(reasoningModeSelect.value),
            visionMode: visionModeSelect.value || 'auto',
        };
    }

    function localizeSearchError(error) {
        const message = String(error || '');
        const exact = {
            'No search provider selected.': 'settings_search_error_no_provider',
            'Tavily API key not set.': 'settings_search_error_key_required',
            'Brave API key not set.': 'settings_search_error_key_required',
            'No SearXNG address set.': 'settings_search_error_endpoint_required',
            'Address must start with http:// or https://': 'settings_search_error_endpoint_protocol',
            'The instance did not respond in time.': 'settings_search_error_timeout',
            'Could not reach that address. Check the URL and that the instance is online.': 'settings_search_error_unreachable',
            'Connected, but the provider returned no results.': 'settings_search_error_no_results',
        };
        if (exact[message]) return t(exact[message]);
        if (/web page instead of JSON|JSON API is disabled/i.test(message)) {
            return t('settings_search_error_json_disabled');
        }
        const status = /HTTP\s+(\d+)/i.exec(message)?.[1];
        if (status) return formatMessage('settings_search_error_http', { status });
        console.warn('[Weft] Unrecognized search connection error', message);
        return t('settings_search_error_unknown');
    }

    function localizeLlmError(result) {
        const keys = {
            auth: 'settings_llm_error_auth',
            rate_limit: 'settings_llm_error_rate_limit',
            context_length: 'settings_llm_error_context_length',
            network: 'settings_llm_error_network',
            timeout: 'settings_llm_error_timeout',
            abort: 'settings_llm_error_abort',
            server: 'settings_llm_error_server',
            bad_request: 'settings_llm_error_bad_request',
            empty_response: 'settings_llm_error_empty_response',
            output_limit: 'settings_llm_error_output_limit',
        };
        if (keys[result?.kind]) return t(keys[result.kind]);
        console.warn('[Weft] Unrecognized LLM connection error', result?.error);
        return t('settings_llm_error_unknown');
    }

    // Save settings
    saveButton.addEventListener('click', async () => {
        const cfgOut = readForm();
        const p = getProvider(cfgOut.provider);

        if (p.needsKey && !cfgOut.apiKey) {
            showStatus('settings_api_key_required', 'error');
            return;
        }
        if (!cfgOut.model) {
            showStatus('settings_model_required', 'error');
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
            showStatus('settings_save_success', 'success');
        } catch (error) {
            console.error('[Weft] Failed to save settings', error);
            showStatus('settings_save_error', 'error');
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

        setStatus(out, 'settings_search_testing', 'info');
        btn.disabled = true;
        try {
            const res = await SearchProvider.testConnection(cfg);
            if (res.ok) {
                setStatus(out, 'settings_search_ok', 'success', { s: res.count });
            } else {
                setStatus(out, 'settings_search_failed_detail', 'error', {
                    detail: () => localizeSearchError(res.error),
                });
            }
        } finally {
            btn.disabled = false;
        }
    });

    // Test connection via the unified client
    testButton.addEventListener('click', async () => {
        const cfgOut = readForm();
        const p = getProvider(cfgOut.provider);
        if (p.needsKey && !cfgOut.apiKey) {
            showStatus('settings_api_key_required', 'error');
            return;
        }
        if (!cfgOut.model) {
            showStatus('settings_model_required', 'error');
            return;
        }

        showStatus('settings_connection_testing', 'info');
        testButton.disabled = true;
        try {
            const result = await LLMClient.testConnection(cfgOut);
            if (result.ok) {
                showStatus('settings_connection_success', 'success');
            } else {
                // Surface raw provider metadata (finish_reason, usage, etc.)
                // to the console so the user can paste it back without us
                // having to write a separate diagnostic UI.
                console.warn('[Weft] Connection test failed. Raw result:', result);
                showStatus('settings_connection_failed_detail', 'error', {
                    detail: () => localizeLlmError(result),
                });
            }
        } catch (error) {
            console.error('[Weft] Connection test failed unexpectedly', error);
            showStatus('settings_connection_error', 'error');
        } finally {
            testButton.disabled = false;
        }
    });
});
