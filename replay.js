/**
 * Knowledge Replay — Review UI with spaced repetition.
 *
 * Shows due snippets as flashcard-style review cards.
 * Optionally generates LLM questions for deeper recall.
 */
(async () => {
    'use strict';

    const sessionSelect = document.getElementById('sessionSelect');
    const statsBar = document.getElementById('statsBar');
    const statDue = document.getElementById('statDue');
    const statReviewed = document.getElementById('statReviewed');
    const statMastered = document.getElementById('statMastered');
    const statTotal = document.getElementById('statTotal');
    const progressFill = document.getElementById('progressFill');
    const emptyState = document.getElementById('emptyState');
    const cardArea = document.getElementById('cardArea');
    const doneState = document.getElementById('doneState');
    const doneStats = document.getElementById('doneStats');

    const cardCounter = document.getElementById('cardCounter');
    const cardSnippet = document.getElementById('cardSnippet');
    const questionArea = document.getElementById('questionArea');
    const cardQuestion = document.getElementById('cardQuestion');
    const showAnswerBtn = document.getElementById('showAnswerBtn');
    const cardAnswer = document.getElementById('cardAnswer');
    const cardMeta = document.getElementById('cardMeta');
    const againBtn = document.getElementById('againBtn');
    const gotItBtn = document.getElementById('gotItBtn');
    const cardLevel = document.getElementById('cardLevel');

    let sessions = {};
    let replayData = {};
    let currentSession = null;
    let dueQueue = [];      // Array of { replayItem, snippet }
    let currentIndex = 0;
    let sessionReviewCount = 0;

    // ---- Init ----
    const stored = await chrome.storage.local.get(['sessions', 'currentSession', 'replayData']);
    sessions = stored.sessions || {};
    replayData = stored.replayData || {};
    currentSession = stored.currentSession || Object.keys(sessions)[0] || 'default';

    populateSessionSelect();
    await loadSession(currentSession);

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

    sessionSelect.addEventListener('change', async () => {
        currentSession = sessionSelect.value;
        await loadSession(currentSession);
    });

    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadSession(currentSession);
    });

    // ---- Load session ----
    async function loadSession(sessionName) {
        const snippets = sessions[sessionName] || [];

        // Initialize replay data for this session
        replayData = ReplayScheduler.initSession(sessionName, snippets, replayData);
        await chrome.storage.local.set({ replayData });

        const sessionItems = replayData[sessionName] || [];
        const stats = ReplayScheduler.getSessionStats(sessionItems);

        // Update stats
        statDue.textContent = stats.due;
        statReviewed.textContent = stats.reviewed;
        statMastered.textContent = stats.mastered;
        statTotal.textContent = stats.total;

        // Build due queue
        const dueItems = ReplayScheduler.getDueItems(sessionItems);
        dueQueue = [];
        for (const item of dueItems) {
            const snippet = snippets.find(s => s.id === item.snippetId);
            if (snippet) {
                dueQueue.push({ replayItem: item, snippet });
            }
        }

        currentIndex = 0;
        sessionReviewCount = 0;

        if (dueQueue.length === 0) {
            emptyState.style.display = '';
            cardArea.style.display = 'none';
            doneState.style.display = 'none';
            progressFill.style.width = '100%';
        } else {
            emptyState.style.display = 'none';
            doneState.style.display = 'none';
            cardArea.style.display = '';
            progressFill.style.width = '0%';
            showCard();
        }
    }

    // ---- Show current card ----
    async function showCard() {
        if (currentIndex >= dueQueue.length) {
            showDone();
            return;
        }

        const { replayItem, snippet } = dueQueue[currentIndex];

        cardCounter.textContent = `${currentIndex + 1} / ${dueQueue.length}`;
        cardSnippet.textContent = snippet.content || '';

        // Meta
        let metaHtml = '';
        if (snippet.sourceTitle) metaHtml += `<span>${esc(snippet.sourceTitle)}</span>`;
        if (snippet.tags && snippet.tags.length > 0) {
            metaHtml += `<span>${snippet.tags.map(t => `#${esc(t)}`).join(' ')}</span>`;
        }
        if (replayItem.reviewCount > 0) {
            metaHtml += `<span>Reviewed ${replayItem.reviewCount}x</span>`;
        }
        cardMeta.innerHTML = metaHtml;

        // Level indicator
        const level = replayItem.reviewLevel;
        const intervals = ReplayScheduler.INTERVALS_DAYS;
        const dots = intervals.map((d, i) =>
            `<span style="color: ${i <= level ? '#7b1fa2' : '#ddd'}; font-size: 14px;">●</span>`
        ).join(' ');
        cardLevel.innerHTML = `Level ${level} ${dots} (next: ${intervals[level]}d)`;

        // Try to generate a question via LLM
        questionArea.style.display = 'none';
        cardAnswer.style.display = 'none';
        showAnswerBtn.style.display = '';

        tryGenerateQuestion(snippet);

        // Update progress
        progressFill.style.width = `${(currentIndex / dueQueue.length) * 100}%`;
    }

    // ---- LLM question generation (optional, non-blocking) ----
    async function tryGenerateQuestion(snippet) {
        try {
            const { apiKey, apiBaseUrl = 'https://api.openai.com', modelName = 'gpt-4o-mini' } =
                await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'modelName']);

            if (!apiKey) return; // No API key — skip question generation

            const cjk = ((snippet.content || '').match(/[\u4e00-\u9fff]/g) || []).length;
            const lang = cjk / (snippet.content || ' ').length > 0.15 ? '中文' : 'English';
            const prompt = ReplayScheduler.buildQuestionPrompt(snippet, lang);

            const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: modelName,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 300,
                    temperature: 0.5,
                }),
            });

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content || '';
            if (!text) return;

            const { question, answer } = ReplayScheduler.parseQA(text);

            questionArea.style.display = '';
            cardQuestion.textContent = question;
            cardAnswer.textContent = answer;
            cardAnswer.style.display = 'none';
            showAnswerBtn.style.display = '';
        } catch {
            // Silently skip — question generation is optional
        }
    }

    showAnswerBtn.addEventListener('click', () => {
        cardAnswer.style.display = '';
        showAnswerBtn.style.display = 'none';
    });

    // ---- Review actions ----
    gotItBtn.addEventListener('click', async () => {
        await reviewCurrent(true);
    });

    againBtn.addEventListener('click', async () => {
        await reviewCurrent(false);
    });

    async function reviewCurrent(gotIt) {
        if (currentIndex >= dueQueue.length) return;

        const { replayItem } = dueQueue[currentIndex];
        ReplayScheduler.markReviewed(replayItem, gotIt);
        sessionReviewCount++;

        // Save
        await chrome.storage.local.set({ replayData });

        // Update badge
        const totalDue = ReplayScheduler.getTotalDueCount(replayData);
        if (totalDue > 0) {
            chrome.action.setBadgeText({ text: String(totalDue) });
        } else {
            chrome.action.setBadgeText({ text: '' });
        }

        // Update stats
        const sessionItems = replayData[currentSession] || [];
        const stats = ReplayScheduler.getSessionStats(sessionItems);
        statDue.textContent = stats.due;
        statReviewed.textContent = stats.reviewed;
        statMastered.textContent = stats.mastered;

        // Next card
        currentIndex++;
        showCard();
    }

    // ---- Done state ----
    function showDone() {
        cardArea.style.display = 'none';
        doneState.style.display = '';
        progressFill.style.width = '100%';
        doneStats.textContent = `You reviewed ${sessionReviewCount} item${sessionReviewCount !== 1 ? 's' : ''} in this session.`;
    }

    // ---- Helpers ----
    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }
})();
