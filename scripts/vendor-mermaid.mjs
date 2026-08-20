#!/usr/bin/env node
/**
 * Copy the pinned Mermaid browser bundle into the extension.
 *
 * Chrome Web Store packages may not execute remotely hosted code, so Mermaid
 * is a development-only dependency and its audited browser bundle is committed
 * under lib/vendor. The extension never loads node_modules at runtime.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(root, 'node_modules', 'mermaid');
const packageJsonPath = join(packageRoot, 'package.json');
const targetRoot = join(root, 'lib', 'vendor');

if (!existsSync(packageJsonPath)) {
    throw new Error('Mermaid is not installed. Run npm ci (or npm install) first.');
}

const packageInfo = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const expectedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.mermaid;
if (!expectedVersion || packageInfo.version !== expectedVersion) {
    throw new Error(`Expected Mermaid ${expectedVersion || '(missing)'}, found ${packageInfo.version}.`);
}

const sourceBundle = join(packageRoot, 'dist', 'mermaid.min.js');
const sourceLicense = join(packageRoot, 'LICENSE');
if (!existsSync(sourceBundle) || !existsSync(sourceLicense)) {
    throw new Error('The installed Mermaid package is missing dist/mermaid.min.js or LICENSE.');
}

mkdirSync(targetRoot, { recursive: true });
copyFileSync(sourceBundle, join(targetRoot, 'mermaid.min.js'));
copyFileSync(sourceLicense, join(targetRoot, 'mermaid.LICENSE'));
writeFileSync(join(targetRoot, 'mermaid.VERSION'), `${packageInfo.version}\n`, 'utf8');

console.log(`Vendored Mermaid ${packageInfo.version} into ${relative(root, targetRoot)}`);
