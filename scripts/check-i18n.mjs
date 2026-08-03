import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const bundles = ['en', 'zh_CN'];

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function collectFiles(directory = root) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...collectFiles(absolute));
        else if (/\.(?:html|js)$/.test(entry.name) && !absolute.includes(`${path.sep}lib${path.sep}vendor${path.sep}`)) {
            files.push(absolute);
        }
    }
    return files;
}

function placeholders(message) {
    return [...message.matchAll(/%[A-Za-z]|\{\{[A-Za-z][A-Za-z0-9_]*\}\}|\$[A-Za-z][A-Za-z0-9_]*\$/g)]
        .map((match) => match[0])
        .sort();
}

const messages = Object.fromEntries(bundles.map((bundle) => [
    bundle,
    readJson(`_locales/${bundle}/messages.json`),
]));
const canonicalKeys = Object.keys(messages.en).sort();
const errors = [];

for (const bundle of bundles) {
    const keys = Object.keys(messages[bundle]).sort();
    if (JSON.stringify(keys) !== JSON.stringify(canonicalKeys)) {
        const missing = canonicalKeys.filter((key) => !keys.includes(key));
        const extra = keys.filter((key) => !canonicalKeys.includes(key));
        errors.push(`${bundle}: key mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
    }
    for (const [key, value] of Object.entries(messages[bundle])) {
        if (!value || typeof value.message !== 'string' || !value.message.trim()) {
            errors.push(`${bundle}.${key}: message must be a non-empty string`);
        }
    }
}

for (const key of canonicalKeys) {
    const enTokens = placeholders(messages.en[key].message);
    const zhTokens = placeholders(messages.zh_CN[key].message);
    if (JSON.stringify(enTokens) !== JSON.stringify(zhTokens)) {
        errors.push(`${key}: placeholder mismatch (${enTokens.join(' ')} vs ${zhTokens.join(' ')})`);
    }
}

const referenced = new Map();
function record(key, file) {
    if (!referenced.has(key)) referenced.set(key, new Set());
    referenced.get(key).add(path.relative(root, file));
}

for (const file of collectFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?=["']([^"']+)["']/g)) {
        record(match[1], file);
    }
    for (const match of source.matchAll(/\b(?:t|I18N\.get)\(\s*["']([^"']+)["']/g)) {
        record(match[1], file);
    }
    for (const match of source.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
        record(match[1], file);
    }
    // Some UI keys are selected through maps (for example an error kind to a
    // localized message) rather than passed directly to t(). Restrict this to
    // our established key namespaces so ordinary application strings do not
    // become false positives.
    for (const match of source.matchAll(/["']((?:action|card|cite|diagram|highlight|language|llm_error|menu|modal|notify|onboarding|popup|provider|quick|sc|search_plan|settings|smart_read|tag|tb|time|wb)_[a-z0-9_]+)["']/g)) {
        record(match[1], file);
    }
}

for (const [key, files] of referenced) {
    if (!messages.en[key] || !messages.zh_CN[key]) {
        errors.push(`${key}: referenced but missing from locale bundles (${[...files].join(', ')})`);
    }
}

const uiHtmlFiles = ['chat.html', 'settings.html', 'popup.html', 'onboarding.html'];
const languageNeutralPlaceholders = new Set([
    'sk-...', 'gpt-4o-mini', '2000', '0.7', '12000', 'key',
    'https://api.openai.com/v1', 'https://searx.example.com',
]);
for (const relativePath of uiHtmlFiles) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '');
    for (const match of source.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
        const [, tagName, attributes] = match;
        for (const [attribute, marker] of [
            ['title', 'data-i18n-title'],
            ['aria-label', 'data-i18n-aria-label'],
            ['placeholder', 'data-i18n-placeholder'],
        ]) {
            const value = new RegExp(`\\b${attribute}=["']([^"']+)["']`, 'i').exec(attributes)?.[1];
            if (!value || !/[A-Za-z]/.test(value) || attributes.includes(marker)) continue;
            if (attribute === 'placeholder' && languageNeutralPlaceholders.has(value)) continue;
            errors.push(`${relativePath}: <${tagName}> has a non-localized ${attribute}="${value}"`);
        }
    }
    for (const match of source.matchAll(/<(title|h1|h2|p|button|label|span|div|option)\b([^>]*)>([^<>]+)<\/\1>/gi)) {
        const [, tagName, attributes, rawText] = match;
        const visibleText = rawText.replace(/&[a-z0-9#]+;/gi, ' ').replace(/\s+/g, ' ').trim();
        if (!/[A-Za-z]/.test(visibleText) || attributes.includes('data-i18n')) continue;
        if (visibleText === 'Weft') continue;
        errors.push(`${relativePath}: <${tagName}> has non-localized text "${visibleText}"`);
    }
}

const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'chat.js'), 'utf8');
const contentAssistSource = fs.readFileSync(path.join(root, 'content-assist.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'settings.js'), 'utf8');
if (!backgroundSource.includes('changes.uiLanguage') || !backgroundSource.includes("type: 'uiLanguageChanged'")) {
    errors.push('background: language changes must rebuild/broadcast localized extension UI');
}
if (!chatSource.includes('changes.uiLanguage') || !chatSource.includes('refreshUiLanguage()')) {
    errors.push('workbench: language changes must refresh dynamic UI');
}
if (!contentAssistSource.includes("message.type === 'uiLanguageChanged'") || !contentAssistSource.includes('loadUiStrings()')) {
    errors.push('content assist: language changes must reload page-overlay strings');
}
if (!settingsSource.includes('refreshDynamicCopy()') || !settingsSource.includes('await I18N.init()')) {
    errors.push('settings: language changes must refresh dynamic options and statuses');
}
const searchPlanStart = chatSource.indexOf('async function generateSearchPlan');
const searchPlanEnd = chatSource.indexOf('function renderSearchPlan', searchPlanStart);
if (searchPlanStart < 0 || !chatSource.slice(searchPlanStart, searchPlanEnd).includes('I18N.promptLanguageInstruction()')) {
    errors.push('search plan: model-visible explanations must follow the selected language');
}

// Behavioral contract: an explicit Weft language must override an English
// browser locale, and every supported DOM attribute must be applied.
const applied = {
    text: { textContent: '', getAttribute: () => 'settings_save' },
    placeholder: {
        value: '', getAttribute: () => 'wb_input_placeholder',
        setAttribute: (_name, value) => { applied.placeholder.value = value; },
    },
    title: {
        value: '', getAttribute: () => 'wb_settings',
        setAttribute: (_name, value) => { applied.title.value = value; },
    },
    aria: {
        value: '', getAttribute: () => 'action_send',
        setAttribute: (_name, value) => { applied.aria.value = value; },
    },
};
const fakeDocument = {
    documentElement: { lang: 'en' },
    querySelectorAll(selector) {
        return ({
            '[data-i18n]': [applied.text],
            '[data-i18n-placeholder]': [applied.placeholder],
            '[data-i18n-title]': [applied.title],
            '[data-i18n-aria-label]': [applied.aria],
        })[selector] || [];
    },
};
const context = vm.createContext({
    chrome: {
        storage: { local: { get: async () => ({ uiLanguage: 'zh_CN' }) } },
        runtime: { getURL: (url) => url },
        i18n: {
            getMessage: (key) => messages.en[key]?.message || '',
            getUILanguage: () => 'en-US',
        },
    },
    fetch: async () => ({ json: async () => messages.zh_CN }),
    document: fakeDocument,
});
const i18nSource = fs.readFileSync(path.join(root, 'lib/i18n.js'), 'utf8');
vm.runInContext(`${i18nSource}\nglobalThis.__I18N_TEST__ = I18N;`, context);
await context.__I18N_TEST__.init();
context.__I18N_TEST__.apply(fakeDocument);
if (context.__I18N_TEST__.get('settings_save') !== messages.zh_CN.settings_save.message) {
    errors.push('explicit zh_CN did not override the English browser locale');
}
if (fakeDocument.documentElement.lang !== 'zh-CN') errors.push('document lang was not updated to zh-CN');
if (applied.text.textContent !== messages.zh_CN.settings_save.message) errors.push('data-i18n was not applied');
if (applied.placeholder.value !== messages.zh_CN.wb_input_placeholder.message) errors.push('localized placeholder was not applied');
if (applied.title.value !== messages.zh_CN.wb_settings.message) errors.push('localized title was not applied');
if (applied.aria.value !== messages.zh_CN.action_send.message) errors.push('localized aria-label was not applied');

if (errors.length) {
    console.error(`i18n check failed with ${errors.length} problem(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(`i18n check passed: ${canonicalKeys.length} symmetric keys, ${referenced.size} referenced keys.`);
