document.addEventListener('DOMContentLoaded', async () => {
    const sessionBadge = document.getElementById('sessionBadge');
    const statusText = document.getElementById('statusText');
    const orgContent = document.getElementById('orgContent');
    const exportHtmlBtn = document.getElementById('exportHtmlBtn');
    const regenerateBtn = document.getElementById('regenerateBtn');

    let currentSession = null;
    let sessionSnippets = [];
    let preprocessed = null;
    let llmResult = null;

    // Load session
    const { currentSession: saved } = await chrome.storage.local.get(['currentSession']);
    currentSession = saved;

    if (!currentSession) {
        orgContent.innerHTML = '<div class="org-loading">No session selected. Open from the popup.</div>';
        return;
    }

    sessionBadge.textContent = currentSession;
    const { sessions } = await chrome.storage.local.get(['sessions']);
    if (!sessions || !sessions[currentSession] || sessions[currentSession].length === 0) {
        orgContent.innerHTML = '<div class="org-loading">No snippets in this session.</div>';
        return;
    }

    sessionSnippets = sessions[currentSession];
    await runOrganization();

    // Regenerate
    regenerateBtn.addEventListener('click', async () => {
        llmResult = null;
        await runOrganization();
    });

    // Export
    exportHtmlBtn.addEventListener('click', () => exportAsHtml());

    /**
     * Main pipeline: preprocess locally, call LLM for minimal augmentation, render.
     */
    async function runOrganization() {
        regenerateBtn.disabled = true;
        exportHtmlBtn.disabled = true;

        // Phase 1: Local preprocessing
        showLoading('Preprocessing snippets locally...');
        preprocessed = SnippetOrganizer.preprocess(sessionSnippets);
        const { stats } = preprocessed;
        statusText.textContent = `${stats.totalSnippets} snippets | ${stats.textSnippets} text, ${stats.imageSnippets} images | ${stats.sources} sources | ${stats.clusters} topic groups`;

        // Phase 2: LLM augmentation (minimal — only section titles, intros, transitions)
        if (preprocessed.clusters.length > 0) {
            showLoading('Generating section structure (LLM)...');
            try {
                llmResult = await callLLMForStructure(preprocessed);
            } catch (e) {
                console.warn('LLM augmentation failed, using fallback:', e);
                llmResult = buildFallbackStructure(preprocessed);
            }
        } else {
            llmResult = buildFallbackStructure(preprocessed);
        }

        // Phase 3: Render
        showLoading('Rendering organized document...');
        await new Promise(r => setTimeout(r, 50)); // let UI update
        renderDocument(preprocessed, llmResult);

        regenerateBtn.disabled = false;
        exportHtmlBtn.disabled = false;
    }

    function showLoading(message) {
        orgContent.innerHTML = `
            <div class="org-loading">
                <div class="org-loading-spinner"></div>
                <div>${message}</div>
            </div>`;
    }

    /**
     * Call LLM with a minimal prompt to get section titles, intros, and transitions.
     */
    async function callLLMForStructure(preprocessed) {
        const {
            apiKey,
            apiBaseUrl = 'https://api.openai.com',
            modelName = 'gpt-4o-mini',
        } = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'modelName']);

        if (!apiKey) throw new Error('API key not configured');

        const prompt = SnippetOrganizer.buildLLMPrompt(preprocessed);

        const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: 0.4,
                max_tokens: 1500,
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in response');
        return JSON.parse(jsonMatch[0]);
    }

    /**
     * Build fallback structure when LLM is unavailable.
     */
    function buildFallbackStructure(preprocessed) {
        const { clusters, stats } = preprocessed;
        const lang = stats.language === 'zh';
        return {
            title: lang ? `${currentSession} — 语料整理` : `${currentSession} — Organized Notes`,
            summary: lang
                ? `共收集 ${stats.totalSnippets} 条语料，来自 ${stats.sources} 个来源，整理为 ${clusters.length} 个主题组。`
                : `${stats.totalSnippets} snippets from ${stats.sources} sources, organized into ${clusters.length} topic groups.`,
            sections: clusters.map((c, i) => ({
                title: lang ? `主题 ${i + 1}` : `Topic ${i + 1}`,
                intro: '',
                transition: '',
            }))
        };
    }

    /**
     * Render the organized document into the content area.
     */
    function renderDocument(preprocessed, structure) {
        const { clusters, imageSnippets, sourceGroups, snippets } = preprocessed;
        let html = '';

        // Title
        html += `<h1 class="org-doc-title">${escapeHtml(structure.title || currentSession)}</h1>`;

        // Summary
        if (structure.summary) {
            html += `<div class="org-summary">${escapeHtml(structure.summary)}</div>`;
        }

        // Stats
        const s = preprocessed.stats;
        html += `<div class="org-stats">
            <span class="org-stat"><span class="org-stat-num">${s.totalSnippets}</span> snippets</span>
            <span class="org-stat"><span class="org-stat-num">${s.sources}</span> sources</span>
            <span class="org-stat"><span class="org-stat-num">${s.clusters}</span> topics</span>
            ${s.imageSnippets > 0 ? `<span class="org-stat"><span class="org-stat-num">${s.imageSnippets}</span> images</span>` : ''}
        </div>`;

        // Sections (from clusters)
        clusters.forEach((cluster, i) => {
            const section = structure.sections?.[i] || {};
            html += `<div class="org-section">
                <div class="org-section-header">
                    <span class="org-section-num">${i + 1}</span>
                    <span class="org-section-title">${escapeHtml(section.title || `Topic ${i + 1}`)}</span>
                </div>`;

            if (section.intro) {
                html += `<div class="org-section-intro">${escapeHtml(section.intro)}</div>`;
            }

            // Render each snippet in this cluster
            cluster.snippets.forEach(snippet => {
                html += renderSnippetCard(snippet);
            });

            if (section.transition) {
                html += `<div class="org-section-transition">${escapeHtml(section.transition)}</div>`;
            }

            html += `</div>`;
        });

        // Image gallery (if any)
        if (imageSnippets && imageSnippets.length > 0) {
            html += renderImageGallery(imageSnippets);
        }

        // Sources/references
        html += renderSources(sourceGroups);

        orgContent.innerHTML = html;
    }

    /**
     * Render a single snippet card.
     */
    function renderSnippetCard(snippet) {
        const tags = snippet._allTags || snippet.tags || [];
        let html = `<div class="org-snippet">`;

        // Tags
        if (tags.length > 0) {
            html += `<div class="org-snippet-tags">`;
            tags.forEach(tag => {
                const cls = getTagClass(tag);
                html += `<span class="org-tag ${cls}">${escapeHtml(tag)}</span>`;
            });
            html += `</div>`;
        }

        // Content
        if (snippet.type === 'image') {
            const src = snippet.cachedDataUrl || snippet.imageUrl || '';
            html += `<img class="org-snippet-image" src="${escapeHtml(src)}" alt="${escapeHtml(snippet.sourceTitle || 'image')}" loading="lazy">`;
        } else {
            const content = snippet.content || '';
            html += `<div class="org-snippet-content">${escapeHtml(content)}</div>`;
        }

        // Source citation
        const source = snippet.sourceTitle || '';
        const url = snippet.sourceUrl || '';
        const time = snippet.timestamp ? formatTime(snippet.timestamp) : '';

        if (source || url || time) {
            html += `<div class="org-snippet-source">`;
            if (url) {
                html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(source || SnippetOrganizer.extractDomain(url))}</a>`;
            } else if (source) {
                html += `<span>${escapeHtml(source)}</span>`;
            }
            if (time) html += `<span class="org-snippet-time">${time}</span>`;
            html += `</div>`;
        }

        html += `</div>`;
        return html;
    }

    /**
     * Render image gallery section.
     */
    function renderImageGallery(images) {
        let html = `<div class="org-image-gallery">
            <div class="org-image-gallery-title">Images (${images.length})</div>
            <div class="org-image-grid">`;

        images.forEach(img => {
            const src = img.cachedDataUrl || img.imageUrl || '';
            const title = img.sourceTitle || '';
            const domain = SnippetOrganizer.extractDomain(img.sourceUrl || '');
            html += `<div class="org-image-card">
                <img src="${escapeHtml(src)}" alt="${escapeHtml(title)}" loading="lazy">
                <div class="org-image-card-meta">${escapeHtml(title || domain)}</div>
            </div>`;
        });

        html += `</div></div>`;
        return html;
    }

    /**
     * Render sources/references footer.
     */
    function renderSources(sourceGroups) {
        if (!sourceGroups || sourceGroups.length === 0) return '';

        let html = `<div class="org-sources">
            <div class="org-sources-title">Sources & References</div>`;

        sourceGroups.forEach((group, i) => {
            const url = group.source.url;
            const title = group.source.title || group.source.domain;
            const count = group.snippets.length;
            html += `<div class="org-source-item">
                <span class="org-source-num">[${i + 1}]</span>
                <span>${url
                    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
                    : escapeHtml(title)
                } (${count} snippet${count !== 1 ? 's' : ''})</span>
            </div>`;
        });

        html += `</div>`;
        return html;
    }

    /**
     * Export the organized content as a self-contained HTML file.
     * Embeds images as base64, includes all styling inline.
     */
    function exportAsHtml() {
        const content = orgContent.innerHTML;
        const title = llmResult?.title || `${currentSession} - Organized`;

        const htmlDoc = `<!DOCTYPE html>
<html lang="${preprocessed?.stats?.language || 'en'}">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:860px;margin:0 auto;padding:32px 24px;color:#333;line-height:1.7;background:#fff}
.org-doc-title{font-size:24px;font-weight:700;color:#1a1a1a;margin-bottom:8px;border-bottom:2px solid #2196f3;padding-bottom:8px}
.org-summary{font-size:14px;color:#555;background:#f8f9ff;border-left:3px solid #2196f3;padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0}
.org-stats{display:flex;gap:16px;flex-wrap:wrap;margin:12px 0 20px;font-size:12px;color:#888}
.org-stat{display:flex;align-items:center;gap:4px}
.org-stat-num{font-weight:600;color:#1565c0}
.org-section{margin-bottom:28px}
.org-section-header{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.org-section-num{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#e3f2fd;color:#1565c0;font-weight:700;font-size:13px;flex-shrink:0}
.org-section-title{font-size:18px;font-weight:600;color:#1a1a1a}
.org-section-intro{font-size:13px;color:#666;margin-bottom:12px;font-style:italic}
.org-section-transition{font-size:13px;color:#999;margin-top:12px;padding-top:10px;border-top:1px dashed #e0e0e0}
.org-snippet{background:#fff;border:1px solid #eee;border-radius:8px;padding:12px 16px;margin-bottom:10px}
.org-snippet-tags{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}
.org-tag{display:inline-block;font-size:10px;padding:2px 7px;border-radius:3px;font-weight:500}
.org-tag-data{background:#e8f5e9;color:#2e7d32}
.org-tag-quote{background:#fff3e0;color:#e65100}
.org-tag-opinion{background:#fce4ec;color:#c62828}
.org-tag-reference{background:#e3f2fd;color:#1565c0}
.org-tag-key-point{background:#f3e5f5;color:#7b1fa2}
.org-tag-definition{background:#e0f7fa;color:#00838f}
.org-tag-example{background:#fff8e1;color:#f57f17}
.org-tag-image{background:#fce4ec;color:#ad1457}
.org-tag-default{background:#f5f5f5;color:#616161}
.org-snippet-content{font-size:14px;color:#333;white-space:pre-wrap;word-break:break-word}
.org-snippet-image{max-width:100%;max-height:400px;border-radius:6px;margin:8px 0;display:block}
.org-snippet-source{display:flex;align-items:center;gap:6px;font-size:11px;color:#999;margin-top:8px;padding-top:6px;border-top:1px solid #f5f5f5}
.org-snippet-source a{color:#1976d2;text-decoration:none}
.org-snippet-source a:hover{text-decoration:underline}
.org-snippet-time{color:#bbb}
.org-image-gallery{margin:20px 0;padding:16px;background:#fafbfc;border-radius:8px;border:1px solid #eee}
.org-image-gallery-title{font-size:15px;font-weight:600;margin-bottom:12px;color:#555}
.org-image-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.org-image-card{border:1px solid #eee;border-radius:6px;overflow:hidden;background:#fff}
.org-image-card img{width:100%;height:160px;object-fit:cover;display:block}
.org-image-card-meta{padding:6px 10px;font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.org-sources{margin-top:28px;padding-top:16px;border-top:2px solid #eee}
.org-sources-title{font-size:15px;font-weight:600;margin-bottom:10px;color:#555}
.org-source-item{display:flex;align-items:flex-start;gap:8px;font-size:13px;margin-bottom:6px;color:#555}
.org-source-item a{color:#1976d2;text-decoration:none;word-break:break-all}
.org-source-item a:hover{text-decoration:underline}
.org-source-num{color:#1565c0;font-weight:600;flex-shrink:0;min-width:24px}
@media print{.org-snippet{break-inside:avoid}}
</style>
</head>
<body>
${content}
<footer style="margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">
Generated by Cyber Assistant &middot; ${new Date().toLocaleDateString()}
</footer>
</body>
</html>`;

        const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentSession}-organized-${new Date().toISOString().slice(0, 10)}.html`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ---- Helpers ----

    function getTagClass(tag) {
        const known = ['data','quote','opinion','reference','key-point','definition','example','image'];
        if (known.includes(tag)) return `org-tag-${tag}`;
        return 'org-tag-default';
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    function formatTime(timestamp) {
        const d = new Date(timestamp);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
});
