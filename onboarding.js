/* global Store */
(async () => {
    'use strict';

    // Seed a demo session so the scenarios are explorable without collecting first.
    try {
        const sessions = await Store.getSessions();
        if (!sessions['Demo · Electric vehicles']) {
            const now = Date.now();
            const demo = [
                {
                    id: 'demo-1', type: 'text',
                    content: 'Global EV sales passed 14 million units in 2023, roughly 18% of all new cars sold worldwide.',
                    sourceUrl: 'https://example.com/ev-report', sourceTitle: 'Global EV Outlook',
                    timestamp: now, tags: ['stats'],
                },
                {
                    id: 'demo-2', type: 'text',
                    content: 'China accounted for about 60% of global EV sales in 2023, driven by aggressive pricing and dense charging infrastructure.',
                    sourceUrl: 'https://example.com/china-ev', sourceTitle: 'China EV Market Note',
                    timestamp: now + 1, tags: ['market'],
                },
                {
                    id: 'demo-3', type: 'text',
                    content: 'Some analysts caution that EV growth may slow in markets where charging access lags and subsidies are being phased out.',
                    sourceUrl: 'https://example.com/ev-skeptic', sourceTitle: 'A More Cautious View',
                    timestamp: now + 2, tags: ['counterpoint'],
                },
            ];
            const all = await Store.getSessions();
            all['Demo · Electric vehicles'] = demo;
            await Store.setSessions(all);
            await Store.setCurrentSession('Demo · Electric vehicles');
        }
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
        nextBtn.textContent = i === steps.length - 1 ? 'Get started' : 'Next';
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
