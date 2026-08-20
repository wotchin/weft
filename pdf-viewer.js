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
    let sessionLoadGeneration = 0;
    let storageRefreshTimer = null;
    let pagePositionFrame = null;
    const viewerController = new AbortController();
    const MAX_RENDERED_PAGES = 12;
    const renderedPages = new Map();
    const renderingPages = new Map();

    function message(key, fallback) {
        const value = t(key);
        return value && value !== key ? value : fallback;
    }

    function setStatus(value) {
        viewerStatus.textContent = value || '';
    }

    function showToast(value) {
        viewerToast.textContent = value;
        viewerToast.classList.add('is-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => viewerToast.classList.remove('is-visible'), 2800);
    }

    function fail(error) {
        console.error('[Weft] PDF viewer failed:', error);
        viewerError.hidden = false;
        viewerError.textContent = message(
            'pdf_viewer_load_failed',
            'This PDF could not be opened in the Weft reader.'
        ) + (error?.code ? ` (${error.code})` : '');
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

    async function loadSession(name) {
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
        if (pdfDocument) locateUnknownSnippetPages().catch(() => {});
    }

    function pageElement(pageNumber) {
        return pdfPages.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
    }

    function updateCurrentPage() {
        if (!pdfDocument) return;
        const scrollTop = pdfScroll.scrollTop;
        let bestPage = currentPage;
        let bestDistance = Infinity;
        for (const element of pdfPages.children) {
            const distance = Math.abs(element.offsetTop - scrollTop - 18);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestPage = Number(element.dataset.pageNumber) || bestPage;
            }
        }
        currentPage = bestPage;
        pageInput.value = String(bestPage);
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
            try { data.renderTask?.cancel?.(); } catch {}
            try { data.textLayer?.cancel?.(); } catch {}
            try { data.page?.cleanup?.(); } catch {}
        }
        for (const data of renderingPages.values()) {
            try { data.renderTask?.cancel?.(); } catch {}
            try { data.textLayer?.cancel?.(); } catch {}
            try { data.page?.cleanup?.(); } catch {}
        }
        renderedPages.clear();
        renderingPages.clear();
    }

    function releaseRenderedPage(pageNumber) {
        const data = renderedPages.get(pageNumber);
        if (!data) return;
        try { data.renderTask?.cancel?.(); } catch {}
        try { data.textLayer?.cancel?.(); } catch {}
        try { data.page?.cleanup?.(); } catch {}
        renderedPages.delete(pageNumber);
        const element = pageElement(pageNumber);
        if (!element) return;
        element.querySelectorAll('canvas,.textLayer').forEach((node) => node.remove());
        element.classList.remove('is-rendered');
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
        const width = Math.round(basePageSize.width * zoom);
        const height = Math.round(basePageSize.height * zoom);
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
        const generation = renderGeneration;
        pageObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting || generation !== renderGeneration) continue;
                renderPage(Number(entry.target.dataset.pageNumber)).catch(fail);
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
        const state = { promise: null, page: null, renderTask: null, textLayer: null };
        state.promise = (async () => {
            const element = pageElement(pageNumber);
            if (!element) return null;
            const page = await pdfDocument.getPage(pageNumber);
            state.page = page;
            if (generation !== renderGeneration) {
                try { page.cleanup?.(); } catch {}
                return null;
            }
            const viewport = page.getViewport({ scale: zoom });
            element.style.width = `${Math.ceil(viewport.width)}px`;
            element.style.height = `${Math.ceil(viewport.height)}px`;
            element.style.setProperty('--scale-factor', String(zoom));

            const canvas = document.createElement('canvas');
            const outputScale = Math.min(Number(globalThis.devicePixelRatio) || 1, 2);
            canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
            canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
            canvas.style.width = `${Math.ceil(viewport.width)}px`;
            canvas.style.height = `${Math.ceil(viewport.height)}px`;
            element.appendChild(canvas);
            const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
            state.renderTask = page.render({ canvas, viewport, transform, background: '#ffffff' });

            const textContentPromise = page.getTextContent({
                includeMarkedContent: false,
                disableNormalization: false,
            });
            await state.renderTask.promise;
            const textContent = await textContentPromise;
            if (generation !== renderGeneration) return null;
            const textContainer = document.createElement('div');
            textContainer.className = 'textLayer';
            element.appendChild(textContainer);
            state.textLayer = new pdfjs.TextLayer({
                textContentSource: textContent,
                container: textContainer,
                viewport,
            });
            await state.textLayer.render();
            if (generation !== renderGeneration) return null;
            const textItems = state.textLayer.textContentItemsStr || [];
            const textDivs = state.textLayer.textDivs || [];
            const sourceItems = Array.isArray(textContent.items)
                ? textContent.items.filter((item) => typeof item?.str === 'string')
                : [];
            const textItemData = textItems.map((text, index) => ({
                ...(sourceItems[index] || {}),
                text,
            }));
            const result = {
                page,
                renderTask: state.renderTask,
                textLayer: state.textLayer,
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
            if (error?.name === 'RenderingCancelledException') return null;
            throw error;
        }).finally(() => {
            if (renderingPages.get(pageNumber) === state) renderingPages.delete(pageNumber);
        });
        renderingPages.set(pageNumber, state);
        return state.promise;
    }

    async function locateUnknownSnippetPages() {
        if (!pdfDocument || !currentSession) return;
        if (locatingUnknown) {
            locateQueued = true;
            return;
        }
        const unknown = snippetsForDocument().filter((snippet) => {
            const page = SourceUtils.pdfPageNumber(snippet.sourcePageNumber);
            return !page || page > pdfDocument.numPages;
        });
        if (unknown.length === 0) return;
        locatingUnknown = true;
        const sessionAtStart = currentSession;
        const matches = new Map(unknown.map((snippet) => [snippet.id, []]));
        const needles = new Map(unknown.map(
            (snippet) => [snippet.id, SourceUtils.normalizePdfSelectionText(snippet.content)]
        ));
        try {
            for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
                if (currentSession !== sessionAtStart) return;
                if (pageNumber === 1 || pageNumber % 5 === 0) {
                    setStatus(message('pdf_viewer_locating_progress', 'Locating saved selections… %s/%t')
                        .replace('%s', String(pageNumber)).replace('%t', String(pdfDocument.numPages)));
                }
                const page = await pdfDocument.getPage(pageNumber);
                const content = await page.getTextContent({
                    includeMarkedContent: false,
                    disableNormalization: false,
                });
                const pageText = canonicalPdfItemsText(content.items);
                for (const snippet of unknown) {
                    const needle = needles.get(snippet.id);
                    if (needle && pageText.includes(needle)) matches.get(snippet.id).push(pageNumber);
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            const patches = [];
            for (const snippet of unknown) {
                const pages = matches.get(snippet.id);
                if (pages.length !== 1 || currentSession !== sessionAtStart) continue;
                patches.push({
                    id: snippet.id,
                    changes: {
                        sourceDocumentType: 'pdf',
                        sourcePageNumber: pages[0],
                    },
                });
            }
            const updated = currentSession === sessionAtStart
                ? await Store.updateSnippets(sessionAtStart, patches)
                : 0;
            if (updated > 0 && currentSession === sessionAtStart) {
                await loadSession(sessionAtStart);
                showToast(message('pdf_viewer_pages_resolved', 'Located %s saved selection(s).').replace('%s', updated));
            }
        } finally {
            locatingUnknown = false;
            if (pdfDocument) setStatus(message('pdf_viewer_ready', 'Ready'));
            if (locateQueued) {
                locateQueued = false;
                Promise.resolve().then(() => locateUnknownSnippetPages().catch(() => {}));
            }
        }
    }

    async function loadPdf() {
        if (!sourceUrl) {
            fail({ code: 'PDF_UNSUPPORTED_URL' });
            return;
        }
        documentTitle.textContent = requestedTitle || sourceUrl;
        setStatus(message('pdf_viewer_downloading', 'Downloading PDF…'));
        const downloaded = await PDFExtractor.fetchBytesFromUrl(sourceUrl, {
            signal: viewerController.signal,
            onProgress(progress) {
                if (progress.phase !== 'download') return;
                const loaded = Math.round((progress.loaded || 0) / 1024 / 1024 * 10) / 10;
                setStatus(message('pdf_viewer_download_progress', 'Downloading PDF… %s MB').replace('%s', loaded));
            },
        });
        setStatus(message('pdf_viewer_opening', 'Opening PDF…'));
        pdfjs = await import(chrome.runtime.getURL('lib/vendor/pdfjs/pdf.min.mjs'));
        const workerUrl = chrome.runtime.getURL('lib/vendor/pdfjs/pdf.worker.min.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        workerPort = new Worker(workerUrl, { type: 'module', name: 'weft-pdf-viewer' });
        pdfWorker = new pdfjs.PDFWorker({ port: workerPort, verbosity: 0 });
        await pdfWorker.promise;
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
            stopAtErrors: false,
            verbosity: 0,
        });
        pdfDocument = await loadingTask.promise;
        if (!Number.isInteger(pdfDocument.numPages) || pdfDocument.numPages < 1) throw new Error('PDF_EMPTY');
        const firstPage = await pdfDocument.getPage(1);
        const baseViewport = firstPage.getViewport({ scale: 1 });
        basePageSize = { width: baseViewport.width, height: baseViewport.height };
        try { firstPage.cleanup?.(); } catch {}
        let metadataTitle = '';
        try { metadataTitle = (await pdfDocument.getMetadata())?.info?.Title || ''; } catch {}
        const title = requestedTitle || String(metadataTitle || '').trim() || sourceUrl.split('/').pop() || sourceUrl;
        documentTitle.textContent = title;
        document.title = `${title} — ${message('pdf_viewer_title', 'Weft PDF Reader')}`;
        currentPage = Math.min(requestedPage, pdfDocument.numPages);
        pageInput.max = String(pdfDocument.numPages);
        pageCount.textContent = `/ ${pdfDocument.numPages}`;
        setStatus(message('pdf_viewer_ready', 'Ready'));
        renderSnippetList();
        rebuildPagePlaceholders();
        locateUnknownSnippetPages().catch((error) => console.warn('[Weft] PDF page location failed:', error));
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
        viewerController.abort();
        selectionAssist.dispose();
        clearTimeout(storageRefreshTimer);
        window.cancelAnimationFrame(pagePositionFrame);
        chrome.storage.onChanged.removeListener(onStorageChanged);
        renderGeneration++;
        pageObserver?.disconnect();
        disposeRenderedPages();
        try { loadingTask?.destroy?.(); } catch {}
        try { pdfWorker?.destroy?.(); } catch {}
        try { workerPort?.terminate?.(); } catch {}
    }, { once: true });

    try {
        await loadSession(requestedSession);
        await loadPdf();
    } catch (error) {
        fail(error);
    }
});
