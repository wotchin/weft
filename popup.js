document.addEventListener('DOMContentLoaded', async () => {
    const sessionSelect = document.getElementById('sessionSelect');
    const sessionContent = document.getElementById('sessionContent');
    const sessionMeta = document.getElementById('sessionMeta');
    const snippetCount = document.getElementById('snippetCount');

    const searchInput = document.getElementById('searchInput');

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

    function displaySessionContent(sessionName) {
        sessionContent.innerHTML = '';
        const snippets = sessions[sessionName] || [];
        snippetCount.textContent = `${snippets.length} snippet${snippets.length !== 1 ? 's' : ''}`;

        if (snippets.length === 0) {
            sessionContent.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">+</div>
                    <p>No snippets yet.<br>Right-click to save text or links.</p>
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
                return content.includes(q) || tags.includes(q) || source.includes(q);
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

            // Content
            const contentDiv = document.createElement('div');
            contentDiv.className = 'snippet-content';
            contentDiv.textContent = snippet.content;
            item.appendChild(contentDiv);

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

            // Tags
            if (snippet.tags && snippet.tags.length > 0) {
                const tagsDiv = document.createElement('div');
                tagsDiv.className = 'snippet-tags';
                snippet.tags.forEach(tag => {
                    const tagEl = document.createElement('span');
                    tagEl.className = 'snippet-tag';
                    tagEl.textContent = tag;
                    tagsDiv.appendChild(tagEl);
                });
                meta.appendChild(tagsDiv);
            }

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
        const name = prompt('Enter new session name:');
        if (!name) return;
        if (sessions[name]) {
            alert('Session name already exists!');
            return;
        }
        sessions[name] = [];
        await chrome.storage.local.set({ sessions });
        populateSelect(name);
        displaySessionContent(name);
    });

    // Delete session
    document.getElementById('deleteSession').addEventListener('click', async () => {
        const selected = sessionSelect.value;
        if (selected === 'default') {
            alert('Cannot delete the default session.');
            return;
        }
        if (!confirm(`Delete session "${selected}"?`)) return;

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
            alert('Cannot rename the default session.');
            return;
        }
        const newName = prompt('Enter new name:', selected);
        if (!newName || newName === selected) return;
        if (sessions[newName]) {
            alert('Session name already exists!');
            return;
        }
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

    // Open settings
    document.getElementById('openSettings').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
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
