/**
 * Weft — shared footer bootstrap for popup, Workbench (side panel) and settings.
 *
 * Renders a consistent "about" footer across all three Weft surfaces:
 *   <project name> · <version> · repo link
 *   © <year> <holder> · <tagline>
 *
 * The version shown is manifest.version_name if present (e.g. "3.1.0-beta"),
 * falling back to manifest.version. The copyright year is generated at render
 * time, so it stays current without code changes. The tagline is a single
 * short, brand-affiliated slogan from the i18n bundle (footer_tagline) —
 * the full licence stays in the release zip's LICENSE file, not in the UI.
 *
 * Each HTML surface just drops in:
 *
 *   <footer class="weft-footer" id="weftFooter"></footer>
 *   <script src="lib/i18n.js"></script>
 *   <script src="lib/footer.js"></script>
 *
 * (i18n.js must load before footer.js.)
 */
/* exported WeftFooter */

const WeftFooter = (() => {
    'use strict';

    const REPO_URL = 'https://github.com/wotchin/weft';
    const COPYRIGHT_HOLDER = 'wotchin';
    const COPYRIGHT_TMPL = '© $1 $2';

    function manifestVersion() {
        try {
            return chrome.runtime.getManifest().version || '';
        } catch {
            return '';
        }
    }

    /** Prefer version_name (e.g. "3.1.0-beta") when present; fall back to version. */
    function manifestDisplayName() {
        try {
            const m = chrome.runtime.getManifest();
            return (m.version_name || m.version || '').toString();
        } catch {
            return '';
        }
    }

    function currentYear() {
        return String(new Date().getFullYear());
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function localized(key, fallback) {
        try {
            return (typeof I18N !== 'undefined' && I18N.get(key)) ||
                   (chrome.i18n && chrome.i18n.getMessage(key)) ||
                   fallback;
        } catch {
            return fallback;
        }
    }

    function applyVersion() {
        const version = manifestDisplayName() || manifestVersion();
        document.querySelectorAll('[data-weft-version]').forEach((el) => {
            el.textContent = version;
        });
        document.querySelectorAll('[data-weft-version-attr]').forEach((el) => {
            const attr = el.getAttribute('data-weft-version-attr') || 'title';
            const tmpl = localized('footer_version', 'Version $1');
            el.setAttribute(attr, tmpl.replace('$1', version));
        });
    }

    /**
     * Build a footer into the given root (defaults to the first
     * .weft-footer, or a dedicated #weftFooter). Safe to call before or
     * after I18N.apply(); it re-applies translations for the footer subtree.
     */
    function render(rootEl) {
        const root = rootEl ||
            document.querySelector('.weft-footer') ||
            document.getElementById('weftFooter');
        if (!root) return;

        const project = localized('footer_project', 'Weft');
        const repoText = localized('footer_repo_link_text', 'View on GitHub');
        const tagline = localized('footer_tagline', 'Weave knowledge into insight');
        const copyrightLine = COPYRIGHT_TMPL
            .replace('$1', currentYear())
            .replace('$2', COPYRIGHT_HOLDER);
        const versionTemplate = localized('footer_version', 'Version $1');
        const version = manifestDisplayName() || manifestVersion();
        const versionLabel = versionTemplate.includes('$1')
            ? versionTemplate.replace('$1', version)
            : `${versionTemplate} ${version}`.trim();
        const projectSafe = escapeHtml(project);
        const repoTextSafe = escapeHtml(repoText);
        const versionSafe = escapeHtml(version);
        const versionLabelSafe = escapeHtml(versionLabel);
        const taglineSafe = escapeHtml(tagline);
        const copyrightSafe = escapeHtml(copyrightLine);

        root.classList.add('weft-footer');
        root.innerHTML = `
            <div class="weft-footer-row">
                <span class="weft-footer-brand">
                    <span class="weft-footer-name">${projectSafe}</span>
                    <span class="weft-footer-sep" aria-hidden="true">·</span>
                    <span class="weft-footer-version" data-weft-version aria-label="${versionLabelSafe}">${versionSafe}</span>
                </span>
                <a class="weft-footer-link" href="${REPO_URL}" target="_blank" rel="noopener noreferrer"
                   title="${REPO_URL}">
                    <svg viewBox="0 0 24 24" aria-hidden="true" class="weft-footer-github">
                        <path fill="currentColor" d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C17 5 18 5.3 18 5.3c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/>
                    </svg>
                    <span>${repoTextSafe}</span>
                </a>
            </div>
            <div class="weft-footer-sub">
                <span class="weft-footer-copy">${copyrightSafe}</span>
                <span class="weft-footer-tagline">${taglineSafe}</span>
            </div>
        `;

        // Re-apply translations for the footer subtree in case this runs after
        // the page-level I18N.apply(); harmless if it runs before.
        try { if (typeof I18N !== 'undefined') I18N.apply(root); } catch { /* noop */ }
        applyVersion();
    }

    function init(root) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => render(root));
        } else {
            render(root);
        }
    }

    return { render, init, applyVersion };
})();

// Auto-init: render any footer present on the page once the DOM is ready.
WeftFooter.init();
