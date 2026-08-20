#!/usr/bin/env node
/** Build and validate the metadata used by the tag-driven release workflow. */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function getReleaseMetadata(manifest, tagName) {
    const version = String(manifest?.version || '').trim();
    const releaseVersion = String(manifest?.version_name || version).trim();
    const expectedTag = `v${releaseVersion}`;

    if (!version || !releaseVersion) throw new Error('manifest.json is missing version metadata.');
    if (tagName !== expectedTag) {
        throw new Error(
            `Tag '${tagName || '(missing)'}' does not match '${expectedTag}' ` +
                '(manifest.version_name, falling back to manifest.version).'
        );
    }

    return {
        version,
        releaseVersion,
        zip: `weft-${version}.zip`,
        // A suffix on the numeric Chrome version is the explicit prerelease
        // convention (for example 3.1.0-beta or 3.1.0-rc.1).
        isPrerelease: /^\d+(?:\.\d+){2,3}-[0-9A-Za-z]/.test(releaseVersion),
    };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
        const metadata = getReleaseMetadata(manifest, process.env.GITHUB_REF_NAME || process.argv[2]);
        const outputPath = process.env.GITHUB_OUTPUT || process.argv[3];
        if (!outputPath) throw new Error('GITHUB_OUTPUT is not set.');
        appendFileSync(
            outputPath,
            [
                `version=${metadata.version}`,
                `release_version=${metadata.releaseVersion}`,
                `zip=${metadata.zip}`,
                `is_prerelease=${metadata.isPrerelease}`,
                '',
            ].join('\n')
        );
    } catch (error) {
        console.error(`::error::${error.message}`);
        process.exitCode = 1;
    }
}
