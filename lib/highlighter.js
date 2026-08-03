/**
 * Highlighter — inject highlights into webpage DOM for Key Takeaways.
 *
 * Uses chrome.scripting.executeScript to find and highlight exact text
 * fragments in the active tab, with per-group colors and scroll-to support.
 * Also supports user-driven highlighting: selection toolbar for assigning
 * text to groups and removing highlights.
 */
const Highlighter = (() => {

    // Color palette — 8 distinct highlight colors (background, border) for takeaway groups
    const COLORS = [
        { bg: 'rgba(255, 235, 59, 0.35)', border: '#f9a825', name: 'yellow' },
        { bg: 'rgba(206, 147, 216, 0.35)', border: '#8e24aa', name: 'purple' },
        { bg: 'rgba(239, 154, 154, 0.35)', border: '#e53935', name: 'red' },
        { bg: 'rgba(129, 212, 250, 0.35)', border: '#0288d1', name: 'blue' },
        { bg: 'rgba(165, 214, 167, 0.35)', border: '#2e7d32', name: 'green' },
        { bg: 'rgba(255, 204, 128, 0.35)', border: '#ef6c00', name: 'orange' },
        { bg: 'rgba(178, 223, 219, 0.35)', border: '#00897b', name: 'teal' },
        { bg: 'rgba(255, 183, 197, 0.35)', border: '#c62828', name: 'pink' },
    ];

    // Tag-type → underline color mapping (matches organizer.css tag badge colors)
    const TAG_COLORS = {
        'data':       { underline: '#2e7d32', bg: 'rgba(46, 125, 50, 0.08)',  badge: '#e8f5e9', text: '#2e7d32' },
        'quote':      { underline: '#e65100', bg: 'rgba(230, 81, 0, 0.08)',   badge: '#fff3e0', text: '#e65100' },
        'opinion':    { underline: '#c62828', bg: 'rgba(198, 40, 40, 0.08)',   badge: '#fce4ec', text: '#c62828' },
        'reference':  { underline: '#1565c0', bg: 'rgba(21, 101, 192, 0.08)', badge: '#e3f2fd', text: '#1565c0' },
        'key-point':  { underline: '#7b1fa2', bg: 'rgba(123, 31, 162, 0.08)', badge: '#f3e5f5', text: '#7b1fa2' },
        'definition': { underline: '#00838f', bg: 'rgba(0, 131, 143, 0.08)',  badge: '#e0f7fa', text: '#00838f' },
        'example':    { underline: '#f57f17', bg: 'rgba(245, 127, 23, 0.08)', badge: '#fff8e1', text: '#f57f17' },
        'default':    { underline: '#616161', bg: 'rgba(97, 97, 97, 0.08)',   badge: '#f5f5f5', text: '#616161' },
    };

    const TAG_LABEL_KEYS = {
        quote: 'tag_quote', data: 'tag_data', opinion: 'tag_opinion',
        reference: 'tag_reference', 'key-point': 'tag_key_point',
        stats: 'tag_stats', market: 'tag_market', counterpoint: 'tag_counterpoint',
        generated: 'tag_generated', analysed: 'tag_analysed',
    };

    function tagDisplayName(tag) {
        return typeof t === 'function' && TAG_LABEL_KEYS[tag]
            ? t(TAG_LABEL_KEYS[tag])
            : tag;
    }

    /**
     * Get color for a takeaway group index.
     */
    function getColor(groupIndex) {
        return COLORS[groupIndex % COLORS.length];
    }

    const TRACKING_PARAM_RE = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|gbraid|wbraid|yclid|twclid|mc_cid|mc_eid|vero_(?:id|conv)|_hsenc|_hsmi|hscid|hsctatracking|mkt_tok|igshid)$/i;

    /**
     * Compare page URLs without fragments or common tracking-only query
     * parameters. Query parameters which can select different content remain
     * significant.
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

    function targetPageChangedError(expectedUrl, actualUrl) {
        const error = new Error('The source tab has navigated to a different page. Analyze the page again before highlighting.');
        error.code = 'TARGET_PAGE_CHANGED';
        error.expectedUrl = expectedUrl;
        error.actualUrl = actualUrl;
        return error;
    }

    /**
     * Resolve an explicit source tab or preserve the legacy active-tab
     * behavior when no target is supplied.
     */
    async function resolveTab(target) {
        if (!target) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return tab && Number.isInteger(tab.id) ? tab : null;
        }
        if (!Number.isInteger(target.tabId) || typeof target.url !== 'string' || !target.url) {
            const error = new Error('A target with both tabId and url is required');
            error.code = 'INVALID_TARGET';
            throw error;
        }

        try {
            return await chrome.tabs.get(target.tabId);
        } catch {
            const error = new Error('The source webpage tab is no longer available.');
            error.code = 'TARGET_TAB_UNAVAILABLE';
            throw error;
        }
    }

    /** Verify the tab's current URL immediately before a targeted DOM operation. */
    function assertTargetPage(tab, target) {
        if (!target?.url) return;
        const tabUrl = tab.pendingUrl || tab.url || '';
        if (!isSameDocumentUrl(target.url, tabUrl)) {
            throw targetPageChangedError(target.url, tabUrl);
        }
    }

    /**
     * Highlight multiple groups of quotes in the active tab.
     * @param {Array<{groupIndex: number, quotes: string[]}>} groups
     * @param {{tabId: number, url: string}} [target] — original source page
     * @returns {Promise<{highlighted: number, total: number}>}
     */
    async function highlightGroups(groups, target) {
        const tab = await resolveTab(target);
        if (!tab) throw new Error('No active tab');
        await assertTargetPage(tab, target);

        const payload = groups.map(g => ({
            quotes: g.quotes,
            bgColor: COLORS[g.groupIndex % COLORS.length].bg,
            borderColor: COLORS[g.groupIndex % COLORS.length].border,
            groupId: `cyber-hl-group-${g.groupIndex}`,
            minLength: Number.isInteger(g.minLength) ? Math.max(2, g.minLength) : 8,
            linkUrl: typeof g.linkUrl === 'string' ? g.linkUrl : '',
        }));

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: injectHighlights,
            args: [payload, comparableUrl(target?.url || tab.pendingUrl || tab.url || '')],
        });

        const result = results?.[0]?.result || { highlighted: 0, total: 0 };
        if (result.pageChanged) {
            throw targetPageChangedError(target?.url || tab.url || '', result.actualUrl || '');
        }
        return result;
    }

    /** Cancel a cooperative highlight job without requiring the old URL to remain loaded. */
    async function cancelPending(target) {
        let tab;
        try { tab = await resolveTab(target); } catch { return; }
        if (!tab?.id) return;
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.__cyberHighlightJobId = (window.__cyberHighlightJobId || 0) + 1;
            },
        }).catch(() => {});
    }

    /**
     * Scroll to a specific highlight group in the active tab.
     * @param {number} groupIndex
     * @param {{tabId: number, url: string}} [target] — original source page
     */
    async function scrollToGroup(groupIndex, target) {
        const tab = await resolveTab(target);
        if (!tab) return;
        await assertTargetPage(tab, target);

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (groupId) => {
                const el = document.querySelector(`[data-cyber-group="${groupId}"]`);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const origOutline = el.style.outline;
                    el.style.outline = '3px solid ' + (el.dataset.cyberBorder || '#f9a825');
                    el.style.outlineOffset = '2px';
                    setTimeout(() => {
                        el.style.outline = origOutline;
                        el.style.outlineOffset = '';
                    }, 2000);
                }
            },
            args: [`cyber-hl-group-${groupIndex}`],
        });
    }

    /**
     * Clear all highlights and the selection toolbar from the active tab.
     */
    async function clearAll(target) {
        const tab = await resolveTab(target);
        if (!tab) return;
        await assertTargetPage(tab, target);

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.__cyberHighlightJobId = (window.__cyberHighlightJobId || 0) + 1;
                // Remove toolbar
                document.getElementById('cyber-hl-toolbar')?.remove();
                // Remove mouseup listener
                if (window.__cyberHlMouseup) {
                    document.removeEventListener('mouseup', window.__cyberHlMouseup);
                    window.__cyberHlMouseup = null;
                }
                if (window.__cyberHlMousedown) {
                    document.removeEventListener('mousedown', window.__cyberHlMousedown, true);
                    window.__cyberHlMousedown = null;
                }
                document.querySelectorAll('.cyber-tag-badge').forEach(el => el.remove());
                // Unwrap all highlights
                document.querySelectorAll('[data-cyber-highlight]').forEach(el => {
                    const parent = el.parentNode;
                    if (parent) {
                        parent.replaceChild(document.createTextNode(el.textContent), el);
                        parent.normalize();
                    }
                });
                document.querySelectorAll('[data-cyber-snippet-hl]').forEach(el => {
                    const parent = el.parentNode;
                    if (parent) {
                        parent.replaceChild(document.createTextNode(el.textContent), el);
                        parent.normalize();
                    }
                });
            },
        });
    }

    /**
     * Inject the selection toolbar into the page so users can select text
     * and assign it to a takeaway group or remove a highlight.
     * @param {number} groupCount — number of takeaway groups (for color buttons)
     * @param {Array<string>} groupTitles — short titles for each group
     * @param {{tabId: number, url: string}} [target] — original source page
     */
    async function enableSelectionMode(groupCount, groupTitles, target) {
        const tab = await resolveTab(target);
        if (!tab) return;
        await assertTargetPage(tab, target);

        const colorPayload = [];
        for (let i = 0; i < groupCount; i++) {
            const c = COLORS[i % COLORS.length];
            colorPayload.push({
                groupIndex: i,
                bg: c.bg,
                border: c.border,
                name: c.name,
                title: groupTitles[i] || (typeof t === 'function'
                    ? t('highlight_group').replace('%s', String(i + 1))
                    : `Group ${i + 1}`),
            });
        }

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: injectSelectionToolbar,
            args: [colorPayload, {
                highlightAs: typeof t === 'function' ? t('highlight_as') : 'Highlight as:',
                removeHighlight: typeof t === 'function' ? t('highlight_remove') : 'Remove highlight',
            }],
        });
    }

    /**
     * Disable the selection toolbar.
     */
    async function disableSelectionMode() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                document.getElementById('cyber-hl-toolbar')?.remove();
                if (window.__cyberHlMouseup) {
                    document.removeEventListener('mouseup', window.__cyberHlMouseup);
                    window.__cyberHlMouseup = null;
                }
                if (window.__cyberHlMousedown) {
                    document.removeEventListener('mousedown', window.__cyberHlMousedown, true);
                    window.__cyberHlMousedown = null;
                }
            },
        });
    }

    /**
     * Collect all current highlights from the page, grouped by groupId.
     * Returns an array of { groupIndex, quotes: string[] }.
     */
    async function collectHighlights(target) {
        const tab = await resolveTab(target);
        if (!tab) return [];
        await assertTargetPage(tab, target);

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const groupMap = {};
                document.querySelectorAll('[data-cyber-highlight]').forEach(el => {
                    const groupId = el.dataset.cyberGroup || '';
                    const text = el.textContent.trim();
                    if (!text) return;
                    if (!groupMap[groupId]) groupMap[groupId] = [];
                    groupMap[groupId].push(text);
                });
                // Convert to array sorted by group index
                return Object.entries(groupMap)
                    .map(([groupId, quotes]) => {
                        const match = groupId.match(/cyber-hl-group-(\d+)/);
                        const groupIndex = match ? parseInt(match[1]) : -1;
                        return { groupIndex, quotes };
                    })
                    .filter(g => g.groupIndex >= 0)
                    .sort((a, b) => a.groupIndex - b.groupIndex);
            },
        });

        return results?.[0]?.result || [];
    }

    // ================================================================
    //  Functions injected into the page context
    // ================================================================

    /**
     * Injected: perform highlighting of text fragments.
     */
    async function injectHighlights(groups, expectedComparableUrl) {
        const MAX_QUOTES = 24;
        const MAX_TEXT_NODES = 8000;
        const MAX_INDEX_CHARS = 250000;
        const jobId = (window.__cyberHighlightJobId || 0) + 1;
        window.__cyberHighlightJobId = jobId;

        const trackingParam = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|gbraid|wbraid|yclid|twclid|mc_cid|mc_eid|vero_(?:id|conv)|_hsenc|_hsmi|hscid|hsctatracking|mkt_tok|igshid)$/i;
        function currentComparableUrl() {
            try {
                const parsed = new URL(location.href);
                parsed.hash = '';
                const params = [];
                parsed.searchParams.forEach((value, key) => {
                    if (!trackingParam.test(key)) params.push([key, value]);
                });
                params.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
                parsed.search = '';
                params.forEach(([key, value]) => parsed.searchParams.append(key, value));
                return parsed.href;
            } catch {
                return String(location.href || '').split('#')[0];
            }
        }
        const pageChanged = () => Boolean(expectedComparableUrl)
            && currentComparableUrl() !== expectedComparableUrl;
        const isCancelled = () => window.__cyberHighlightJobId !== jobId || pageChanged();
        const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

        if (pageChanged()) {
            return {
                highlighted: 0,
                total: groups.reduce((sum, group) => sum + group.quotes.length, 0),
                pageChanged: true,
                actualUrl: location.href,
            };
        }
        function stoppedResult(highlighted, total, limited = false) {
            return pageChanged()
                ? { highlighted, total, limited, pageChanged: true, actualUrl: location.href }
                : { highlighted, total, limited, cancelled: true };
        }

        // Clear once, then normalize each affected parent once. The previous
        // per-span normalize loop repeatedly forced DOM consolidation/layout.
        document.getElementById('cyber-hl-toolbar')?.remove();
        if (window.__cyberHlMouseup) {
            document.removeEventListener('mouseup', window.__cyberHlMouseup);
            window.__cyberHlMouseup = null;
        }
        if (window.__cyberHlMousedown) {
            document.removeEventListener('mousedown', window.__cyberHlMousedown, true);
            window.__cyberHlMousedown = null;
        }
        document.querySelectorAll('.cyber-tag-badge').forEach((element) => element.remove());
        const oldHighlights = document.querySelectorAll('[data-cyber-highlight],[data-cyber-snippet-hl]');
        const parentsToNormalize = new Set();
        for (let index = 0; index < oldHighlights.length; index++) {
            const element = oldHighlights[index];
            const parent = element.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(element.textContent), element);
                parentsToNormalize.add(parent);
            }
            if (index > 0 && index % 80 === 0) await yieldToPage();
            if (isCancelled()) return stoppedResult(0, 0);
        }
        let parentIndex = 0;
        for (const parent of parentsToNormalize) {
            parent.normalize();
            parentIndex++;
            if (parentIndex % 80 === 0) await yieldToPage();
        }

        const allTasks = [];
        for (const group of groups) {
            for (const quote of group.quotes) {
                allTasks.push({
                    quote,
                    minLength: group.minLength,
                    bgColor: group.bgColor,
                    borderColor: group.borderColor,
                    groupId: group.groupId,
                    linkUrl: group.linkUrl || '',
                });
            }
        }
        const tasks = allTasks.slice(0, MAX_QUOTES);
        const visibilityCache = new WeakMap();
        const indexCache = new WeakMap();
        const builtIndexes = [];

        function normalizeLink(value) {
            try {
                const parsed = new URL(value, location.href);
                parsed.hash = '';
                return parsed.href;
            } catch {
                return '';
            }
        }

        function isVisibleParent(parent) {
            if (visibilityCache.has(parent)) return visibilityCache.get(parent);
            let visible = true;
            if (parent.closest('script,style,noscript,iframe,template,nav,footer,[hidden],[aria-hidden="true"],[role="navigation"],[role="dialog"]')) {
                visible = false;
            } else {
                const style = window.getComputedStyle(parent);
                visible = style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && style.visibility !== 'collapse'
                    && Number(style.opacity) > 0.01
                    && parent.getClientRects().length > 0;
            }
            visibilityCache.set(parent, visible);
            return visible;
        }

        async function buildTextIndex(root) {
            if (indexCache.has(root)) return indexCache.get(root);
            const pieces = [];
            const segments = [];
            let length = 0;
            let nodeCount = 0;
            let truncated = false;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                nodeCount++;
                if (nodeCount > MAX_TEXT_NODES || length >= MAX_INDEX_CHARS) {
                    truncated = true;
                    break;
                }
                if (nodeCount % 400 === 0) {
                    await yieldToPage();
                    if (isCancelled()) return null;
                }
                const parent = node.parentElement;
                if (!parent || !isVisibleParent(parent)) continue;
                const snapshot = String(node.textContent || '');
                let normalized = snapshot.replace(/\s+/g, ' ').trim();
                if (!normalized) continue;
                const separator = length > 0 ? 1 : 0;
                const available = MAX_INDEX_CHARS - length - separator;
                if (available <= 0) {
                    truncated = true;
                    break;
                }
                if (normalized.length > available) {
                    normalized = normalized.slice(0, available);
                    truncated = true;
                }
                if (separator) {
                    pieces.push(' ');
                    length++;
                }
                const start = length;
                pieces.push(normalized);
                length += normalized.length;
                segments.push({ node, start, end: length, snapshot });
                if (truncated) break;
            }
            const text = pieces.join('');
            const result = { text, lower: text.toLowerCase(), segments, truncated, matches: [] };
            indexCache.set(root, result);
            builtIndexes.push(result);
            return result;
        }

        // Resolve every requested URL in one anchor pass instead of querying
        // and laying out every link once per Smart Read selection.
        const expectedLinks = new Set(tasks.map((task) => normalizeLink(task.linkUrl)).filter(Boolean));
        const anchorsByUrl = new Map();
        if (expectedLinks.size > 0) {
            const anchors = document.querySelectorAll('a[href]');
            const anchorLimit = Math.min(anchors.length, 4000);
            for (let index = 0; index < anchorLimit; index++) {
                const anchor = anchors[index];
                const href = normalizeLink(anchor.href);
                if (expectedLinks.has(href) && anchor.getClientRects().length > 0) {
                    const matches = anchorsByUrl.get(href) || [];
                    if (matches.length < 3) matches.push(anchor);
                    anchorsByUrl.set(href, matches);
                }
                if (index > 0 && index % 400 === 0) await yieldToPage();
                if (isCancelled()) return stoppedResult(0, allTasks.length, true);
            }
        }

        function overlapsExisting(textIndex, start, end) {
            return textIndex.matches.some((match) => start < match.end && match.start < end);
        }

        for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
            const task = tasks[taskIndex];
            const search = String(task.quote || '').replace(/\s+/g, ' ').trim();
            if (search.length < task.minLength) continue;
            const roots = task.linkUrl
                ? (anchorsByUrl.get(normalizeLink(task.linkUrl)) || [])
                : [document.body];
            for (const root of roots) {
                const textIndex = await buildTextIndex(root);
                if (!textIndex) break;
                let start = textIndex.text.indexOf(search);
                if (start < 0) {
                    const lowerSearch = search.toLowerCase();
                    // Some Unicode case folds change string length. Only use
                    // the fallback when offsets stay in the same coordinate space.
                    if (textIndex.lower.length === textIndex.text.length && lowerSearch.length === search.length) {
                        start = textIndex.lower.indexOf(lowerSearch);
                    }
                }
                const end = start + search.length;
                if (start >= 0 && !overlapsExisting(textIndex, start, end)) {
                    textIndex.matches.push({ ...task, start, end });
                    break;
                }
            }
            if (taskIndex % 3 === 2) await yieldToPage();
            if (isCancelled()) return stoppedResult(0, allTasks.length, true);
        }

        function findSegment(segments, offset) {
            let low = 0;
            let high = segments.length - 1;
            while (low <= high) {
                const middle = (low + high) >> 1;
                const segment = segments[middle];
                if (offset < segment.start) high = middle - 1;
                else if (offset >= segment.end) low = middle + 1;
                else return middle;
            }
            return -1;
        }

        function collapsedOffsets(original) {
            const offsets = [];
            let hasText = false;
            let pendingSpace = -1;
            for (let index = 0; index < original.length; index++) {
                if (/\s/.test(original[index])) {
                    if (hasText && pendingSpace < 0) pendingSpace = index;
                    continue;
                }
                if (pendingSpace >= 0 && hasText) offsets.push(pendingSpace);
                pendingSpace = -1;
                offsets.push(index);
                hasText = true;
            }
            return offsets;
        }

        function wrapRange(textNode, start, end, match) {
            if (!textNode?.isConnected || start >= end || start < 0) return false;
            try {
                const range = document.createRange();
                range.setStart(textNode, Math.min(start, textNode.textContent.length));
                range.setEnd(textNode, Math.min(end, textNode.textContent.length));
                const span = document.createElement('span');
                span.setAttribute('data-cyber-highlight', 'true');
                span.setAttribute('data-cyber-group', match.groupId);
                span.setAttribute('data-cyber-border', match.borderColor);
                span.style.cssText = `background:${match.bgColor};border-bottom:2px solid ${match.borderColor};padding:1px 0;border-radius:2px;`;
                range.surroundContents(span);
                return true;
            } catch {
                return false;
            }
        }

        function applyMatch(textIndex, match) {
            const startSegmentIndex = findSegment(textIndex.segments, match.start);
            const endSegmentIndex = findSegment(textIndex.segments, match.end - 1);
            if (startSegmentIndex < 0 || endSegmentIndex < 0) return false;
            let wrapped = false;
            for (let index = endSegmentIndex; index >= startSegmentIndex; index--) {
                const segment = textIndex.segments[index];
                const original = segment.snapshot;
                const offsets = collapsedOffsets(original);
                const localStart = index === startSegmentIndex ? match.start - segment.start : 0;
                const localEnd = index === endSegmentIndex ? match.end - segment.start : offsets.length;
                const startOffset = offsets[localStart];
                const endOffset = offsets[localEnd - 1];
                if (startOffset === undefined || endOffset === undefined) continue;
                wrapped = wrapRange(segment.node, startOffset, endOffset + 1, match) || wrapped;
            }
            return wrapped;
        }

        function matchSnapshotIsCurrent(textIndex, match) {
            const startSegmentIndex = findSegment(textIndex.segments, match.start);
            const endSegmentIndex = findSegment(textIndex.segments, match.end - 1);
            if (startSegmentIndex < 0 || endSegmentIndex < 0) return false;
            for (let index = startSegmentIndex; index <= endSegmentIndex; index++) {
                const segment = textIndex.segments[index];
                if (!segment.node.isConnected || segment.node.textContent !== segment.snapshot) return false;
            }
            return true;
        }

        let totalHighlighted = 0;
        let limited = allTasks.length > tasks.length;
        for (const textIndex of builtIndexes) {
            limited = limited || textIndex.truncated;
            textIndex.matches = textIndex.matches.filter((match) => matchSnapshotIsCurrent(textIndex, match));
            textIndex.matches.sort((left, right) => right.start - left.start);
            for (let index = 0; index < textIndex.matches.length; index++) {
                if (applyMatch(textIndex, textIndex.matches[index])) totalHighlighted++;
                if (index % 4 === 3) await yieldToPage();
                if (isCancelled()) {
                    return stoppedResult(totalHighlighted, allTasks.length, limited);
                }
            }
        }

        return { highlighted: totalHighlighted, total: allTasks.length, limited };
    }

    /**
     * Injected: floating selection toolbar.
     * When the user selects text on the page, a small toolbar appears near the
     * selection with color-coded group buttons (assign to group) + a remove button.
     */
    function injectSelectionToolbar(colors, labels) {
        // Remove existing toolbar if any
        document.getElementById('cyber-hl-toolbar')?.remove();
        if (window.__cyberHlMouseup) {
            document.removeEventListener('mouseup', window.__cyberHlMouseup);
        }
        if (window.__cyberHlMousedown) {
            document.removeEventListener('mousedown', window.__cyberHlMousedown, true);
        }

        // Create toolbar (hidden initially)
        const toolbar = document.createElement('div');
        toolbar.id = 'cyber-hl-toolbar';
        toolbar.style.cssText = `
            position:fixed; z-index:2147483647; display:none;
            background:#fff; border:1px solid #ddd; border-radius:8px;
            box-shadow:0 4px 16px rgba(0,0,0,0.15); padding:6px 8px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            font-size:12px; line-height:1;
            transition: opacity 0.15s;
        `;

        // Label
        const label = document.createElement('span');
        label.textContent = labels?.highlightAs || 'Highlight as:';
        label.style.cssText = 'color:#888; margin-right:6px; font-size:11px; vertical-align:middle;';
        toolbar.appendChild(label);

        // Color buttons for each group
        colors.forEach(c => {
            const btn = document.createElement('button');
            btn.title = c.title;
            btn.dataset.groupIndex = c.groupIndex;
            btn.style.cssText = `
                display:inline-block; width:20px; height:20px; border-radius:50%;
                border:2px solid ${c.border}; background:${c.bg};
                cursor:pointer; margin:0 3px; vertical-align:middle;
                transition: transform 0.1s, box-shadow 0.1s;
                position:relative;
            `;
            btn.addEventListener('mouseenter', () => {
                btn.style.transform = 'scale(1.2)';
                btn.style.boxShadow = `0 0 0 2px ${c.border}40`;
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.transform = '';
                btn.style.boxShadow = '';
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                applyHighlightToSelection(c.groupIndex, c.bg, c.border);
                hideToolbar();
            });
            toolbar.appendChild(btn);
        });

        // Separator
        const sep = document.createElement('span');
        sep.style.cssText = 'display:inline-block; width:1px; height:16px; background:#ddd; margin:0 6px; vertical-align:middle;';
        toolbar.appendChild(sep);

        // Remove highlight button
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '\u2715';
        removeBtn.title = labels?.removeHighlight || 'Remove highlight';
        removeBtn.style.cssText = `
            display:inline-block; width:20px; height:20px; border-radius:50%;
            border:1px solid #ddd; background:#f5f5f5; color:#999;
            cursor:pointer; font-size:12px; line-height:18px; text-align:center;
            margin:0 2px; vertical-align:middle;
            transition: border-color 0.1s, color 0.1s;
        `;
        removeBtn.addEventListener('mouseenter', () => {
            removeBtn.style.borderColor = '#f44336';
            removeBtn.style.color = '#f44336';
        });
        removeBtn.addEventListener('mouseleave', () => {
            removeBtn.style.borderColor = '#ddd';
            removeBtn.style.color = '#999';
        });
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeHighlightAtSelection();
            hideToolbar();
        });
        toolbar.appendChild(removeBtn);

        document.body.appendChild(toolbar);

        function hideToolbar() {
            toolbar.style.display = 'none';
        }

        function showToolbar(x, y) {
            toolbar.style.display = 'block';
            // Position near cursor, clamp to viewport
            const rect = toolbar.getBoundingClientRect();
            const vw = window.innerWidth;
            let left = x - rect.width / 2;
            let top = y - rect.height - 10;
            if (left < 8) left = 8;
            if (left + rect.width > vw - 8) left = vw - rect.width - 8;
            if (top < 8) top = y + 20; // show below if no room above
            toolbar.style.left = left + 'px';
            toolbar.style.top = top + 'px';
        }

        /**
         * Apply highlight color to current text selection.
         */
        function applyHighlightToSelection(groupIndex, bgColor, borderColor) {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) return;

            const range = sel.getRangeAt(0);
            const selectedText = sel.toString().trim();
            if (selectedText.length < 2) return;

            const groupId = `cyber-hl-group-${groupIndex}`;

            // Check if selection is inside an existing highlight — if so, change its group
            const existingHL = range.startContainer.parentElement?.closest('[data-cyber-highlight]');
            if (existingHL && existingHL.textContent.trim() === selectedText) {
                existingHL.setAttribute('data-cyber-group', groupId);
                existingHL.setAttribute('data-cyber-border', borderColor);
                existingHL.style.background = bgColor;
                existingHL.style.borderBottomColor = borderColor;
                sel.removeAllRanges();
                return;
            }

            // Wrap the selection in a highlight span
            try {
                const span = document.createElement('span');
                span.setAttribute('data-cyber-highlight', 'true');
                span.setAttribute('data-cyber-group', groupId);
                span.setAttribute('data-cyber-border', borderColor);
                span.style.cssText = `background:${bgColor};border-bottom:2px solid ${borderColor};padding:1px 0;border-radius:2px;`;
                range.surroundContents(span);
            } catch (e) {
                // If surroundContents fails (cross-element selection), extract and wrap
                try {
                    const fragment = range.extractContents();
                    const span = document.createElement('span');
                    span.setAttribute('data-cyber-highlight', 'true');
                    span.setAttribute('data-cyber-group', groupId);
                    span.setAttribute('data-cyber-border', borderColor);
                    span.style.cssText = `background:${bgColor};border-bottom:2px solid ${borderColor};padding:1px 0;border-radius:2px;`;
                    span.appendChild(fragment);
                    range.insertNode(span);
                } catch (e2) {
                    console.warn('[Cyber] Could not highlight selection:', e2);
                }
            }
            sel.removeAllRanges();
        }

        /**
         * Remove highlight from current selection or the highlight span at cursor.
         */
        function removeHighlightAtSelection() {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;

            const range = sel.getRangeAt(0);
            // Find the highlight span that contains the selection
            let hlEl = range.startContainer.nodeType === Node.TEXT_NODE
                ? range.startContainer.parentElement
                : range.startContainer;
            hlEl = hlEl?.closest('[data-cyber-highlight]');

            if (hlEl) {
                const parent = hlEl.parentNode;
                if (parent) {
                    parent.replaceChild(document.createTextNode(hlEl.textContent), hlEl);
                    parent.normalize();
                }
            }
            sel.removeAllRanges();
        }

        // Listen for text selection (mouseup)
        window.__cyberHlMouseup = (e) => {
            // Ignore clicks on the toolbar itself
            if (toolbar.contains(e.target)) return;

            setTimeout(() => {
                const sel = window.getSelection();
                if (sel && !sel.isCollapsed && sel.toString().trim().length >= 2) {
                    showToolbar(e.clientX, e.clientY);
                } else {
                    hideToolbar();
                }
            }, 10);
        };
        document.addEventListener('mouseup', window.__cyberHlMouseup);

        // Hide on scroll or click outside
        window.__cyberHlMousedown = (e) => {
            if (!toolbar.contains(e.target)) hideToolbar();
        };
        document.addEventListener('mousedown', window.__cyberHlMousedown, true);
    }

    /**
     * Highlight saved snippets on the current page with tag-based underlines
     * and floating tag badges. Uses a different data attribute
     * (data-cyber-snippet-hl) to avoid conflicts with takeaway highlights.
     *
     * @param {Array<{content: string, tags: string[], id: string}>} snippets
     * @returns {Promise<{highlighted: number, total: number}>}
     */
    async function highlightSnippets(snippets) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) throw new Error('No active tab');

        // Build payload: each snippet gets the color of its first tag
        const eligible = snippets
            .filter(s => s.type === 'text' && s.content && s.content.trim().length >= 8)
            .map(s => {
                const tag = (s.tags && s.tags[0]) || 'default';
                const tc = TAG_COLORS[tag] || TAG_COLORS['default'];
                return {
                    text: s.content.trim(),
                    snippetId: s.id,
                    tags: s.tags || [],
                    displayTags: (s.tags || []).map(tagDisplayName),
                    underline: tc.underline,
                    bg: tc.bg,
                    badgeBg: tc.badge,
                    badgeText: tc.text,
                };
            });
        // "Show on page" can target sessions with thousands of snippets. A
        // bounded first batch keeps the publisher page responsive.
        const payload = eligible.slice(0, 24);

        if (payload.length === 0) return { highlighted: 0, total: 0 };

        const tagColorsPayload = TAG_COLORS;

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: injectSnippetHighlights,
            args: [payload, tagColorsPayload],
        });

        const result = results?.[0]?.result || { highlighted: 0, total: payload.length };
        return { ...result, total: eligible.length, limited: eligible.length > payload.length };
    }

    /**
     * Clear only snippet-based highlights (not takeaway highlights).
     */
    async function clearSnippetHighlights() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.__cyberHighlightJobId = (window.__cyberHighlightJobId || 0) + 1;
                // Remove tag badges
                document.querySelectorAll('.cyber-tag-badge').forEach(el => el.remove());
                // Unwrap snippet highlights
                document.querySelectorAll('[data-cyber-snippet-hl]').forEach(el => {
                    const parent = el.parentNode;
                    if (parent) {
                        parent.replaceChild(document.createTextNode(el.textContent), el);
                        parent.normalize();
                    }
                });
            },
        });
    }

    /**
     * Injected: highlight saved snippets with tag-based underlines + tag badges.
     */
    async function injectSnippetHighlights(snippets, tagColors) {
        const jobId = (window.__cyberHighlightJobId || 0) + 1;
        window.__cyberHighlightJobId = jobId;
        const isCancelled = () => window.__cyberHighlightJobId !== jobId;
        const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));
        // Remove existing snippet highlights first
        document.querySelectorAll('.cyber-tag-badge').forEach(el => el.remove());
        const takeawayHighlights = document.querySelectorAll('[data-cyber-highlight]');
        for (let index = 0; index < takeawayHighlights.length; index++) {
            const el = takeawayHighlights[index];
            const parent = el.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(el.textContent), el);
                parent.normalize();
            }
            if (index > 0 && index % 80 === 0) await yieldToPage();
            if (isCancelled()) return { highlighted: 0, total: snippets.length, cancelled: true };
        }
        const snippetHighlights = document.querySelectorAll('[data-cyber-snippet-hl]');
        for (let index = 0; index < snippetHighlights.length; index++) {
            const el = snippetHighlights[index];
            const parent = el.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(el.textContent), el);
                parent.normalize();
            }
            if (index > 0 && index % 80 === 0) await yieldToPage();
            if (isCancelled()) return { highlighted: 0, total: snippets.length, cancelled: true };
        }

        // Inject badge styles once
        if (!document.getElementById('cyber-snippet-hl-styles')) {
            const style = document.createElement('style');
            style.id = 'cyber-snippet-hl-styles';
            style.textContent = `
                [data-cyber-snippet-hl] {
                    position: relative;
                    padding: 1px 0;
                    border-radius: 2px;
                    transition: background 0.15s;
                }
                [data-cyber-snippet-hl]:hover {
                    filter: brightness(0.96);
                }
                .cyber-tag-badge {
                    position: absolute;
                    top: -8px;
                    right: -2px;
                    font-size: 9px;
                    font-weight: 600;
                    line-height: 1;
                    padding: 2px 5px;
                    border-radius: 3px;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    white-space: nowrap;
                    pointer-events: none;
                    z-index: 1000;
                    opacity: 0;
                    transition: opacity 0.15s;
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }
                [data-cyber-snippet-hl]:hover .cyber-tag-badge {
                    opacity: 1;
                }
            `;
            document.head.appendChild(style);
        }

        let totalHighlighted = 0;

        for (let index = 0; index < snippets.length; index++) {
            const snippet = snippets[index];
            const found = findAndHighlightSnippet(
                snippet.text, snippet.underline, snippet.bg,
                snippet.snippetId, snippet.displayTags || snippet.tags, snippet.badgeBg, snippet.badgeText
            );
            if (found) totalHighlighted++;
            if (index % 2 === 1) await yieldToPage();
            if (isCancelled()) return { highlighted: totalHighlighted, total: snippets.length, cancelled: true };
        }

        return { highlighted: totalHighlighted, total: snippets.length };

        function findAndHighlightSnippet(searchText, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText) {
            const normalizedSearch = searchText.replace(/\s+/g, ' ').trim();
            if (!normalizedSearch || normalizedSearch.length < 8) return false;

            // Use only the first 200 chars for matching if content is very long
            const matchText = normalizedSearch.length > 200
                ? normalizedSearch.substring(0, 200) : normalizedSearch;

            const walker = document.createTreeWalker(
                document.body, NodeFilter.SHOW_TEXT, {
                    acceptNode: (node) => {
                        const parent = node.parentElement;
                        if (!parent) return NodeFilter.FILTER_REJECT;
                        if (parent.closest('script,style,noscript,iframe,template,nav,footer,[hidden],[aria-hidden="true"],[role="navigation"],[role="dialog"]'))
                            return NodeFilter.FILTER_REJECT;
                        if (parent.closest('[data-cyber-snippet-hl]') || parent.closest('[data-cyber-highlight]'))
                            return NodeFilter.FILTER_REJECT;
                        const style = window.getComputedStyle(parent);
                        if (style.display === 'none' || style.visibility === 'hidden'
                            || style.visibility === 'collapse' || Number(style.opacity) <= 0.01
                            || parent.getClientRects().length === 0) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        return NodeFilter.FILTER_ACCEPT;
                    }
                }
            );

            const textNodes = [];
            let node;
            while ((node = walker.nextNode())) textNodes.push(node);

            // Strategy 1: single text node match
            for (const textNode of textNodes) {
                const nodeText = textNode.textContent;
                const normalizedNode = nodeText.replace(/\s+/g, ' ');
                const idx = normalizedNode.toLowerCase().indexOf(matchText.toLowerCase());
                if (idx === -1) continue;
                const matchStart = mapNormIdx(nodeText, idx);
                const matchEnd = mapNormIdx(nodeText, idx + matchText.length);
                return wrapSnippet(textNode, matchStart, matchEnd, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
            }

            // Strategy 2: cross-node match
            // Keep matching semantics aligned with PageExtractor and retain a
            // precise normalized-character-to-DOM-offset map.
            const flattened = [];
            const positions = [];
            let hasText = false;
            let pendingSpace = false;
            for (const textNode of textNodes) {
                const original = textNode.textContent || '';
                if (hasText) pendingSpace = true;
                for (let offset = 0; offset < original.length; offset++) {
                    const character = original[offset];
                    if (/\s/.test(character)) {
                        if (hasText) pendingSpace = true;
                        continue;
                    }
                    if (pendingSpace && hasText) {
                        flattened.push(' ');
                        positions.push(null);
                        pendingSpace = false;
                    }
                    flattened.push(character);
                    positions.push({ node: textNode, offset });
                    hasText = true;
                }
            }
            const normalizedFull = flattened.join('');
            const fullIdx = normalizedFull.toLowerCase().indexOf(matchText.toLowerCase());
            if (fullIdx === -1) return false;

            const startPosition = positions[fullIdx];
            const endPosition = positions[fullIdx + matchText.length - 1];
            if (!startPosition || !endPosition) return false;
            const startNode = startPosition.node;
            const startOffset = startPosition.offset;
            const endNode = endPosition.node;
            const endOffset = endPosition.offset + 1;
            if (startNode === endNode) {
                return wrapSnippet(startNode, startOffset, endOffset, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
            }

            const startIndex = textNodes.indexOf(startNode);
            const endIndex = textNodes.indexOf(endNode);
            let wrapped = false;
            for (let index = endIndex; index >= startIndex; index--) {
                const textNode = textNodes[index];
                const segmentStart = index === startIndex ? startOffset : 0;
                const segmentEnd = index === endIndex ? endOffset : textNode.textContent.length;
                if (!textNode.textContent.slice(segmentStart, segmentEnd).trim()) continue;
                wrapped = wrapSnippet(
                    textNode,
                    segmentStart,
                    segmentEnd,
                    underlineColor,
                    bgColor,
                    snippetId,
                    tags,
                    badgeBg,
                    badgeText,
                    index === startIndex
                ) || wrapped;
            }
            return wrapped;
        }

        function makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText, showBadge = true) {
            const span = document.createElement('span');
            span.setAttribute('data-cyber-snippet-hl', 'true');
            span.setAttribute('data-cyber-snippet-id', snippetId);
            span.setAttribute('data-cyber-tags', (tags || []).join(','));
            span.style.cssText = `background:${bgColor};border-bottom:2px solid ${underlineColor};padding:1px 0;border-radius:2px;position:relative;`;

            // Add tag badge(s) — show up to 2 tags
            if (showBadge && tags && tags.length > 0) {
                const displayTags = tags.slice(0, 2);
                const badge = document.createElement('span');
                badge.className = 'cyber-tag-badge';
                badge.textContent = displayTags.join(' · ');
                badge.style.cssText += `background:${badgeBg};color:${badgeText};`;
                span.appendChild(badge);
            }

            return span;
        }

        function wrapSnippet(textNode, start, end, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText, showBadge = true) {
            if (start >= end || start < 0) return false;
            try {
                const range = document.createRange();
                range.setStart(textNode, Math.min(start, textNode.textContent.length));
                range.setEnd(textNode, Math.min(end, textNode.textContent.length));
                const span = makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText, showBadge);
                range.surroundContents(span);
                return true;
            } catch (e) { return false; }
        }

        function mapNormIdx(original, normalizedIdx) {
            let ni = 0, inSpace = false;
            for (let i = 0; i < original.length; i++) {
                if (ni >= normalizedIdx) return i;
                if (/\s/.test(original[i])) { if (!inSpace) { ni++; inSpace = true; } }
                else { ni++; inSpace = false; }
            }
            return original.length;
        }
    }

    return {
        COLORS, TAG_COLORS, getColor,
        isSameDocumentUrl,
        highlightGroups, scrollToGroup, clearAll,
        cancelPending,
        enableSelectionMode, disableSelectionMode,
        collectHighlights,
        highlightSnippets, clearSnippetHighlights,
    };
})();
