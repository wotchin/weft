#!/usr/bin/env node
/** Ensure the committed Mermaid runtime matches the exact development pin. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expected = pkg.devDependencies?.mermaid;
const vendorRoot = join(root, 'lib', 'vendor');
const bundlePath = join(vendorRoot, 'mermaid.min.js');
const licensePath = join(vendorRoot, 'mermaid.LICENSE');
const versionPath = join(vendorRoot, 'mermaid.VERSION');
const required = [bundlePath, licensePath, versionPath];

const missing = required.filter((path) => !existsSync(path));
if (missing.length) {
    console.error(
        `✗ Mermaid vendor files are missing: ${missing.map((path) => path.slice(vendorRoot.length + 1)).join(', ')}`
    );
    console.error('  Run: npm run vendor:mermaid');
    process.exit(1);
}

const actual = readFileSync(versionPath, 'utf8').trim();
if (!expected || actual !== expected) {
    console.error(
        `✗ Mermaid vendor version ${actual || '(missing)'} does not match package pin ${expected || '(missing)'}`
    );
    console.error('  Run: npm ci && npm run vendor:mermaid');
    process.exit(1);
}

const bundle = readFileSync(bundlePath);
const embeddedVersion = new RegExp(`version:["']${expected.replaceAll('.', '\\.')}["']`).test(bundle.toString('utf8'));
if (!embeddedVersion) {
    console.error(`✗ Mermaid bundle does not identify itself as ${expected}.`);
    process.exit(1);
}

// CI has node_modules after npm ci; byte comparison makes accidental/manual
// vendor edits fail while still allowing the validator to run in a clean
// extension source tree that contains only committed runtime files.
const installedBundlePath = join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
if (existsSync(installedBundlePath)) {
    const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
    if (digest(bundlePath) !== digest(installedBundlePath)) {
        console.error('✗ Vendored Mermaid bundle differs from the pinned npm package.');
        console.error('  Run: npm run vendor:mermaid');
        process.exit(1);
    }
}

console.log(`✓ Mermaid vendor runtime ${actual}`);
