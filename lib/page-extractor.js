/**
 * PageExtractor — extract the readable, currently rendered DOM from a webpage.
 *
 * No network requests are made here. In particular, this module does not try
 * to load content which the page has not already rendered for the user.
 *
 * Returns: {
 *   title, url, description, content, wordCount, lang,
 *   blocks: [{ id, text, tag }],
 *   links: [{ id, text, href, section }],
 *   pageType: 'article' | 'index',
 *   isLikelyPartial, partialReason
 * }
 */
const PageExtractor = (() => {
    const TRACKING_PARAM_RE = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|gbraid|wbraid|yclid|twclid|mc_cid|mc_eid|vero_(?:id|conv)|_hsenc|_hsmi|hscid|hsctatracking|mkt_tok|igshid)$/i;

    /**
     * Compare page URLs while ignoring fragments and known tracking-only
     * parameters. All other query parameters are retained because they may
     * select different article content.
     */
    function comparableUrl(url) {
        try {
            const parsed = new URL(url);
            parsed.hash = '';

            const params = [];
            parsed.searchParams.forEach((value, key) => {
                if (!TRACKING_PARAM_RE.test(key)) params.push([key, value]);
            });
            params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
            parsed.search = '';
            params.forEach(([key, value]) => parsed.searchParams.append(key, value));
            return parsed.href;
        } catch {
            return String(url || '').split('#')[0];
        }
    }

    function isSameDocumentUrl(left, right) {
        return Boolean(left && right) && comparableUrl(left) === comparableUrl(right);
    }

    // This function is serialized and injected into the page. Keep every
    // helper it uses inside the function body.
    function extractPageContent() {
        const MAX_CONTENT_CHARS = 100000;
        const MAX_LINKS = 500;
        const MAX_PREFERRED_INSPECTED = 96;
        const MAX_PREFERRED_CANDIDATES = 24;
        const MAX_GENERIC_INSPECTED = 400;
        const MAX_GENERIC_CANDIDATES = 24;
        const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,blockquote,pre,li,figcaption,dt,dd,tr';
        const IGNORE_SELECTOR = [
            'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas',
            'nav', 'footer', '[role="navigation"]', '[role="banner"]',
            '[role="contentinfo"]', '[role="dialog"]', '[aria-hidden="true"]',
            '[hidden]', '[inert]', '#cyber-hl-toolbar', '.cyber-tag-badge',
        ].join(',');
        // Access-control wrappers sometimes remain around the readable article
        // for signed-in subscribers, so paywall/metered/subscription tokens are
        // handled by detectPartial rather than discarded as generic noise.
        const NOISE_TOKEN_RE = /(?:^|[\s_-])(?:nav(?:bar)?|menu|advert(?:isement)?|ads?|promo|cookie|consent|modal|popup|overlay|newsletter|comments?|disqus|related|recommended|social|share|toolbar)(?:$|[\s_-])/i;
        const visibilityCache = new WeakMap();
        const structuralVisibilityCache = new WeakMap();
        const styleCache = new WeakMap();

        function normalizeText(value) {
            return String(value || '').replace(/\s+/g, ' ').trim();
        }

        function hasNoiseToken(element) {
            if (!element || element === document.body) return false;
            const tokens = [
                element.id || '',
                typeof element.className === 'string' ? element.className : '',
                element.getAttribute?.('role') || '',
                element.getAttribute?.('aria-label') || '',
                element.getAttribute?.('data-testid') || '',
            ].join(' ');
            return NOISE_TOKEN_RE.test(tokens);
        }

        function isStructurallyVisible(element) {
            if (!element) return false;
            if (structuralVisibilityCache.has(element)) return structuralVisibilityCache.get(element);
            let visible = true;
            const parent = element.parentElement;
            if (element !== document.body && element.matches(IGNORE_SELECTOR)) {
                visible = false;
            } else if (hasNoiseToken(element)) {
                visible = false;
            } else if (parent && !isStructurallyVisible(parent)) {
                visible = false;
            } else {
                const style = window.getComputedStyle(element);
                styleCache.set(element, style);
                const opacity = Number.parseFloat(style.opacity);
                const filter = `${style.filter || ''} ${style.webkitFilter || ''}`;
                const blurred = Array.from(filter.matchAll(/blur\(([-\d.]+)/gi))
                    .some(match => Math.abs(Number(match[1])) > 0.01);
                const clipped = /rect\(0(?:px)?,\s*0(?:px)?,\s*0(?:px)?,\s*0(?:px)?\)/i.test(style.clip || '')
                    || /inset\((?:50|100)%/i.test(style.clipPath || '')
                    || /circle\(0(?:px|%)?/i.test(style.clipPath || '');
                visible = style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && style.visibility !== 'collapse'
                    && style.contentVisibility !== 'hidden'
                    && (!Number.isFinite(opacity) || opacity > 0.01)
                    && !blurred
                    && !clipped;
                if (
                    visible && element !== document.body && element !== document.documentElement
                    && style.display !== 'contents' && element.getClientRects().length === 0
                ) {
                    visible = false;
                }
            }

            structuralVisibilityCache.set(element, visible);
            return visible;
        }

        function isVisible(element) {
            if (!element) return false;
            if (visibilityCache.has(element)) return visibilityCache.get(element);

            let visible = isStructurallyVisible(element);
            if (visible) {
                const style = styleCache.get(element) || window.getComputedStyle(element);
                styleCache.set(element, style);
                visible = !/^rgba\([^)]*,\s*0(?:\.0+)?\)$/i.test(style.color || '');
            }

            visibilityCache.set(element, visible);
            return visible;
        }

        function visibleText(root, limit = 200000) {
            const parts = [];
            let length = 0;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    const parent = node.parentElement;
                    if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
                    const text = normalizeText(node.textContent);
                    return text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                },
            });

            let node;
            while ((node = walker.nextNode()) && length < limit) {
                const text = normalizeText(node.textContent);
                if (!text) continue;
                parts.push(text);
                length += text.length + 1;
            }
            return normalizeText(parts.join(' ')).substring(0, limit);
        }

        function getCandidateMetrics(element) {
            const text = visibleText(element);
            const textLength = text.length;
            const paragraphs = Array.from(element.querySelectorAll('p'))
                .filter(isVisible)
                .map(p => visibleText(p, 2000))
                .filter(Boolean);
            const longParagraphs = paragraphs.filter(textValue => textValue.length >= 120).length;
            const links = Array.from(element.querySelectorAll('a[href]')).filter(isVisible);
            const linkTextLength = links.reduce((sum, link) => sum + visibleText(link, 1000).length, 0);
            const linkDensity = textLength ? Math.min(1, linkTextLength / textLength) : 1;
            const headingCount = Array.from(element.querySelectorAll('h1,h2,h3,h4')).filter(isVisible).length;

            let semanticBonus = 0;
            if (element.matches('article,[itemprop="articleBody"],[data-testid*="article-body" i]')) {
                semanticBonus = 3200;
            } else if (element.matches('main,[role="main"]')) {
                semanticBonus = 700;
            } else if (element.matches('[class*="article-content" i],[class*="post-content" i],[class*="entry-content" i]')) {
                semanticBonus = 2200;
            }

            const nestedArticles = element.querySelectorAll('article').length;
            const proseScore = (textLength - linkTextLength)
                + paragraphs.length * 90
                + longParagraphs * 260
                + headingCount * 45
                - linkTextLength * 0.35
                - Math.max(0, nestedArticles - 1) * 350;
            // A high-quality index is intentionally link-dense. Give large
            // headline collections a second path to win without letting link
            // chrome overpower a prose article.
            const indexScore = textLength * 0.6
                + linkTextLength * 0.3
                + headingCount * 45
                + Math.min(links.length, 100) * 35;
            const score = Math.max(proseScore, indexScore) + semanticBonus;

            return {
                element,
                text,
                textLength,
                paragraphs,
                longParagraphs,
                links,
                linkTextLength,
                linkDensity,
                headingCount,
                nestedArticles,
                score,
            };
        }

        function chooseReadableRoot() {
            const candidateSet = new Set([document.body]);
            const preferredSelectors = [
                'article', 'main', '[role="main"]', '[itemprop="articleBody"]',
                '[data-testid*="article-body" i]', '[data-testid*="article-content" i]',
                '.article', '.post', '.entry-content', '.article-content',
                '.post-content', '.page-content', '#content', '#main', '#article',
            ];
            const strongSemanticSelector = [
                'article', 'main', '[role="main"]', '[itemprop="articleBody"]',
                '[data-testid*="article-body" i]', '[data-testid*="article-content" i]',
                '.entry-content', '.article-content', '.post-content',
            ].join(',');
            let preferredInspected = 0;
            let preferredAccepted = 0;
            let hasStrongSemanticRoot = false;
            for (const element of document.querySelectorAll(preferredSelectors.join(','))) {
                if (
                    preferredInspected >= MAX_PREFERRED_INSPECTED
                    || preferredAccepted >= MAX_PREFERRED_CANDIDATES
                ) break;
                preferredInspected++;
                if (!isVisible(element)) continue;
                const roughLength = normalizeText(element.textContent).length;
                if (roughLength < 200) continue;
                candidateSet.add(element);
                preferredAccepted++;
                if (
                    roughLength >= 800
                    && element.matches(strongSemanticSelector)
                    && element.querySelectorAll('p').length >= 2
                ) {
                    hasStrongSemanticRoot = true;
                }
            }

            // Many publishers use anonymous div/section containers. Consider a
            // bounded set of prose-shaped containers only when semantic markup
            // did not already identify a substantial readable root. Count every
            // inspected element before doing style or subtree work so a page full
            // of unsuitable wrappers cannot evade the budget.
            if (!hasStrongSemanticRoot) {
                let genericInspected = 0;
                let genericAccepted = 0;
                for (const element of document.querySelectorAll('section,div')) {
                    if (
                        genericInspected >= MAX_GENERIC_INSPECTED
                        || genericAccepted >= MAX_GENERIC_CANDIDATES
                    ) break;
                    genericInspected++;
                    if (candidateSet.has(element) || !isVisible(element)) continue;
                    const roughLength = normalizeText(element.textContent).length;
                    if (roughLength < 500 || element.querySelectorAll('p').length < 2) continue;
                    candidateSet.add(element);
                    genericAccepted++;
                }
            }

            const candidates = Array.from(candidateSet)
                .map(getCandidateMetrics)
                .filter(candidate => candidate.textLength >= 80);
            if (!candidates.length) {
                const fallback = getCandidateMetrics(document.body);
                fallback.bodyText = fallback.text;
                return fallback;
            }

            // The body is a safe fallback, but a focused container should win
            // when its readability score is close.
            if (candidates.length > 1) {
                const bodyCandidate = candidates.find(candidate => candidate.element === document.body);
                if (bodyCandidate) bodyCandidate.score *= 0.72;
            }
            candidates.sort((a, b) => b.score - a.score || b.textLength - a.textLength);
            const winner = candidates[0];
            const bodyCandidate = candidates.find(candidate => candidate.element === document.body);
            const winnerLooksLikeIndex = winner.links.length >= 8
                && (winner.linkDensity >= 0.16 || winner.links.length > Math.max(8, winner.longParagraphs * 4));
            const bodyLooksLikeCardIndex = Boolean(bodyCandidate) && (
                bodyCandidate.nestedArticles >= 8
                || (
                    bodyCandidate.nestedArticles >= 3
                    && bodyCandidate.links.length >= 12
                    && (
                        bodyCandidate.linkDensity >= 0.12
                        || bodyCandidate.links.length > bodyCandidate.longParagraphs * 2
                    )
                )
            );

            // A focused homepage section can outscore the body, but Smart Read
            // should let the user's stated purpose choose across the page, not
            // silently restrict candidates to whichever section scored first.
            let chosen = winner;
            if (
                bodyCandidate && winner !== bodyCandidate
                && (winnerLooksLikeIndex || bodyLooksLikeCardIndex)
                && bodyCandidate.links.length >= winner.links.length + 6
            ) {
                chosen = bodyCandidate;
            }
            chosen.bodyText = bodyCandidate?.text || chosen.text;
            return chosen;
        }

        function detectPageType(metrics) {
            const root = metrics.element;
            const ogType = document.querySelector('meta[property="og:type"]')?.content || '';
            const schemaArticle = document.querySelector(
                '[itemtype*="schema.org/Article" i],[itemtype*="schema.org/NewsArticle" i],script[type="application/ld+json"]'
            );
            const semanticArticle = root.matches('article,[itemprop="articleBody"]')
                || Boolean(root.closest('article,[itemprop="articleBody"]'));

            let articleEvidence = 0;
            if (/article/i.test(ogType)) articleEvidence += 4;
            if (semanticArticle) articleEvidence += 4;
            if (schemaArticle && /article/i.test(schemaArticle.textContent || schemaArticle.getAttribute('itemtype') || '')) {
                articleEvidence += 2;
            }
            if (metrics.longParagraphs >= 4) articleEvidence += 3;
            else if (metrics.longParagraphs >= 2) articleEvidence += 1;
            if (metrics.textLength >= 1800 && metrics.linkDensity < 0.18) articleEvidence += 2;

            let indexEvidence = 0;
            if (metrics.links.length >= 12) indexEvidence += 2;
            if (metrics.links.length >= 25) indexEvidence += 2;
            if (metrics.linkDensity >= 0.25) indexEvidence += 3;
            else if (metrics.linkDensity >= 0.16) indexEvidence += 1;
            if (metrics.links.length > Math.max(8, metrics.longParagraphs * 4)) indexEvidence += 2;
            if (metrics.longParagraphs <= 1 && metrics.links.length >= 8) indexEvidence += 2;
            if (metrics.nestedArticles >= 3) indexEvidence += 4;
            if (metrics.nestedArticles >= 8) indexEvidence += 2;

            // Ambiguous link-rich pages should ask for a reading focus instead
            // of silently treating one card collection as a single article.
            return indexEvidence >= articleEvidence && indexEvidence >= 3 ? 'index' : 'article';
        }

        function collectBlocks(root) {
            const elementSet = new Set();
            root.querySelectorAll(BLOCK_SELECTOR).forEach(element => elementSet.add(element));

            // Headline cards on index pages are not always marked up as
            // headings. Preserve meaningful uncovered anchor text as a block.
            root.querySelectorAll('a[href]').forEach(anchor => {
                if (!anchor.closest(BLOCK_SELECTOR)) elementSet.add(anchor);
            });

            // Preserve prose stored in otherwise unstructured leaf containers.
            root.querySelectorAll('div,section').forEach(element => {
                if (element.querySelector(BLOCK_SELECTOR) || element.querySelector('a[href]')) return;
                if (normalizeText(element.textContent).length >= 40) elementSet.add(element);
            });

            const elements = Array.from(elementSet).sort((a, b) => {
                if (a === b) return 0;
                return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });
            const blocks = [];
            const seen = new Set();
            let usedChars = 0;

            for (const element of elements) {
                if (!isVisible(element)) continue;
                if (element.matches('li') && element.querySelector(BLOCK_SELECTOR)) continue;
                const text = visibleText(element, 12000);
                if (!text || text.length < 2) continue;
                const dedupeKey = text.toLocaleLowerCase();
                if (seen.has(dedupeKey)) continue;

                const remaining = MAX_CONTENT_CHARS - usedChars;
                if (remaining <= 0) break;
                const blockText = text.substring(0, remaining);
                blocks.push({
                    id: `page-block-${blocks.length}`,
                    text: blockText,
                    tag: element.tagName.toLowerCase(),
                });
                seen.add(dedupeKey);
                usedChars += blockText.length + 2;
            }

            if (!blocks.length) {
                const fallback = visibleText(root, MAX_CONTENT_CHARS);
                if (fallback) blocks.push({ id: 'page-block-0', text: fallback, tag: 'div' });
            }
            return blocks;
        }

        function formatContent(blocks) {
            return blocks.map(block => {
                if (/^h[1-6]$/.test(block.tag)) {
                    return `${'#'.repeat(Number(block.tag[1]))} ${block.text}`;
                }
                if (block.tag === 'li') return `- ${block.text}`;
                return block.text;
            }).join('\n\n').substring(0, MAX_CONTENT_CHARS).trim();
        }

        function collectLinks(root) {
            const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4'))
                .filter(isVisible)
                .map(element => ({ element, text: visibleText(element, 300) }))
                .filter(item => item.text);
            const links = [];
            const seen = new Set();

            function findSection(anchor) {
                const container = anchor.closest('section,article,main');
                if (container) {
                    const ownHeading = anchor.closest('h1,h2,h3,h4');
                    let localHeadingText = '';
                    for (const heading of container.querySelectorAll('h1,h2,h3,h4')) {
                        if (heading === ownHeading || !isVisible(heading)) continue;
                        if (heading.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) {
                            localHeadingText = visibleText(heading, 160);
                        } else {
                            break;
                        }
                    }
                    if (localHeadingText) return localHeadingText;
                    const label = normalizeText(container.getAttribute('aria-label'));
                    if (label) return label.substring(0, 160);
                }

                let preceding = '';
                for (const heading of headings) {
                    if (heading.element === anchor || heading.element.contains(anchor)) continue;
                    const relation = heading.element.compareDocumentPosition(anchor);
                    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) preceding = heading.text;
                    else break;
                }
                return preceding.substring(0, 160);
            }

            for (const anchor of root.querySelectorAll('a[href]')) {
                if (links.length >= MAX_LINKS) break;
                if (!isVisible(anchor)) continue;
                const text = visibleText(anchor, 1000);
                if (!text || text.length < 2) continue;

                let parsed;
                try {
                    parsed = new URL(anchor.href, location.href);
                } catch {
                    continue;
                }
                if (!/^https?:$/.test(parsed.protocol)) continue;
                parsed.hash = '';
                const href = parsed.href;
                if (seen.has(href)) continue;
                seen.add(href);
                links.push({
                    id: `page-link-${links.length}`,
                    text,
                    href,
                    section: findSection(anchor),
                });
            }
            return links;
        }

        function detectPartial(pageType, content, metrics) {
            const strongGateText = /(?:subscribe|sign in|register|become a member).{0,45}(?:continue reading|read (?:the )?(?:full )?article|unlock (?:this|the) article)|(?:continue reading|read (?:the )?(?:full )?article|unlock (?:this|the) article).{0,45}(?:subscribe|sign in|register|member)/i;
            const gateActionText = /\b(?:subscribe|sign in|register|unlock|continue reading|full article)\b/i;
            const gateSelectors = [
                '[class*="paywall" i]', '[id*="paywall" i]',
                '[data-testid*="paywall" i]', '[class*="subscription-gate" i]',
                '[class*="regwall" i]', '[data-testid*="regwall" i]',
            ];
            const visibleGate = Array.from(document.querySelectorAll(gateSelectors.join(',')))
                .some(element => {
                    const style = window.getComputedStyle(element);
                    const rendered = !element.hidden
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && style.visibility !== 'collapse'
                        && style.opacity !== '0'
                        && element.getClientRects().length > 0;
                    if (!rendered) return false;
                    const gateText = normalizeText(element.textContent);
                    return gateText.length > 0
                        && (strongGateText.test(gateText) || gateActionText.test(gateText));
                });
            // Body metrics were already built while choosing the readable root.
            // Reuse that bounded visible text instead of forcing another whole-
            // document `innerText` layout and only then truncating its result.
            const bodyText = normalizeText(metrics.bodyText || metrics.text || content).substring(0, 50000);

            if (visibleGate || strongGateText.test(bodyText)) {
                return { isLikelyPartial: true, partialReason: 'access-gate-detected' };
            }
            if (metrics.textLength > MAX_CONTENT_CHARS || content.length >= MAX_CONTENT_CHARS) {
                return { isLikelyPartial: true, partialReason: 'content-limit-reached' };
            }
            if (pageType === 'article' && content.length < 350) {
                return { isLikelyPartial: true, partialReason: 'article-content-too-short' };
            }
            return { isLikelyPartial: false, partialReason: '' };
        }

        const metrics = chooseReadableRoot();
        const pageType = detectPageType(metrics);
        let blocks = collectBlocks(metrics.element);
        let content = formatContent(blocks);
        const links = collectLinks(metrics.element);
        const partial = detectPartial(pageType, content, metrics);
        // A visible access gate can cover otherwise present DOM text. Returning
        // that text would effectively bypass what the user can see, so expose
        // no article body until the gate is gone.
        if (partial.partialReason === 'access-gate-detected') {
            blocks = [];
            content = '';
        }
        const metaDesc = document.querySelector('meta[name="description"]')?.content
            || document.querySelector('meta[property="og:description"]')?.content
            || '';
        const cjkChars = content.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
        const nonCjkContent = content.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
        const lexicalWords = nonCjkContent.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || [];

        return {
            title: document.title || '',
            url: location.href,
            description: normalizeText(metaDesc).substring(0, 500),
            content,
            wordCount: lexicalWords.length + cjkChars.length,
            lang: document.documentElement.lang || '',
            blocks,
            links,
            pageType,
            isLikelyPartial: partial.isLikelyPartial,
            partialReason: partial.partialReason,
        };
    }

    /** Browser-internal, extension, and non-HTTP pages cannot be scripted. */
    function isRestrictedUrl(url) {
        if (!url || !/^https?:\/\//i.test(url)) return true;
        return url.startsWith('https://chrome.google.com/webstore')
            || url.startsWith('https://chromewebstore.google.com');
    }

    function hasTabId(tab) {
        return tab && Number.isInteger(tab.id);
    }

    function mostRecentReadableTab(tabs) {
        return tabs
            .filter(tab => hasTabId(tab) && !isRestrictedUrl(tab.url || tab.pendingUrl))
            .sort((a, b) => {
                const activeDifference = Number(Boolean(b.active)) - Number(Boolean(a.active));
                if (activeDifference) return activeDifference;
                return (b.lastAccessed || 0) - (a.lastAccessed || 0);
            })[0] || null;
    }

    /**
     * Resolve the user's most relevant normal webpage tab. This works from a
     * side panel as well as from a standalone Workbench extension window.
     */
    async function getReadableActiveTab() {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (hasTabId(activeTab) && !isRestrictedUrl(activeTab.url || activeTab.pendingUrl)) {
            return activeTab;
        }

        // A standalone Workbench is itself the active extension tab. Prefer
        // its opener when available, then the most recently used HTTP(S) tab.
        if (Number.isInteger(activeTab?.openerTabId)) {
            try {
                const opener = await chrome.tabs.get(activeTab.openerTabId);
                if (hasTabId(opener) && !isRestrictedUrl(opener.url || opener.pendingUrl)) return opener;
            } catch {
                // The opener may have been closed; continue with recency.
            }
        }

        const currentWindowTabs = await chrome.tabs.query({ currentWindow: true });
        const currentWindowCandidate = mostRecentReadableTab(currentWindowTabs);
        if (currentWindowCandidate) return currentWindowCandidate;

        const allTabs = await chrome.tabs.query({});
        return mostRecentReadableTab(allTabs);
    }

    /** Is the most relevant webpage tab one we can read? → { ok, reason, tab? } */
    async function canExtractActiveTab() {
        const tab = await getReadableActiveTab();
        if (!hasTabId(tab)) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return hasTabId(activeTab) && isRestrictedUrl(activeTab.url || activeTab.pendingUrl)
                ? { ok: false, reason: 'restricted' }
                : { ok: false, reason: 'no-tab' };
        }
        if (isRestrictedUrl(tab.url || tab.pendingUrl)) return { ok: false, reason: 'restricted' };
        return { ok: true, tab };
    }

    function pageChangedError(expectedUrl, actualUrl) {
        const error = new Error('The target tab has navigated to a different page. Analyze the page again.');
        error.code = 'TARGET_PAGE_CHANGED';
        error.expectedUrl = expectedUrl;
        error.actualUrl = actualUrl;
        return error;
    }

    /**
     * Extract from a specific tab, optionally verifying that it still displays
     * the page from which the operation was started.
     */
    async function extractFromTab(tabId, expectedUrl) {
        if (!Number.isInteger(tabId)) throw new Error('A valid target tab id is required');

        let tab;
        try {
            tab = await chrome.tabs.get(tabId);
        } catch {
            const error = new Error('The target webpage tab is no longer available.');
            error.code = 'TARGET_TAB_UNAVAILABLE';
            throw error;
        }

        const tabUrl = tab.pendingUrl || tab.url || '';
        if (isRestrictedUrl(tabUrl)) {
            throw new Error('This browser page can’t be read. Switch to a normal web page and try again.');
        }
        if (expectedUrl && !isSameDocumentUrl(expectedUrl, tabUrl)) {
            throw pageChangedError(expectedUrl, tabUrl);
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: extractPageContent,
        });
        const result = results?.[0]?.result;
        if (!result) throw new Error('Failed to extract page content');

        // Detect a navigation which occurred after tabs.get() but before the
        // injected extractor ran.
        if (expectedUrl && !isSameDocumentUrl(expectedUrl, result.url)) {
            throw pageChangedError(expectedUrl, result.url);
        }
        return result;
    }

    /** Extract content from the most relevant normal webpage tab. */
    async function extract() {
        const tab = await getReadableActiveTab();
        if (!hasTabId(tab)) throw new Error('No readable webpage tab found');
        return extractFromTab(tab.id, tab.url || tab.pendingUrl);
    }

    /** Extract and chunk the backwards-compatible content field for RAG. */
    async function extractAsSnippets() {
        const page = await extract();
        if (!page.content || page.content.length < 50) return { page, snippets: [] };

        const chunks = WeftTokenizer.chunkText(page.content, 512);
        const snippets = chunks.map((chunk, i) => ({
            id: `page-chunk-${i}`,
            type: 'text',
            content: chunk,
            sourceUrl: page.url,
            sourceTitle: page.title,
            timestamp: Date.now(),
            tags: ['page-content'],
        }));
        return { page, snippets };
    }

    return {
        extract,
        extractFromTab,
        extractAsSnippets,
        getReadableActiveTab,
        isRestrictedUrl,
        isSameDocumentUrl,
        canExtractActiveTab,
    };
})();
