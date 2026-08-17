#!/usr/bin/env node
/** Ensure the committed PDF.js runtime matches the exact development pin. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expected = pkg.devDependencies?.['pdfjs-dist'];
const vendorRoot = join(root, 'lib', 'vendor', 'pdfjs');
const required = [
    'pdf.min.mjs',
    'pdf.worker.min.mjs',
    'LICENSE',
    'VERSION',
    'cmaps/LICENSE',
    'standard_fonts/LICENSE_FOXIT',
    'standard_fonts/LICENSE_LIBERATION',
];

const missing = required.filter((path) => !existsSync(join(vendorRoot, path)));
if (missing.length) {
    console.error(`✗ PDF.js vendor files are missing: ${missing.join(', ')}`);
    console.error('  Run: npm run vendor:pdfjs');
    process.exit(1);
}

const actual = readFileSync(join(vendorRoot, 'VERSION'), 'utf8').trim();
if (!expected || actual !== expected) {
    console.error(
        `✗ PDF.js vendor version ${actual || '(missing)'} does not match package pin ${expected || '(missing)'}`
    );
    console.error('  Run: npm install && npm run vendor:pdfjs');
    process.exit(1);
}

console.log(`✓ PDF.js vendor runtime ${actual}`);
