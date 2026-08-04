#!/usr/bin/env node
/**
 * Cross-platform store-zip builder for Weft.
 *
 * Replaces scripts/pack.sh for environments without a system `zip`
 * (notably Windows without WSL). Uses only Node's built-ins — no deps.
 *
 *   node scripts/pack.mjs            # build weft-<version>.zip
 *
 * The file list comes from scripts/package-files.mjs --list, and we
 * always run --check first so a stray file can't reach users (and a real
 * runtime file can't silently go missing).
 */
import { writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import process from 'node:process';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';

// Run the allow-list coverage check — fail fast if anything drifted.
try {
    execSync('node scripts/package-files.mjs --check', { stdio: 'inherit', cwd: root });
} catch {
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipName = `weft-${version}.zip`;
const zipPath = join(root, zipName);

// List of entries from the allow-list (directories expand recursively).
const listRaw = execSync('node scripts/package-files.mjs --list', { cwd: root })
    .toString('utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

// Expand directories into concrete files; skip OS/IDE junk.
const JUNK = /\.(?:DS_Store|Thumbs\.db|desktop)$/i;
const files = [];
function walk(rel) {
    const abs = join(root, rel);
    const st = statSync(abs);
    if (st.isFile()) {
        if (!JUNK.test(rel)) files.push(rel);
        return;
    }
    if (!st.isDirectory()) return;
    for (const name of readdirSync(abs)) walk(posix.join(rel, name));
}
for (const entry of listRaw) walk(entry.replace(/\\/g, '/'));

if (!files.length) {
    console.error('✗ nothing to pack');
    process.exit(1);
}
// Stable ordering for reproducible builds.
files.sort();

// --- Minimal ZIP writer (store + per-file CRC32), no compression deps. -----
const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

const chunks = [];
const central = [];
let offset = 0;
const enc = new TextEncoder();
const fixedTime = (() => {
    // Deterministic DOS time/date for reproducible archives.
    const d = new Date(0);
    return {
        time: (((d.getHours()) << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1)) & 0xFFFF,
        date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
    };
})();

for (const rel of files) {
    const abs = join(root, rel);
    const raw = readFileSync(abs);
    const crc = crc32(raw);
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const data = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const nameBytes = enc.encode(rel.replace(/\\/g, '/'));

    // Local file header (signature 0x04034b50)
    const lh = new Uint8Array(30);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);            // version needed
    dv.setUint16(6, 0, true);             // flags
    dv.setUint16(8, method, true);
    dv.setUint16(10, fixedTime.time, true);
    dv.setUint16(12, fixedTime.date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);  // compressed size
    dv.setUint32(22, raw.length, true);   // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);            // extra length
    chunks.push(lh, nameBytes, data);

    // Central directory record
    const cd = new Uint8Array(46);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, fixedTime.time, true);
    cv.setUint16(14, fixedTime.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);            // extra
    cv.setUint16(32, 0, true);            // comment
    cv.setUint16(34, 0, true);            // disk number
    cv.setUint16(36, 0, true);            // internal attrs
    cv.setUint32(38, 0, true);            // external attrs
    cv.setUint32(42, offset, true);       // local header offset
    central.push(cd, nameBytes);

    offset += lh.length + nameBytes.length + data.length;
}

// Central directory + end-of-central-directory record
const cdStart = offset;
let cdSize = 0;
for (const c of central) cdSize += c.length;
const eocd = new Uint8Array(22);
const ev = new DataView(eocd.buffer);
ev.setUint32(0, 0x06054b50, true);
ev.setUint16(4, 0, true);
ev.setUint16(6, 0, true);
ev.setUint16(8, files.length, true);
ev.setUint16(10, files.length, true);
ev.setUint32(12, cdSize, true);
ev.setUint32(16, cdStart, true);
ev.setUint16(20, 0, true);

writeFileSync(zipPath, Buffer.concat([...chunks, ...central, eocd]));
const stat = statSync(zipPath);
console.log(`Built ${zipName} (${files.length} files, ${(stat.size / 1024).toFixed(1)} KiB)`);
