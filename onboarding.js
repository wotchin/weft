/* global Store, I18N, t */
(async () => {
    'use strict';

    await I18N.init();
    I18N.apply();

    // Seed a demo session so the scenarios are explorable without collecting first.
    try {
        const now = Date.now();
        const demo = [
            {
                id: 'demo-1', type: 'text',
                content: t('onboarding_demo_sales_content'),
                sourceUrl: 'https://example.com/ev-report', sourceTitle: t('onboarding_demo_sales_source'),
                timestamp: now, tags: ['stats'],
            },
            {
                id: 'demo-2', type: 'text',
                content: t('onboarding_demo_china_content'),
                sourceUrl: 'https://example.com/china-ev', sourceTitle: t('onboarding_demo_china_source'),
                timestamp: now + 1, tags: ['market'],
            },
            {
                id: 'demo-3', type: 'text',
                content: t('onboarding_demo_caution_content'),
                sourceUrl: 'https://example.com/ev-skeptic', sourceTitle: t('onboarding_demo_caution_source'),
                timestamp: now + 2, tags: ['counterpoint'],
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

    render();
})();
