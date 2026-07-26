#!/usr/bin/env node
/**
 * Minimal manifest sanity check for CI.
 * - manifest.json is valid JSON
 * - required keys present
 * - every file referenced by the manifest actually exists
 * - version matches package.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => {
    console.error('✗ ' + msg);
    process.exitCode = 1;
};

let manifest;
try {
    manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
} catch (e) {
    fail('manifest.json is not valid JSON: ' + e.message);
    process.exit(1);
}

for (const key of ['manifest_version', 'name', 'version', 'background', 'action']) {
    if (!(key in manifest)) fail(`manifest missing required key: ${key}`);
}
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');

// Collect referenced files
const refs = new Set();
const add = (p) => p && refs.add(p);
add(manifest.background?.service_worker);
add(manifest.action?.default_popup);
add(manifest.options_page);
for (const cs of manifest.content_scripts || []) (cs.js || []).forEach(add);
for (const p of manifest.sandbox?.pages || []) add(p);
for (const size of Object.values(manifest.icons || {})) add(size);
for (const size of Object.values(manifest.action?.default_icon || {})) add(size);

for (const ref of refs) {
    if (!existsSync(join(root, ref))) fail(`manifest references missing file: ${ref}`);
}

// Version consistency
try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.version !== manifest.version) {
        fail(`version mismatch: package.json ${pkg.version} vs manifest ${manifest.version}`);
    }
} catch {
    /* package.json optional */
}

if (!process.exitCode) console.log('✓ manifest OK (' + refs.size + ' referenced files present)');
