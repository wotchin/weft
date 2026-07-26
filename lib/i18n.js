/**
 * Weft — interface language and AI output language.
 *
 * One setting (`uiLanguage`) drives both:
 *   - the interface, when a matching bundle exists under _locales/
 *   - the language the model is asked to answer in
 *
 * chrome.i18n always follows the *browser* locale and cannot be overridden at
 * runtime, so when the user picks an explicit language we load that bundle
 * ourselves and read from it, falling back to chrome.i18n (then English).
 *
 * Call `await I18N.init()` before reading any string, then `I18N.apply()` to
 * fill in the DOM. `t(key)` is synchronous and safe once init() has resolved.
 */
/* exported I18N, t */

const I18N = (() => {
    'use strict';

    // Languages Weft can ask the model to answer in. `ui: true` means we also
    // ship an interface bundle; the rest fall back to English chrome.
    const LANGUAGES = [
        { code: 'auto',  label: 'Auto (follow browser)', ui: true },
        { code: 'en',    label: 'English',   name: 'English',            ui: true },
        { code: 'zh_CN', label: '简体中文',   name: 'Simplified Chinese', ui: true },
        { code: 'fr',    label: 'Français',  name: 'French' },
        { code: 'de',    label: 'Deutsch',   name: 'German' },
        { code: 'es',    label: 'Español',   name: 'Spanish' },
        { code: 'ja',    label: '日本語',     name: 'Japanese' },
        { code: 'ko',    label: '한국어',      name: 'Korean' },
        { code: 'pt',    label: 'Português', name: 'Portuguese' },
        { code: 'ru',    label: 'Русский',   name: 'Russian' },
    ];

    let override = null;   // parsed messages.json when an explicit UI bundle is loaded
    let setting = 'auto';  // raw stored preference
    let ready = false;

    async function readSetting() {
        try {
            const { uiLanguage } = await chrome.storage.local.get(['uiLanguage']);
            return uiLanguage || 'auto';
        } catch {
            return 'auto';
        }
    }

    /** Load the chosen interface bundle, if we ship one for it. */
    async function init() {
        setting = await readSetting();
        override = null;
        if (setting !== 'auto') {
            const entry = LANGUAGES.find((l) => l.code === setting);
            // Only 'ui: true' languages have a bundle; others keep English chrome.
            const bundle = entry && entry.ui ? setting : 'en';
            try {
                const res = await fetch(chrome.runtime.getURL(`_locales/${bundle}/messages.json`));
                override = await res.json();
            } catch {
                override = null;
            }
        }
        ready = true;
        return setting;
    }

    function get(key) {
        if (override && override[key] && override[key].message) return override[key].message;
        try { return chrome.i18n.getMessage(key) || ''; } catch { return ''; }
    }

    /** BCP-47-ish code actually in effect (resolves 'auto' against the browser). */
    function resolvedCode() {
        if (setting !== 'auto') return setting;
        try { return chrome.i18n.getUILanguage(); } catch { return 'en'; }
    }

    /** English name of the effective language, for use inside prompts. */
    function outputLanguageName() {
        const code = resolvedCode().toLowerCase().replace('_', '-');
        const base = code.split('-')[0];
        if (base === 'zh') {
            return /-(tw|hk|mo)$/.test(code) ? 'Traditional Chinese' : 'Simplified Chinese';
        }
        const hit = LANGUAGES.find((l) => l.code === base && l.name);
        return hit ? hit.name : 'English';
    }

    /**
     * Instruction appended to system prompts so answers come back in the
     * language the user picked, regardless of the source material's language.
     */
    function promptLanguageInstruction() {
        return `Write your response in ${outputLanguageName()}, regardless of the language of the source material.`;
    }

    function apply(root = document) {
        root.querySelectorAll('[data-i18n]').forEach((el) => {
            const msg = get(el.getAttribute('data-i18n'));
            if (msg) el.textContent = msg;
        });
        root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            const msg = get(el.getAttribute('data-i18n-placeholder'));
            if (msg) el.setAttribute('placeholder', msg);
        });
        root.querySelectorAll('[data-i18n-title]').forEach((el) => {
            const msg = get(el.getAttribute('data-i18n-title'));
            if (msg) el.setAttribute('title', msg);
        });
    }

    /** Convenience for pages that don't need to await anything else. */
    async function start(root) {
        await init();
        apply(root);
    }

    return {
        LANGUAGES, init, apply, start, get, resolvedCode,
        outputLanguageName, promptLanguageInstruction,
        get isReady() { return ready; },
    };
})();

function t(key) {
    return I18N.get(key) || key;
}
