#!/usr/bin/env node
/**
 * Copy the small, audited PDF.js runtime surface used by the extension into
 * lib/vendor. Chrome Web Store packages must not load executable code from a
 * CDN, and the extension zip intentionally excludes node_modules.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(root, 'node_modules', 'pdfjs-dist');
const targetRoot = join(root, 'lib', 'vendor', 'pdfjs');
const packageJsonPath = join(packageRoot, 'package.json');

if (!existsSync(packageJsonPath)) {
    throw new Error('pdfjs-dist is not installed. Run npm install first.');
}

const packageInfo = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const expectedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.['pdfjs-dist'];
if (!expectedVersion || packageInfo.version !== expectedVersion) {
    throw new Error(`Expected pdfjs-dist ${expectedVersion || '(missing)'}, found ${packageInfo.version}.`);
}

const files = [
    ['legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
    ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
    ['LICENSE', 'LICENSE'],
];
const directories = ['cmaps', 'standard_fonts'];

mkdirSync(targetRoot, { recursive: true });
for (const [source, destination] of files) {
    const sourcePath = join(packageRoot, source);
    if (!existsSync(sourcePath)) throw new Error(`Missing PDF.js runtime file: ${source}`);
    copyFileSync(sourcePath, join(targetRoot, destination));
}
for (const directory of directories) {
    const sourcePath = join(packageRoot, directory);
    if (!existsSync(sourcePath)) throw new Error(`Missing PDF.js runtime directory: ${directory}`);
    cpSync(sourcePath, join(targetRoot, directory), { recursive: true, force: true });
}
writeFileSync(join(targetRoot, 'VERSION'), `${packageInfo.version}\n`, 'utf8');

console.log(`Vendored PDF.js ${packageInfo.version} into ${relative(root, targetRoot)}`);
