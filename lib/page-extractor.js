/**
 * PageExtractor — extract readable text content from the current webpage
 * via chrome.scripting.executeScript.
 *
 * Returns: { title, url, description, content, wordCount, lang }
 */
const PageExtractor = (() => {
    // The function injected into the page to extract content
    function extractPageContent() {
        // Elements to remove before extraction
        const REMOVE_SELECTORS = [
            'script', 'style', 'noscript', 'iframe', 'svg',
            'nav', 'footer', 'header',
            '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
            '.nav', '.navbar', '.footer', '.sidebar', '.menu',
            '.advertisement', '.ad', '.ads', '.adsbygoogle',
            '.cookie-banner', '.cookie-notice',
            '.popup', '.modal', '.overlay',
            '.social-share', '.share-buttons',
            '.comments', '#comments', '.comment-section',
            '#disqus_thread',
        ];

        // Clone body so we don't mutate the actual DOM
        const clone = document.body.cloneNode(true);

        // Remove unwanted elements
        REMOVE_SELECTORS.forEach(sel => {
            clone.querySelectorAll(sel).forEach(el => el.remove());
        });

        // Try to find main content area
        const mainSelectors = [
            'article', 'main', '[role="main"]',
            '.article', '.post', '.content', '.entry-content',
            '.article-content', '.post-content', '.page-content',
            '#content', '#main', '#article',
        ];

        let mainEl = null;
        for (const sel of mainSelectors) {
            const el = clone.querySelector(sel);
            if (el && el.textContent.trim().length > 200) {
                mainEl = el;
                break;
            }
        }

        // Fallback to the whole cleaned body
        const source = mainEl || clone;

        // Extract text with structure preservation
        function extractText(node) {
            const parts = [];
            const BLOCK_TAGS = new Set([
                'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
                'LI', 'TR', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE',
                'FIGCAPTION', 'DT', 'DD'
            ]);

            for (const child of node.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    const text = child.textContent.trim();
                    if (text) parts.push(text);
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    const tag = child.tagName;

                    // Skip hidden elements
                    const style = child.style;
                    if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
                    if (child.hidden) continue;

                    // Handle headings specially
                    if (/^H[1-6]$/.test(tag)) {
                        const headingText = child.textContent.trim();
                        if (headingText) {
                            const level = parseInt(tag[1]);
                            parts.push('\n' + '#'.repeat(level) + ' ' + headingText + '\n');
                        }
                        continue;
                    }

                    // Handle lists
                    if (tag === 'LI') {
                        const liText = extractText(child).trim();
                        if (liText) parts.push('- ' + liText);
                        continue;
                    }

                    // Handle table rows
                    if (tag === 'TR') {
                        const cells = Array.from(child.querySelectorAll('th, td'));
                        const rowText = cells.map(c => c.textContent.trim()).filter(Boolean).join(' | ');
                        if (rowText) parts.push(rowText);
                        continue;
                    }

                    // Handle links - include href for context
                    if (tag === 'A') {
                        const linkText = child.textContent.trim();
                        if (linkText) parts.push(linkText);
                        continue;
                    }

                    // Handle line breaks
                    if (tag === 'BR') {
                        parts.push('\n');
                        continue;
                    }

                    // Recurse into child
                    const childText = extractText(child);
                    if (childText) {
                        if (BLOCK_TAGS.has(tag)) {
                            parts.push('\n' + childText + '\n');
                        } else {
                            parts.push(childText);
                        }
                    }
                }
            }
            return parts.join(' ').replace(/  +/g, ' ');
        }

        const rawText = extractText(source);

        // Clean up excessive whitespace/newlines
        const content = rawText
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]+/g, ' ')
            .split('\n')
            .map(line => line.trim())
            .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
            .join('\n')
            .trim();

        // Get meta description
        const metaDesc = document.querySelector('meta[name="description"]')?.content
            || document.querySelector('meta[property="og:description"]')?.content
            || '';

        // Word count (rough: split by whitespace + CJK chars count individually)
        const wordCount = content.split(/\s+/).length +
            (content.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;

        return {
            title: document.title || '',
            url: location.href,
            description: metaDesc.substring(0, 500),
            content: content.substring(0, 100000), // Cap at ~100K chars
            wordCount,
            lang: document.documentElement.lang || '',
        };
    }

    /**
     * Extract content from the active tab.
     * @returns {Promise<{title, url, description, content, wordCount, lang}>}
     */
    async function extract() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
            throw new Error('No active tab found');
        }

        // chrome:// and edge:// pages can't be scripted
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
            throw new Error('Cannot extract content from browser internal pages');
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractPageContent,
        });

        const result = results?.[0]?.result;
        if (!result) {
            throw new Error('Failed to extract page content');
        }

        return result;
    }

    /**
     * Extract and chunk for RAG usage.
     * Returns an array of snippet-like objects that can be fed into the RAG pipeline.
     */
    async function extractAsSnippets() {
        const page = await extract();
        if (!page.content || page.content.length < 50) {
            return { page, snippets: [] };
        }

        // Split content into chunks (~512 tokens each)
        const chunks = CyberTokenizer.chunkText(page.content, 512);
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

    return { extract, extractAsSnippets };
})();
