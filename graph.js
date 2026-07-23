/**
 * Knowledge Graph Viewer — canvas-based force-directed graph
 * with interactive node selection, zoom/pan, filtering, and export.
 */
(async () => {
    // ---- State ----
    let graph = { nodes: [], edges: [], crossPageLinks: [], stats: {} };
    let sessionName = '';
    let visibleTypes = new Set(['page', 'snippet', 'keyword', 'tag']);
    let selectedNodeId = null;
    let hoveredNodeId = null;
    let dragNodeId = null;
    let dragOffsetX = 0, dragOffsetY = 0;

    // Camera
    let camX = 0, camY = 0, camZoom = 1;
    let isPanning = false, panStartX = 0, panStartY = 0, panStartCamX = 0, panStartCamY = 0;

    // Physics
    let simNodes = []; // { id, x, y, vx, vy, type, radius, ... }
    let simEdges = []; // { source, target, ... }
    let simRunning = true;
    let simAlpha = 1;

    // DOM
    const canvas = document.getElementById('graphCanvas');
    const ctx = canvas.getContext('2d');
    const statusText = document.getElementById('statusText');
    const detailPanel = document.getElementById('detailPanel');
    const detailContent = document.getElementById('detailContent');
    const insightsPanel = document.getElementById('insightsPanel');
    const insightsList = document.getElementById('insightsList');

    // ---- Visual constants ----
    const NODE_STYLES = {
        page:    { color: '#1565c0', fill: '#e3f2fd', radius: 22, font: 'bold 11px sans-serif' },
        snippet: { color: '#f57f17', fill: '#fff8e1', radius: 16, font: '10px sans-serif' },
        keyword: { color: '#7b1fa2', fill: '#f3e5f5', radius: 10, font: '9px sans-serif' },
        tag:     { color: '#2e7d32', fill: '#e8f5e9', radius: 12, font: 'bold 9px sans-serif' },
    };

    const EDGE_STYLES = {
        from_page:      { color: '#bbdefb', width: 1.5, dash: [4, 3] },
        has_keyword:    { color: '#e1bee7', width: 1, dash: [] },
        has_tag:        { color: '#c8e6c9', width: 1, dash: [] },
        shared_keyword: { color: '#ce93d8', width: 2, dash: [] },
        shared_topic:   { color: '#1565c0', width: 2.5, dash: [] },
        similar:        { color: '#ffcc80', width: 1.5, dash: [3, 3] },
        supports:       { color: '#66bb6a', width: 2, dash: [] },
        contradicts:    { color: '#ef5350', width: 2, dash: [] },
        causes:         { color: '#42a5f5', width: 2, dash: [] },
        example_of:     { color: '#ab47bc', width: 1.5, dash: [5, 3] },
        elaborates:     { color: '#78909c', width: 1.5, dash: [] },
        same_topic:     { color: '#8d6e63', width: 1.5, dash: [] },
    };

    // ---- Initialize ----
    async function init() {
        const { currentSession } = await chrome.storage.local.get(['currentSession']);
        sessionName = currentSession || 'default';
        document.getElementById('sessionBadge').textContent = sessionName;

        const { sessions } = await chrome.storage.local.get(['sessions']);
        const snippets = (sessions && sessions[sessionName]) || [];

        if (snippets.length === 0) {
            statusText.textContent = 'No snippets in this session. Save some content first!';
            return;
        }

        statusText.textContent = 'Building graph...';
        graph = GraphBuilder.buildGraph(snippets);

        // Update filter counts
        document.getElementById('countPages').textContent = graph.stats.pages;
        document.getElementById('countSnippets').textContent = graph.stats.snippets;
        document.getElementById('countKeywords').textContent = graph.stats.keywords;
        document.getElementById('countTags').textContent = graph.stats.tags;

        statusText.textContent =
            `${graph.stats.snippets} snippets \u00b7 ${graph.stats.pages} pages \u00b7 ` +
            `${graph.stats.keywords} keywords \u00b7 ${graph.stats.crossPageLinks} cross-page links`;

        // Show cross-page insights
        if (graph.crossPageLinks && graph.crossPageLinks.length > 0) {
            showInsights(graph.crossPageLinks);
        }

        initSimulation();
        resizeCanvas();
        requestAnimationFrame(loop);
    }

    // ---- Force-directed simulation ----
    function initSimulation() {
        simNodes = graph.nodes.map((n, i) => {
            const style = NODE_STYLES[n.type] || NODE_STYLES.keyword;
            const angle = (i / graph.nodes.length) * Math.PI * 2;
            const r = 150 + Math.random() * 100;
            return {
                ...n,
                x: Math.cos(angle) * r,
                y: Math.sin(angle) * r,
                vx: 0, vy: 0,
                radius: style.radius * (n.type === 'snippet' ? (0.8 + (n.importance || 0.5) * 0.4) : 1),
            };
        });

        simEdges = graph.edges.map(e => ({
            ...e,
            sourceNode: simNodes.find(n => n.id === e.source),
            targetNode: simNodes.find(n => n.id === e.target),
        })).filter(e => e.sourceNode && e.targetNode);

        simAlpha = 1;
        simRunning = true;
        fitToView();
    }

    function tick() {
        if (!simRunning || simAlpha < 0.001) { simRunning = false; return; }
        simAlpha *= 0.985;

        const damping = 0.6;
        const repulsion = 3000;
        const springK = 0.008;
        const springLen = 100;
        const centerPull = 0.001;

        // Repulsion (all pairs)
        for (let i = 0; i < simNodes.length; i++) {
            for (let j = i + 1; j < simNodes.length; j++) {
                const a = simNodes[i], b = simNodes[j];
                if (!isVisible(a) || !isVisible(b)) continue;
                let dx = b.x - a.x, dy = b.y - a.y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const force = repulsion / (dist * dist) * simAlpha;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx -= fx; a.vy -= fy;
                b.vx += fx; b.vy += fy;
            }
        }

        // Spring (edges)
        for (const e of simEdges) {
            const a = e.sourceNode, b = e.targetNode;
            if (!isVisible(a) || !isVisible(b)) continue;
            let dx = b.x - a.x, dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const targetLen = e.type === 'from_page' ? springLen * 1.5 :
                              e.type === 'shared_topic' ? springLen * 2 : springLen;
            const displacement = dist - targetLen;
            const force = springK * displacement * simAlpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
        }

        // Center pull + velocity update
        for (const n of simNodes) {
            if (!isVisible(n)) continue;
            if (n.id === dragNodeId) { n.vx = 0; n.vy = 0; continue; }
            n.vx -= n.x * centerPull * simAlpha;
            n.vy -= n.y * centerPull * simAlpha;
            n.vx *= damping;
            n.vy *= damping;
            n.x += n.vx;
            n.y += n.vy;
        }
    }

    function isVisible(node) {
        return visibleTypes.has(node.type);
    }

    // ---- Rendering ----
    function resizeCanvas() {
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * devicePixelRatio;
        canvas.height = rect.height * devicePixelRatio;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
    }

    function loop() {
        tick();
        render();
        requestAnimationFrame(loop);
    }

    function render() {
        const w = canvas.width, h = canvas.height;
        const dpr = devicePixelRatio;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // Apply camera
        ctx.setTransform(
            camZoom * dpr, 0, 0, camZoom * dpr,
            (w / 2 + camX * dpr) * 1, (h / 2 + camY * dpr) * 1
        );

        // Draw edges
        for (const e of simEdges) {
            if (!isVisible(e.sourceNode) || !isVisible(e.targetNode)) continue;
            const style = EDGE_STYLES[e.type] || EDGE_STYLES.has_keyword;
            const isHighlighted = selectedNodeId && (e.source === selectedNodeId || e.target === selectedNodeId);
            ctx.beginPath();
            ctx.moveTo(e.sourceNode.x, e.sourceNode.y);
            ctx.lineTo(e.targetNode.x, e.targetNode.y);
            ctx.strokeStyle = isHighlighted ? style.color : (style.color + '80');
            ctx.lineWidth = isHighlighted ? style.width + 1 : style.width;
            ctx.setLineDash(style.dash);
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw edge label if enhanced
            if (e.enhanced && e.label) {
                const mx = (e.sourceNode.x + e.targetNode.x) / 2;
                const my = (e.sourceNode.y + e.targetNode.y) / 2;
                ctx.font = '8px sans-serif';
                ctx.fillStyle = '#999';
                ctx.textAlign = 'center';
                ctx.fillText(e.label, mx, my - 4);
            }
        }

        // Draw nodes
        for (const n of simNodes) {
            if (!isVisible(n)) continue;
            const style = NODE_STYLES[n.type] || NODE_STYLES.keyword;
            const r = n.radius;
            const isSelected = n.id === selectedNodeId;
            const isHovered = n.id === hoveredNodeId;
            const isConnected = selectedNodeId && getConnectedIds(selectedNodeId).has(n.id);
            const dimmed = selectedNodeId && !isSelected && !isConnected;

            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, Math.PI * 2);

            // Fill
            ctx.fillStyle = dimmed ? '#f0f0f0' : style.fill;
            ctx.fill();

            // Stroke
            ctx.lineWidth = isSelected ? 3 : isHovered ? 2.5 : 1.5;
            ctx.strokeStyle = dimmed ? '#ddd' : (isSelected || isHovered ? style.color : style.color + 'aa');
            ctx.stroke();

            // Selection glow
            if (isSelected) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
                ctx.strokeStyle = style.color + '40';
                ctx.lineWidth = 4;
                ctx.stroke();
            }

            // Label
            const label = truncate(n.label || '', n.type === 'page' ? 20 : n.type === 'snippet' ? 15 : 10);
            ctx.font = style.font;
            ctx.fillStyle = dimmed ? '#ccc' : style.color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, n.x, n.y + r + 10);
        }
    }

    function truncate(str, max) {
        return str.length > max ? str.substring(0, max) + '..' : str;
    }

    function getConnectedIds(nodeId) {
        const set = new Set();
        for (const e of simEdges) {
            if (e.source === nodeId) set.add(e.target);
            if (e.target === nodeId) set.add(e.source);
        }
        return set;
    }

    // ---- Hit testing ----
    function screenToWorld(sx, sy) {
        const rect = canvas.getBoundingClientRect();
        const cx = (sx - rect.left - rect.width / 2 - camX) / camZoom;
        const cy = (sy - rect.top - rect.height / 2 - camY) / camZoom;
        return { x: cx, y: cy };
    }

    function hitTest(sx, sy) {
        const { x, y } = screenToWorld(sx, sy);
        // Check in reverse order (top nodes first)
        for (let i = simNodes.length - 1; i >= 0; i--) {
            const n = simNodes[i];
            if (!isVisible(n)) continue;
            const dx = n.x - x, dy = n.y - y;
            if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n;
        }
        return null;
    }

    // ---- Camera controls ----
    function fitToView() {
        const visible = simNodes.filter(isVisible);
        if (visible.length === 0) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const n of visible) {
            minX = Math.min(minX, n.x - n.radius);
            maxX = Math.max(maxX, n.x + n.radius);
            minY = Math.min(minY, n.y - n.radius);
            maxY = Math.max(maxY, n.y + n.radius);
        }
        const rect = canvas.getBoundingClientRect();
        const gw = maxX - minX + 100, gh = maxY - minY + 100;
        camZoom = Math.min(rect.width / gw, rect.height / gh, 2);
        camX = -(minX + maxX) / 2 * camZoom;
        camY = -(minY + maxY) / 2 * camZoom;
    }

    // ---- Interaction ----
    canvas.addEventListener('mousedown', (e) => {
        const node = hitTest(e.clientX, e.clientY);
        if (node) {
            dragNodeId = node.id;
            const { x, y } = screenToWorld(e.clientX, e.clientY);
            dragOffsetX = node.x - x;
            dragOffsetY = node.y - y;
            canvas.classList.add('dragging');
        } else {
            isPanning = true;
            panStartX = e.clientX;
            panStartY = e.clientY;
            panStartCamX = camX;
            panStartCamY = camY;
            canvas.classList.add('dragging');
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (dragNodeId) {
            const { x, y } = screenToWorld(e.clientX, e.clientY);
            const node = simNodes.find(n => n.id === dragNodeId);
            if (node) {
                node.x = x + dragOffsetX;
                node.y = y + dragOffsetY;
                node.vx = 0;
                node.vy = 0;
            }
            simAlpha = Math.max(simAlpha, 0.1);
            simRunning = true;
        } else if (isPanning) {
            camX = panStartCamX + (e.clientX - panStartX);
            camY = panStartCamY + (e.clientY - panStartY);
        } else {
            const node = hitTest(e.clientX, e.clientY);
            hoveredNodeId = node ? node.id : null;
            canvas.style.cursor = node ? 'pointer' : 'grab';
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        if (dragNodeId) {
            // If barely moved, treat as click → select
            const node = hitTest(e.clientX, e.clientY);
            if (node && node.id === dragNodeId) {
                selectNode(node);
            }
            dragNodeId = null;
        }
        isPanning = false;
        canvas.classList.remove('dragging');
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        camZoom = Math.max(0.1, Math.min(5, camZoom * factor));
    }, { passive: false });

    // Click outside detail panel → deselect
    canvas.addEventListener('dblclick', () => {
        selectedNodeId = null;
        detailPanel.classList.add('hidden');
    });

    // ---- Selection & detail panel ----
    function selectNode(node) {
        selectedNodeId = node.id;
        renderDetail(node);
        detailPanel.classList.remove('hidden');
    }

    function renderDetail(node) {
        const connected = getConnectedIds(node.id);
        const connNodes = simNodes.filter(n => connected.has(n.id));

        let html = `<div class="detail-type-badge ${node.type}">${node.type}</div>`;

        if (node.type === 'page') {
            html += `<div class="detail-title">${esc(node.label)}</div>`;
            html += `<div class="detail-meta">${node.snippetCount} snippets from this page</div>`;
            if (node.url) {
                html += `<div class="detail-meta"><a href="${esc(node.url)}" target="_blank">${esc(node.url)}</a></div>`;
            }
        } else if (node.type === 'snippet') {
            html += `<div class="detail-title">${esc(node.label)}</div>`;
            if (node.content) {
                html += `<div class="detail-content">${esc(node.content)}</div>`;
            }
            if (node.comment) {
                html += `<div class="detail-comment"><div class="detail-comment-label">Comment</div>${esc(node.comment)}</div>`;
            }
            if (node.tags && node.tags.length > 0) {
                html += `<div class="detail-tags">${node.tags.map(t => `<span class="detail-tag">${esc(t)}</span>`).join('')}</div>`;
            }
            if (node.sourceTitle) {
                html += `<div class="detail-meta">From: ${esc(node.sourceTitle)}</div>`;
            }
            if (node.timestamp) {
                html += `<div class="detail-meta">${new Date(node.timestamp).toLocaleString()}</div>`;
            }
        } else if (node.type === 'keyword') {
            html += `<div class="detail-title">"${esc(node.label)}"</div>`;
            const snippetConns = connNodes.filter(n => n.type === 'snippet');
            html += `<div class="detail-meta">Appears in ${snippetConns.length} snippets</div>`;
        } else if (node.type === 'tag') {
            html += `<div class="detail-title">#${esc(node.label)}</div>`;
            const snippetConns = connNodes.filter(n => n.type === 'snippet');
            html += `<div class="detail-meta">${snippetConns.length} tagged snippets</div>`;
        }

        // Connections
        if (connNodes.length > 0) {
            html += `<div class="detail-connections"><h4>Connections (${connNodes.length})</h4>`;
            // Group by type
            const groups = {};
            for (const cn of connNodes) {
                if (!groups[cn.type]) groups[cn.type] = [];
                groups[cn.type].push(cn);
            }
            for (const [type, items] of Object.entries(groups)) {
                const style = NODE_STYLES[type];
                for (const item of items.slice(0, 10)) {
                    html += `<div class="detail-conn-item" data-node-id="${esc(item.id)}">
                        <span class="detail-conn-dot" style="background:${style.color};"></span>
                        ${esc(truncate(item.label || '', 40))}
                    </div>`;
                }
                if (items.length > 10) {
                    html += `<div class="detail-meta">... and ${items.length - 10} more</div>`;
                }
            }
            html += '</div>';
        }

        detailContent.innerHTML = html;

        // Click handlers for connection items
        detailContent.querySelectorAll('.detail-conn-item').forEach(el => {
            el.addEventListener('click', () => {
                const targetId = el.dataset.nodeId;
                const targetNode = simNodes.find(n => n.id === targetId);
                if (targetNode) selectNode(targetNode);
            });
        });
    }

    document.getElementById('detailClose').addEventListener('click', () => {
        selectedNodeId = null;
        detailPanel.classList.add('hidden');
    });

    // ---- Filter chips ----
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const type = chip.dataset.type;
            chip.classList.toggle('active');
            if (chip.classList.contains('active')) {
                visibleTypes.add(type);
            } else {
                visibleTypes.delete(type);
            }
        });
    });

    // ---- Zoom/fit buttons ----
    document.getElementById('zoomIn').addEventListener('click', () => { camZoom = Math.min(5, camZoom * 1.25); });
    document.getElementById('zoomOut').addEventListener('click', () => { camZoom = Math.max(0.1, camZoom * 0.8); });
    document.getElementById('fitBtn').addEventListener('click', fitToView);
    document.getElementById('resetBtn').addEventListener('click', () => {
        initSimulation();
    });

    // ---- Cross-page insights ----
    function showInsights(links) {
        insightsPanel.classList.remove('hidden');
        insightsList.innerHTML = links.map(link => {
            const pageA = graph.nodes.find(n => n.id === `page:${link.pageA}`);
            const pageB = graph.nodes.find(n => n.id === `page:${link.pageB}`);
            const kws = link.sharedKeywords.slice(0, 5).join(', ');
            return `<div class="insight-item">
                <span class="insight-link">${esc(truncate(pageA?.label || link.pageA, 30))}</span>
                \u2194
                <span class="insight-link">${esc(truncate(pageB?.label || link.pageB, 30))}</span>
                <span class="insight-kws">[${esc(kws)}]</span>
            </div>`;
        }).join('');
    }

    // ---- Enhance with AI ----
    document.getElementById('enhanceBtn').addEventListener('click', async () => {
        const btn = document.getElementById('enhanceBtn');
        if (btn.classList.contains('loading')) return;
        btn.classList.add('loading');
        btn.textContent = 'Analyzing...';

        try {
            const { apiKey, apiBaseUrl = 'https://api.openai.com', modelName = 'gpt-4o-mini' } =
                await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'modelName']);
            if (!apiKey) {
                statusText.textContent = 'API key required. Set it in Settings.';
                return;
            }

            const snippetNodes = graph.nodes.filter(n => n.type === 'snippet');
            const lang = detectLang(snippetNodes);
            const enhanceData = GraphBuilder.buildEnhancePrompt(graph, lang);
            if (!enhanceData) {
                statusText.textContent = 'Not enough snippets to enhance.';
                return;
            }

            const baseUrl = apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: modelName,
                    messages: [
                        { role: 'system', content: 'You are a knowledge graph analyst. Output ONLY valid JSON.' },
                        { role: 'user', content: enhanceData.prompt }
                    ],
                    max_tokens: 2000,
                    temperature: 0.3,
                }),
            });

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || '';
            // Parse JSON from response (strip markdown fences)
            const jsonStr = content.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
            const relationships = JSON.parse(jsonStr);

            if (Array.isArray(relationships)) {
                GraphBuilder.mergeEnhancedEdges(graph, relationships, enhanceData.snippetNodeIds);
                // Rebuild simEdges
                simEdges = graph.edges.map(e => ({
                    ...e,
                    sourceNode: simNodes.find(n => n.id === e.source),
                    targetNode: simNodes.find(n => n.id === e.target),
                })).filter(e => e.sourceNode && e.targetNode);

                statusText.textContent += ` \u00b7 +${relationships.length} AI-discovered relationships`;
            }
        } catch (e) {
            console.error('Enhance failed:', e);
            statusText.textContent = 'AI enhancement failed: ' + e.message;
        } finally {
            btn.classList.remove('loading');
            btn.textContent = 'Enhance with AI';
        }
    });

    // ---- Export Mermaid ----
    document.getElementById('exportMermaidBtn').addEventListener('click', () => {
        const mermaidStr = GraphBuilder.toMermaid(graph);
        const blob = new Blob([mermaidStr], { type: 'text/plain' });
        downloadBlob(blob, `knowledge-graph-${sessionName}.mmd`);
    });

    // ---- Export interactive HTML ----
    document.getElementById('exportHtmlBtn').addEventListener('click', () => {
        const serialized = GraphBuilder.serialize(graph);
        const html = buildExportHtml(serialized, sessionName);
        const blob = new Blob([html], { type: 'text/html' });
        downloadBlob(blob, `knowledge-graph-${sessionName}.html`);
    });

    function buildExportHtml(graphData, session) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Knowledge Graph - ${esc(session)}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f8f9fa; overflow:hidden; height:100vh; }
#header { padding:12px 20px; background:#fff; border-bottom:1px solid #e0e0e0; display:flex; align-items:center; justify-content:space-between; }
#header h2 { font-size:16px; }
#header .badge { font-size:11px; color:#888; background:#f0f0f0; padding:2px 8px; border-radius:10px; margin-left:8px; }
#main { height:calc(100vh - 50px); position:relative; }
#mynetwork { width:100%; height:100%; }
#detail { position:absolute; top:12px; right:12px; width:320px; max-height:calc(100% - 24px); background:#fff; border:1px solid #e0e0e0; border-radius:10px; box-shadow:0 4px 20px rgba(0,0,0,0.1); padding:16px; overflow-y:auto; display:none; font-size:12px; }
#detail .type { display:inline-block; font-size:10px; font-weight:600; text-transform:uppercase; padding:2px 8px; border-radius:4px; margin-bottom:6px; }
#detail .title { font-size:14px; font-weight:600; margin-bottom:6px; }
#detail .content { background:#fafafa; padding:8px; border-radius:6px; margin-bottom:8px; line-height:1.6; max-height:200px; overflow-y:auto; word-break:break-word; }
#detail .meta { color:#999; font-size:11px; margin-bottom:4px; }
#detail .close { position:absolute; top:8px; right:10px; background:none; border:none; font-size:18px; cursor:pointer; color:#999; }
.tag { display:inline-block; font-size:10px; padding:2px 7px; border-radius:4px; background:#e8f5e9; color:#2e7d32; margin:0 2px 4px 0; }
</style>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"><\/script>
</head>
<body>
<div id="header">
    <div style="display:flex;align-items:center;">
        <h2>Knowledge Graph</h2>
        <span class="badge">${esc(session)}</span>
    </div>
    <div style="font-size:11px;color:#999;">${graphData.stats.snippets} snippets &middot; ${graphData.stats.pages} pages &middot; ${graphData.stats.keywords} keywords</div>
</div>
<div id="main">
    <div id="mynetwork"></div>
    <div id="detail">
        <button class="close" onclick="document.getElementById('detail').style.display='none'">&times;</button>
        <div id="detailBody"></div>
    </div>
</div>
<script>
const graphData = ${JSON.stringify(graphData)};
const nodeColors = { page:'#1565c0', snippet:'#f57f17', keyword:'#7b1fa2', tag:'#2e7d32' };
const nodeBgs = { page:'#e3f2fd', snippet:'#fff8e1', keyword:'#f3e5f5', tag:'#e8f5e9' };
const nodeShapes = { page:'dot', snippet:'box', keyword:'diamond', tag:'hexagon' };
const nodeSizes = { page:25, snippet:18, keyword:12, tag:14 };

const visNodes = graphData.nodes.map(n => ({
    id: n.id,
    label: (n.label || '').substring(0, 30),
    shape: nodeShapes[n.type] || 'dot',
    size: nodeSizes[n.type] || 12,
    color: { background: nodeBgs[n.type], border: nodeColors[n.type], highlight: { background: nodeBgs[n.type], border: nodeColors[n.type] } },
    font: { size: n.type==='keyword'?9:11, color: nodeColors[n.type] },
    _data: n,
}));
const visEdges = graphData.edges.map((e, i) => ({
    id: 'e'+i, from: e.source, to: e.target,
    color: { color: '#ccc', highlight: '#999' },
    width: e.enhanced ? 2 : 1,
    dashes: e.type==='from_page' || e.type==='similar',
    label: e.enhanced ? (e.label||'') : '',
    font: { size: 8, color: '#999' },
}));

const container = document.getElementById('mynetwork');
const network = new vis.Network(container, { nodes: new vis.DataSet(visNodes), edges: new vis.DataSet(visEdges) }, {
    physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -50, springLength: 120 } },
    interaction: { hover: true, tooltipDelay: 200 },
});

network.on('click', (params) => {
    if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = visNodes.find(n => n.id === nodeId)?._data;
        if (node) showDetail(node);
    }
});

function showDetail(n) {
    const d = document.getElementById('detail');
    const b = document.getElementById('detailBody');
    d.style.display = 'block';
    let h = '<div class="type" style="background:'+nodeBgs[n.type]+';color:'+nodeColors[n.type]+'">'+n.type+'</div>';
    h += '<div class="title">' + esc(n.label) + '</div>';
    if (n.content) h += '<div class="content">' + esc(n.content) + '</div>';
    if (n.tags && n.tags.length) h += '<div>' + n.tags.map(t=>'<span class="tag">'+esc(t)+'</span>').join('') + '</div>';
    if (n.sourceTitle) h += '<div class="meta">From: ' + esc(n.sourceTitle) + '</div>';
    if (n.url) h += '<div class="meta"><a href="'+esc(n.url)+'" target="_blank">'+esc(n.url)+'</a></div>';
    b.innerHTML = h;
}
function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
<\/script>
</body>
</html>`;
    }

    // ---- Helpers ----
    function esc(s) {
        const div = document.createElement('div');
        div.textContent = s || '';
        return div.innerHTML;
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    }

    function detectLang(snippetNodes) {
        const text = snippetNodes.map(n => n.content || '').join(' ');
        const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        return cjk / text.length > 0.15 ? 'zh' : 'en';
    }

    // Resize handler
    window.addEventListener('resize', resizeCanvas);

    // Start
    init();
})();
