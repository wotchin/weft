/**
 * Cyber Assistant — Block-based Markdown to HTML renderer
 * Supports: GFM tables, blockquotes, fenced code blocks, lists (nested),
 *           headers, horizontal rules, bold, italic, inline code, links, images.
 *
 * Usage: renderMarkdown(text) => HTML string
 */
/* exported renderMarkdown */

const renderMarkdown = (() => {
    'use strict';

    // ── Inline processing ──────────────────────────────────────────────

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;');
    }

    function processInline(text) {
        let html = text;
        // Inline code (protect first)
        const codes = [];
        html = html.replace(/`([^`]+?)`/g, (_, code) => {
            codes.push(`<code>${escapeHtml(code)}</code>`);
            return `\x00IC${codes.length - 1}\x00`;
        });
        // Images  ![alt](url)
        html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');
        // Links  [text](url)
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        // Bold + italic  ***text***
        html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        // Bold  **text**  or __text__
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
        // Italic  *text*  or _text_  (not inside words for _)
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>');
        // Strikethrough ~~text~~
        html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
        // Restore inline codes
        html = html.replace(/\x00IC(\d+)\x00/g, (_, i) => codes[parseInt(i)]);
        return html;
    }

    // ── Block-level parsing ────────────────────────────────────────────

    function parseTable(lines) {
        // lines[0] = header, lines[1] = separator (|---|---|), lines[2..] = rows
        if (lines.length < 2) return null;
        const sep = lines[1];
        if (!/^\|?[\s-:|]+\|?$/.test(sep) || !sep.includes('-')) return null;

        const parseRow = (line) =>
            line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

        // Alignment from separator row
        const aligns = parseRow(sep).map(cell => {
            const l = cell.startsWith(':'), r = cell.endsWith(':');
            if (l && r) return 'center';
            if (r) return 'right';
            return 'left';
        });

        const headers = parseRow(lines[0]);
        let html = '<div class="md-table-wrap"><table><thead><tr>';
        headers.forEach((h, i) => {
            const align = aligns[i] || 'left';
            html += `<th style="text-align:${align}">${processInline(h)}</th>`;
        });
        html += '</tr></thead><tbody>';

        for (let r = 2; r < lines.length; r++) {
            const cells = parseRow(lines[r]);
            html += '<tr>';
            cells.forEach((c, i) => {
                const align = aligns[i] || 'left';
                html += `<td style="text-align:${align}">${processInline(c)}</td>`;
            });
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        return html;
    }

    function parseBlockquote(lines) {
        // Strip leading > or > from each line
        const inner = lines.map(l => l.replace(/^>\s?/, ''));
        // Recursively render the inner content
        return `<blockquote>${render(inner.join('\n'))}</blockquote>`;
    }

    function parseList(lines, startIndex) {
        // Determine if ordered or unordered
        const isOrdered = /^\s*\d+[.)]\s/.test(lines[startIndex]);
        const tag = isOrdered ? 'ol' : 'ul';
        const itemPattern = isOrdered ? /^\s*\d+[.)]\s+(.*)/ : /^\s*[-*+]\s+(.*)/;
        let html = `<${tag}>`;
        let i = startIndex;

        while (i < lines.length) {
            const match = lines[i].match(itemPattern);
            if (!match) break;
            let content = match[1];
            // Gather continuation lines (indented, not a new item)
            i++;
            while (i < lines.length && /^\s{2,}/.test(lines[i]) && !itemPattern.test(lines[i])) {
                content += '\n' + lines[i].replace(/^\s{2,}/, '');
                i++;
            }
            html += `<li>${processInline(content)}</li>`;
        }
        html += `</${tag}>`;
        return { html, nextIndex: i };
    }

    function parseFencedCode(lines, startIndex) {
        const opener = lines[startIndex].match(/^(`{3,}|~{3,})(\w*)/);
        if (!opener) return null;
        const fence = opener[1].charAt(0);
        const fenceLen = opener[1].length;
        const lang = opener[2] || '';
        let code = '';
        let i = startIndex + 1;
        while (i < lines.length) {
            const closer = lines[i].match(new RegExp(`^${fence}{${fenceLen},}\\s*$`));
            if (closer) { i++; break; }
            code += (code ? '\n' : '') + lines[i];
            i++;
        }
        const langAttr = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
        const html = `<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`;
        return { html, nextIndex: i };
    }

    // ── Main renderer ──────────────────────────────────────────────────

    function render(text) {
        // If the response already contains raw HTML (reports, tables, SVG), pass through
        if (/<(table|div|h[1-6]|ul|ol|svg|style|html|body|head)\b/i.test(text)) {
            let html = text.replace(/```html\s*([\s\S]*?)```/g, '$1');
            return html;
        }

        const lines = text.split('\n');
        const blocks = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            // ── Fenced code block ──
            if (/^(`{3,}|~{3,})/.test(line)) {
                const result = parseFencedCode(lines, i);
                if (result) {
                    blocks.push(result.html);
                    i = result.nextIndex;
                    continue;
                }
            }

            // ── Blank line ──
            if (line.trim() === '') {
                i++;
                continue;
            }

            // ── Horizontal rule ──
            if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
                blocks.push('<hr>');
                i++;
                continue;
            }

            // ── Headers ──
            const headerMatch = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
            if (headerMatch) {
                const level = headerMatch[1].length;
                blocks.push(`<h${level}>${processInline(headerMatch[2])}</h${level}>`);
                i++;
                continue;
            }

            // ── Blockquote ──
            if (/^>\s?/.test(line)) {
                const bqLines = [];
                while (i < lines.length && (/^>\s?/.test(lines[i]) || (lines[i].trim() !== '' && bqLines.length > 0 && !/^#|^[-*+] |^\d+[.)] |^```|^>/.test(lines[i])))) {
                    bqLines.push(lines[i]);
                    i++;
                }
                blocks.push(parseBlockquote(bqLines));
                continue;
            }

            // ── Table ──
            if (line.includes('|') && i + 1 < lines.length && /^\|?[\s-:|]+\|?$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
                const tableLines = [];
                while (i < lines.length && lines[i].includes('|')) {
                    tableLines.push(lines[i]);
                    i++;
                }
                const tableHtml = parseTable(tableLines);
                if (tableHtml) {
                    blocks.push(tableHtml);
                    continue;
                }
                // Fallback: not a valid table, re-process as paragraph
                i -= tableLines.length;
            }

            // ── List ──
            if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
                const result = parseList(lines, i);
                blocks.push(result.html);
                i = result.nextIndex;
                continue;
            }

            // ── Paragraph ── (collect consecutive non-blank, non-special lines)
            const paraLines = [];
            while (i < lines.length && lines[i].trim() !== '' &&
                   !/^#{1,6}\s/.test(lines[i]) &&
                   !/^>\s?/.test(lines[i]) &&
                   !/^(`{3,}|~{3,})/.test(lines[i]) &&
                   !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i].trim()) &&
                   !/^\s*[-*+]\s+/.test(lines[i]) &&
                   !/^\s*\d+[.)]\s+/.test(lines[i])) {
                // Check if this line starts a table (pipe + next line is separator)
                if (lines[i].includes('|') && i + 1 < lines.length && /^\|?[\s-:|]+\|?$/.test(lines[i + 1]) && lines[i + 1].includes('-')) break;
                paraLines.push(lines[i]);
                i++;
            }
            if (paraLines.length > 0) {
                blocks.push(`<p>${processInline(paraLines.join('<br>'))}</p>`);
            }
        }

        return blocks.join('\n');
    }

    return render;
})();
