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
    async function clearAll() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                // Remove toolbar
                document.getElementById('cyber-hl-toolbar')?.remove();
                // Remove mouseup listener
                if (window.__cyberHlMouseup) {
                    document.removeEventListener('mouseup', window.__cyberHlMouseup);
                    window.__cyberHlMouseup = null;
                }
                // Unwrap all highlights
                document.querySelectorAll('[data-cyber-highlight]').forEach(el => {
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
     */
    async function enableSelectionMode(groupCount, groupTitles) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;

        const colorPayload = [];
        for (let i = 0; i < groupCount; i++) {
            const c = COLORS[i % COLORS.length];
            colorPayload.push({
                groupIndex: i,
                bg: c.bg,
                border: c.border,
                name: c.name,
                title: groupTitles[i] || `Group ${i + 1}`,
            });
        }

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: injectSelectionToolbar,
            args: [colorPayload],
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
            },
        });
    }

    /**
     * Collect all current highlights from the page, grouped by groupId.
     * Returns an array of { groupIndex, quotes: string[] }.
     */
    async function collectHighlights() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return [];

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
    function injectHighlights(groups) {
        // Clear existing highlights first
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
                if (trimmed.length < 8) continue;
                const found = findAndHighlight(trimmed, group.bgColor, group.borderColor, group.groupId);
                if (found) totalHighlighted++;
            }
        }

        return { highlighted: totalHighlighted, total: totalQuotes };

        function findAndHighlight(searchText, bgColor, borderColor, groupId) {
            const normalizedSearch = searchText.replace(/\s+/g, ' ').trim();
            if (!normalizedSearch) return false;

            const walker = document.createTreeWalker(
                document.body, NodeFilter.SHOW_TEXT, {
                    acceptNode: (node) => {
                        const parent = node.parentElement;
                        if (!parent) return NodeFilter.FILTER_REJECT;
                        if (['SCRIPT','STYLE','NOSCRIPT','IFRAME'].includes(parent.tagName))
                            return NodeFilter.FILTER_REJECT;
                        if (parent.closest('[data-cyber-highlight]'))
                            return NodeFilter.FILTER_REJECT;
                        return NodeFilter.FILTER_ACCEPT;
                    }
                }
            );

            const textNodes = [];
            let node;
            while ((node = walker.nextNode())) textNodes.push(node);

            // Strategy 1: single text node
            for (const textNode of textNodes) {
                const nodeText = textNode.textContent;
                const normalizedNode = nodeText.replace(/\s+/g, ' ');
                const idx = normalizedNode.toLowerCase().indexOf(normalizedSearch.toLowerCase());
                if (idx === -1) continue;
                const matchStart = mapNormalizedIndex(nodeText, idx);
                const matchEnd = mapNormalizedIndex(nodeText, idx + normalizedSearch.length);
                return wrapRange(textNode, matchStart, matchEnd, bgColor, borderColor, groupId);
            }

            // Strategy 2: cross-node
            const fullText = textNodes.map(n => n.textContent).join('');
            const normalizedFull = fullText.replace(/\s+/g, ' ');
            const fullIdx = normalizedFull.toLowerCase().indexOf(normalizedSearch.toLowerCase());
            if (fullIdx === -1) return false;

            const matchLen = normalizedSearch.length;
            let charOffset = 0;
            let startNode = null, startOffset = 0;
            let endNode = null, endOffset = 0;
            const normalizedLens = textNodes.map(n => n.textContent.replace(/\s+/g, ' ').length);

            for (let i = 0; i < textNodes.length; i++) {
                const nLen = normalizedLens[i];
                if (!startNode && charOffset + nLen > fullIdx) {
                    startNode = textNodes[i];
                    startOffset = mapNormalizedIndex(startNode.textContent, fullIdx - charOffset);
                }
                if (startNode && charOffset + nLen >= fullIdx + matchLen) {
                    endNode = textNodes[i];
                    endOffset = mapNormalizedIndex(endNode.textContent, fullIdx + matchLen - charOffset);
                    break;
                }
                charOffset += nLen;
            }

            if (!startNode || !endNode) return false;
            if (startNode === endNode) {
                return wrapRange(startNode, startOffset, endOffset, bgColor, borderColor, groupId);
            }
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
                return wrapRange(startNode, startOffset, startNode.textContent.length, bgColor, borderColor, groupId);
            }
        }

        function mapNormalizedIndex(original, normalizedIdx) {
            let ni = 0, inSpace = false;
            for (let i = 0; i < original.length; i++) {
                if (ni >= normalizedIdx) return i;
                if (/\s/.test(original[i])) { if (!inSpace) { ni++; inSpace = true; } }
                else { ni++; inSpace = false; }
            }
            return original.length;
        }

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
            } catch (e) { return false; }
        }
    }

    /**
     * Injected: floating selection toolbar.
     * When the user selects text on the page, a small toolbar appears near the
     * selection with color-coded group buttons (assign to group) + a remove button.
     */
    function injectSelectionToolbar(colors) {
        // Remove existing toolbar if any
        document.getElementById('cyber-hl-toolbar')?.remove();
        if (window.__cyberHlMouseup) {
            document.removeEventListener('mouseup', window.__cyberHlMouseup);
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
        label.textContent = 'Highlight as:';
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
        removeBtn.title = 'Remove highlight';
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
            const vh = window.innerHeight;
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
        document.addEventListener('mousedown', (e) => {
            if (!toolbar.contains(e.target)) hideToolbar();
        }, true);
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
        const payload = snippets
            .filter(s => s.type === 'text' && s.content && s.content.trim().length >= 8)
            .map(s => {
                const tag = (s.tags && s.tags[0]) || 'default';
                const tc = TAG_COLORS[tag] || TAG_COLORS['default'];
                return {
                    text: s.content.trim(),
                    snippetId: s.id,
                    tags: s.tags || [],
                    underline: tc.underline,
                    bg: tc.bg,
                    badgeBg: tc.badge,
                    badgeText: tc.text,
                };
            });

        if (payload.length === 0) return { highlighted: 0, total: 0 };

        const tagColorsPayload = TAG_COLORS;

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: injectSnippetHighlights,
            args: [payload, tagColorsPayload],
        });

        return results?.[0]?.result || { highlighted: 0, total: 0 };
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
    function injectSnippetHighlights(snippets, tagColors) {
        // Remove existing snippet highlights first
        document.querySelectorAll('.cyber-tag-badge').forEach(el => el.remove());
        document.querySelectorAll('[data-cyber-snippet-hl]').forEach(el => {
            const parent = el.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(el.textContent), el);
                parent.normalize();
            }
        });

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

        for (const snippet of snippets) {
            const found = findAndHighlightSnippet(
                snippet.text, snippet.underline, snippet.bg,
                snippet.snippetId, snippet.tags, snippet.badgeBg, snippet.badgeText
            );
            if (found) totalHighlighted++;
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
                        if (['SCRIPT','STYLE','NOSCRIPT','IFRAME'].includes(parent.tagName))
                            return NodeFilter.FILTER_REJECT;
                        if (parent.closest('[data-cyber-snippet-hl]') || parent.closest('[data-cyber-highlight]'))
                            return NodeFilter.FILTER_REJECT;
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
            const fullText = textNodes.map(n => n.textContent).join('');
            const normalizedFull = fullText.replace(/\s+/g, ' ');
            const fullIdx = normalizedFull.toLowerCase().indexOf(matchText.toLowerCase());
            if (fullIdx === -1) return false;

            let charOffset = 0;
            let startNode = null, startOffset = 0;
            let endNode = null, endOffset = 0;
            const normalizedLens = textNodes.map(n => n.textContent.replace(/\s+/g, ' ').length);

            for (let i = 0; i < textNodes.length; i++) {
                const nLen = normalizedLens[i];
                if (!startNode && charOffset + nLen > fullIdx) {
                    startNode = textNodes[i];
                    startOffset = mapNormIdx(startNode.textContent, fullIdx - charOffset);
                }
                if (startNode && charOffset + nLen >= fullIdx + matchText.length) {
                    endNode = textNodes[i];
                    endOffset = mapNormIdx(endNode.textContent, fullIdx + matchText.length - charOffset);
                    break;
                }
                charOffset += nLen;
            }

            if (!startNode || !endNode) return false;
            if (startNode === endNode) {
                return wrapSnippet(startNode, startOffset, endOffset, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
            }

            try {
                const range = document.createRange();
                range.setStart(startNode, startOffset);
                range.setEnd(endNode, endOffset);
                const span = makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
                range.surroundContents(span);
                return true;
            } catch (e) {
                return wrapSnippet(startNode, startOffset, startNode.textContent.length, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
            }
        }

        function makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText) {
            const span = document.createElement('span');
            span.setAttribute('data-cyber-snippet-hl', 'true');
            span.setAttribute('data-cyber-snippet-id', snippetId);
            span.setAttribute('data-cyber-tags', (tags || []).join(','));
            span.style.cssText = `background:${bgColor};border-bottom:2px solid ${underlineColor};padding:1px 0;border-radius:2px;position:relative;`;

            // Add tag badge(s) — show up to 2 tags
            if (tags && tags.length > 0) {
                const displayTags = tags.slice(0, 2);
                const badge = document.createElement('span');
                badge.className = 'cyber-tag-badge';
                badge.textContent = displayTags.join(' · ');
                badge.style.cssText += `background:${badgeBg};color:${badgeText};`;
                span.appendChild(badge);
            }

            return span;
        }

        function wrapSnippet(textNode, start, end, underlineColor, bgColor, snippetId, tags, badgeBg, badgeText) {
            if (start >= end || start < 0) return false;
            try {
                const range = document.createRange();
                range.setStart(textNode, Math.min(start, textNode.textContent.length));
                range.setEnd(textNode, Math.min(end, textNode.textContent.length));
                const span = makeSnippetSpan(underlineColor, bgColor, snippetId, tags, badgeBg, badgeText);
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
        highlightGroups, scrollToGroup, clearAll,
        enableSelectionMode, disableSelectionMode,
        collectHighlights,
        highlightSnippets, clearSnippetHighlights,
    };
})();
