/**
 * Weft — pluggable web search.
 *
 * Opt-in and disabled by default. Every option is bring-your-own:
 *   - Tavily  — free tier, no card; the easiest way to get going.
 *   - SearXNG — point Weft at an instance you run (or any instance whose JSON
 *               API is open). Most *public* instances disable `format=json`, so
 *               there is no reliable zero-config option to offer here.
 *   - Brave   — paid; its free tier was discontinued in 2026.
 *
 * We deliberately do not scrape Google/Bing result pages: it breaks their terms
 * of service, trips bot protection, shatters whenever the markup changes, and
 * is a known Chrome Web Store rejection trigger.
 *
 * Config lives in chrome.storage.local under `searchConfig`:
 *   { provider: 'none'|'tavily'|'searxng'|'brave', apiKey?, endpoint? }
 *
 * Usage: SearchProvider.search(query, maxResults) → [{title, url, snippet}]
 */
/* exported SearchProvider */

const SearchProvider = (() => {
    'use strict';

    const REQUEST_TIMEOUT_MS = 8000;

    async function getConfig() {
        const { searchConfig } = await chrome.storage.local.get(['searchConfig']);
        return searchConfig || { provider: 'none' };
    }

    async function isEnabled() {
        const cfg = await getConfig();
        return !!cfg.provider && cfg.provider !== 'none';
    }

    /** Does this provider need the user to supply anything? */
    function needsCredentials(provider) {
        return provider === 'tavily' || provider === 'brave' || provider === 'searxng';
    }

    async function search(query, maxResults = 6) {
        const cfg = await getConfig();
        switch (cfg.provider) {
            case 'tavily': return tavily(query, maxResults, cfg);
            case 'brave': return brave(query, maxResults, cfg);
            case 'searxng': return searxngAt(cfg.endpoint, query, maxResults);
            default: return [];
        }
    }

    // Abort slow endpoints so one dead instance can't stall the whole plan.
    async function fetchWithTimeout(url, init = {}) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { ...init, signal: ctl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    // Tavily — POST JSON, https://api.tavily.com/search
    async function tavily(query, maxResults, cfg) {
        if (!cfg.apiKey) throw new Error('Tavily API key not set.');
        const res = await fetchWithTimeout('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: maxResults }),
        });
        if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
        const data = await res.json();
        return (data.results || []).slice(0, maxResults).map((r) => ({
            title: r.title || '', url: r.url || '', snippet: r.content || '',
        }));
    }

    // Brave — GET with header. Paid: the free tier was discontinued in 2026.
    async function brave(query, maxResults, cfg) {
        if (!cfg.apiKey) throw new Error('Brave API key not set.');
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
        const res = await fetchWithTimeout(url, {
            headers: { 'Accept': 'application/json', 'X-Subscription-Token': cfg.apiKey },
        });
        if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
        const data = await res.json();
        return (data.web?.results || []).slice(0, maxResults).map((r) => ({
            title: r.title || '', url: r.url || '', snippet: r.description || '',
        }));
    }

    /**
     * Query a SearXNG instance via its JSON API.
     * Note: most public instances ship with `format=json` disabled, in which
     * case they answer with an HTML page (or 403). We detect that and say so,
     * because "invalid JSON" on its own is not a useful thing to show a user.
     */
    async function searxngAt(endpoint, query, maxResults) {
        const base = (endpoint || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('No SearXNG address set.');
        if (!/^https?:\/\//i.test(base)) throw new Error('Address must start with http:// or https://');

        let res;
        try {
            res = await fetchWithTimeout(
                `${base}/search?q=${encodeURIComponent(query)}&format=json`,
                { headers: { 'Accept': 'application/json' } }
            );
        } catch (e) {
            throw new Error(e.name === 'AbortError'
                ? 'The instance did not respond in time.'
                : 'Could not reach that address. Check the URL and that the instance is online.');
        }

        if (res.status === 403 || res.status === 429) {
            throw new Error(`The instance refused the request (HTTP ${res.status}) — its JSON API is probably closed to outside callers.`);
        }
        if (!res.ok) throw new Error(`The instance returned HTTP ${res.status}.`);

        const body = await res.text();
        let data;
        try {
            data = JSON.parse(body);
        } catch {
            throw new Error('That instance answered with a web page instead of JSON, which means its JSON API is disabled. Enable "json" under search.formats in its settings.yml, or use a different instance.');
        }

        return (data.results || []).slice(0, maxResults).map((r) => ({
            title: r.title || '', url: r.url || '', snippet: r.content || '',
        }));
    }

    async function testConnection(cfg) {
        try {
            const probe = { ...cfg };
            let results;
            switch (probe.provider) {
                case 'tavily': results = await tavily('weft connectivity test', 1, probe); break;
                case 'brave': results = await brave('weft connectivity test', 1, probe); break;
                case 'searxng': results = await searxngAt(probe.endpoint, 'weft', 1); break;
                default: return { ok: false, error: 'No search provider selected.' };
            }
            if (results.length === 0) {
                return { ok: false, error: 'Connected, but the provider returned no results.' };
            }
            return { ok: true, count: results.length };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    return { search, isEnabled, getConfig, testConnection, needsCredentials };
})();
