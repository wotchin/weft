/**
 * SnippetOrganizer — local preprocessing for snippet organization.
 *
 * Performs as much work as possible without LLM calls:
 * - Group by source domain/page
 * - Infer tags from content analysis (keywords, patterns)
 * - Estimate importance / relevance
 * - Detect snippet types (quote, data, opinion, reference)
 * - Sort by topic clustering (simple TF overlap)
 * - Prepare a minimal prompt for LLM to fill gaps
 */
const SnippetOrganizer = (() => {

    // ---- Tag inference patterns ----
    const TAG_PATTERNS = [
        { tag: 'data',      patterns: [/\d+(\.\d+)?%/, /\$[\d,.]+/, /\d{4}年/, /\d+\s*(million|billion|trillion|万|亿)/, /increased?\s+by/, /decreased?\s+by/, /growth\s+rate/, /statistics?/i, /percentage/i] },
        { tag: 'quote',     patterns: [/^[""\u201c].*[""\u201d]$/s, /said\b/i, /according\s+to/i, /stated\s+that/i, /^「.*」$/s, /表示/, /认为/, /指出/] },
        { tag: 'opinion',   patterns: [/\bI\s+think\b/i, /\bI\s+believe\b/i, /\bshould\b/i, /\bmust\b/i, /我认为/, /我觉得/, /应该/, /必须/, /观点/, /arguably/i] },
        { tag: 'reference', patterns: [/https?:\/\//, /\bsource[s]?\b/i, /\bcite[sd]?\b/i, /参考/, /来源/, /引用/, /\bet\s+al\b/i, /\[\d+\]/] },
        { tag: 'key-point', patterns: [/\bimportant\b/i, /\bkey\b/i, /\bcritical\b/i, /\bessential\b/i, /重要/, /关键/, /核心/, /要点/] },
        { tag: 'definition',patterns: [/\bis\s+defined\s+as\b/i, /\brefers\s+to\b/i, /定义/, /是指/, /即/] },
        { tag: 'example',   patterns: [/\bfor\s+example\b/i, /\bsuch\s+as\b/i, /\be\.g\.\b/i, /例如/, /比如/, /举例/] },
    ];

    /**
     * Infer tags for a single snippet based on content patterns.
     * Returns array of suggested tags (excluding tags the snippet already has).
     */
    function inferTags(snippet) {
        const text = snippet.content || '';
        const existingTags = new Set(snippet.tags || []);
        const suggested = [];

        if (snippet.type === 'image') {
            if (!existingTags.has('image')) suggested.push('image');
            return suggested;
        }

        for (const { tag, patterns } of TAG_PATTERNS) {
            if (existingTags.has(tag)) continue;
            if (patterns.some(p => p.test(text))) {
                suggested.push(tag);
            }
        }

        return suggested;
    }

    /**
     * Extract domain from URL.
     */
    function extractDomain(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); }
        catch { return ''; }
    }

    /**
     * Group snippets by source page (domain + path or sourceTitle).
     * Returns: [{ source: { domain, title, url }, snippets: [...] }]
     */
    function groupBySource(snippets) {
        const groups = new Map();

        snippets.forEach((snippet, index) => {
            const url = snippet.sourceUrl || '';
            const title = snippet.sourceTitle || '';
            const domain = extractDomain(url);
            // Group key: use sourceUrl (without hash) or title
            const baseUrl = url.split('#')[0].split('?')[0];
            const key = baseUrl || title || 'unknown';

            if (!groups.has(key)) {
                groups.set(key, {
                    source: { domain, title, url: baseUrl || url },
                    snippets: []
                });
            }
            groups.get(key).snippets.push({ ...snippet, _originalIndex: index });
        });

        return Array.from(groups.values());
    }

    /**
     * Simple tokenization for clustering (Chinese + English).
     */
    function tokenize(text) {
        if (!text) return [];
        const words = text.toLowerCase()
            .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 1);
        // Add Chinese bigrams
        const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
        for (let i = 0; i < cjk.length - 1; i++) {
            words.push(cjk[i] + cjk[i + 1]);
        }
        return words;
    }

    /**
     * Compute TF-based similarity between two texts (0-1).
     */
    function textSimilarity(a, b) {
        const tokensA = new Set(tokenize(a));
        const tokensB = new Set(tokenize(b));
        if (tokensA.size === 0 || tokensB.size === 0) return 0;
        let overlap = 0;
        for (const t of tokensA) if (tokensB.has(t)) overlap++;
        return overlap / Math.sqrt(tokensA.size * tokensB.size);
    }

    /**
     * Cluster snippets by topic similarity.
     * Simple greedy clustering: assign each snippet to the most similar
     * existing cluster or create a new one.
     */
    function clusterByTopic(snippets, threshold = 0.15) {
        const clusters = []; // [{ centroidText, snippets }]

        for (const snippet of snippets) {
            const text = snippet.content || snippet.sourceTitle || '';
            let bestCluster = null;
            let bestSim = threshold;

            for (const cluster of clusters) {
                const sim = textSimilarity(text, cluster.centroidText);
                if (sim > bestSim) {
                    bestSim = sim;
                    bestCluster = cluster;
                }
            }

            if (bestCluster) {
                bestCluster.snippets.push(snippet);
                bestCluster.centroidText += ' ' + text; // grow centroid
            } else {
                clusters.push({ centroidText: text, snippets: [snippet] });
            }
        }

        return clusters;
    }

    /**
     * Estimate snippet importance (0-1) based on:
     * - Content length (longer = more info)
     * - Has tags (manually tagged = user cares)
     * - Has data/numbers
     * - Is from a distinct source
     */
    function estimateImportance(snippet) {
        let score = 0.3; // base
        const text = snippet.content || '';

        // Length bonus
        if (text.length > 200) score += 0.15;
        else if (text.length > 50) score += 0.08;

        // Has user-assigned tags
        if (snippet.tags && snippet.tags.length > 0) score += 0.2;

        // Contains numbers/data
        if (/\d+(\.\d+)?%/.test(text) || /\$[\d,.]+/.test(text)) score += 0.15;

        // Is a key-point or data tag
        if ((snippet.tags || []).some(t => ['key-point', 'data'].includes(t))) score += 0.1;

        // Image snippet
        if (snippet.type === 'image') score += 0.1;

        return Math.min(score, 1.0);
    }

    /**
     * Detect language of text (simplified).
     */
    function detectLanguage(text) {
        const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const total = text.length;
        if (total === 0) return 'en';
        return cjk / total > 0.15 ? 'zh' : 'en';
    }

    /**
     * Full preprocessing pipeline.
     * Returns a structured object ready for minimal LLM augmentation.
     */
    function preprocess(snippets) {
        if (!snippets || snippets.length === 0) {
            return { sourceGroups: [], clusters: [], snippets: [], language: 'en', stats: {} };
        }

        // 1. Infer tags for each snippet
        const enriched = snippets.map((s, i) => {
            const inferred = inferTags(s);
            return {
                ...s,
                _index: i,
                _inferredTags: inferred,
                _allTags: [...new Set([...(s.tags || []), ...inferred])],
                _importance: estimateImportance(s),
            };
        });

        // 2. Group by source
        const sourceGroups = groupBySource(enriched);

        // 3. Cluster by topic (text snippets only)
        const textSnippets = enriched.filter(s => s.type !== 'image');
        const imageSnippets = enriched.filter(s => s.type === 'image');
        const clusters = clusterByTopic(textSnippets);

        // 4. Sort clusters by aggregate importance
        clusters.sort((a, b) => {
            const avgA = a.snippets.reduce((sum, s) => sum + s._importance, 0) / a.snippets.length;
            const avgB = b.snippets.reduce((sum, s) => sum + s._importance, 0) / b.snippets.length;
            return avgB - avgA;
        });

        // 5. Detect language
        const allText = enriched.map(s => s.content || '').join(' ');
        const language = detectLanguage(allText);

        // 6. Stats
        const stats = {
            totalSnippets: snippets.length,
            textSnippets: textSnippets.length,
            imageSnippets: imageSnippets.length,
            sources: sourceGroups.length,
            clusters: clusters.length,
            totalChars: allText.length,
            language,
        };

        return { sourceGroups, clusters, imageSnippets, snippets: enriched, language, stats };
    }

    /**
     * Build the minimal LLM prompt for context enrichment.
     * Only asks LLM to: generate a title, write section intros, and
     * suggest ordering — NOT to rewrite or summarize the snippets themselves.
     */
    function buildLLMPrompt(preprocessed) {
        const { clusters, snippets, stats, language } = preprocessed;
        const lang = language === 'zh' ? '中文' : 'English';

        let prompt = `You are organizing a collection of ${stats.totalSnippets} web snippets (${stats.textSnippets} text, ${stats.imageSnippets} images) from ${stats.sources} sources.

The snippets have been pre-clustered into ${clusters.length} topic groups. For each group, generate:
1. A short section title (3-8 words)
2. A brief contextual intro (1-2 sentences) that connects the snippets and fills in missing context
3. A transition sentence to the next section (if not the last)

Also generate:
- An overall document title
- A brief executive summary (2-3 sentences)

Output in ${lang}. Output ONLY valid JSON:
{
  "title": "Overall document title",
  "summary": "Executive summary",
  "sections": [
    {
      "title": "Section title",
      "intro": "Contextual introduction",
      "transition": "Transition to next section (empty string if last)"
    }
  ]
}

Here are the topic clusters:\n\n`;

        clusters.forEach((cluster, i) => {
            prompt += `--- Cluster ${i + 1} (${cluster.snippets.length} snippets) ---\n`;
            cluster.snippets.forEach((s, j) => {
                const tags = s._allTags.join(', ');
                const source = s.sourceTitle || extractDomain(s.sourceUrl || '') || '';
                const text = (s.content || '').substring(0, 300);
                prompt += `[${j + 1}] ${tags ? `(${tags}) ` : ''}${source ? `from ${source}: ` : ''}${text}\n`;
            });
            prompt += '\n';
        });

        return prompt;
    }

    return {
        inferTags, groupBySource, clusterByTopic, estimateImportance,
        detectLanguage, textSimilarity, preprocess, buildLLMPrompt,
        extractDomain,
    };
})();
