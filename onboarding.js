/* global Store, I18N, t */
(async () => {
    'use strict';

    await I18N.init();
    I18N.apply();

    // Seed a demo session so the scenarios are explorable without collecting first.
    // The seed content is intentionally about Weft itself: every new snippet
    // doubles as a feature vignette (traceability, Sessions, Deep Search,
    // Smart Read), so the demo also reads like documentation.
    try {
        const now = Date.now();
        const sharedSource = {
            sourceUrl: t('onboarding_demo_source_url'),
            sourceTitle: t('onboarding_demo_source_title'),
        };
        const demo = [
            {
                id: 'demo-1', type: 'text',
                content: t('onboarding_demo_snippet_1_content'),
                ...sharedSource,
                timestamp: now, tags: ['key-point', 'smart-read'],
                comment: t('onboarding_demo_snippet_1_comment'),
            },
            {
                id: 'demo-2', type: 'text',
                content: t('onboarding_demo_snippet_2_content'),
                ...sharedSource,
                timestamp: now + 1, tags: ['key-point', 'smart-read'],
                comment: t('onboarding_demo_snippet_2_comment'),
            },
            {
                id: 'demo-3', type: 'text',
                content: t('onboarding_demo_snippet_3_content'),
                ...sharedSource,
                timestamp: now + 2, tags: ['key-point', 'smart-read'],
                comment: t('onboarding_demo_snippet_3_comment'),
            },
            {
                id: 'demo-4', type: 'text',
                content: t('onboarding_demo_snippet_4_content'),
                ...sharedSource,
                timestamp: now + 3, tags: ['key-point', 'smart-read'],
                comment: t('onboarding_demo_snippet_4_comment'),
            },
            {
                id: 'demo-5', type: 'text',
                content: t('onboarding_demo_snippet_5_content'),
                ...sharedSource,
                timestamp: now + 4, tags: ['key-point', 'smart-read'],
                comment: t('onboarding_demo_snippet_5_comment'),
            },
        ];
        await Store.createSessionIfMissing(t('onboarding_demo_session'), demo, { activate: true });
    } catch (e) {
        console.warn('[Weft] demo seed failed', e);
    }

    const steps = Array.from(document.querySelectorAll('.step'));
    const dots = Array.from(document.querySelectorAll('.dot'));
    const nextBtn = document.getElementById('nextBtn');
    const skipBtn = document.getElementById('skipBtn');
    let i = 0;

    function render() {
        steps.forEach((s, n) => s.classList.toggle('active', n === i));
        dots.forEach((d, n) => d.classList.toggle('active', n === i));
        nextBtn.textContent = i === steps.length - 1
            ? t('onboarding_get_started')
            : t('onboarding_next');
    }

    nextBtn.addEventListener('click', () => {
        if (i < steps.length - 1) { i++; render(); }
        else { window.close(); }
    });
    skipBtn.addEventListener('click', () => window.close());

    document.getElementById('openSettings').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });

    // ── First-run provider consent (step 1) ────────────────────────────
    // background.js has already probed LanguageModel.availability() and
    // written either 'builtin' (Chrome 138+ on-device AI available) or
    // 'custom' (fallback). This block reconciles the step-1 UI with that
    // choice and lets the user opt in/out of the ~1.5 GB model download.
    const builtinConsent = document.getElementById('builtinConsent');
    const manualConnect = document.getElementById('manualConnect');
    const useBuiltinBtn = document.getElementById('useBuiltinBtn');
    const declineBuiltinBtn = document.getElementById('declineBuiltinBtn');
    const builtinChosen = document.getElementById('builtinChosen');

    let detectedProvider = 'custom';
    let builtinModelStatus = '';
    try {
        const cfg = await Store.getLlmConfig();
        detectedProvider = cfg.provider || 'custom';
        builtinModelStatus = cfg.builtinModelStatus || '';
    } catch (e) {
        console.warn('[Weft] could not read llm config in onboarding', e);
    }

    // Show the consent card only when the probe selected 'builtin'. The
    // other branches (custom fallback, or prior-install user with their
    // own provider already selected) get the standard manual-setup copy.
    if (detectedProvider === 'builtin') {
        builtinConsent.hidden = false;
        manualConnect.hidden = true;
        // Switch the description based on whether the on-device model is
        // already downloaded (LanguageModel.availability() === 'available')
        // or whether the first chat will trigger a multi-GB download
        // (=== 'downloadable'). Falls back to the download variant when
        // the status is missing or unrecognized — being transparent about
        // a possible large download is the safer default.
        const readyDesc = document.getElementById('builtinDetectedReadyDesc');
        const downloadDesc = document.getElementById('builtinDetectedDownloadDesc');
        if (builtinModelStatus === 'available') {
            if (readyDesc) readyDesc.hidden = false;
            if (downloadDesc) downloadDesc.hidden = true;
        } else {
            if (readyDesc) readyDesc.hidden = true;
            if (downloadDesc) downloadDesc.hidden = false;
        }
    } else {
        builtinConsent.hidden = true;
        manualConnect.hidden = false;
    }

    // Confirm built-in AI: leave the config as-is (already 'builtin'),
    // collapse the prompt, and show a one-line confirmation so the user
    // sees the decision was applied.
    useBuiltinBtn.addEventListener('click', () => {
        useBuiltinBtn.hidden = true;
        declineBuiltinBtn.hidden = true;
        builtinChosen.hidden = false;
    });

    // Decline: switch to the generic OpenAI-compatible custom provider with
    // blank fields and send the user to Settings to pick a real endpoint +
    // key. Better than silently leaving builtin-as-default after a decline.
    declineBuiltinBtn.addEventListener('click', async () => {
        try {
            await Store.setLlmConfig({
                provider: 'custom',
                apiKey: '',
                baseUrl: '',
                model: '',
            });
        } catch (e) {
            console.warn('[Weft] failed to reset provider to custom', e);
        }
        builtinConsent.hidden = true;
        manualConnect.hidden = false;
        chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });

    render();
})();
