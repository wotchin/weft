/**
 * ReplayScheduler — Spaced repetition engine for Knowledge Replay.
 *
 * Intervals (in days): 1, 3, 7, 14, 30
 * Each snippet has a reviewLevel (0–4) that determines the next interval.
 * On "Got it" → advance level, schedule next review.
 * On "Again"  → reset to level 0, schedule tomorrow.
 */
/* exported ReplayScheduler */

const ReplayScheduler = (() => {
    'use strict';

    const INTERVALS_DAYS = [1, 3, 7, 14, 30];
    const DAY_MS = 24 * 60 * 60 * 1000;

    /**
     * Initialize replay data for a session from its snippets.
     * Only adds new snippets; preserves existing review state.
     */
    function initSession(sessionName, snippets, existingData = {}) {
        const items = existingData[sessionName] || [];
        const existingIds = new Set(items.map(i => i.snippetId));

        for (const s of snippets) {
            if (existingIds.has(s.id)) continue;
            items.push({
                snippetId: s.id,
                reviewLevel: 0,
                nextReview: Date.now() + INTERVALS_DAYS[0] * DAY_MS,
                lastReview: null,
                reviewCount: 0,
            });
        }

        existingData[sessionName] = items;
        return existingData;
    }

    /**
     * Get items due for review in a session.
     */
    function getDueItems(sessionReplayItems, now = Date.now()) {
        return (sessionReplayItems || []).filter(item => item.nextReview <= now);
    }

    /**
     * Mark an item as reviewed.
     * @param {object} item - replay item
     * @param {boolean} gotIt - true = advance, false = reset
     */
    function markReviewed(item, gotIt) {
        const now = Date.now();
        item.lastReview = now;
        item.reviewCount++;

        if (gotIt) {
            item.reviewLevel = Math.min(item.reviewLevel + 1, INTERVALS_DAYS.length - 1);
        } else {
            item.reviewLevel = 0;
        }

        const interval = INTERVALS_DAYS[item.reviewLevel];
        item.nextReview = now + interval * DAY_MS;
        return item;
    }

    /**
     * Get total due count across all sessions.
     */
    function getTotalDueCount(replayData, now = Date.now()) {
        let count = 0;
        for (const items of Object.values(replayData || {})) {
            for (const item of items) {
                if (item.nextReview && item.nextReview <= now) count++;
            }
        }
        return count;
    }

    /**
     * Get review stats for a session.
     */
    function getSessionStats(sessionReplayItems) {
        const items = sessionReplayItems || [];
        const now = Date.now();
        return {
            total: items.length,
            due: items.filter(i => i.nextReview <= now).length,
            mastered: items.filter(i => i.reviewLevel >= INTERVALS_DAYS.length - 1).length,
            reviewed: items.filter(i => i.reviewCount > 0).length,
        };
    }

    /**
     * Build an LLM prompt to generate a review question for a snippet.
     */
    function buildQuestionPrompt(snippet, lang = 'English') {
        const content = (snippet.content || '').substring(0, 2000);
        return `Based on the following knowledge snippet, generate exactly ONE concise review question that tests understanding of the key concept. Also provide the expected answer in 1-2 sentences.

Reply in ${lang}. Format:
Q: [question]
A: [answer]

Snippet:
${content}`;
    }

    /**
     * Parse LLM response into question and answer.
     */
    function parseQA(response) {
        const qMatch = response.match(/Q:\s*(.+?)(?:\n|$)/);
        const aMatch = response.match(/A:\s*(.+?)(?:\n\n|$)/s);
        return {
            question: qMatch ? qMatch[1].trim() : response.split('\n')[0],
            answer: aMatch ? aMatch[1].trim() : '',
        };
    }

    return {
        INTERVALS_DAYS,
        initSession,
        getDueItems,
        markReviewed,
        getTotalDueCount,
        getSessionStats,
        buildQuestionPrompt,
        parseQA,
    };
})();
