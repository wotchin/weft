/**
 * PDFExtractor — fetch and parse a text-layer PDF without replacing Chrome's
 * built-in viewer. PDF.js and its worker are loaded lazily from local extension
 * files so parsing stays off the Workbench UI thread.
 */
/* exported PDFExtractor */
/* global chrome, SourceUtils */

const PDFExtractor = (() => {
    'use strict';

    const DEFAULT_LIMITS = Object.freeze({
        maxBytes: 25 * 1024 * 1024,
        maxPages: 300,
        maxTextChars: 1_000_000,
        maxPageTextChars: 250_000,
        maxItemsPerPage: 50_000,
        blockChars: 6000,
        minTextChars: 50,
    });
    const PDF_HEADER = new TextEncoder().encode('%PDF-');
    const PDF_SNIFF_BYTES = 1024 + PDF_HEADER.length;
    let pdfJsPromise = null;

    class PDFExtractionError extends Error {
        constructor(code, message, cause) {
            super(message || code, cause ? { cause } : undefined);
            this.name = 'PDFExtractionError';
            this.code = code;
        }
    }

    function abortError() {
        const error = new Error('PDF extraction was cancelled.');
        error.name = 'AbortError';
        error.code = 'PDF_ABORTED';
        return error;
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) throw abortError();
    }

    function waitWithSignal(value, signal) {
        if (!signal) return Promise.resolve(value);
        throwIfAborted(signal);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, result) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                callback(result);
            };
            const onAbort = () => finish(reject, abortError());
            signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(value).then(
                (result) => finish(resolve, result),
                (error) => finish(reject, error)
            );
        });
    }

    function positiveLimit(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
    }

    function limitsFrom(options = {}) {
        return {
            maxBytes: positiveLimit(options.maxBytes, DEFAULT_LIMITS.maxBytes),
            maxPages: positiveLimit(options.maxPages, DEFAULT_LIMITS.maxPages),
            maxTextChars: positiveLimit(options.maxTextChars, DEFAULT_LIMITS.maxTextChars),
            maxPageTextChars: positiveLimit(options.maxPageTextChars, DEFAULT_LIMITS.maxPageTextChars),
            maxItemsPerPage: positiveLimit(options.maxItemsPerPage, DEFAULT_LIMITS.maxItemsPerPage),
            blockChars: positiveLimit(options.blockChars, DEFAULT_LIMITS.blockChars),
            minTextChars: positiveLimit(options.minTextChars, DEFAULT_LIMITS.minTextChars),
        };
    }

    function emitProgress(callback, progress) {
        if (typeof callback !== 'function') return;
        try {
            callback(progress);
        } catch {
            /* progress must never break extraction */
        }
    }

    function isPdfBytes(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
        const searchLength = Math.min(1024, Math.max(0, data.length - PDF_HEADER.length + 1));
        for (let offset = 0; offset < searchLength; offset++) {
            let match = true;
            for (let index = 0; index < PDF_HEADER.length; index++) {
                if (data[offset + index] !== PDF_HEADER[index]) {
                    match = false;
                    break;
                }
            }
            if (match) return true;
        }
        return false;
    }

    function headerValue(headers, name) {
        try {
            return headers?.get?.(name) || '';
        } catch {
            return '';
        }
    }

    async function cancelReader(reader, reason) {
        try {
            await Promise.resolve(reader?.cancel?.(reason));
        } catch {}
    }

    async function readResponseBytes(response, options, limits) {
        const declaredLength = Number(headerValue(response.headers, 'content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > limits.maxBytes) {
            throw new PDFExtractionError('PDF_TOO_LARGE', 'The PDF exceeds the download limit.');
        }

        const signal = options.signal;
        throwIfAborted(signal);
        if (!response.body?.getReader) {
            const buffer = await waitWithSignal(response.arrayBuffer(), signal);
            throwIfAborted(signal);
            if (buffer.byteLength > limits.maxBytes) {
                throw new PDFExtractionError('PDF_TOO_LARGE', 'The PDF exceeds the download limit.');
            }
            emitProgress(options.onProgress, {
                phase: 'download',
                loaded: buffer.byteLength,
                total: declaredLength || buffer.byteLength,
            });
            return new Uint8Array(buffer);
        }

        const reader = response.body.getReader();
        const chunks = [];
        const prefix = new Uint8Array(PDF_SNIFF_BYTES);
        let prefixLength = 0;
        let received = 0;
        let abortListener = null;
        if (signal) {
            abortListener = () => {
                cancelReader(reader, abortError());
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }
        try {
            while (true) {
                throwIfAborted(signal);
                const { done, value } = await waitWithSignal(reader.read(), signal);
                if (done) break;
                const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
                received += chunk.byteLength;
                if (received > limits.maxBytes) {
                    await cancelReader(reader);
                    throw new PDFExtractionError('PDF_TOO_LARGE', 'The PDF exceeds the download limit.');
                }
                if (prefixLength < prefix.length) {
                    const take = Math.min(chunk.byteLength, prefix.length - prefixLength);
                    prefix.set(chunk.subarray(0, take), prefixLength);
                    prefixLength += take;
                    if (prefixLength === prefix.length && !isPdfBytes(prefix)) {
                        await cancelReader(reader);
                        throw new PDFExtractionError('PDF_NOT_PDF', 'The response is not a PDF document.');
                    }
                }
                chunks.push(chunk);
                emitProgress(options.onProgress, {
                    phase: 'download',
                    loaded: received,
                    total: declaredLength || 0,
                });
            }
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw abortError();
            throw error;
        } finally {
            if (signal && abortListener) signal.removeEventListener('abort', abortListener);
            try {
                reader.releaseLock?.();
            } catch {}
        }

        throwIfAborted(signal);
        if (!isPdfBytes(prefix.subarray(0, prefixLength))) {
            throw new PDFExtractionError('PDF_NOT_PDF', 'The response is not a PDF document.');
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }

    async function fetchPdf(url, options, limits) {
        const fetchImpl = options.fetchImpl || globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new PDFExtractionError('PDF_FETCH_FAILED', 'PDF download is unavailable.');
        }
        throwIfAborted(options.signal);

        let response;
        try {
            response = await fetchImpl(url, {
                method: 'GET',
                credentials: 'include',
                redirect: 'follow',
                cache: 'default',
                headers: { Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.1' },
                signal: options.signal,
            });
        } catch (error) {
            if (options.signal?.aborted || error?.name === 'AbortError') throw abortError();
            throw new PDFExtractionError('PDF_FETCH_FAILED', 'The PDF could not be downloaded.', error);
        }
        if (!response?.ok) {
            throw new PDFExtractionError('PDF_FETCH_FAILED', `The PDF request failed (${response?.status || 0}).`);
        }

        const contentType = headerValue(response.headers, 'content-type').toLowerCase();
        if (/^(?:text\/html|application\/(?:xhtml\+xml|json))(?:\s*;|$)/u.test(contentType)) {
            throw new PDFExtractionError('PDF_NOT_PDF', 'The response is not a PDF document.');
        }

        let bytes;
        try {
            bytes = await readResponseBytes(response, options, limits);
        } catch (error) {
            if (error instanceof PDFExtractionError || error?.name === 'AbortError') throw error;
            if (options.signal?.aborted) throw abortError();
            throw new PDFExtractionError('PDF_FETCH_FAILED', 'The PDF could not be downloaded.', error);
        }
        if (!isPdfBytes(bytes)) {
            throw new PDFExtractionError('PDF_NOT_PDF', 'The response is not a PDF document.');
        }
        return { bytes, response };
    }

    function normalizeItemText(value) {
        return String(value || '')
            .replace(/[\t\f\v ]+/gu, ' ')
            .trim();
    }

    function textItemsToPageText(items) {
        const lines = [];
        let lineSegments = [];
        let lineY = null;
        let lineHeight = 0;

        const finishLine = () => {
            const clean = SourceUtils.joinPdfSelectionSegments(lineSegments);
            if (clean) lines.push(clean);
            lineSegments = [];
            lineY = null;
            lineHeight = 0;
        };

        for (const item of Array.isArray(items) ? items : []) {
            const text = normalizeItemText(item?.str);
            if (!text) {
                if (item?.hasEOL) finishLine();
                continue;
            }
            const y = Number(item?.transform?.[5]);
            const height = Math.abs(Number(item?.height) || Number(item?.transform?.[3]) || 0);
            const changedLine =
                lineSegments.length > 0 &&
                Number.isFinite(y) &&
                Number.isFinite(lineY) &&
                Math.abs(y - lineY) > Math.max(2, Math.min(12, Math.max(height, lineHeight) * 0.6));
            if (changedLine) finishLine();
            lineSegments.push({ ...item, text });
            if (Number.isFinite(y)) lineY = y;
            lineHeight = Math.max(lineHeight, height);
            if (item?.hasEOL) finishLine();
        }
        finishLine();
        return lines.join('\n');
    }

    function splitLongLine(line, maxChars) {
        const pieces = [];
        let remaining = line;
        while (remaining.length > maxChars) {
            let split = remaining.lastIndexOf(' ', maxChars);
            if (split < Math.floor(maxChars * 0.5)) split = maxChars;
            pieces.push(remaining.slice(0, split).trim());
            remaining = remaining.slice(split).trim();
        }
        if (remaining) pieces.push(remaining);
        return pieces;
    }

    function buildPageBlocks(text, pageNumber, maxChars = DEFAULT_LIMITS.blockChars) {
        const limit = positiveLimit(maxChars, DEFAULT_LIMITS.blockChars);
        const lines = String(text || '')
            .split(/\n+/u)
            .map((line) => line.trim())
            .filter(Boolean);
        const blocks = [];
        let current = '';
        const push = () => {
            if (!current) return;
            blocks.push({
                id: `pdf-p${pageNumber}-b${blocks.length + 1}`,
                text: current,
                tag: 'p',
                pageNumber,
            });
            current = '';
        };
        for (const line of lines.flatMap((value) => splitLongLine(value, limit))) {
            const candidate = current ? `${current}\n${line}` : line;
            if (candidate.length > limit && current) push();
            current = current ? `${current}\n${line}` : line;
        }
        push();
        return blocks;
    }

    function countWords(content) {
        const text = String(content || '');
        const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) || [];
        const words =
            text
                .replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu, ' ')
                .match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || [];
        return cjk.length + words.length;
    }

    function dispositionFilename(response) {
        const value = headerValue(response?.headers, 'content-disposition');
        const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/iu)?.[1];
        if (encoded) {
            try {
                return decodeURIComponent(encoded)
                    .replace(/^['"]|['"]$/gu, '')
                    .trim();
            } catch {}
        }
        return (
            value
                .match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/iu)
                ?.slice(1)
                .find(Boolean)
                ?.trim() || ''
        );
    }

    function inferredTitle(url, sourceTitle, response, metadataTitle) {
        const candidates = [metadataTitle, sourceTitle, dispositionFilename(response)];
        try {
            const parsed = new URL(url);
            const filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
            candidates.push(filename.replace(/\.pdf$/iu, ''));
        } catch {}
        const title =
            candidates
                .map((value) =>
                    String(value || '')
                        .replace(/\.pdf$/iu, '')
                        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
                        .replace(/\s+/gu, ' ')
                        .trim()
                )
                .find(Boolean) || 'PDF document';
        return title.slice(0, 300);
    }

    async function loadPdfJs() {
        if (!pdfJsPromise) {
            const moduleUrl = chrome.runtime.getURL('lib/vendor/pdfjs/pdf.min.mjs');
            pdfJsPromise = import(moduleUrl)
                .then((pdfjs) => {
                    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/vendor/pdfjs/pdf.worker.min.mjs');
                    return pdfjs;
                })
                .catch((error) => {
                    pdfJsPromise = null;
                    throw error;
                });
        }
        return pdfJsPromise;
    }

    async function createDedicatedWorker(pdfjs, options) {
        // Injected PDF.js doubles intentionally omit browser workers in unit
        // tests. Production always takes this branch, preventing PDF.js from
        // silently falling back to its UI-thread "fake worker".
        if (options.pdfjs && typeof options.workerFactory !== 'function') return null;
        if (typeof pdfjs?.PDFWorker !== 'function') {
            throw new PDFExtractionError('PDF_WORKER_FAILED', 'The PDF worker is unavailable.');
        }

        const workerUrl = chrome.runtime.getURL('lib/vendor/pdfjs/pdf.worker.min.mjs');
        const workerFactory =
            options.workerFactory ||
            ((url) => {
                if (typeof globalThis.Worker !== 'function') {
                    throw new Error('Module workers are unavailable.');
                }
                return new globalThis.Worker(url, { type: 'module', name: 'weft-pdf-parser' });
            });
        let port = null;
        let pdfWorker = null;
        try {
            port = workerFactory(workerUrl);
            if (!port || typeof port.postMessage !== 'function') {
                throw new Error('The PDF worker did not provide a message port.');
            }
            pdfWorker = new pdfjs.PDFWorker({ port, verbosity: 0 });
            await waitWithSignal(pdfWorker.promise, options.signal);
            throwIfAborted(options.signal);
            return { pdfWorker, port };
        } catch (error) {
            try {
                pdfWorker?.destroy?.();
            } catch {}
            try {
                port?.terminate?.();
            } catch {}
            if (options.signal?.aborted || error?.name === 'AbortError') throw abortError();
            throw new PDFExtractionError('PDF_WORKER_FAILED', 'The isolated PDF worker could not be started.', error);
        }
    }

    function responseDocumentBaseUrl(response, fallback) {
        try {
            const url = new URL(String(response?.url || fallback || ''));
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : fallback;
        } catch {
            return fallback;
        }
    }

    function pdfJsOptions(bytes, url, pdfWorker = null) {
        const runtimeUrl = (path) => chrome.runtime.getURL(`lib/vendor/pdfjs/${path}`);
        return {
            data: bytes,
            docBaseUrl: url,
            ...(pdfWorker ? { worker: pdfWorker } : {}),
            cMapUrl: runtimeUrl('cmaps/'),
            cMapPacked: true,
            standardFontDataUrl: runtimeUrl('standard_fonts/'),
            useSystemFonts: true,
            useWasm: false,
            useWorkerFetch: false,
            isEvalSupported: false,
            // A PDF is data, never an active document. Keep JavaScript actions
            // disabled even if a future PDF.js default changes.
            enableScripting: false,
            stopAtErrors: false,
            verbosity: 0,
        };
    }

    function mappedParseError(error) {
        if (error?.name === 'PasswordException' || /password/iu.test(String(error?.name || ''))) {
            return new PDFExtractionError(
                'PDF_PASSWORD_REQUIRED',
                'Password-protected PDFs are not supported yet.',
                error
            );
        }
        if (error instanceof PDFExtractionError || error?.name === 'AbortError') return error;
        return new PDFExtractionError('PDF_PARSE_FAILED', 'The PDF could not be parsed.', error);
    }

    async function parsePdf(bytes, url, response, options, limits) {
        throwIfAborted(options.signal);
        const pdfjs = options.pdfjs || (await loadPdfJs());
        throwIfAborted(options.signal);
        let loadingTask = null;
        let document = null;
        let workerHandle = null;
        let abortListener = null;
        let cleanupPromise = null;
        const cleanup = () => {
            if (!cleanupPromise) {
                cleanupPromise = (async () => {
                    let forceTerminateTimer = null;
                    if (workerHandle?.port) {
                        forceTerminateTimer = setTimeout(() => {
                            try {
                                workerHandle.port.terminate?.();
                            } catch {}
                        }, 1500);
                    }
                    try {
                        await loadingTask?.destroy?.();
                    } catch {
                        // Cleanup errors cannot replace the extraction result.
                    } finally {
                        if (forceTerminateTimer) clearTimeout(forceTerminateTimer);
                        try {
                            workerHandle?.pdfWorker?.destroy?.();
                        } catch {}
                        try {
                            workerHandle?.port?.terminate?.();
                        } catch {}
                    }
                })();
            }
            return cleanupPromise;
        };
        try {
            workerHandle = await createDedicatedWorker(pdfjs, options);
            throwIfAborted(options.signal);
            loadingTask = pdfjs.getDocument(
                pdfJsOptions(bytes, responseDocumentBaseUrl(response, url), workerHandle?.pdfWorker)
            );
            if (options.signal) {
                abortListener = () => {
                    cleanup().catch(() => {});
                };
                options.signal.addEventListener('abort', abortListener, { once: true });
                if (options.signal.aborted) {
                    abortListener();
                    throw abortError();
                }
            }
            document = await waitWithSignal(loadingTask.promise, options.signal);
            throwIfAborted(options.signal);
            if (!Number.isInteger(document.numPages) || document.numPages < 1) {
                throw new PDFExtractionError('PDF_PARSE_FAILED', 'The PDF does not contain any pages.');
            }
            if (document.numPages > limits.maxPages) {
                throw new PDFExtractionError('PDF_TOO_MANY_PAGES', 'The PDF exceeds the page limit.');
            }

            let metadataTitle = '';
            try {
                metadataTitle = (await waitWithSignal(document.getMetadata(), options.signal))?.info?.Title || '';
            } catch {}
            const blocks = [];
            const pageTexts = [];
            let textChars = 0;

            for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
                throwIfAborted(options.signal);
                const page = await waitWithSignal(document.getPage(pageNumber), options.signal);
                throwIfAborted(options.signal);
                try {
                    const textContent = await waitWithSignal(
                        page.getTextContent({
                            includeMarkedContent: false,
                            disableNormalization: false,
                        }),
                        options.signal
                    );
                    throwIfAborted(options.signal);
                    const items = Array.isArray(textContent?.items) ? textContent.items : [];
                    if (items.length > limits.maxItemsPerPage) {
                        throw new PDFExtractionError('PDF_TOO_MUCH_TEXT', 'A PDF page exceeds the text-item limit.');
                    }
                    const pageText = textItemsToPageText(items);
                    if (pageText.length > limits.maxPageTextChars) {
                        throw new PDFExtractionError('PDF_TOO_MUCH_TEXT', 'A PDF page exceeds the text limit.');
                    }
                    if (pageText) {
                        textChars += pageText.length;
                        if (textChars > limits.maxTextChars) {
                            throw new PDFExtractionError(
                                'PDF_TOO_MUCH_TEXT',
                                'The PDF text exceeds the extraction limit.'
                            );
                        }
                        pageTexts.push(pageText);
                        blocks.push(...buildPageBlocks(pageText, pageNumber, limits.blockChars));
                    }
                } finally {
                    try {
                        page.cleanup?.();
                    } catch {}
                }
                emitProgress(options.onProgress, {
                    phase: 'parse',
                    pageNumber,
                    totalPages: document.numPages,
                });
                // Even though decoding stays in the dedicated Worker, text
                // normalization runs here. Yield every page to keep UI input,
                // scrolling, and the Clear recovery action responsive.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            const content = pageTexts.join('\n\n');
            if (content.replace(/\s+/gu, '').length < limits.minTextChars || blocks.length === 0) {
                throw new PDFExtractionError('PDF_NO_TEXT_LAYER', 'No readable PDF text layer was found.');
            }
            return {
                title: inferredTitle(url, options.sourceTitle, response, metadataTitle),
                url,
                description: '',
                content,
                wordCount: countWords(content),
                lang: '',
                blocks,
                links: [],
                pageType: 'article',
                documentType: 'pdf',
                pageCount: document.numPages,
                isLikelyPartial: false,
                partialReason: '',
            };
        } catch (error) {
            if (options.signal?.aborted) throw abortError();
            throw mappedParseError(error);
        } finally {
            if (options.signal && abortListener) options.signal.removeEventListener('abort', abortListener);
            const cleanupTask = cleanup();
            if (options.signal?.aborted) {
                await Promise.race([cleanupTask, new Promise((resolve) => setTimeout(resolve, 2000))]);
            } else {
                await cleanupTask;
            }
        }
    }

    async function extractFromUrl(value, options = {}) {
        let url;
        try {
            const parsed = new URL(String(value || ''));
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported protocol');
            parsed.hash = '';
            url = parsed.href;
        } catch {
            throw new PDFExtractionError('PDF_UNSUPPORTED_URL', 'Only HTTP(S) PDF URLs are supported.');
        }
        const limits = limitsFrom(options);
        const { bytes, response } = await fetchPdf(url, options, limits);
        return parsePdf(bytes, url, response, options, limits);
    }

    /** Download and validate a PDF for a local extension viewer. */
    async function fetchBytesFromUrl(value, options = {}) {
        let url;
        try {
            const parsed = new URL(String(value || ''));
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported protocol');
            parsed.hash = '';
            url = parsed.href;
        } catch {
            throw new PDFExtractionError('PDF_UNSUPPORTED_URL', 'Only HTTP(S) PDF URLs are supported.');
        }
        const limits = limitsFrom(options);
        const { bytes, response } = await fetchPdf(url, options, limits);
        return Object.freeze({
            bytes,
            url,
            responseUrl: responseDocumentBaseUrl(response, url),
            contentType: headerValue(response?.headers, 'content-type'),
        });
    }

    return Object.freeze({
        DEFAULT_LIMITS,
        PDFExtractionError,
        buildPageBlocks,
        extractFromUrl,
        fetchBytesFromUrl,
        isLikelyPdfUrl: SourceUtils.isLikelyPdfUrl,
        isPdfBytes,
        textItemsToPageText,
    });
})();
