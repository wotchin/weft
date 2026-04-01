/**
 * Highlighter — inject highlights into webpage DOM for Key Takeaways.
 *
 * Uses chrome.scripting.executeScript to find and highlight exact text
 * fragments in the active tab, with per-group colors and scroll-to support.
 */
const Highlighter = (() => {

    // Color palette — 8 distinct highlight colors (background, border)
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

    /**
     * Get color for a takeaway group index.
     */
    function getColor(groupIndex) {
        return COLORS[groupIndex % COLORS.length];
    }

    /**
     * Highlight multiple groups of quotes in the active tab.
     * @param {Array<{groupIndex: number, quotes: string[]}>} groups
     * @returns {Promise<{highlighted: number, total: number}>}
     */
    async function highlightGroups(groups) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) throw new Error('No active tab');

        // Build injection payload: array of { quotes, bgColor, borderColor, groupId }
        const payload = groups.map(g => ({
            quotes: g.quotes,
            bgColor: COLORS[g.groupIndex % COLORS.length].bg,
            borderColor: COLORS[g.groupIndex % COLORS.length].border,
            groupId: `cyber-hl-group-${g.groupIndex}`,
        }));

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: injectHighlights,
            args: [payload],
        });

        return results?.[0]?.result || { highlighted: 0, total: 0 };
    }

    /**
     * Scroll to a specific highlight group in the active tab.
     * @param {number} groupIndex
     */
    async function scrollToGroup(groupIndex) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (groupId) => {
                const el = document.querySelector(`[data-cyber-group="${groupId}"]`);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Flash effect
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
     * Clear all highlights from the active tab.
     */
    async function clearAll() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                document.querySelectorAll('[data-cyber-highlight]').forEach(el => {
                    const parent = el.parentNode;
                    if (parent) {
                        parent.replaceChild(document.createTextNode(el.textContent), el);
                        parent.normalize(); // merge adjacent text nodes
                    }
                });
            },
        });
    }

    /**
     * The function injected into the page to perform highlighting.
     * This runs in the webpage context, not the extension context.
     */
    function injectHighlights(groups) {
        // First clear any existing highlights
        document.querySelectorAll('[data-cyber-highlight]').forEach(el => {
            const parent = el.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(el.textContent), el);
                parent.normalize();
            }
        });

        let totalQuotes = 0;
        let totalHighlighted = 0;

        for (const group of groups) {
            for (const quote of group.quotes) {
                totalQuotes++;
                const trimmed = quote.trim();
                if (trimmed.length < 8) continue; // skip very short fragments

                const found = findAndHighlight(trimmed, group.bgColor, group.borderColor, group.groupId);
                if (found) totalHighlighted++;
            }
        }

        return { highlighted: totalHighlighted, total: totalQuotes };

        /**
         * Find text in DOM and wrap with highlight span.
         * Uses TreeWalker for efficient text node traversal.
         * Supports fuzzy matching: tries exact first, then normalized whitespace.
         */
        function findAndHighlight(searchText, bgColor, borderColor, groupId) {
            // Normalize search text
            const normalizedSearch = searchText.replace(/\s+/g, ' ').trim();
            if (!normalizedSearch) return false;

            // Get all text nodes in body (skip script, style, etc.)
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: (node) => {
                        const parent = node.parentElement;
                        if (!parent) return NodeFilter.FILTER_REJECT;
                        const tag = parent.tagName;
                        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(tag)) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        if (parent.closest('[data-cyber-highlight]')) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        return NodeFilter.FILTER_ACCEPT;
                    }
                }
            );

            // Build a list of text nodes with their content
            const textNodes = [];
            let node;
            while ((node = walker.nextNode())) {
                textNodes.push(node);
            }

            // Strategy 1: Try to find the text within a single text node
            for (const textNode of textNodes) {
                const nodeText = textNode.textContent;
                const normalizedNode = nodeText.replace(/\s+/g, ' ');

                const idx = normalizedNode.toLowerCase().indexOf(normalizedSearch.toLowerCase());
                if (idx === -1) continue;

                // Map normalized index back to original text position
                const matchStart = mapNormalizedIndex(nodeText, idx);
                const matchEnd = mapNormalizedIndex(nodeText, idx + normalizedSearch.length);

                return wrapRange(textNode, matchStart, matchEnd, bgColor, borderColor, groupId);
            }

            // Strategy 2: Cross-node matching — concatenate adjacent text nodes
            // and search across node boundaries
            const fullText = textNodes.map(n => n.textContent).join('');
            const normalizedFull = fullText.replace(/\s+/g, ' ');
            const fullIdx = normalizedFull.toLowerCase().indexOf(normalizedSearch.toLowerCase());
            if (fullIdx === -1) return false;

            // Find which text nodes span this match
            const matchLen = normalizedSearch.length;
            let charOffset = 0;
            let startNode = null, startOffset = 0;
            let endNode = null, endOffset = 0;

            const normalizedLens = textNodes.map(n => n.textContent.replace(/\s+/g, ' ').length);

            for (let i = 0; i < textNodes.length; i++) {
                const nLen = normalizedLens[i];
                if (!startNode && charOffset + nLen > fullIdx) {
                    startNode = textNodes[i];
                    const localIdx = fullIdx - charOffset;
                    startOffset = mapNormalizedIndex(startNode.textContent, localIdx);
                }
                if (startNode && charOffset + nLen >= fullIdx + matchLen) {
                    endNode = textNodes[i];
                    const localIdx = fullIdx + matchLen - charOffset;
                    endOffset = mapNormalizedIndex(endNode.textContent, localIdx);
                    break;
                }
                charOffset += nLen;
            }

            if (!startNode || !endNode) return false;

            if (startNode === endNode) {
                return wrapRange(startNode, startOffset, endOffset, bgColor, borderColor, groupId);
            }

            // Multi-node highlight: wrap from startNode to endNode
            try {
                const range = document.createRange();
                range.setStart(startNode, startOffset);
                range.setEnd(endNode, endOffset);

                const span = document.createElement('span');
                span.setAttribute('data-cyber-highlight', 'true');
                span.setAttribute('data-cyber-group', groupId);
                span.setAttribute('data-cyber-border', borderColor);
                span.style.cssText = `background:${bgColor};border-bottom:2px solid ${borderColor};padding:1px 0;border-radius:2px;`;
                range.surroundContents(span);
                return true;
            } catch (e) {
                // surroundContents can fail if range crosses element boundaries
                // Fall back to highlighting just the start node portion
                return wrapRange(startNode, startOffset, startNode.textContent.length, bgColor, borderColor, groupId);
            }
        }

        /**
         * Map a position in normalized text (collapsed whitespace) back to
         * the original text position.
         */
        function mapNormalizedIndex(original, normalizedIdx) {
            let ni = 0;
            let inSpace = false;
            for (let i = 0; i < original.length; i++) {
                if (ni >= normalizedIdx) return i;
                const ch = original[i];
                if (/\s/.test(ch)) {
                    if (!inSpace) {
                        ni++;
                        inSpace = true;
                    }
                } else {
                    ni++;
                    inSpace = false;
                }
            }
            return original.length;
        }

        /**
         * Wrap a range within a single text node with a highlight span.
         */
        function wrapRange(textNode, start, end, bgColor, borderColor, groupId) {
            if (start >= end || start < 0) return false;
            try {
                const range = document.createRange();
                range.setStart(textNode, Math.min(start, textNode.textContent.length));
                range.setEnd(textNode, Math.min(end, textNode.textContent.length));

                const span = document.createElement('span');
                span.setAttribute('data-cyber-highlight', 'true');
                span.setAttribute('data-cyber-group', groupId);
                span.setAttribute('data-cyber-border', borderColor);
                span.style.cssText = `background:${bgColor};border-bottom:2px solid ${borderColor};padding:1px 0;border-radius:2px;`;
                range.surroundContents(span);
                return true;
            } catch (e) {
                return false;
            }
        }
    }

    return { COLORS, getColor, highlightGroups, scrollToGroup, clearAll };
})();
