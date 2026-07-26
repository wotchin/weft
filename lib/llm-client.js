/**
 * Weft — LLMClient: the single entry point for all model calls.
 *
 * Speaks three protocol dialects — `openai` (covers most vendors), `anthropic`,
 * and `builtin` (Chrome's on-device Prompt API). All UI code should call this
 * rather than fetching a provider endpoint directly.
 *
 * API:
 *   LLMClient.chat(messages, { stream, onDelta, signal, temperature, maxTokens, jsonMode })
 *     → { text, usage }
 *   LLMClient.completeJSON(messages, opts) → parsed object (non-streaming, tolerant)
 *   LLMClient.testConnection(cfg) → { ok, error? }
 *
 * Message shape (dialect-neutral, OpenAI-style):
 *   { role: 'system'|'user'|'assistant', content: string | ContentPart[] }
 *   ContentPart: { type:'text', text } | { type:'image_url', image_url:{ url } }
 */
/* exported LLMClient, LLMError */
/* global Store, getProvider */

class LLMError extends Error {
    constructor(kind, message, status) {
        super(message);
        this.name = 'LLMError';
        this.kind = kind; // auth|rate_limit|context_length|network|abort|server|bad_request
        this.status = status;
    }
    /** Short, user-facing hint (EN). UI can localize by kind. */
    get hint() {
        switch (this.kind) {
            case 'auth': return 'Check that your API key is valid and matches the selected provider.';
            case 'rate_limit': return 'Rate limited. Wait a moment and try again.';
            case 'context_length': return 'Too much context. Enable RAG or reduce selected snippets.';
            case 'network': return 'Network error. Check your connection and the Base URL.';
            case 'server': return 'The provider returned a server error. Try again shortly.';
            case 'bad_request': return 'The request was rejected. Check model name and settings.';
            case 'empty_response': return 'Reasoning models can use the whole token budget thinking. Raise Max Tokens in Settings, or pick a non-reasoning model.';
            default: return '';
        }
    }
}

const LLMClient = (() => {
    'use strict';

    function classifyStatus(status, body) {
        if (status === 401 || status === 403) return 'auth';
        if (status === 429) return 'rate_limit';
        if (status === 400 && /context|maximum context|too many tokens|length/i.test(body || '')) return 'context_length';
        if (status >= 500) return 'server';
        if (status === 400) return 'bad_request';
        return 'server';
    }

    function normalizeBaseUrl(url, fallback) {
        const u = (url || fallback || '').trim().replace(/\/+$/, '');
        return u;
    }

    // ── Message adaptation ──────────────────────────────────────────────
    function splitSystem(messages) {
        const system = messages.filter((m) => m.role === 'system')
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .join('\n\n');
        const rest = messages.filter((m) => m.role !== 'system');
        return { system, rest };
    }

    function dataUrlToParts(url) {
        // "data:image/png;base64,XXXX" → { media_type, data }
        const m = /^data:([^;]+);base64,(.*)$/.exec(url || '');
        if (!m) return null;
        return { media_type: m[1], data: m[2] };
    }

    function toAnthropicContent(content) {
        if (typeof content === 'string') return content;
        return content.map((part) => {
            if (part.type === 'text') return { type: 'text', text: part.text };
            if (part.type === 'image_url') {
                const img = dataUrlToParts(part.image_url?.url);
                if (img) return { type: 'image', source: { type: 'base64', ...img } };
                return { type: 'text', text: `[image: ${part.image_url?.url || 'unavailable'}]` };
            }
            return { type: 'text', text: '' };
        });
    }

    // ── SSE parsing ─────────────────────────────────────────────────────
    async function parseSSE(response, dialect, onDelta, onReasoning) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const data = t.slice(5).trim();
                if (data === '[DONE]') continue;
                let json;
                try { json = JSON.parse(data); } catch { continue; }

                let delta = '';
                let reasoning = '';
                if (dialect === 'anthropic') {
                    if (json.type === 'content_block_delta') {
                        const d = json.delta || {};
                        // Extended-thinking blocks stream separately from the answer.
                        if (d.type === 'thinking_delta') reasoning = d.thinking || '';
                        else delta = d.text || '';
                    }
                } else {
                    const d = json.choices?.[0]?.delta || {};
                    delta = d.content || '';
                    // Reasoning models (DeepSeek-R1, some proxies) put chain-of-thought
                    // in a separate field; surface it as progress, not as the answer.
                    reasoning = d.reasoning_content || d.reasoning || '';
                }
                if (reasoning && onReasoning) onReasoning(reasoning);
                if (delta) {
                    full += delta;
                    if (onDelta) onDelta(delta);
                }
            }
        }
        return full;
    }

    // ── Requests ────────────────────────────────────────────────────────
    async function requestOpenAI(cfg, messages, opts) {
        const base = normalizeBaseUrl(cfg.baseUrl, 'https://api.openai.com/v1');
        const body = {
            model: cfg.model,
            messages,
            temperature: opts.temperature ?? cfg.temperature ?? 0.7,
            max_tokens: opts.maxTokens ?? cfg.maxTokens ?? 2000,
            stream: !!opts.stream,
        };
        if (opts.jsonMode) body.response_format = { type: 'json_object' };

        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

        return fetch(`${base}/chat/completions`, {
            method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal,
        });
    }

    async function requestAnthropic(cfg, messages, opts) {
        const base = normalizeBaseUrl(cfg.baseUrl, 'https://api.anthropic.com/v1');
        const { system, rest } = splitSystem(messages);
        const body = {
            model: cfg.model,
            system: system || undefined,
            messages: rest.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
            temperature: opts.temperature ?? cfg.temperature ?? 0.7,
            max_tokens: opts.maxTokens ?? cfg.maxTokens ?? 2000, // required by Anthropic
            stream: !!opts.stream,
        };
        const headers = {
            'Content-Type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        };
        return fetch(`${base}/messages`, {
            method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal,
        });
    }

    function parseNonStreamText(dialect, json) {
        if (dialect === 'anthropic') {
            return (json.content || []).map((b) => b.text || '').join('');
        }
        return json.choices?.[0]?.message?.content || '';
    }

    function parseUsage(dialect, json) {
        const u = json.usage || {};
        if (dialect === 'anthropic') {
            return { promptTokens: u.input_tokens, completionTokens: u.output_tokens };
        }
        return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
    }

    // ── Chrome built-in AI (Prompt API) ─────────────────────────────────
    // Interface is still evolving (Chrome 138+ `LanguageModel` global); we
    // feature-detect and degrade to a clear error when unavailable.
    async function isBuiltinAvailable() {
        try {
            if (typeof LanguageModel === 'undefined') return false;
            const a = await LanguageModel.availability();
            return a === 'available' || a === 'downloadable' || a === 'downloading';
        } catch {
            return false;
        }
    }

    // Chrome's on-device model only supports these output languages today.
    const BUILTIN_LANGS = ['en', 'de', 'es', 'fr', 'ja'];

    function builtinOutputLanguage(preferred) {
        const candidates = [];
        if (preferred) candidates.push(preferred);
        // Honour the user's language setting before the browser's.
        try { candidates.push(I18N.resolvedCode()); } catch { /* i18n not loaded */ }
        try { candidates.push(chrome.i18n.getUILanguage()); } catch { /* not in a page */ }
        for (const c of candidates) {
            const base = String(c || '').toLowerCase().split('-')[0];
            if (BUILTIN_LANGS.includes(base)) return base;
        }
        return 'en';
    }

    async function chatBuiltin(messages, opts) {
        if (typeof LanguageModel === 'undefined') {
            throw new LLMError('bad_request', 'Chrome built-in AI is unavailable. Use Chrome 138+ or configure a cloud provider.');
        }
        const { system, rest } = splitSystem(messages);
        const toText = (c) => (typeof c === 'string' ? c : (c || []).map((p) => p.text || '').join('\n'));
        let session;
        try {
            const opForCreate = {};
            if (system) opForCreate.initialPrompts = [{ role: 'system', content: system }];
            if (opts.signal) opForCreate.signal = opts.signal;
            // The on-device model requires a declared output language; it only
            // supports a fixed set, so fall back to English for anything else.
            const lang = builtinOutputLanguage(opts.outputLanguage);
            opForCreate.expectedOutputs = [{ type: 'text', languages: [lang] }];
            opForCreate.outputLanguage = lang; // older/newer builds read either
            session = await LanguageModel.create(opForCreate);
        } catch (e) {
            throw new LLMError('server', 'Built-in AI failed to start: ' + (e.message || e));
        }
        // Concatenate the non-system turns into one prompt (small context window).
        const prompt = rest.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${toText(m.content)}`).join('\n\n');
        try {
            if (opts.stream && session.promptStreaming) {
                let full = '';
                const stream = session.promptStreaming(prompt, opts.signal ? { signal: opts.signal } : undefined);
                for await (const chunk of stream) {
                    // Some Chrome builds emit cumulative text, others deltas. Normalize to deltas.
                    const delta = chunk.startsWith(full) ? chunk.slice(full.length) : chunk;
                    full += delta;
                    if (opts.onDelta && delta) opts.onDelta(delta);
                }
                return { text: full, usage: null };
            }
            const text = await session.prompt(prompt, opts.signal ? { signal: opts.signal } : undefined);
            return { text, usage: null };
        } catch (e) {
            if (e.name === 'AbortError') throw new LLMError('abort', 'Request cancelled.');
            throw new LLMError('server', 'Built-in AI error: ' + (e.message || e));
        } finally {
            try { session && session.destroy && session.destroy(); } catch { /* noop */ }
        }
    }

    // ── Public API ──────────────────────────────────────────────────────
    async function chat(messages, opts = {}) {
        const cfg = opts.config || await Store.getLlmConfig();
        const provider = getProvider(cfg.provider);
        const dialect = provider.dialect;

        if (dialect === 'builtin') {
            return chatBuiltin(messages, opts);
        }
        if (provider.needsKey && !cfg.apiKey) {
            throw new LLMError('auth', 'API key not configured. Open Settings to add one.');
        }

        let response;
        try {
            response = dialect === 'anthropic'
                ? await requestAnthropic(cfg, messages, opts)
                : await requestOpenAI(cfg, messages, opts);
        } catch (e) {
            if (e.name === 'AbortError') throw new LLMError('abort', 'Request cancelled.');
            throw new LLMError('network', e.message || 'Network request failed');
        }

        if (!response.ok) {
            const raw = await response.text().catch(() => '');
            let msg = raw;
            try { msg = JSON.parse(raw).error?.message || raw; } catch { /* keep raw */ }
            throw new LLMError(classifyStatus(response.status, raw), msg || `HTTP ${response.status}`, response.status);
        }

        if (opts.stream) {
            const text = await parseSSE(response, dialect, opts.onDelta, opts.onReasoning);
            // A completed stream with no answer text is a real failure (usually a
            // reasoning model that spent the whole budget thinking). Say so
            // rather than leaving the caller with a silent blank.
            if (!text.trim()) {
                throw new LLMError(
                    'empty_response',
                    'The model finished without returning any text.',
                );
            }
            return { text, usage: null };
        }
        const json = await response.json();
        const text = parseNonStreamText(dialect, json);
        if (!text.trim()) {
            throw new LLMError('empty_response', 'The model returned an empty response.');
        }
        return { text, usage: parseUsage(dialect, json) };
    }

    async function completeJSON(messages, opts = {}) {
        const { text } = await chat(messages, { ...opts, stream: false, jsonMode: true });
        // Tolerant parse: strip ```json fences / prose around the object.
        let s = text.trim();
        const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
        if (fence) s = fence[1].trim();
        const first = s.indexOf('{');
        const last = s.lastIndexOf('}');
        if (first !== -1 && last !== -1) s = s.slice(first, last + 1);
        return JSON.parse(s);
    }

    async function testConnection(cfg) {
        try {
            const { text } = await chat(
                [{ role: 'user', content: 'ping' }],
                { config: cfg, stream: false, maxTokens: 5 }
            );
            return { ok: true, sample: text.slice(0, 40) };
        } catch (e) {
            return { ok: false, error: e.message, kind: e.kind, hint: e.hint };
        }
    }

    return { chat, completeJSON, testConnection, isBuiltinAvailable };
})();
