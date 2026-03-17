// Cyber Assistant - Lightweight in-page toast notification
// Injected as content script on all pages

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'showToast') {
        showToast(message.title, message.text);
        sendResponse({ ok: true });
    }
});

function showToast(title, text) {
    // Remove existing toast if present
    const existing = document.getElementById('cyber-assistant-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'cyber-assistant-toast';
    Object.assign(toast.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: '2147483647',
        background: '#323232',
        color: '#fff',
        padding: '10px 18px',
        borderRadius: '8px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        maxWidth: '320px',
        opacity: '0',
        transform: 'translateY(-8px)',
        transition: 'opacity 0.3s, transform 0.3s',
        lineHeight: '1.4',
        pointerEvents: 'none'
    });

    const titleEl = document.createElement('strong');
    titleEl.style.cssText = 'display:block;margin-bottom:2px;font-size:12px;opacity:0.85;';
    titleEl.textContent = title;

    const textEl = document.createElement('span');
    textEl.textContent = text;

    toast.appendChild(titleEl);
    toast.appendChild(textEl);
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    // Auto-remove after 2.5 seconds
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}
