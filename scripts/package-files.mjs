#!/usr/bin/env node
/**
 * Single source of truth for what goes into the Chrome Web Store zip.
 *
 * This is an allow-list, not a deny-list: a stray file in the repo root can
 * never leak into a published package. The trade-off is the opposite failure —
 * adding a real runtime file and forgetting to list it here — so `--check`
 * resolves everything the manifest and the HTML entry points actually load and
 * fails if any of it falls outside the list.
 *
 *   node scripts/package-files.mjs --list    # newline-separated zip inputs
 *   node scripts/package-files.mjs --check   # verify the list covers runtime deps
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, posix } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths shipped to users. Directories are included recursively.
 * LICENSE ships because AGPL-3.0 §4 requires conveying the licence text
 * together with the program.
 */
export const PACKAGE_PATHS = [
    'manifest.json',
    'LICENSE',
    'background.js',
    'content-assist.js',
    'markdown.js',
    'chat.html',
    'chat.js',
    'chat.css',
    'popup.html',
    'popup.js',
    'styles.css',
    'settings.html',
    'settings.js',
    'onboarding.html',
    'onboarding.js',
    'sandbox-mermaid.html',
    '_locales',
    'assets',
    'lib',
];

/** Is `ref` the allow-listed file itself, or inside an allow-listed directory? */
function isCovered(ref) {
    return PACKAGE_PATHS.some((entry) => ref === entry || ref.startsWith(entry + '/'));
}

/** Strip query strings and leading ./ or / so manifest and HTML refs compare equal. */
function normalize(ref) {
    return ref.split(/[?#]/)[0].replace(/^\.?\//, '');
}

/** Every local file the extension loads at runtime, resolved from its entry points. */
function runtimeRefs() {
    const refs = new Map(); // path -> where it was referenced from
    const note = (ref, from) => {
        if (!ref) return;
        const clean = normalize(ref);
        // Skip absolute URLs and data: URIs — only local files matter here.
        if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return;
        if (!refs.has(clean)) refs.set(clean, from);
    };

    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    note(manifest.background?.service_worker, 'manifest.background');
    note(manifest.action?.default_popup, 'manifest.action.default_popup');
    note(manifest.options_page, 'manifest.options_page');
    note(manifest.side_panel?.default_path, 'manifest.side_panel');
    for (const cs of manifest.content_scripts || []) (cs.js || []).forEach((p) => note(p, 'manifest.content_scripts'));
    for (const p of manifest.sandbox?.pages || []) note(p, 'manifest.sandbox');
    for (const p of Object.values(manifest.icons || {})) note(p, 'manifest.icons');
    for (const p of Object.values(manifest.action?.default_icon || {})) note(p, 'manifest.action.default_icon');

    // Follow the HTML entry points one level: their <script src> / <link href> /
    // <img src> are the rest of the runtime surface.
    for (const [ref, from] of [...refs]) {
        if (!ref.endsWith('.html')) continue;
        const abs = join(root, ref);
        if (!existsSync(abs)) continue;
        const html = readFileSync(abs, 'utf8');
        for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
            note(m[1], `${ref} (via ${from})`);
        }
    }
    return refs;
}

const mode = process.argv[2];

if (mode === '--list') {
    console.log(PACKAGE_PATHS.join('\n'));
} else if (mode === '--check') {
    const problems = [];

    for (const entry of PACKAGE_PATHS) {
        if (!existsSync(join(root, entry))) problems.push(`allow-listed path does not exist: ${entry}`);
    }

    for (const [ref, from] of runtimeRefs()) {
        const abs = join(root, ref);
        if (!existsSync(abs)) {
            problems.push(`referenced file is missing from the repo: ${ref}  (from ${from})`);
        } else if (statSync(abs).isFile() && !isCovered(posix.normalize(ref))) {
            problems.push(`runtime file is NOT in the package allow-list: ${ref}  (from ${from})`
                + `\n    → add it to PACKAGE_PATHS in scripts/package-files.mjs`);
        }
    }

    if (problems.length) {
        for (const p of problems) console.error('✗ ' + p);
        process.exit(1);
    }
    console.log(`✓ package allow-list covers every runtime reference (${PACKAGE_PATHS.length} entries)`);
} else {
    console.error('usage: package-files.mjs --list | --check');
    process.exit(2);
}
