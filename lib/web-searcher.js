/**
 * WebSearcher — execute web searches and extract results from search pages.
 *
 * Since Chrome extensions cannot directly call search APIs without keys,
 * this module opens search result pages and extracts content from them.
 * It uses DuckDuckGo HTML (no API key needed) as the search backend.
 */
const WebSearcher = (() => {

    /**
     * Search DuckDuckGo and extract results by injecting into a tab.
     * @param {string} query - Search query
     * @param {number} maxResults - Max results to return (default 8)
     * @returns {Promise<Array<{title, url, snippet}>>}
     */
    async function search(query, maxResults = 8) {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

        // Create a tab in background, extract results, then close it
        const tab = await chrome.tabs.create({ url: searchUrl, active: false });

        try {
            // Wait for tab to load
            await waitForTabLoad(tab.id, 15000);

            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (max) => {
                    const items = [];
                    const resultElements = document.querySelectorAll('.result');
                    for (const el of resultElements) {
                        if (items.length >= max) break;
                        const titleEl = el.querySelector('.result__title a, .result__a');
                        const snippetEl = el.querySelector('.result__snippet');
                        const urlEl = el.querySelector('.result__url');
                        if (!titleEl) continue;

                        let href = titleEl.href || '';
                        // DuckDuckGo wraps URLs in redirects
                        if (href.includes('duckduckgo.com/l/?')) {
                            try {
                                const u = new URL(href);
                                href = u.searchParams.get('uddg') || href;
                            } catch (e) { /* keep original */ }
                        }

                        items.push({
                            title: titleEl.textContent.trim(),
                            url: href,
                            snippet: snippetEl ? snippetEl.textContent.trim() : '',
                        });
                    }
                    return items;
                },
                args: [maxResults],
            });

            return results?.[0]?.result || [];
        } finally {
            // Always close the search tab
            try { await chrome.tabs.remove(tab.id); } catch (e) { /* tab already closed */ }
        }
    }

    /**
     * Fetch and extract readable content from a URL by opening it in a background tab.
     * @param {string} url - URL to fetch
     * @param {number} maxChars - Max characters to extract (default 15000)
     * @returns {Promise<{title, url, content}>}
     */
    async function fetchPageContent(url, maxChars = 15000) {
        const tab = await chrome.tabs.create({ url, active: false });
        try {
            await waitForTabLoad(tab.id, 20000);

            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (maxLen) => {
                    // Simplified extraction (same logic as PageExtractor but inline)
                    const removeSels = ['script','style','noscript','iframe','svg','nav','footer','header','.nav','.sidebar','.ad','.ads','.cookie-banner','.comments'];
                    const clone = document.body.cloneNode(true);
                    removeSels.forEach(s => clone.querySelectorAll(s).forEach(e => e.remove()));

                    // Find main content
                    const mainSels = ['article','main','[role="main"]','.article','.post','.content','.entry-content','#content','#main'];
                    let main = null;
                    for (const s of mainSels) {
                        const el = clone.querySelector(s);
                        if (el && el.textContent.trim().length > 100) { main = el; break; }
                    }

                    const text = (main || clone).innerText
                        .replace(/\n{3,}/g, '\n\n')
                        .replace(/[ \t]+/g, ' ')
                        .trim()
                        .substring(0, maxLen);

                    return {
                        title: document.title || '',
                        url: location.href,
                        content: text,
                    };
                },
                args: [maxChars],
            });

            return results?.[0]?.result || { title: '', url, content: '' };
        } finally {
            try { await chrome.tabs.remove(tab.id); } catch (e) {}
        }
    }

    /**
     * Wait for a tab to finish loading.
     */
    function waitForTabLoad(tabId, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve(); // resolve anyway; partial content is better than nothing
            }, timeout);

            function listener(id, changeInfo) {
                if (id === tabId && changeInfo.status === 'complete') {
                    clearTimeout(timer);
                    chrome.tabs.onUpdated.removeListener(listener);
                    // Small delay to let JS render
                    setTimeout(resolve, 500);
                }
            }
            chrome.tabs.onUpdated.addListener(listener);

            // Check if already loaded
            chrome.tabs.get(tabId).then(tab => {
                if (tab.status === 'complete') {
                    clearTimeout(timer);
                    chrome.tabs.onUpdated.removeListener(listener);
                    setTimeout(resolve, 500);
                }
            }).catch(() => {
                clearTimeout(timer);
                reject(new Error('Tab not found'));
            });
        });
    }

    /**
     * Execute a search plan: run multiple queries, fetch top results, return combined content.
     * @param {Array<{query: string, reason: string}>} plan - Search plan from LLM
     * @param {function} onProgress - Progress callback: (step, total, message)
     * @returns {Promise<Array<{query, results: Array<{title, url, snippet, content?}>}>>}
     */
    async function executePlan(plan, onProgress = () => {}) {
        const allResults = [];

        for (let i = 0; i < plan.length; i++) {
            const { query } = plan[i];
            onProgress(i + 1, plan.length, `Searching: ${query}`);

            try {
                // Search
                const searchResults = await search(query, 5);

                // Fetch content from top 2 results
                const enrichedResults = [];
                for (let j = 0; j < Math.min(2, searchResults.length); j++) {
                    const result = searchResults[j];
                    try {
                        onProgress(i + 1, plan.length, `Reading: ${result.title.substring(0, 40)}...`);
                        const page = await fetchPageContent(result.url, 8000);
                        enrichedResults.push({
                            ...result,
                            content: page.content,
                        });
                    } catch (e) {
                        enrichedResults.push(result); // keep snippet-only
                    }
                }
                // Add remaining results without fetching content
                for (let j = 2; j < searchResults.length; j++) {
                    enrichedResults.push(searchResults[j]);
                }

                allResults.push({ query, results: enrichedResults });
            } catch (e) {
                allResults.push({ query, results: [], error: e.message });
            }
        }

        return allResults;
    }

    return { search, fetchPageContent, executePlan };
})();
