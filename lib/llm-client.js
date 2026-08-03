/**
 * Weft — LLMClient: the single entry point for all model calls.
 *
 * Speaks three protocol dialects — `openai` (covers most vendors), `anthropic`,
 * and `builtin` (Chrome's on-device Prompt API). All UI code should call this
 * rather than fetching a provider endpoint directly.
 *
 * API:
 *   LLMClient.chat(messages, { stream, onDelta, signal, timeoutMs, streamIdleTimeoutMs, temperature, maxTokens, jsonMode })
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
        this.kind = kind; // auth|rate_limit|context_length|network|timeout|abort|server|bad_request|empty_response|output_limit
        this.status = status;
    }
    /** Short, user-facing hint (EN). UI can localize by kind. */
    get hint() {
        switch (this.kind) {
            case 'auth': return 'Check that your API key is valid and matches the selected provider.';
            case 'rate_limit': return 'Rate limited. Wait a moment and try again.';
            case 'context_length': return 'Too much context. Enable RAG or reduce selected snippets.';
            case 'network': return 'Network error. Check your connection and the Base URL.';
            case 'timeout': return 'The provider stopped responding. Try again or choose a faster model.';
            case 'server': return 'The provider returned a server error. Try again shortly.';
            case 'bad_request': return 'The request was rejected. Check model name and settings.';
            case 'empty_response': return 'Reasoning models can use the whole token budget thinking. Raise Max Tokens in Settings, or pick a non-reasoning model.';
            case 'output_limit': return 'The answer reached the output limit before it was complete. Raise Max Tokens or ask for a shorter answer.';
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

    function classifyProviderError(error) {
        const parsedStatus = Number(error?.status || error?.status_code);
        const status = Number.isFinite(parsedStatus) ? parsedStatus : undefined;
        const detail = [error?.type, error?.code, error?.message]
            .filter((value) => typeof value === 'string')
            .join(' ')
            .toLowerCase();
        if (status === 401 || status === 403 || /auth|permission|unauthori[sz]ed|forbidden|api.?key/u.test(detail)) {
            return { kind: 'auth', status };
        }
        if (status === 429 || /rate.?limit|too many requests|quota/u.test(detail)) {
            return { kind: 'rate_limit', status };
        }
        if (/context.?length|context window|prompt.{0,20}too long|too many (?:input )?tokens/u.test(detail)) {
            return { kind: 'context_length', status };
        }
        if (status === 400 || /invalid.?request|bad.?request|validation/u.test(detail)) {
            return { kind: 'bad_request', status };
        }
        return { kind: 'server', status };
    }

    function normalizeBaseUrl(url, fallback) {
        const u = (url || fallback || '').trim().replace(/\/+$/, '');
        return u;
    }

    const DEFAULT_REQUEST_TIMEOUT_MS = 180000;
    const DEFAULT_STREAM_TIMEOUT_MS = 300000;
    const MAX_REQUEST_TIMEOUT_MS = 600000;

    /** Combine a caller cancellation signal with a bounded request lifetime. */
    function createRequestControl(opts) {
        const fallback = opts.stream ? DEFAULT_STREAM_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
        const requested = Number(opts.timeoutMs);
        const timeoutMs = Number.isFinite(requested) && requested > 0
            ? Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(25, requested))
            : fallback;
        const controller = new AbortController();
        let timedOut = false;

        const abortFromCaller = () => controller.abort();
        if (opts.signal?.aborted) abortFromCaller();
        else opts.signal?.addEventListener('abort', abortFromCaller, { once: true });

        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        return {
            signal: controller.signal,
            timedOut: () => timedOut,
            cleanup() {
                clearTimeout(timer);
                opts.signal?.removeEventListener('abort', abortFromCaller);
            },
        };
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
    async function parseSSE(response, dialect, onDelta, onReasoning, idleTimeoutMs) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';
        let finishReason = '';
        let protocolComplete = false;
        let reasoningPresent = false;
        let promptTokens;
        let completionTokens;

        function captureUsage(rawUsage) {
            if (!rawUsage || typeof rawUsage !== 'object') return;
            const prompt = dialect === 'anthropic'
                ? rawUsage.input_tokens
                : rawUsage.prompt_tokens;
            const completion = dialect === 'anthropic'
                ? rawUsage.output_tokens
                : rawUsage.completion_tokens;
            if (Number.isFinite(prompt)) promptTokens = prompt;
            if (Number.isFinite(completion)) completionTokens = completion;
        }

        function result() {
            const hasUsage = Number.isFinite(promptTokens) || Number.isFinite(completionTokens);
            return {
                text: full,
                finishReason,
                protocolComplete,
                reasoningPresent,
                usage: hasUsage ? { promptTokens, completionTokens } : null,
            };
        }

        function consumeLine(line) {
            const t = line.trim();
            if (!t.startsWith('data:')) return false;
            const data = t.slice(5).trim();
            if (data === '[DONE]') {
                // Some OpenAI-compatible proxies keep the HTTP connection
                // alive after the protocol-level terminator. Stop reading
                // immediately or the UI appears finished but stays busy.
                protocolComplete = true;
                reader.cancel().catch(() => {});
                return true;
            }
            let json;
            try { json = JSON.parse(data); } catch { return false; }

            const providerError = json?.error || (json?.type === 'error' ? json.error : null);
            if (providerError) {
                reader.cancel().catch(() => {});
                const message = typeof providerError.message === 'string'
                    ? providerError.message
                    : 'The provider returned an error while streaming.';
                const classification = classifyProviderError(providerError);
                throw new LLMError(classification.kind, message, classification.status);
            }

            if (dialect === 'anthropic' && json.type === 'message_stop') {
                protocolComplete = true;
                reader.cancel().catch(() => {});
                return true;
            }

            let delta = '';
            let reasoning = '';
            if (dialect === 'anthropic') {
                if (json.type === 'message_start') captureUsage(json.message?.usage);
                if (json.type === 'message_delta') {
                    if (json.delta?.stop_reason) finishReason = String(json.delta.stop_reason);
                    captureUsage(json.usage);
                }
                if (json.type === 'content_block_delta') {
                    const d = json.delta || {};
                    // Extended-thinking blocks stream separately from the answer.
                    if (d.type === 'thinking_delta') reasoning = d.thinking || '';
                    else delta = d.text || '';
                }
            } else {
                const choice = json.choices?.[0] || {};
                const d = choice.delta || {};
                delta = d.content || '';
                if (choice.finish_reason) finishReason = String(choice.finish_reason);
                captureUsage(json.usage);
                // Reasoning models (DeepSeek-R1, some proxies) put chain-of-thought
                // in a separate field; surface it as progress, not as the answer.
                reasoning = d.reasoning_content || d.reasoning || '';
            }
            if (reasoning) {
                reasoningPresent = true;
                if (onReasoning) onReasoning(reasoning);
            }
            if (delta) {
                full += delta;
                if (onDelta) onDelta(delta);
            }
            return false;
        }

        while (true) {
            let idleTimer = null;
            let packet;
            try {
                packet = await Promise.race([
                    reader.read(),
                    new Promise((_, reject) => {
                        idleTimer = setTimeout(() => reject(new LLMError(
                            'timeout',
                            'The model stream stopped responding before it completed.'
                        )), idleTimeoutMs);
                    }),
                ]);
            } catch (error) {
                reader.cancel().catch(() => {});
                throw error;
            } finally {
                if (idleTimer) clearTimeout(idleTimer);
            }
            const { done, value } = packet;
            if (done) {
                // TextDecoder may still hold an incomplete multi-byte character,
                // and some providers omit the final newline. Flush and consume
                // every residual line before treating the stream as complete.
                buffer += decoder.decode();
                for (const line of buffer.split('\n')) {
                    if (consumeLine(line)) return result();
                }
                return result();
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (consumeLine(line)) return result();
            }
        }
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

    function contentPartsText(content) {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (typeof part.text === 'string') return part.text;
            if (typeof part.text?.value === 'string') return part.text.value;
            return '';
        }).join('');
    }

    function parseNonStreamText(dialect, json) {
        if (dialect === 'anthropic') return contentPartsText(json?.content);
        return contentPartsText(json?.choices?.[0]?.message?.content);
    }

    function parseUsage(dialect, json) {
        const u = json?.usage || {};
        if (dialect === 'anthropic') {
            return { promptTokens: u.input_tokens, completionTokens: u.output_tokens };
        }
        return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
    }

    function finishReasonFlags(finishReason) {
        const reason = String(finishReason || '').toLowerCase();
        const successful = !reason || /^(?:stop|end_turn|stop_sequence|completed|eos|eos_token)$/u.test(reason);
        const filtered = /(?:content_filter|safety|refusal|blocked)/u.test(reason);
        const toolCall = /^(?:tool_calls|tool_use|pause_turn|function_call)$/u.test(reason);
        const truncated = /^(?:length|max_tokens|max_output_tokens|model_context_window_exceeded)$/u.test(reason);
        const resourceFailure = /^(?:insufficient_system_resource|resource_exhausted|overloaded|server_error)$/u.test(reason);
        const terminalFailure = Boolean(reason) && !successful && !filtered && !toolCall && !truncated;
        return { reason, successful, filtered, toolCall, truncated, resourceFailure, terminalFailure };
    }

    function completionMeta(dialect, json) {
        const choice = dialect === 'anthropic' ? null : json?.choices?.[0];
        const message = choice?.message || {};
        const finishReason = String(
            dialect === 'anthropic' ? (json?.stop_reason || '') : (choice?.finish_reason || '')
        ).toLowerCase();
        const refusal = typeof message.refusal === 'string' && Boolean(message.refusal.trim());
        const flags = finishReasonFlags(finishReason);
        const filtered = refusal || flags.filtered;
        const toolCall = flags.toolCall
            || Boolean(message.function_call)
            || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
        const reasoningPresent = Boolean(
            message.reasoning_content
            || message.reasoning
            || json?.usage?.completion_tokens_details?.reasoning_tokens
        );
        return {
            finishReason,
            refusal,
            filtered,
            toolCall,
            truncated: flags.truncated,
            resourceFailure: flags.resourceFailure,
            terminalFailure: flags.terminalFailure,
            reasoningPresent,
            retryable: !filtered && !toolCall,
            usage: parseUsage(dialect, json),
        };
    }

    function attachCompletionMeta(error, meta, maxTokens) {
        error.finishReason = meta.finishReason;
        error.truncated = meta.truncated;
        error.retryable = meta.retryable;
        error.reasoningPresent = meta.reasoningPresent;
        error.resourceFailure = Boolean(meta.resourceFailure);
        error.usage = meta.usage;
        const budget = Number(maxTokens);
        if (Number.isFinite(budget) && budget > 0) error.maxTokens = Math.floor(budget);
        return error;
    }

    function emptyResponseError(meta, maxTokens) {
        const message = meta.truncated
            ? 'The model reached its output limit before returning final text.'
            : meta.filtered || meta.refusal
                ? 'The model did not return text because the response was filtered or refused.'
                : meta.toolCall
                    ? 'The model returned a tool call instead of text.'
                    : 'The model returned an empty response.';
        return attachCompletionMeta(new LLMError('empty_response', message), meta, maxTokens);
    }

    function completionStatusError(meta, maxTokens) {
        if (meta.truncated) {
            return attachCompletionMeta(new LLMError(
                'output_limit',
                'The model reached its output limit before completing the answer.'
            ), meta, maxTokens);
        }
        if (meta.filtered || meta.refusal) {
            return attachCompletionMeta(new LLMError(
                'bad_request',
                'The model response was filtered or refused.'
            ), meta, maxTokens);
        }
        if (meta.toolCall) {
            return attachCompletionMeta(new LLMError(
                'bad_request',
                'The model returned a tool call instead of a final answer.'
            ), meta, maxTokens);
        }
        if (meta.terminalFailure) {
            return attachCompletionMeta(new LLMError(
                'server',
                `The model stopped before completing the answer (${meta.finishReason || 'unknown reason'}).`
            ), meta, maxTokens);
        }
        return null;
    }

    function streamCompletionMeta(stream) {
        const finishReason = String(stream?.finishReason || '').toLowerCase();
        const flags = finishReasonFlags(finishReason);
        return {
            finishReason,
            refusal: false,
            filtered: flags.filtered,
            toolCall: flags.toolCall,
            truncated: flags.truncated,
            resourceFailure: flags.resourceFailure,
            terminalFailure: flags.terminalFailure,
            reasoningPresent: Boolean(stream?.reasoningPresent),
            retryable: !flags.filtered && !flags.toolCall,
            usage: stream?.usage || null,
        };
    }

    function incompleteStreamError(stream, maxTokens) {
        const meta = streamCompletionMeta(stream);
        meta.retryable = true;
        const error = attachCompletionMeta(new LLMError(
            'network',
            'The model stream ended before reporting that the answer was complete.'
        ), meta, maxTokens);
        error.incomplete = true;
        return error;
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
            if (e.name === 'AbortError') throw new LLMError('abort', 'Request cancelled.');
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
        const control = createRequestControl(opts);
        const requestOpts = { ...opts, signal: control.signal };
        try {
            if (dialect === 'builtin') {
                const completion = await chatBuiltin(messages, requestOpts);
                if (!String(completion?.text || '').trim()) {
                    throw new LLMError('empty_response', 'The built-in model returned an empty response.');
                }
                return completion;
            }
            if (provider.needsKey && !cfg.apiKey) {
                throw new LLMError('auth', 'API key not configured. Open Settings to add one.');
            }

            let response;
            try {
                response = dialect === 'anthropic'
                    ? await requestAnthropic(cfg, messages, requestOpts)
                    : await requestOpenAI(cfg, messages, requestOpts);
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

            if (requestOpts.stream) {
                const requestedIdleTimeout = Number(requestOpts.streamIdleTimeoutMs);
                const streamIdleTimeoutMs = Number.isFinite(requestedIdleTimeout) && requestedIdleTimeout > 0
                    ? Math.min(120000, Math.max(25, requestedIdleTimeout))
                    : 45000;
                const stream = await parseSSE(
                    response,
                    dialect,
                    requestOpts.onDelta,
                    requestOpts.onReasoning,
                    streamIdleTimeoutMs
                );
                const text = stream.text;
                const meta = streamCompletionMeta(stream);
                const maxTokens = requestOpts.maxTokens ?? cfg.maxTokens;
                // A completed stream with no answer text is a real failure (usually a
                // reasoning model that spent the whole budget thinking). Say so
                // rather than leaving the caller with a silent blank.
                if (!text.trim()) {
                    throw emptyResponseError(meta, maxTokens);
                }
                const statusError = completionStatusError(meta, maxTokens);
                if (statusError) throw statusError;
                // [DONE]/message_stop is sufficient for compatible providers
                // that omit a semantic finish reason. A bare EOF is not: treating
                // it as success silently promotes a broken half-answer.
                if (!stream.protocolComplete && !meta.finishReason) {
                    throw incompleteStreamError(stream, maxTokens);
                }
                return {
                    text,
                    usage: meta.usage,
                    finishReason: meta.finishReason,
                    truncated: false,
                };
            }
            const json = await response.json();
            if (json?.error) {
                const providerMessage = typeof json.error?.message === 'string'
                    ? json.error.message
                    : 'The provider returned an error response.';
                throw new LLMError(classifyStatus(Number(json.error?.status) || 500, providerMessage), providerMessage);
            }
            const text = parseNonStreamText(dialect, json);
            const meta = completionMeta(dialect, json);
            const maxTokens = requestOpts.maxTokens ?? cfg.maxTokens;
            if (!text.trim()) {
                throw emptyResponseError(meta, maxTokens);
            }
            const statusError = completionStatusError(meta, maxTokens);
            if (statusError) throw statusError;
            return {
                text,
                usage: meta.usage,
                finishReason: meta.finishReason,
                truncated: meta.truncated,
            };
        } catch (e) {
            if (control.timedOut()) {
                throw new LLMError('timeout', 'The model request timed out before it completed.');
            }
            if (e?.name === 'AbortError') throw new LLMError('abort', 'Request cancelled.');
            throw e;
        } finally {
            control.cleanup();
        }
    }

    async function completeJSON(messages, opts = {}) {
        const completion = await chat(messages, {
            ...opts,
            stream: false,
            jsonMode: opts.jsonMode !== false,
        });
        // Tolerant parse: strip ```json fences / prose around the object.
        let s = completion.text.trim();
        const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
        if (fence) s = fence[1].trim();
        const first = s.indexOf('{');
        const last = s.lastIndexOf('}');
        if (first !== -1 && last !== -1) s = s.slice(first, last + 1);
        try {
            return JSON.parse(s);
        } catch (error) {
            // Preserve safe completion metadata for caller-specific recovery;
            // never attach raw provider payloads or hidden reasoning text.
            error.finishReason = completion.finishReason || '';
            error.truncated = Boolean(completion.truncated);
            error.retryable = true;
            throw error;
        }
    }

    async function testConnection(cfg) {
        try {
            const { text } = await chat(
                [{ role: 'user', content: 'ping' }],
                { config: cfg, stream: false, maxTokens: 5, timeoutMs: 30000 }
            );
            return { ok: true, sample: text.slice(0, 40) };
        } catch (e) {
            return { ok: false, error: e.message, kind: e.kind, hint: e.hint };
        }
    }

    return { chat, completeJSON, testConnection, isBuiltinAvailable };
})();
