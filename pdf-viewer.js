/* global Store, SourceUtils, PDFExtractor, PDFSelectionAssist, I18N, t, chrome */

document.addEventListener('DOMContentLoaded', async () => {
    await I18N.init();
    I18N.apply();

    const params = new URLSearchParams(location.search);
    const sourceUrl = SourceUtils.safeHttpUrl(params.get('src'));
    const requestedSession = String(params.get('session') || '').trim();
    const requestedPage = SourceUtils.pdfPageNumber(params.get('page')) || 1;
    const requestedTitle = String(params.get('title') || '').trim().slice(0, 300);

    const documentTitle = document.getElementById('documentTitle');
    const sessionSelect = document.getElementById('sessionSelect');
    const toggleHighlights = document.getElementById('toggleHighlights');
    const openOriginal = document.getElementById('openOriginal');
    const zoomOut = document.getElementById('zoomOut');
    const zoomIn = document.getElementById('zoomIn');
    const zoomLabel = document.getElementById('zoomLabel');
    const pageInput = document.getElementById('pageInput');
    const pageCount = document.getElementById('pageCount');
    const viewerStatus = document.getElementById('viewerStatus');
    const snippetCount = document.getElementById('snippetCount');
    const snippetList = document.getElementById('snippetList');
    const pdfScroll = document.getElementById('pdfScroll');
    const pdfPages = document.getElementById('pdfPages');
    const viewerError = document.getElementById('viewerError');
    const viewerToast = document.getElementById('viewerToast');

    let pdfjs = null;
    let pdfDocument = null;
    let loadingTask = null;
    let workerPort = null;
    let pdfWorker = null;
    let pageObserver = null;
    let currentSession = '';
    let sessionSnippets = [];
    let zoom = 1.2;
    let basePageSize = { width: 816, height: 1056 };
    let renderGeneration = 0;
    let currentPage = requestedPage;
    let highlightsVisible = true;
    let toastTimer = null;
    let locatingUnknown = false;
    let locateQueued = false;
    let locateController = null;
    let locateAttemptDocument = null;
    let locateAttemptSession = '';
    let locateAttemptedKeys = new Set();
    let locateBatchChainRemaining = 0;
    let locateBatchChainDeadline = 0;
    let locateRestartQueued = false;
    let locateStoragePatchExpectations = [];
    let locateStoragePatchTimer = null;
    let sessionLoadGeneration = 0;
    let storageRefreshTimer = null;
    let pagePositionFrame = null;
    let pageOffsetFrame = null;
    let pageOffsets = [];
    let loadDeadlineTimer = null;
    let viewerTimedOut = false;
    let viewerDisposed = false;
    let shutdownPromise = null;
    const viewerController = new AbortController();
    const MAX_RENDERED_PAGES = 12;
    const MAX_PDF_PAGES = Number(PDFExtractor.DEFAULT_LIMITS?.maxPages) || 300;
    const MAX_VIEWPORT_DIMENSION = 10_000;
    const MAX_VIEWPORT_PIXELS = 25_000_000;
    const MAX_CANVAS_DIMENSION = 8_192;
    const MAX_CANVAS_PIXELS = 16_000_000;
    const MAX_RENDER_TEXT_ITEMS = 20_000;
    const MAX_RENDER_TEXT_CHARS = 1_000_000;
    const PAGE_STAGE_TIMEOUT_MS = 30_000;
    const MAX_LOCATE_UNIQUE_NEEDLES = 64;
    const MAX_LOCATE_AUTO_BATCHES = 2;
    const MAX_LOCATE_COMPARISONS = MAX_PDF_PAGES * MAX_LOCATE_UNIQUE_NEEDLES;
    const MAX_LOCATE_PAGE_CHARS = Number(PDFExtractor.DEFAULT_LIMITS?.maxPageTextChars) || 250000;
    const MAX_LOCATE_ITEMS_PER_PAGE = Number(PDFExtractor.DEFAULT_LIMITS?.maxItemsPerPage) || 50000;
    const MAX_LOCATE_TOTAL_CHARS = 25_000_000;
    const LOCATE_TIMEOUT_MS = 20_000;
    const LOCATE_CHAIN_TIMEOUT_MS = 25_000;
    const VIEWER_LOAD_TIMEOUT_MS = 180_000;
    const renderedPages = new Map();
    const renderingPages = new Map();

    function message(key, fallback) {
        const value = t(key);
        return value && value !== key ? value : fallback;
    }

    function setStatus(value) {
        viewerStatus.textContent = value || '';
    }

    function viewerAbortError() {
        if (viewerTimedOut) {
            const error = new Error('The PDF viewer load deadline was exceeded.');
            error.name = 'TimeoutError';
            error.code = 'PDF_VIEWER_TIMEOUT';
            return error;
        }
        const reason = viewerController.signal.reason;
        if (reason instanceof Error) return reason;
        const error = new Error('The PDF viewer was closed.');
        error.name = 'AbortError';
        error.code = 'PDF_ABORTED';
        return error;
    }

    function throwIfViewerAborted() {
        if (viewerController.signal.aborted) throw viewerAbortError();
    }

    function waitWithSignal(value, signal, errorFactory = viewerAbortError) {
        if (!signal) return Promise.resolve(value);
        if (signal.aborted) return Promise.reject(errorFactory());
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, result) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                callback(result);
            };
            const onAbort = () => finish(reject, errorFactory());
            signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(value).then(
                (result) => finish(resolve, result),
                (error) => finish(reject, error)
            );
        });
    }

    function pageAbortError() {
        const error = new Error('PDF page rendering was cancelled.');
        error.name = 'AbortError';
        error.code = 'PDF_PAGE_ABORTED';
        return error;
    }

    function pageStageTimeoutError(stage) {
        const error = new Error(`PDF page ${stage} exceeded its deadline.`);
        error.name = 'TimeoutError';
        error.code = 'PDF_PAGE_RENDER_TIMEOUT';
        return error;
    }

    function pageResourceLimitError(detail) {
        const error = new Error(`PDF page exceeds the safe ${detail} limit.`);
        error.name = 'RangeError';
        error.code = 'PDF_PAGE_RESOURCE_LIMIT';
        return error;
    }

    function cancelPageState(state, reason = pageAbortError()) {
        if (!state) return;
        if (!state.controller.signal.aborted) state.controller.abort(reason);
        try { state.renderTask?.cancel?.(); } catch {}
        try { state.textLayer?.cancel?.(); } catch {}
    }

    async function waitForPageStage(factory, state, stage) {
        if (state.controller.signal.aborted) {
            throw state.controller.signal.reason instanceof Error
                ? state.controller.signal.reason
                : pageAbortError();
        }
        const timer = setTimeout(() => {
            cancelPageState(state, pageStageTimeoutError(stage));
        }, PAGE_STAGE_TIMEOUT_MS);
        try {
            return await waitWithSignal(
                Promise.resolve().then(factory),
                state.controller.signal,
                () => state.controller.signal.reason instanceof Error
                    ? state.controller.signal.reason
                    : pageAbortError()
            );
        } finally {
            clearTimeout(timer);
        }
    }

    function validatedPageViewport(viewport) {
        const width = Number(viewport?.width);
        const height = Number(viewport?.height);
        const pixels = width * height;
        if (
            !Number.isFinite(width) || !Number.isFinite(height) ||
            width <= 0 || height <= 0 ||
            width > MAX_VIEWPORT_DIMENSION || height > MAX_VIEWPORT_DIMENSION ||
            !Number.isFinite(pixels) || pixels > MAX_VIEWPORT_PIXELS
        ) throw pageResourceLimitError('viewport');
        return { width, height, pixels };
    }

    function boundedCanvasOutput(viewport, deviceScale) {
        const { width, height, pixels } = validatedPageViewport(viewport);
        const requestedScale = Math.min(Math.max(Number(deviceScale) || 1, 1), 2);
        const outputScale = Math.min(
            requestedScale,
            MAX_CANVAS_DIMENSION / width,
            MAX_CANVAS_DIMENSION / height,
            Math.sqrt(MAX_CANVAS_PIXELS / pixels)
        );
        if (!Number.isFinite(outputScale) || outputScale <= 0) {
            throw pageResourceLimitError('canvas');
        }
        const canvasWidth = Math.max(1, Math.floor(width * outputScale));
        const canvasHeight = Math.max(1, Math.floor(height * outputScale));
        if (
            canvasWidth > MAX_CANVAS_DIMENSION || canvasHeight > MAX_CANVAS_DIMENSION ||
            canvasWidth * canvasHeight > MAX_CANVAS_PIXELS
        ) throw pageResourceLimitError('canvas');
        return { outputScale, canvasWidth, canvasHeight };
    }

    function boundedPlaceholderBox(widthValue, heightValue) {
        const width = Number(widthValue);
        const height = Number(heightValue);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return { width: 816, height: 1056 };
        }
        const pixels = width * height;
        const scale = Math.min(
            1,
            MAX_VIEWPORT_DIMENSION / width,
            MAX_VIEWPORT_DIMENSION / height,
            Math.sqrt(MAX_VIEWPORT_PIXELS / pixels)
        );
        return {
            width: Math.max(1, Math.ceil(width * scale)),
            height: Math.max(1, Math.ceil(height * scale)),
        };
    }

    function validatedRenderTextItems(textContent) {
        const items = Array.isArray(textContent?.items) ? textContent.items : null;
        if (!items || items.length > MAX_RENDER_TEXT_ITEMS) {
            throw pageResourceLimitError('text item');
        }
        let characters = 0;
        for (const item of items) {
            if (typeof item?.str !== 'string') continue;
            characters += item.str.length;
            if (characters > MAX_RENDER_TEXT_CHARS) {
                throw pageResourceLimitError('text character');
            }
        }
        return items;
    }

    function showPageError(pageNumber, error) {
        const element = pageElement(pageNumber);
        if (!element || viewerDisposed) return;
        element.querySelectorAll('canvas,.textLayer').forEach((node) => node.remove());
        element.classList.remove('is-rendered');
        element.classList.add('has-render-error');
        const placeholder = element.querySelector('.page-placeholder');
        if (placeholder) {
            const key = error?.code === 'PDF_PAGE_RESOURCE_LIMIT'
                ? 'pdf_viewer_page_too_complex'
                : error?.code === 'PDF_PAGE_RENDER_TIMEOUT'
                    ? 'pdf_viewer_page_timeout'
                    : 'pdf_viewer_page_render_failed';
            const fallbacks = {
                pdf_viewer_page_too_complex: 'Page %s is too complex to display safely. Open the original PDF to view it.',
                pdf_viewer_page_timeout: 'Page %s took too long to render. Change the zoom level or reopen the reader to retry.',
                pdf_viewer_page_render_failed: 'Page %s could not be displayed. Open the original PDF to view it.',
            };
            placeholder.textContent = message(key, fallbacks[key]).replace('%s', String(pageNumber));
        }
        pageObserver?.unobserve(element);
    }

    function showToast(value) {
        viewerToast.textContent = value;
        viewerToast.classList.add('is-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => viewerToast.classList.remove('is-visible'), 2800);
    }

    function fail(error) {
        if (viewerDisposed) return;
        console.error('[Weft] PDF viewer failed:', error);
        viewerError.hidden = false;
        const code = viewerTimedOut ? 'PDF_VIEWER_TIMEOUT' : String(error?.code || '');
        const errors = {
            PDF_TOO_MANY_PAGES: message(
                'pdf_viewer_too_many_pages',
                'This PDF has too many pages. The Weft reader supports up to %s pages.'
            ).replace('%s', String(MAX_PDF_PAGES)),
            PDF_VIEWER_TIMEOUT: message(
                'pdf_viewer_timeout',
                'Opening this PDF took too long. Try a smaller file or check your connection.'
            ),
        };
        viewerError.textContent = errors[code] || message(
            'pdf_viewer_load_failed',
            'This PDF could not be opened in the Weft reader.'
        );
        setStatus('');
    }

    function pageLabel(page) {
        return message('pdf_page_label', 'Page %s').replace('%s', String(page));
    }

    function canonicalPdfItemsText(items) {
        return SourceUtils.normalizePdfSelectionText(SourceUtils.joinPdfSelectionSegments(
            (Array.isArray(items) ? items : []).map((item) => ({ ...item, text: item?.str || '' }))
        ));
    }

    function matchingTextDivs(items, textDivs, itemData, content) {
        const needle = SourceUtils.normalizePdfSelectionText(content);
        if (needle.length < 2) return [];
        let pageText = '';
        const ranges = [];
        let previous = null;
        for (let index = 0; index < items.length; index++) {
            const text = SourceUtils.normalizePdfSelectionText(items[index]);
            if (!text) continue;
            const segment = { ...(itemData[index] || {}), text };
            if (previous) {
                const pair = SourceUtils.joinPdfSelectionSegments([previous, segment]);
                if (pair.length > previous.text.length + segment.text.length) pageText += ' ';
            }
            const start = pageText.length;
            pageText += text;
            ranges.push({ start, end: pageText.length, div: textDivs[index] });
            previous = segment;
        }
        const matched = new Set();
        let offset = 0;
        while (offset <= pageText.length - needle.length) {
            const start = pageText.indexOf(needle, offset);
            if (start < 0) break;
            const end = start + needle.length;
            for (const range of ranges) {
                if (range.end > start && range.start < end && range.div) matched.add(range.div);
            }
            offset = start + Math.max(1, needle.length);
        }
        return [...matched];
    }

    function snippetsForDocument() {
        return SourceUtils.pdfSnippetsForDocument(sessionSnippets, sourceUrl);
    }

    function snippetsForPage(pageNumber) {
        return snippetsForDocument().filter((snippet) => {
            const page = SourceUtils.pdfPageNumber(snippet.sourcePageNumber);
            return !page || page === pageNumber;
        });
    }

    function clearRenderedHighlights() {
        for (const data of renderedPages.values()) {
            for (const div of data.textDivs || []) {
                div.classList.remove('weft-pdf-highlight', 'is-focused');
                delete div.dataset.weftSnippetIds;
            }
        }
    }

    function applyPageHighlights(pageNumber, textItems, textDivs, textItemData = []) {
        for (const snippet of snippetsForPage(pageNumber)) {
            for (const div of matchingTextDivs(textItems, textDivs, textItemData, snippet.content)) {
                div.classList.add('weft-pdf-highlight');
                const ids = new Set(String(div.dataset.weftSnippetIds || '').split(',').filter(Boolean));
                ids.add(snippet.id);
                div.dataset.weftSnippetIds = [...ids].join(',');
            }
        }
    }

    function reapplyHighlights() {
        clearRenderedHighlights();
        for (const [pageNumber, data] of renderedPages.entries()) {
            applyPageHighlights(pageNumber, data.textItems, data.textDivs, data.textItemData);
        }
    }

    function renderSnippetList() {
        const snippets = snippetsForDocument();
        snippetCount.textContent = String(snippets.length);
        snippetList.innerHTML = '';
        if (snippets.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'snippet-empty';
            empty.textContent = message(
                'pdf_viewer_no_annotations',
                'This Session has no snippets from this PDF yet. Select text in the document to save one.'
            );
            snippetList.appendChild(empty);
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const snippet of snippets) {
            const page = SourceUtils.pdfPageNumber(snippet.sourcePageNumber);
            const pageIsUsable = Boolean(page && (!pdfDocument || page <= pdfDocument.numPages));
            const card = document.createElement('button');
            card.type = 'button';
            card.className = `snippet-card${pageIsUsable ? ' is-located' : ''}`;
            card.dataset.snippetId = snippet.id;
            const pageElement = document.createElement('div');
            pageElement.className = 'snippet-card-page';
            pageElement.textContent = pageIsUsable
                ? pageLabel(page)
                : message('pdf_viewer_locating_page', 'Locating page…');
            const text = document.createElement('div');
            text.className = 'snippet-card-text';
            text.textContent = snippet.content;
            card.append(pageElement, text);
            card.addEventListener('click', async () => {
                const targetPage = SourceUtils.pdfPageNumber(snippet.sourcePageNumber);
                if (!targetPage || !pdfDocument || targetPage > pdfDocument.numPages) {
                    showToast(message('pdf_viewer_page_not_found', 'The exact page has not been identified yet.'));
                    return;
                }
                scrollToPage(targetPage);
                const data = await renderPage(targetPage);
                if (!data) return;
                for (const div of data.textDivs || []) {
                    const ids = String(div.dataset.weftSnippetIds || '').split(',');
                    if (ids.includes(snippet.id)) div.classList.add('is-focused');
                }
                setTimeout(() => {
                    for (const div of data.textDivs || []) div.classList.remove('is-focused');
                }, 1800);
            });
            fragment.appendChild(card);
        }
        snippetList.appendChild(fragment);
    }

    async function loadSession(name, { locateUnknown = true } = {}) {
        const generation = ++sessionLoadGeneration;
        const sessions = await Store.getSessions();
        const names = Object.keys(sessions);
        const storedCurrent = names.length > 0 ? await Store.getCurrentSession() : '';
        if (generation !== sessionLoadGeneration) return;
        currentSession = names.includes(name)
            ? name
            : names.includes(currentSession)
                ? currentSession
                : names.includes(requestedSession)
                    ? requestedSession
                    : storedCurrent || names[0] || '';
        sessionSelect.innerHTML = '';
        for (const sessionName of names) {
            const option = document.createElement('option');
            option.value = sessionName;
            option.textContent = sessionName;
            sessionSelect.appendChild(option);
        }
        sessionSelect.disabled = names.length === 0;
        if (currentSession) sessionSelect.value = currentSession;
        sessionSnippets = currentSession && Array.isArray(sessions[currentSession])
            ? sessions[currentSession]
            : [];
        renderSnippetList();
        reapplyHighlights();
        if (pdfDocument && locateUnknown) requestUnknownPageLocation();
    }

    function pageElement(pageNumber) {
        return pdfPages.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
    }

    function refreshPageOffsets() {
        pageOffsets = Array.from(pdfPages.children, (element) => element.offsetTop);
    }

    function schedulePageOffsetsRefresh() {
        if (pageOffsetFrame !== null) return;
        pageOffsetFrame = requestAnimationFrame(() => {
            pageOffsetFrame = null;
            refreshPageOffsets();
            updateCurrentPage();
        });
    }

    function updateCurrentPage() {
        if (!pdfDocument) return;
        if (pageOffsets.length !== pdfDocument.numPages) refreshPageOffsets();
        const target = pdfScroll.scrollTop + 18;
        let low = 0;
        let high = pageOffsets.length - 1;
        let found = 0;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (pageOffsets[middle] <= target) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        currentPage = Math.max(1, Math.min(pdfDocument.numPages, found + 1));
        pageInput.value = String(currentPage);
    }

    function scheduleCurrentPageUpdate() {
        if (pagePositionFrame !== null) return;
        pagePositionFrame = requestAnimationFrame(() => {
            pagePositionFrame = null;
            updateCurrentPage();
        });
    }

    function scrollToPage(pageNumber) {
        if (!pdfDocument) return;
        const page = Math.max(1, Math.min(pdfDocument.numPages, Number(pageNumber) || 1));
        const element = pageElement(page);
        if (element) element.scrollIntoView({ block: 'start', behavior: 'smooth' });
        currentPage = page;
        pageInput.value = String(page);
    }

    function disposeRenderedPages() {
        for (const data of renderedPages.values()) {
            cancelPageState(data);
            try { data.page?.cleanup?.(); } catch {}
        }
        for (const data of renderingPages.values()) {
            cancelPageState(data);
            try { data.page?.cleanup?.(); } catch {}
        }
        renderedPages.clear();
        renderingPages.clear();
    }

    function destroyPdfRuntime() {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            renderGeneration++;
            pageObserver?.disconnect();
            disposeRenderedPages();
            window.cancelAnimationFrame(pageOffsetFrame);
            pageOffsetFrame = null;
            pageOffsets = [];
            const task = loadingTask;
            const worker = pdfWorker;
            const port = workerPort;
            loadingTask = null;
            pdfWorker = null;
            workerPort = null;
            pdfDocument = null;
            let forceTerminateTimer = null;
            if (port) {
                forceTerminateTimer = setTimeout(() => {
                    try { port.terminate?.(); } catch {}
                }, 1500);
            }
            const boundedCleanup = async (callback) => {
                let timer = null;
                try {
                    await Promise.race([
                        Promise.resolve().then(callback).catch(() => {}),
                        new Promise((resolve) => { timer = setTimeout(resolve, 1600); }),
                    ]);
                } finally {
                    clearTimeout(timer);
                }
            };
            await boundedCleanup(() => task?.destroy?.());
            await boundedCleanup(() => worker?.destroy?.());
            if (forceTerminateTimer) clearTimeout(forceTerminateTimer);
            try { port?.terminate?.(); } catch {}
        })();
        return shutdownPromise;
    }

    function releaseRenderedPage(pageNumber) {
        const data = renderedPages.get(pageNumber);
        if (!data) return;
        cancelPageState(data);
        try { data.page?.cleanup?.(); } catch {}
        renderedPages.delete(pageNumber);
        const element = pageElement(pageNumber);
        if (!element) return;
        element.querySelectorAll('canvas,.textLayer').forEach((node) => node.remove());
        element.classList.remove('is-rendered', 'has-render-error');
        // Re-observing resets the intersection state so returning to an
        // evicted page schedules a fresh render.
        pageObserver?.unobserve(element);
        pageObserver?.observe(element);
    }

    function pruneRenderedPages(anchorPage) {
        if (renderedPages.size <= MAX_RENDERED_PAGES) return;
        const removable = [...renderedPages.keys()]
            .filter((page) => page !== anchorPage)
            .sort((left, right) => Math.abs(right - anchorPage) - Math.abs(left - anchorPage));
        while (renderedPages.size > MAX_RENDERED_PAGES && removable.length > 0) {
            releaseRenderedPage(removable.shift());
        }
    }

    function rebuildPagePlaceholders() {
        renderGeneration++;
        pageObserver?.disconnect();
        disposeRenderedPages();
        pdfPages.innerHTML = '';
        if (!pdfDocument) return;
        const placeholderBox = boundedPlaceholderBox(basePageSize.width * zoom, basePageSize.height * zoom);
        const { width, height } = placeholderBox;
        const fragment = document.createDocumentFragment();
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
            const element = document.createElement('section');
            element.className = 'pdf-page';
            element.dataset.pageNumber = String(pageNumber);
            element.style.width = `${width}px`;
            element.style.height = `${height}px`;
            element.style.setProperty('--scale-factor', String(zoom));
            const placeholder = document.createElement('div');
            placeholder.className = 'page-placeholder';
            placeholder.textContent = pageLabel(pageNumber);
            element.appendChild(placeholder);
            fragment.appendChild(element);
        }
        pdfPages.appendChild(fragment);
        refreshPageOffsets();
        const generation = renderGeneration;
        pageObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting || generation !== renderGeneration) continue;
                renderPage(Number(entry.target.dataset.pageNumber)).catch((error) => {
                    console.warn('[Weft] PDF page render failed:', error);
                });
            }
        }, { root: pdfScroll, rootMargin: '1200px 0px', threshold: 0.01 });
        for (const element of pdfPages.children) pageObserver.observe(element);
        requestAnimationFrame(() => scrollToPage(currentPage));
    }

    async function renderPage(pageNumber) {
        if (!pdfDocument || !Number.isInteger(pageNumber)) return null;
        if (renderedPages.has(pageNumber)) return renderedPages.get(pageNumber);
        if (renderingPages.has(pageNumber)) return renderingPages.get(pageNumber).promise;
        const generation = renderGeneration;
        const state = {
            promise: null,
            page: null,
            renderTask: null,
            textLayer: null,
            controller: new AbortController(),
        };
        state.promise = (async () => {
            const element = pageElement(pageNumber);
            if (!element) return null;
            element.classList.remove('has-render-error');
            const page = await waitForPageStage(
                () => pdfDocument.getPage(pageNumber),
                state,
                'load'
            );
            state.page = page;
            if (generation !== renderGeneration) {
                throw pageAbortError();
            }
            const viewport = page.getViewport({ scale: zoom });
            validatedPageViewport(viewport);
            element.style.width = `${Math.ceil(viewport.width)}px`;
            element.style.height = `${Math.ceil(viewport.height)}px`;
            element.style.setProperty('--scale-factor', String(zoom));
            schedulePageOffsetsRefresh();

            const canvas = document.createElement('canvas');
            const { outputScale, canvasWidth, canvasHeight } = boundedCanvasOutput(
                viewport,
                globalThis.devicePixelRatio
            );
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            canvas.style.width = `${Math.ceil(viewport.width)}px`;
            canvas.style.height = `${Math.ceil(viewport.height)}px`;
            element.appendChild(canvas);
            const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
            state.renderTask = page.render({ canvas, viewport, transform, background: '#ffffff' });
            await waitForPageStage(() => state.renderTask.promise, state, 'canvas render');
            const textContent = await waitForPageStage(() => page.getTextContent({
                includeMarkedContent: false,
                disableNormalization: false,
            }), state, 'text extraction');
            const sourceItems = validatedRenderTextItems(textContent)
                .filter((item) => typeof item?.str === 'string');
            if (generation !== renderGeneration) throw pageAbortError();
            const textContainer = document.createElement('div');
            textContainer.className = 'textLayer';
            element.appendChild(textContainer);
            state.textLayer = new pdfjs.TextLayer({
                textContentSource: textContent,
                container: textContainer,
                viewport,
            });
            await waitForPageStage(() => state.textLayer.render(), state, 'text layer render');
            if (generation !== renderGeneration) throw pageAbortError();
            const textItems = state.textLayer.textContentItemsStr || [];
            const textDivs = state.textLayer.textDivs || [];
            const textItemData = textItems.map((text, index) => ({
                ...(sourceItems[index] || {}),
                text,
            }));
            const result = {
                page,
                renderTask: state.renderTask,
                textLayer: state.textLayer,
                controller: state.controller,
                textItems,
                textDivs,
                textItemData,
            };
            renderedPages.set(pageNumber, result);
            applyPageHighlights(pageNumber, textItems, textDivs, textItemData);
            element.classList.add('is-rendered');
            pruneRenderedPages(pageNumber);
            return result;
        })().catch((error) => {
            cancelPageState(state, error instanceof Error ? error : pageAbortError());
            try { state.page?.cleanup?.(); } catch {}
            const cancelled = error?.name === 'AbortError' || error?.name === 'RenderingCancelledException';
            if (!cancelled && generation === renderGeneration && !viewerController.signal.aborted) {
                console.warn(`[Weft] PDF page ${pageNumber} could not be rendered:`, error);
                showPageError(pageNumber, error);
            }
            return null;
        }).finally(() => {
            if (renderingPages.get(pageNumber) === state) renderingPages.delete(pageNumber);
        });
        renderingPages.set(pageNumber, state);
        return state.promise;
    }

    function locateAbortError() {
        const error = new Error('PDF snippet location was cancelled.');
        error.name = 'AbortError';
        error.code = 'PDF_LOCATE_ABORTED';
        return error;
    }

    function startLocateBatchChain() {
        locateBatchChainRemaining = MAX_LOCATE_AUTO_BATCHES;
        locateBatchChainDeadline = Date.now() + LOCATE_CHAIN_TIMEOUT_MS;
    }

    function launchUnknownPageLocation() {
        Promise.resolve().then(() => locateUnknownSnippetPages()).catch((error) => {
            if (error?.name !== 'AbortError') console.warn('[Weft] PDF page location failed:', error);
        });
    }

    function requestUnknownPageLocation() {
        locateQueued = true;
        // Session mutations invalidate both the needle set and any matches
        // collected so far. Cancel promptly and let the finalizer restart once.
        locateController?.abort(locateAbortError());
        if (locatingUnknown) {
            locateRestartQueued = true;
            return;
        }
        if (!pdfDocument || viewerController.signal.aborted) return;
        locateRestartQueued = false;
        startLocateBatchChain();
        locateQueued = false;
        launchUnknownPageLocation();
    }

    function locateAttemptKey(snippet, needle) {
        return `${String(snippet?.id || '')}\u0000${needle}`;
    }

    function nextUnattemptedNeedleBatch(needleGroups, attemptedKeys, limit) {
        const pending = [];
        for (const [needle, snippets] of needleGroups.entries()) {
            const attemptKeys = snippets.map((snippet) => locateAttemptKey(snippet, needle));
            if (attemptKeys.every((key) => attemptedKeys.has(key))) continue;
            pending.push({ needle, snippets, attemptKeys, page: 0, ambiguous: false });
        }
        return {
            searches: pending.slice(0, Math.max(1, limit)),
            hasMore: pending.length > Math.max(1, limit),
        };
    }

    function ensureLocateAttemptContext(documentValue, sessionName) {
        if (locateAttemptDocument === documentValue && locateAttemptSession === sessionName) return;
        locateAttemptDocument = documentValue;
        locateAttemptSession = sessionName;
        locateAttemptedKeys = new Set();
    }

    function rememberLocatorStoragePatch(sessionName, patches) {
        const pages = new Map();
        for (const patch of patches) {
            const id = String(patch?.id || '');
            const page = SourceUtils.pdfPageNumber(patch?.changes?.sourcePageNumber);
            if (id && page) pages.set(id, page);
        }
        if (pages.size === 0) return null;
        const expectation = { sessionName, pages };
        locateStoragePatchExpectations.push(expectation);
        locateStoragePatchExpectations = locateStoragePatchExpectations.slice(-MAX_LOCATE_AUTO_BATCHES);
        clearTimeout(locateStoragePatchTimer);
        locateStoragePatchTimer = setTimeout(() => {
            locateStoragePatchExpectations = [];
            locateStoragePatchTimer = null;
        }, 5000);
        return expectation;
    }

    function forgetLocatorStoragePatch(expectation) {
        if (!expectation) return;
        locateStoragePatchExpectations = locateStoragePatchExpectations
            .filter((candidate) => candidate !== expectation);
    }

    function consumeExpectedLocatorStorageChange(sessions) {
        for (let index = 0; index < locateStoragePatchExpectations.length; index++) {
            const expectation = locateStoragePatchExpectations[index];
            const snippets = sessions?.[expectation.sessionName];
            if (!Array.isArray(snippets)) continue;
            const actualPages = new Map(snippets.map((snippet) => [
                String(snippet?.id || ''),
                SourceUtils.pdfPageNumber(snippet?.sourcePageNumber),
            ]));
            const matches = [...expectation.pages.entries()]
                .every(([id, page]) => actualPages.get(id) === page);
            if (!matches) continue;
            locateStoragePatchExpectations.splice(index, 1);
            if (locateStoragePatchExpectations.length === 0) {
                clearTimeout(locateStoragePatchTimer);
                locateStoragePatchTimer = null;
            }
            return true;
        }
        return false;
    }

    async function locateUnknownSnippetPages() {
        if (!pdfDocument || !currentSession || viewerController.signal.aborted) return;
        if (locatingUnknown) {
            requestUnknownPageLocation();
            return;
        }
        if (locateBatchChainRemaining <= 0 || Date.now() >= locateBatchChainDeadline) return;
        locateBatchChainRemaining--;
        const unknown = snippetsForDocument().filter((snippet) => {
            const page = SourceUtils.pdfPageNumber(snippet.sourcePageNumber);
            return !page || page > pdfDocument.numPages;
        });
        if (unknown.length === 0) return;

        // Deduplicate identical selections before scanning. Besides avoiding
        // repeated work, this places a hard ceiling on imported legacy data.
        const needleGroups = new Map();
        for (const snippet of unknown) {
            const needle = SourceUtils.normalizePdfSelectionText(snippet.content);
            if (needle.length < 2) continue;
            if (!needleGroups.has(needle)) needleGroups.set(needle, []);
            needleGroups.get(needle).push(snippet);
        }
        ensureLocateAttemptContext(pdfDocument, currentSession);
        const { searches, hasMore } = nextUnattemptedNeedleBatch(
            needleGroups,
            locateAttemptedKeys,
            MAX_LOCATE_UNIQUE_NEEDLES
        );
        if (searches.length === 0) return;

        locatingUnknown = true;
        const controller = new AbortController();
        locateController = controller;
        const sessionAtStart = currentSession;
        const documentAtStart = pdfDocument;
        let comparisons = 0;
        let scannedChars = 0;
        let scanComplete = true;
        const abortFromViewer = () => controller.abort(viewerAbortError());
        viewerController.signal.addEventListener('abort', abortFromViewer, { once: true });
        const batchDeadlineMs = Math.max(
            1,
            Math.min(LOCATE_TIMEOUT_MS, locateBatchChainDeadline - Date.now())
        );
        const deadlineTimer = setTimeout(() => controller.abort(locateAbortError()), batchDeadlineMs);
        try {
            for (let pageNumber = 1; pageNumber <= documentAtStart.numPages; pageNumber++) {
                if (
                    controller.signal.aborted || currentSession !== sessionAtStart ||
                    pdfDocument !== documentAtStart
                ) throw locateAbortError();
                if (pageNumber === 1 || pageNumber % 5 === 0) {
                    setStatus(message('pdf_viewer_locating_progress', 'Locating saved selections… %s/%t')
                        .replace('%s', String(pageNumber)).replace('%t', String(documentAtStart.numPages)));
                }
                let page = null;
                try {
                    const pagePromise = Promise.resolve(documentAtStart.getPage(pageNumber)).then((value) => {
                        if (controller.signal.aborted) {
                            try { value?.cleanup?.(); } catch {}
                            throw locateAbortError();
                        }
                        return value;
                    });
                    page = await waitWithSignal(
                        pagePromise,
                        controller.signal,
                        locateAbortError
                    );
                    const content = await waitWithSignal(page.getTextContent({
                        includeMarkedContent: false,
                        disableNormalization: false,
                    }), controller.signal, locateAbortError);
                    if (!Array.isArray(content?.items) || content.items.length > MAX_LOCATE_ITEMS_PER_PAGE) {
                        scanComplete = false;
                        break;
                    }
                    const pageText = canonicalPdfItemsText(content.items);
                    if (pageText.length > MAX_LOCATE_PAGE_CHARS) {
                        scanComplete = false;
                        break;
                    }
                    scannedChars += pageText.length;
                    if (scannedChars > MAX_LOCATE_TOTAL_CHARS) {
                        scanComplete = false;
                        break;
                    }
                    for (const search of searches) {
                        if (search.ambiguous) continue;
                        comparisons++;
                        if (comparisons > MAX_LOCATE_COMPARISONS) {
                            scanComplete = false;
                            break;
                        }
                        if (!pageText.includes(search.needle)) continue;
                        if (search.page) search.ambiguous = true;
                        else search.page = pageNumber;
                    }
                    if (!scanComplete) break;
                } finally {
                    try { page?.cleanup?.(); } catch {}
                }
                // Text normalization still happens on the UI thread. Yield so
                // scrolling and Session changes can cancel between pages.
                await waitWithSignal(
                    new Promise((resolve) => setTimeout(resolve, 0)),
                    controller.signal,
                    locateAbortError
                );
            }
            if (!scanComplete || controller.signal.aborted || currentSession !== sessionAtStart) return;
            for (const search of searches) {
                for (const key of search.attemptKeys) locateAttemptedKeys.add(key);
            }
            // Continue with the next deterministic batch. Failed/ambiguous
            // needles are remembered so the first 64 cannot starve later ones.
            if (
                hasMore && locateBatchChainRemaining > 0 &&
                Date.now() < locateBatchChainDeadline
            ) locateQueued = true;
            const patches = [];
            for (const search of searches) {
                if (!search.page || search.ambiguous) continue;
                for (const snippet of search.snippets) {
                    patches.push({
                        id: snippet.id,
                        changes: {
                            sourceDocumentType: 'pdf',
                            sourcePageNumber: search.page,
                        },
                    });
                }
            }
            let updated = 0;
            if (patches.length > 0 && currentSession === sessionAtStart) {
                const expectation = rememberLocatorStoragePatch(sessionAtStart, patches);
                try {
                    updated = await Store.updateSnippets(sessionAtStart, patches);
                } catch (error) {
                    forgetLocatorStoragePatch(expectation);
                    throw error;
                }
                if (updated <= 0) forgetLocatorStoragePatch(expectation);
            }
            if (updated > 0 && currentSession === sessionAtStart) {
                // The writer refreshes its own in-memory view without turning
                // the resulting storage event into a fresh locator chain.
                await loadSession(sessionAtStart, { locateUnknown: false });
                showToast(message('pdf_viewer_pages_resolved', 'Located %s saved selection(s).').replace('%s', updated));
            }
        } catch (error) {
            if (error?.name !== 'AbortError') throw error;
        } finally {
            clearTimeout(deadlineTimer);
            viewerController.signal.removeEventListener('abort', abortFromViewer);
            if (locateController === controller) locateController = null;
            locatingUnknown = false;
            if (pdfDocument) setStatus(message('pdf_viewer_ready', 'Ready'));
            if (locateRestartQueued && pdfDocument && !viewerController.signal.aborted) {
                locateRestartQueued = false;
                locateQueued = false;
                startLocateBatchChain();
                launchUnknownPageLocation();
            } else if (
                locateQueued && locateBatchChainRemaining > 0 &&
                Date.now() < locateBatchChainDeadline &&
                pdfDocument && !viewerController.signal.aborted
            ) {
                locateQueued = false;
                launchUnknownPageLocation();
            } else {
                locateQueued = false;
            }
        }
    }

    function startLoadDeadline() {
        clearTimeout(loadDeadlineTimer);
        loadDeadlineTimer = setTimeout(() => {
            if (viewerController.signal.aborted) return;
            viewerTimedOut = true;
            const error = viewerAbortError();
            viewerController.abort(error);
            destroyPdfRuntime().catch(() => {});
        }, VIEWER_LOAD_TIMEOUT_MS);
    }

    function clearLoadDeadline() {
        clearTimeout(loadDeadlineTimer);
        loadDeadlineTimer = null;
    }

    async function loadPdf() {
        if (!sourceUrl) {
            fail({ code: 'PDF_UNSUPPORTED_URL' });
            return;
        }
        startLoadDeadline();
        documentTitle.textContent = requestedTitle || sourceUrl;
        setStatus(message('pdf_viewer_downloading', 'Downloading PDF…'));
        try {
            const downloaded = await PDFExtractor.fetchBytesFromUrl(sourceUrl, {
                signal: viewerController.signal,
                onProgress(progress) {
                    if (progress.phase !== 'download') return;
                    const loaded = Math.round((progress.loaded || 0) / 1024 / 1024 * 10) / 10;
                    setStatus(message('pdf_viewer_download_progress', 'Downloading PDF… %s MB').replace('%s', loaded));
                },
            });
            throwIfViewerAborted();
            setStatus(message('pdf_viewer_opening', 'Opening PDF…'));
            pdfjs = await waitWithSignal(
                import(chrome.runtime.getURL('lib/vendor/pdfjs/pdf.min.mjs')),
                viewerController.signal
            );
            throwIfViewerAborted();
            const workerUrl = chrome.runtime.getURL('lib/vendor/pdfjs/pdf.worker.min.mjs');
            pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
            workerPort = new Worker(workerUrl, { type: 'module', name: 'weft-pdf-viewer' });
            pdfWorker = new pdfjs.PDFWorker({ port: workerPort, verbosity: 0 });
            await waitWithSignal(pdfWorker.promise, viewerController.signal);
            throwIfViewerAborted();
            const runtimeUrl = (path) => chrome.runtime.getURL(`lib/vendor/pdfjs/${path}`);
            loadingTask = pdfjs.getDocument({
                data: downloaded.bytes,
                docBaseUrl: downloaded.responseUrl,
                worker: pdfWorker,
                cMapUrl: runtimeUrl('cmaps/'),
                cMapPacked: true,
                standardFontDataUrl: runtimeUrl('standard_fonts/'),
                useSystemFonts: true,
                useWasm: false,
                useWorkerFetch: false,
                isEvalSupported: false,
                enableScripting: false,
                stopAtErrors: false,
                verbosity: 0,
            });
            pdfDocument = await waitWithSignal(loadingTask.promise, viewerController.signal);
            throwIfViewerAborted();
            if (!Number.isInteger(pdfDocument.numPages) || pdfDocument.numPages < 1) {
                const error = new Error('The PDF does not contain any pages.');
                error.code = 'PDF_EMPTY';
                throw error;
            }
            if (pdfDocument.numPages > MAX_PDF_PAGES) {
                const error = new Error('The PDF exceeds the viewer page limit.');
                error.code = 'PDF_TOO_MANY_PAGES';
                throw error;
            }
            const firstPage = await waitWithSignal(pdfDocument.getPage(1), viewerController.signal);
            try {
                const baseViewport = firstPage.getViewport({ scale: 1 });
                basePageSize = { width: baseViewport.width, height: baseViewport.height };
            } finally {
                try { firstPage.cleanup?.(); } catch {}
            }
            let metadataTitle = '';
            try {
                metadataTitle = (await waitWithSignal(
                    pdfDocument.getMetadata(),
                    viewerController.signal
                ))?.info?.Title || '';
            } catch (error) {
                if (viewerController.signal.aborted) throw error;
            }
            throwIfViewerAborted();
            const title = requestedTitle || String(metadataTitle || '').trim() || sourceUrl.split('/').pop() || sourceUrl;
            documentTitle.textContent = title;
            document.title = `${title} — ${message('pdf_viewer_title', 'Weft PDF Reader')}`;
            currentPage = Math.min(requestedPage, pdfDocument.numPages);
            pageInput.max = String(pdfDocument.numPages);
            pageCount.textContent = `/ ${pdfDocument.numPages}`;
            setStatus(message('pdf_viewer_ready', 'Ready'));
            renderSnippetList();
            rebuildPagePlaceholders();
            requestUnknownPageLocation();
        } finally {
            clearLoadDeadline();
        }
    }

    function selectionPage(range) {
        const startElement = range?.startContainer?.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range?.startContainer?.parentElement;
        const endElement = range?.endContainer?.nodeType === Node.ELEMENT_NODE
            ? range.endContainer
            : range?.endContainer?.parentElement;
        const startPage = SourceUtils.pdfPageNumber(startElement?.closest?.('.pdf-page')?.dataset?.pageNumber);
        const endPage = SourceUtils.pdfPageNumber(endElement?.closest?.('.pdf-page')?.dataset?.pageNumber);
        return startPage && startPage === endPage ? startPage : null;
    }

    function boundaryOffsetWithin(element, container, offset) {
        if (!element || !container || (element !== container && !element.contains(container))) return null;
        try {
            const probe = document.createRange();
            probe.selectNodeContents(element);
            probe.setEnd(container, offset);
            return probe.toString().length;
        } catch {
            return null;
        }
    }

    function textDivIndex(textDivs, container) {
        return textDivs.findIndex((div) => div === container || div.contains?.(container));
    }

    function canonicalSelectionText(range, pageNumber) {
        const data = renderedPages.get(pageNumber);
        if (!data) return '';
        const startIndex = textDivIndex(data.textDivs, range.startContainer);
        const endIndex = textDivIndex(data.textDivs, range.endContainer);
        if (startIndex < 0 || endIndex < startIndex) {
            return SourceUtils.joinPdfSelectionSegments([{ text: range.toString() }]);
        }
        const segments = [];
        for (let index = startIndex; index <= endIndex; index++) {
            const div = data.textDivs[index];
            const fullText = String(div?.textContent || data.textItems[index] || '');
            let start = 0;
            let end = fullText.length;
            if (index === startIndex) {
                start = boundaryOffsetWithin(div, range.startContainer, range.startOffset) ?? 0;
            }
            if (index === endIndex) {
                end = boundaryOffsetWithin(div, range.endContainer, range.endOffset) ?? end;
            }
            if (end <= start) continue;
            segments.push({
                ...(data.textItemData[index] || {}),
                text: fullText.slice(Math.max(0, start), Math.min(fullText.length, end)),
            });
        }
        return SourceUtils.joinPdfSelectionSegments(segments);
    }

    function capturePdfSelection() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
        const range = selection.getRangeAt(0);
        const pageNumber = selectionPage(range);
        if (!pageNumber || !pdfPages.contains(range.commonAncestorContainer)) return null;
        const text = canonicalSelectionText(range, pageNumber).slice(0, 100000);
        if (text.length < 2) return null;
        const rect = range.getBoundingClientRect();
        if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
        return {
            text,
            pageNumber,
            rect,
            sourceUrl,
            sourceTitle: documentTitle.textContent || requestedTitle,
        };
    }

    const selectionAssist = PDFSelectionAssist.create({
        root: pdfPages,
        scrollRoot: pdfScroll,
        capture: capturePdfSelection,
        message,
        async save(selection) {
            if (!currentSession) throw new Error('PDF_SESSION_REQUIRED');
            const result = await chrome.runtime.sendMessage({
                type: 'savePdfSelection',
                sessionName: currentSession,
                sourceUrl: selection.sourceUrl,
                sourceTitle: selection.sourceTitle,
                pageNumber: selection.pageNumber,
                text: selection.text,
            });
            if (!result?.ok) throw new Error(result?.error || 'PDF_SELECTION_SAVE_FAILED');
            await loadSession(result.session || currentSession);
            showToast(message('pdf_viewer_selection_saved', 'Selection saved to %s.')
                .replace('%s', result.session || currentSession));
        },
        async saveAnalysis(selection, answer) {
            const result = await chrome.runtime.sendMessage({
                type: 'saveQuickResult',
                selectedText: selection.text,
                result: answer,
                sourceUrl: selection.sourceUrl,
                sourceTitle: selection.sourceTitle,
                sourceDocumentType: 'pdf',
                sourcePageNumber: selection.pageNumber,
                sessionName: currentSession,
            });
            if (!result?.ok) throw new Error(result?.error || 'PDF_ANALYSIS_SAVE_FAILED');
            await loadSession(result.session || currentSession);
        },
        async ask(selection) {
            await chrome.storage.local.set({
                askAIContext: {
                    selectedText: selection.text,
                    question: '',
                    questionType: 'freeform',
                    label: '',
                    sourceUrl: selection.sourceUrl,
                    sourceTitle: selection.sourceTitle,
                    sourceDocumentType: 'pdf',
                    sourcePageNumber: selection.pageNumber,
                    timestamp: Date.now(),
                },
            });
            await chrome.runtime.sendMessage({ type: 'openChatAskAI' });
        },
        onError(error) {
            console.warn('[Weft] PDF selection action failed:', error);
            showToast(message('pdf_viewer_selection_failed', 'The selection action could not be completed.'));
        },
    });

    pdfScroll.addEventListener('scroll', scheduleCurrentPageUpdate, { passive: true });

    sessionSelect.addEventListener('change', async () => {
        locateController?.abort(locateAbortError());
        currentSession = sessionSelect.value;
        await Store.setCurrentSession(currentSession);
        await loadSession(currentSession);
    });
    toggleHighlights.addEventListener('click', () => {
        highlightsVisible = !highlightsVisible;
        document.body.classList.toggle('highlights-hidden', !highlightsVisible);
        toggleHighlights.classList.toggle('is-active', highlightsVisible);
        toggleHighlights.setAttribute('aria-pressed', String(highlightsVisible));
        toggleHighlights.textContent = message(
            highlightsVisible ? 'pdf_viewer_hide_highlights' : 'pdf_viewer_show_highlights',
            highlightsVisible ? 'Hide highlights' : 'Show highlights'
        );
    });
    openOriginal.addEventListener('click', () => {
        const target = SourceUtils.withPdfPage(sourceUrl, currentPage) || sourceUrl;
        if (target) chrome.tabs.create({ url: target });
    });
    zoomOut.addEventListener('click', () => {
        zoom = Math.max(0.6, Math.round((zoom - 0.2) * 10) / 10);
        zoomLabel.textContent = `${Math.round(zoom / 1.2 * 100)}%`;
        rebuildPagePlaceholders();
    });
    zoomIn.addEventListener('click', () => {
        zoom = Math.min(2.4, Math.round((zoom + 0.2) * 10) / 10);
        zoomLabel.textContent = `${Math.round(zoom / 1.2 * 100)}%`;
        rebuildPagePlaceholders();
    });
    pageInput.addEventListener('change', () => scrollToPage(Number(pageInput.value)));
    pageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') scrollToPage(Number(pageInput.value));
    });

    function onStorageChanged(changes, areaName) {
        if (areaName !== 'local' || (!changes.sessions && !changes.currentSession)) return;
        const locatorOwnPatch = changes.sessions && consumeExpectedLocatorStorageChange(
            changes.sessions.newValue
        );
        if (locatorOwnPatch && !changes.currentSession) return;
        clearTimeout(storageRefreshTimer);
        storageRefreshTimer = setTimeout(() => {
            const requested = typeof changes.currentSession?.newValue === 'string'
                ? changes.currentSession.newValue
                : currentSession;
            loadSession(requested).catch((error) => console.warn('[Weft] PDF Session refresh failed:', error));
        }, 80);
    }
    chrome.storage.onChanged.addListener(onStorageChanged);

    window.addEventListener('pagehide', () => {
        viewerDisposed = true;
        clearLoadDeadline();
        viewerController.abort(viewerAbortError());
        locateController?.abort(locateAbortError());
        selectionAssist.dispose();
        clearTimeout(storageRefreshTimer);
        clearTimeout(locateStoragePatchTimer);
        locateStoragePatchExpectations = [];
        window.cancelAnimationFrame(pagePositionFrame);
        window.cancelAnimationFrame(pageOffsetFrame);
        chrome.storage.onChanged.removeListener(onStorageChanged);
        destroyPdfRuntime().catch(() => {});
    }, { once: true });

    try {
        await loadSession(requestedSession);
        await loadPdf();
    } catch (error) {
        fail(error);
        await destroyPdfRuntime();
    }
});
