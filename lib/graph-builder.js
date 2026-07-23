/**
 * GraphBuilder — construct knowledge graphs from session snippets.
 *
 * Builds a node-edge graph structure from snippets, automatically discovering
 * relationships through keyword co-occurrence, source linking, and topic clustering.
 * Works at two layers:
 *   - Page level: snippets from a single page
 *   - Session level: cross-page connections within a session
 *
 * Relies on SnippetOrganizer for tokenize/similarity helpers.
 */
const GraphBuilder = (() => {

    // Stop words for keyword extraction (EN + ZH common particles)
    const STOP_WORDS = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
        'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
        'through', 'after', 'before', 'above', 'below', 'and', 'or', 'but',
        'not', 'no', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
        'it', 'its', 'he', 'she', 'they', 'we', 'you', 'me', 'him', 'her',
        'them', 'us', 'my', 'your', 'his', 'our', 'their', 'what', 'which',
        'who', 'whom', 'where', 'when', 'how', 'why', 'all', 'each', 'every',
        'both', 'few', 'more', 'most', 'some', 'any', 'other', 'so', 'very',
        'just', 'also', 'more', 'much', 'such', 'only', 'same', 'too',
        '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
        '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
        '着', '没有', '看', '好', '自己', '这', '他', '她', '它',
    ]);

    /**
     * Extract keywords from text using TF scoring.
     * Returns top-N keywords sorted by score.
     */
    function extractKeywords(text, topN = 8) {
        if (!text || text.length < 5) return [];

        // Tokenize: words + CJK bigrams
        const raw = text.toLowerCase().replace(/[^\w\u4e00-\u9fff\s-]/g, ' ');
        const words = raw.split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));

        // CJK bigrams
        const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
        for (let i = 0; i < cjk.length - 1; i++) {
            const bigram = cjk[i] + cjk[i + 1];
            if (!STOP_WORDS.has(bigram)) words.push(bigram);
        }

        // Term frequency
        const tf = {};
        for (const w of words) {
            tf[w] = (tf[w] || 0) + 1;
        }

        // Score: TF × length bonus (longer terms are more specific)
        const scored = Object.entries(tf).map(([term, freq]) => ({
            term,
            score: freq * (1 + Math.min(term.length / 10, 0.5)),
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topN).map(s => s.term);
    }

    /**
     * Extract named entities (simple pattern-based).
     * Returns { urls, numbers, dates, terms }.
     */
    function extractEntities(text) {
        const entities = { urls: [], numbers: [], dates: [], terms: [] };
        if (!text) return entities;

        // URLs
        const urlRe = /https?:\/\/[^\s<>"]+/g;
        let m;
        while ((m = urlRe.exec(text)) !== null) entities.urls.push(m[0]);

        // Numbers with units
        const numRe = /\d+(\.\d+)?(%|\s*(million|billion|trillion|万|亿|千|百))/gi;
        while ((m = numRe.exec(text)) !== null) entities.numbers.push(m[0].trim());

        // Dates
        const dateRe = /\b\d{4}[-/年]\d{1,2}[-/月]?\d{0,2}日?\b/g;
        while ((m = dateRe.exec(text)) !== null) entities.dates.push(m[0]);

        return entities;
    }

    /**
     * Build a full knowledge graph from snippets.
     *
     * @param {Array} snippets — array of snippet objects
     * @param {Object} options — { pageUrl?: string (filter to one page) }
     * @returns {{ nodes: Array, edges: Array, stats: Object }}
     *
     * Node types: 'page', 'snippet', 'keyword', 'tag'
     * Edge types: 'from_page', 'has_keyword', 'has_tag', 'shared_keyword', 'similar'
     */
    function buildGraph(snippets, options = {}) {
        if (!snippets || snippets.length === 0) {
            return { nodes: [], edges: [], stats: { snippets: 0, pages: 0, keywords: 0 } };
        }

        const { pageUrl } = options;

        // Filter to specific page if requested
        let filtered = snippets.filter(s => s.type === 'text' && s.content);
        if (pageUrl) {
            filtered = filtered.filter(s => samePage(s.sourceUrl, pageUrl));
        }

        if (filtered.length === 0) {
            return { nodes: [], edges: [], stats: { snippets: 0, pages: 0, keywords: 0 } };
        }

        const nodes = [];
        const edges = [];
        const nodeMap = new Map(); // id → node

        // Helper: add node if not exists
        function addNode(id, type, data) {
            if (nodeMap.has(id)) return nodeMap.get(id);
            const node = { id, type, ...data };
            nodes.push(node);
            nodeMap.set(id, node);
            return node;
        }

        // Helper: add edge
        function addEdge(source, target, type, data = {}) {
            edges.push({ source, target, type, ...data });
        }

        // 1. Create page nodes
        const pageGroups = new Map();
        for (const s of filtered) {
            const pageKey = normalizeUrl(s.sourceUrl || '');
            if (!pageGroups.has(pageKey)) pageGroups.set(pageKey, []);
            pageGroups.get(pageKey).push(s);
        }

        for (const [url, group] of pageGroups) {
            const title = group[0].sourceTitle || extractDomain(url) || 'Unknown Page';
            addNode(`page:${url}`, 'page', {
                label: title,
                url,
                snippetCount: group.length,
            });
        }

        // 2. Create snippet nodes + extract keywords
        const snippetKeywords = new Map(); // snippetId → keyword[]

        for (const s of filtered) {
            const importance = estimateImportance(s);
            const allTags = [...new Set([...(s.tags || []), ...inferTagsLocal(s)])];

            addNode(`snippet:${s.id}`, 'snippet', {
                label: (s.content || '').substring(0, 60) + (s.content.length > 60 ? '...' : ''),
                content: s.content,
                tags: allTags,
                importance,
                sourceUrl: s.sourceUrl,
                sourceTitle: s.sourceTitle,
                comment: s.comment || '',
                timestamp: s.timestamp,
            });

            // Edge: snippet → page
            const pageKey = normalizeUrl(s.sourceUrl || '');
            if (nodeMap.has(`page:${pageKey}`)) {
                addEdge(`snippet:${s.id}`, `page:${pageKey}`, 'from_page');
            }

            // Extract keywords
            const kws = extractKeywords(s.content, 6);
            snippetKeywords.set(s.id, kws);

            // Create keyword nodes + edges
            for (const kw of kws) {
                addNode(`kw:${kw}`, 'keyword', { label: kw });
                addEdge(`snippet:${s.id}`, `kw:${kw}`, 'has_keyword');
            }

            // Create tag nodes + edges
            for (const tag of allTags) {
                addNode(`tag:${tag}`, 'tag', { label: tag });
                addEdge(`snippet:${s.id}`, `tag:${tag}`, 'has_tag');
            }
        }

        // 3. Find shared-keyword connections (cross-snippet)
        const kwToSnippets = new Map();
        for (const [sid, kws] of snippetKeywords) {
            for (const kw of kws) {
                if (!kwToSnippets.has(kw)) kwToSnippets.set(kw, []);
                kwToSnippets.get(kw).push(sid);
            }
        }

        // Only create shared_keyword edges for keywords shared by 2+ snippets
        // but not too many (>5 = too generic)
        for (const [kw, sids] of kwToSnippets) {
            if (sids.length >= 2 && sids.length <= 5) {
                for (let i = 0; i < sids.length; i++) {
                    for (let j = i + 1; j < sids.length; j++) {
                        addEdge(`snippet:${sids[i]}`, `snippet:${sids[j]}`, 'shared_keyword', { keyword: kw });
                    }
                }
            }
        }

        // 4. Find direct similarity connections (for snippets without shared keywords)
        for (let i = 0; i < filtered.length; i++) {
            for (let j = i + 1; j < filtered.length; j++) {
                const a = filtered[i], b = filtered[j];
                // Skip if already connected via shared keywords
                const aKws = new Set(snippetKeywords.get(a.id) || []);
                const bKws = snippetKeywords.get(b.id) || [];
                const hasSharedKw = bKws.some(k => aKws.has(k));
                if (hasSharedKw) continue;

                const sim = textSimilarityLocal(a.content, b.content);
                if (sim > 0.2) {
                    addEdge(`snippet:${a.id}`, `snippet:${b.id}`, 'similar', { weight: sim });
                }
            }
        }

        // 5. Compute cross-page connections
        const crossPageLinks = [];
        const pageKeys = Array.from(pageGroups.keys());
        for (let i = 0; i < pageKeys.length; i++) {
            for (let j = i + 1; j < pageKeys.length; j++) {
                const sharedKws = findSharedKeywords(
                    pageGroups.get(pageKeys[i]),
                    pageGroups.get(pageKeys[j]),
                    snippetKeywords
                );
                if (sharedKws.length > 0) {
                    crossPageLinks.push({
                        pageA: pageKeys[i],
                        pageB: pageKeys[j],
                        sharedKeywords: sharedKws,
                    });
                    addEdge(`page:${pageKeys[i]}`, `page:${pageKeys[j]}`, 'shared_topic', {
                        keywords: sharedKws,
                        weight: sharedKws.length,
                    });
                }
            }
        }

        // 6. Prune low-value keyword nodes (connected to only 1 snippet)
        const kwEdgeCount = {};
        for (const e of edges) {
            if (e.type === 'has_keyword') {
                kwEdgeCount[e.target] = (kwEdgeCount[e.target] || 0) + 1;
            }
        }

        // Remove keyword nodes that only connect to 1 snippet (not bridging)
        const pruneIds = new Set();
        for (const [kwId, count] of Object.entries(kwEdgeCount)) {
            if (count <= 1) pruneIds.add(kwId);
        }

        const prunedNodes = nodes.filter(n => !pruneIds.has(n.id));
        const prunedEdges = edges.filter(e => !pruneIds.has(e.source) && !pruneIds.has(e.target));

        return {
            nodes: prunedNodes,
            edges: prunedEdges,
            crossPageLinks,
            stats: {
                snippets: filtered.length,
                pages: pageGroups.size,
                keywords: prunedNodes.filter(n => n.type === 'keyword').length,
                tags: prunedNodes.filter(n => n.type === 'tag').length,
                crossPageLinks: crossPageLinks.length,
            },
        };
    }

    /**
     * Find shared keywords between two groups of snippets.
     */
    function findSharedKeywords(groupA, groupB, snippetKeywords) {
        const kwsA = new Set();
        for (const s of groupA) {
            for (const kw of (snippetKeywords.get(s.id) || [])) kwsA.add(kw);
        }
        const shared = [];
        for (const s of groupB) {
            for (const kw of (snippetKeywords.get(s.id) || [])) {
                if (kwsA.has(kw) && !shared.includes(kw)) shared.push(kw);
            }
        }
        return shared;
    }

    /**
     * Build an LLM prompt to enhance the graph with richer relationships.
     * Asks LLM to identify: supports, contradicts, causes, examples_of.
     */
    function buildEnhancePrompt(graph, language) {
        const snippetNodes = graph.nodes.filter(n => n.type === 'snippet');
        if (snippetNodes.length < 2) return null;

        const lang = language === 'zh' ? '中文' : 'English';

        let prompt = `Analyze these ${snippetNodes.length} text snippets and identify relationships between them.

For each pair where a meaningful relationship exists, output the relationship type.
Relationship types: supports, contradicts, causes, example_of, elaborates, same_topic

Output ONLY valid JSON — an array of relationships:
[{"from": <index>, "to": <index>, "type": "<relationship>", "label": "brief description"}]

Snippets:\n\n`;

        snippetNodes.forEach((n, i) => {
            const tags = (n.tags || []).join(', ');
            const text = (n.content || '').substring(0, 250);
            prompt += `[${i}] ${tags ? `(${tags}) ` : ''}${text}\n\n`;
        });

        prompt += `\nRespond in ${lang}. Only include significant relationships (not trivial ones). Max 20 relationships.`;

        return { prompt, snippetNodeIds: snippetNodes.map(n => n.id) };
    }

    /**
     * Merge LLM-generated relationships into existing graph.
     */
    function mergeEnhancedEdges(graph, llmRelationships, snippetNodeIds) {
        for (const rel of llmRelationships) {
            const fromId = snippetNodeIds[rel.from];
            const toId = snippetNodeIds[rel.to];
            if (!fromId || !toId) continue;
            graph.edges.push({
                source: fromId,
                target: toId,
                type: rel.type,
                label: rel.label || rel.type,
                enhanced: true,
            });
        }
        return graph;
    }

    /**
     * Generate a Mermaid diagram string from the graph.
     */
    function toMermaid(graph) {
        const lines = ['graph LR'];
        const nodeIds = new Map(); // id → mermaid safe id

        let counter = 0;
        function mId(id) {
            if (!nodeIds.has(id)) nodeIds.set(id, `n${counter++}`);
            return nodeIds.get(id);
        }

        // Nodes
        for (const n of graph.nodes) {
            const mid = mId(n.id);
            const label = (n.label || '').replace(/"/g, "'").substring(0, 40);
            if (n.type === 'page') {
                lines.push(`    ${mid}[("${label}")]:::page`);
            } else if (n.type === 'snippet') {
                lines.push(`    ${mid}["${label}"]:::snippet`);
            } else if (n.type === 'keyword') {
                lines.push(`    ${mid}(("${label}")):::keyword`);
            } else if (n.type === 'tag') {
                lines.push(`    ${mid}{{"${label}"}}:::tag`);
            }
        }

        // Edges
        for (const e of graph.edges) {
            const s = mId(e.source), t = mId(e.target);
            const edgeLabel = e.label || e.type;
            if (e.type === 'from_page') {
                lines.push(`    ${s} -.-> ${t}`);
            } else if (e.type === 'has_keyword' || e.type === 'has_tag') {
                lines.push(`    ${s} --- ${t}`);
            } else if (e.type === 'shared_keyword' || e.type === 'shared_topic') {
                lines.push(`    ${s} <===> ${t}`);
            } else if (e.enhanced) {
                lines.push(`    ${s} -- "${edgeLabel}" --> ${t}`);
            } else {
                lines.push(`    ${s} -.- ${t}`);
            }
        }

        // Styles
        lines.push('    classDef page fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:#1565c0');
        lines.push('    classDef snippet fill:#fff8e1,stroke:#f57f17,stroke-width:1px,color:#333');
        lines.push('    classDef keyword fill:#f3e5f5,stroke:#7b1fa2,stroke-width:1px,color:#7b1fa2');
        lines.push('    classDef tag fill:#e8f5e9,stroke:#2e7d32,stroke-width:1px,color:#2e7d32');

        return lines.join('\n');
    }

    /**
     * Serialize graph for export (JSON-safe).
     */
    function serialize(graph) {
        return JSON.parse(JSON.stringify(graph));
    }

    // --- Internal helpers ---

    function normalizeUrl(url) {
        try {
            const u = new URL(url);
            return u.origin + u.pathname;
        } catch { return url; }
    }

    function extractDomain(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); }
        catch { return ''; }
    }

    function samePage(url1, url2) {
        return normalizeUrl(url1) === normalizeUrl(url2);
    }

    function textSimilarityLocal(a, b) {
        const tokA = new Set(tokenizeLocal(a));
        const tokB = new Set(tokenizeLocal(b));
        if (tokA.size === 0 || tokB.size === 0) return 0;
        let overlap = 0;
        for (const t of tokA) if (tokB.has(t)) overlap++;
        return overlap / Math.sqrt(tokA.size * tokB.size);
    }

    function tokenizeLocal(text) {
        if (!text) return [];
        const words = text.toLowerCase()
            .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 1 && !STOP_WORDS.has(w));
        const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
        for (let i = 0; i < cjk.length - 1; i++) words.push(cjk[i] + cjk[i + 1]);
        return words;
    }

    function inferTagsLocal(snippet) {
        // Delegate to SnippetOrganizer if available
        if (typeof SnippetOrganizer !== 'undefined') {
            return SnippetOrganizer.inferTags(snippet);
        }
        return [];
    }

    function estimateImportance(snippet) {
        let score = 0.3;
        const text = snippet.content || '';
        if (text.length > 200) score += 0.15;
        else if (text.length > 50) score += 0.08;
        if (snippet.tags && snippet.tags.length > 0) score += 0.2;
        if (/\d+(\.\d+)?%/.test(text) || /\$[\d,.]+/.test(text)) score += 0.15;
        if ((snippet.tags || []).some(t => ['key-point', 'data'].includes(t))) score += 0.1;
        if (snippet.comment) score += 0.1;
        return Math.min(score, 1.0);
    }

    return {
        extractKeywords, extractEntities,
        buildGraph, buildEnhancePrompt, mergeEnhancedEdges,
        toMermaid, serialize,
    };
})();
