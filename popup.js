document.addEventListener('DOMContentLoaded', async () => {
    const sessionSelect = document.getElementById('sessionSelect');
    const sessionContent = document.getElementById('sessionContent');
    const sessionMeta = document.getElementById('sessionMeta');
    const snippetCount = document.getElementById('snippetCount');

    const searchInput = document.getElementById('searchInput');

    // Custom modal elements
    const modalOverlay = document.getElementById('modalOverlay');
    const modalTitle = document.getElementById('modalTitle');
    const modalInput = document.getElementById('modalInput');
    const modalError = document.getElementById('modalError');
    const modalCancel = document.getElementById('modalCancel');
    const modalConfirm = document.getElementById('modalConfirm');
    const modalBody = document.getElementById('modalBody');

    // Reusable modal: returns Promise<string|null> for prompt, Promise<bool> for confirm
    function showModal({ title, placeholder = '', defaultValue = '', showInput = true, confirmText = 'OK', confirmClass = 'confirm', validate = null }) {
        return new Promise((resolve) => {
            modalTitle.textContent = title;
            modalError.textContent = '';
            modalConfirm.textContent = confirmText;
            modalConfirm.className = `modal-btn ${confirmClass}`;
            modalInput.style.display = showInput ? '' : 'none';

            if (showInput) {
                modalInput.value = defaultValue;
                modalInput.placeholder = placeholder;
            }

            modalOverlay.classList.remove('hidden');
            if (showInput) {
                setTimeout(() => { modalInput.focus(); modalInput.select(); }, 50);
            }

            function cleanup() {
                modalOverlay.classList.add('hidden');
                modalConfirm.removeEventListener('click', onConfirm);
                modalCancel.removeEventListener('click', onCancel);
                modalInput.removeEventListener('keydown', onKeydown);
                modalOverlay.removeEventListener('click', onBackdrop);
            }

            function onConfirm() {
                if (showInput) {
                    const val = modalInput.value.trim();
                    if (validate) {
                        const err = validate(val);
                        if (err) { modalError.textContent = err; return; }
                    }
                    cleanup();
                    resolve(val || null);
                } else {
                    cleanup();
                    resolve(true);
                }
            }

            function onCancel() { cleanup(); resolve(showInput ? null : false); }

            function onKeydown(e) {
                if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
                if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }

            function onBackdrop(e) {
                if (e.target === modalOverlay) onCancel();
            }

            modalConfirm.addEventListener('click', onConfirm);
            modalCancel.addEventListener('click', onCancel);
            if (showInput) modalInput.addEventListener('keydown', onKeydown);
            modalOverlay.addEventListener('click', onBackdrop);
        });
    }

    let sessions = {};
    let searchQuery = '';

    async function loadSessions() {
        const data = await chrome.storage.local.get(['sessions']);
        sessions = data.sessions || {};
        if (Object.keys(sessions).length === 0) {
            sessions['default'] = [];
            await chrome.storage.local.set({ sessions });
        }
        return sessions;
    }

    function populateSelect(selectedName) {
        sessionSelect.innerHTML = '';
        Object.keys(sessions).forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            sessionSelect.appendChild(option);
        });
        if (selectedName && sessions[selectedName]) {
            sessionSelect.value = selectedName;
        }
    }

    function formatTime(timestamp) {
        const d = new Date(timestamp);
        const now = new Date();
        const diff = now - d;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return d.toLocaleDateString();
    }

    function extractDomain(url) {
        try {
            return new URL(url).hostname;
        } catch {
            return '';
        }
    }

    function showTagPicker(container, snippet, sessionName) {
        // Toggle: remove picker if already open
        const existing = container.querySelector('.tag-picker');
        if (existing) { existing.remove(); return; }

        const picker = document.createElement('div');
        picker.className = 'tag-picker';

        const presetTags = ['quote', 'data', 'opinion', 'reference', 'key-point'];
        presetTags.forEach(tag => {
            if (snippet.tags && snippet.tags.includes(tag)) return;
            const btn = document.createElement('button');
            btn.className = 'tag-picker-btn';
            btn.textContent = tag;
            btn.addEventListener('click', async () => {
                if (!snippet.tags) snippet.tags = [];
                snippet.tags.push(tag);
                await chrome.storage.local.set({ sessions });
                displaySessionContent(sessionName);
            });
            picker.appendChild(btn);
        });

        // Custom tag input
        const customInput = document.createElement('input');
        customInput.className = 'tag-custom-input';
        customInput.placeholder = 'custom...';
        customInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                const val = customInput.value.trim().toLowerCase();
                if (val && !(snippet.tags || []).includes(val)) {
                    if (!snippet.tags) snippet.tags = [];
                    snippet.tags.push(val);
                    await chrome.storage.local.set({ sessions });
                    displaySessionContent(sessionName);
                }
            }
        });
        picker.appendChild(customInput);
        container.appendChild(picker);
    }

    function displaySessionContent(sessionName) {
        sessionContent.innerHTML = '';
        const snippets = sessions[sessionName] || [];
        snippetCount.textContent = `${snippets.length} snippet${snippets.length !== 1 ? 's' : ''}`;

        if (snippets.length === 0) {
            sessionContent.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">+</div>
                    <p>No snippets yet.<br>Right-click to save text, links, or images.</p>
                </div>`;
            return;
        }

        // Filter by search query
        let filtered = snippets.map((s, i) => ({ snippet: s, index: i }));
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            filtered = filtered.filter(({ snippet }) => {
                const content = (snippet.content || '').toLowerCase();
                const tags = (snippet.tags || []).join(' ').toLowerCase();
                const source = (snippet.sourceTitle || '').toLowerCase();
                const imageUrl = (snippet.imageUrl || '').toLowerCase();
                return content.includes(q) || tags.includes(q) || source.includes(q) || imageUrl.includes(q);
            });
        }

        // Show newest first
        filtered.reverse().forEach(({ snippet, index: realIndex }) => {
            const item = document.createElement('div');
            item.className = 'snippet-item';
            item.draggable = true;
            item.dataset.index = realIndex;

            // Type badge
            const badge = document.createElement('span');
            badge.className = `snippet-type-badge ${snippet.type || 'text'}`;
            badge.textContent = snippet.type || 'text';
            item.appendChild(badge);

            // Content: image or text
            if (snippet.type === 'image') {
                const imgContainer = document.createElement('div');
                imgContainer.className = 'snippet-image-container';

                const img = document.createElement('img');
                img.className = 'snippet-image';
                // 优先使用缓存的 base64（防止反盗链），否则用原始 URL
                img.src = snippet.cachedDataUrl || snippet.imageUrl || '';
                img.alt = snippet.sourceTitle || 'Saved image';
                img.loading = 'lazy';
                // 如果缓存版本加载失败，回退到原始 URL
                if (snippet.cachedDataUrl) {
                    img.addEventListener('error', () => {
                        if (snippet.imageUrl && img.src !== snippet.imageUrl) {
                            img.src = snippet.imageUrl;
                        }
                    }, { once: true });
                }
                // 点击图片在新标签页打开原图
                img.style.cursor = 'pointer';
                img.addEventListener('click', () => {
                    chrome.tabs.create({ url: snippet.imageUrl || snippet.cachedDataUrl });
                });
                imgContainer.appendChild(img);

                // 显示原始图片 URL
                const urlLabel = document.createElement('div');
                urlLabel.className = 'snippet-image-url';
                urlLabel.textContent = snippet.imageUrl || '';
                urlLabel.title = snippet.imageUrl || '';
                imgContainer.appendChild(urlLabel);

                item.appendChild(imgContainer);
            } else {
                const contentDiv = document.createElement('div');
                contentDiv.className = 'snippet-content';
                contentDiv.textContent = snippet.content;
                item.appendChild(contentDiv);
            }

            // Link URL if applicable
            if (snippet.linkUrl) {
                const link = document.createElement('a');
                link.className = 'snippet-link';
                link.href = snippet.linkUrl;
                link.textContent = snippet.linkUrl;
                link.target = '_blank';
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    chrome.tabs.create({ url: snippet.linkUrl });
                });
                item.appendChild(link);
            }

            // Meta row
            const meta = document.createElement('div');
            meta.className = 'snippet-meta';

            if (snippet.timestamp) {
                const time = document.createElement('span');
                time.textContent = formatTime(snippet.timestamp);
                meta.appendChild(time);
            }

            if (snippet.sourceUrl) {
                const source = document.createElement('span');
                source.className = 'snippet-source';
                source.textContent = extractDomain(snippet.sourceUrl);
                source.title = snippet.sourceTitle || snippet.sourceUrl;
                meta.appendChild(source);
            }

            // Tags (interactive: click to remove, + to add)
            const tagsContainer = document.createElement('div');
            tagsContainer.className = 'snippet-tags-container';

            if (snippet.tags && snippet.tags.length > 0) {
                snippet.tags.forEach((tag, tagIndex) => {
                    const tagEl = document.createElement('span');
                    tagEl.className = 'snippet-tag';
                    tagEl.textContent = tag;
                    tagEl.title = 'Click to remove';
                    tagEl.addEventListener('click', async () => {
                        snippet.tags.splice(tagIndex, 1);
                        await chrome.storage.local.set({ sessions });
                        displaySessionContent(sessionName);
                    });
                    tagsContainer.appendChild(tagEl);
                });
            }

            const addTagBtn = document.createElement('span');
            addTagBtn.className = 'snippet-tag add-tag-btn';
            addTagBtn.textContent = '+';
            addTagBtn.title = 'Add tag';
            addTagBtn.addEventListener('click', () => {
                showTagPicker(tagsContainer, snippet, sessionName);
            });
            tagsContainer.appendChild(addTagBtn);
            meta.appendChild(tagsContainer);

            item.appendChild(meta);

            // Action buttons
            const actions = document.createElement('div');
            actions.className = 'snippet-actions';

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'snippet-action-btn';
            deleteBtn.textContent = 'Del';
            deleteBtn.title = 'Delete snippet';
            deleteBtn.addEventListener('click', async () => {
                snippets.splice(realIndex, 1);
                await chrome.storage.local.set({ sessions });
                displaySessionContent(sessionName);
            });
            actions.appendChild(deleteBtn);

            item.appendChild(actions);
            sessionContent.appendChild(item);
        });

        // Drag and drop handlers
        setupDragAndDrop(sessionName, snippets);
    }

    function setupDragAndDrop(sessionName, snippets) {
        let dragSrcIndex = null;

        sessionContent.querySelectorAll('.snippet-item').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                dragSrcIndex = parseInt(item.dataset.index);
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                sessionContent.querySelectorAll('.snippet-item').forEach(el => {
                    el.classList.remove('drag-over');
                });
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                item.classList.add('drag-over');
            });

            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over');
            });

            item.addEventListener('drop', async (e) => {
                e.preventDefault();
                const targetIndex = parseInt(item.dataset.index);
                if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;

                // Move snippet
                const [moved] = snippets.splice(dragSrcIndex, 1);
                snippets.splice(targetIndex, 0, moved);
                await chrome.storage.local.set({ sessions });
                displaySessionContent(sessionName);
            });
        });
    }

    // Search
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        const current = sessionSelect.value;
        if (sessions[current]) displaySessionContent(current);
    });

    // Init
    await loadSessions();
    populateSelect();

    const names = Object.keys(sessions);
    if (names.length > 0) {
        displaySessionContent(names[0]);
    }

    // Session change
    sessionSelect.addEventListener('change', () => {
        displaySessionContent(sessionSelect.value);
    });

    // New session
    document.getElementById('newSession').addEventListener('click', async () => {
        const name = await showModal({
            title: 'New Session',
            placeholder: 'Enter session name...',
            validate: (val) => {
                if (!val) return 'Session name cannot be empty.';
                if (sessions[val]) return 'Session name already exists.';
                return null;
            }
        });
        if (!name) return;
        sessions[name] = [];
        await chrome.storage.local.set({ sessions });
        populateSelect(name);
        displaySessionContent(name);
    });

    // Delete session
    document.getElementById('deleteSession').addEventListener('click', async () => {
        const selected = sessionSelect.value;
        if (selected === 'default') {
            await showModal({
                title: 'Cannot delete the default session.',
                showInput: false,
                confirmText: 'OK'
            });
            return;
        }
        const confirmed = await showModal({
            title: `Delete session "${selected}"?`,
            showInput: false,
            confirmText: 'Delete',
            confirmClass: 'danger'
        });
        if (!confirmed) return;

        delete sessions[selected];
        await chrome.storage.local.set({ sessions });
        populateSelect();
        const first = Object.keys(sessions)[0];
        if (first) displaySessionContent(first);
        else sessionContent.innerHTML = '';
    });

    // Rename session
    document.getElementById('renameSession').addEventListener('click', async () => {
        const selected = sessionSelect.value;
        if (selected === 'default') {
            await showModal({
                title: 'Cannot rename the default session.',
                showInput: false,
                confirmText: 'OK'
            });
            return;
        }
        const newName = await showModal({
            title: 'Rename Session',
            placeholder: 'Enter new name...',
            defaultValue: selected,
            validate: (val) => {
                if (!val) return 'Name cannot be empty.';
                if (val === selected) return null; // allow same name = cancel
                if (sessions[val]) return 'Session name already exists.';
                return null;
            }
        });
        if (!newName || newName === selected) return;
        sessions[newName] = sessions[selected];
        delete sessions[selected];
        await chrome.storage.local.set({ sessions });
        populateSelect(newName);
        displaySessionContent(newName);
    });

    // Open chat
    document.getElementById('openChat').addEventListener('click', () => {
        chrome.storage.local.set({ currentSession: sessionSelect.value }, () => {
            chrome.windows.create({
                url: chrome.runtime.getURL('chat.html'),
                type: 'popup',
                width: 900,
                height: 700,
                left: Math.round((screen.width - 900) / 2),
                top: Math.round((screen.height - 700) / 2)
            });
        });
    });

    // Open settings in a new tab
    document.getElementById('openSettings').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });

    // Listen for storage changes to refresh
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.sessions) {
            sessions = changes.sessions.newValue || {};
            const current = sessionSelect.value;
            populateSelect(current);
            if (sessions[current]) {
                displaySessionContent(current);
            }
        }
    });
});
