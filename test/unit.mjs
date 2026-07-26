/**
 * Weft — unit tests for the pure-logic modules.
 *
 * The extension has no build step, so modules are plain IIFEs that expect
 * browser globals. We load them into a Node `vm` context with minimal
 * chrome.storage / IndexedDB shims and assert on their behaviour.
 *
 * Run: npm test
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

const results = [];
const ok = (name, cond, extra = '') => results.push({ name, pass: !!cond, extra });

// ── Shims ───────────────────────────────────────────────────────────────
function makeContext() {
    const store = {};
    const chrome = {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) return { ...store };
                    const arr = Array.isArray(keys) ? keys : [keys];
                    const out = {};
                    for (const k of arr) if (k in store) out[k] = store[k];
                    return out;
                },
                async set(obj) { Object.assign(store, obj); },
                async remove(keys) {
                    const arr = Array.isArray(keys) ? keys : [keys];
                    for (const k of arr) delete store[k];
                },
            },
        },
        i18n: { getMessage: (k) => k },
    };
    const images = new Map();
    const WeftIDB = {
        async open() { return {}; },
        async put(_db, s, v) { if (s === 'images') images.set(v.id, v); },
        async get(_db, s, id) { return s === 'images' ? images.get(id) || null : null; },
        async delete(_db, s, id) { if (s === 'images') images.delete(id); },
    };
    // Pretend the provider replied with a well-formed but empty completion.
    const fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
            return { choices: [{ message: { content: '' } }], usage: {} };
        },
        async text() { return ''; },
    });
    const ctx = { chrome, console, WeftIDB, fetch, __store: store, __images: images };
    vm.createContext(ctx);
    return ctx;
}

function load(ctx, files, testSrc) {
    const src = files.map(read).join('\n;\n');
    return vm.runInContext(`${src}\n;\n${testSrc}`, ctx, { filename: 'weft-tests' });
}

// ── Tests ───────────────────────────────────────────────────────────────
const ctx = makeContext();

await load(
    ctx,
    ['lib/providers.js', 'lib/store.js', 'lib/llm-client.js', 'markdown.js', 'lib/citations.js'],
    `(async () => {
        globalThis.__run = async (report) => {
            const store = __store;

            // providers
            report('provider: openai dialect', getProvider('openai').dialect === 'openai');
            report('provider: anthropic dialect', getProvider('anthropic').dialect === 'anthropic');
            report('provider: unknown falls back to custom',
                getProvider('nope').label === PROVIDERS.custom.label);

            // migration: legacy flat LLM keys -> llmConfig, then removed
            Object.assign(store, {
                apiKey: 'sk-legacy', apiBaseUrl: 'https://x/v1',
                modelName: 'm1', temperature: 0.5, maxTokens: 1234,
            });
            // legacy inline image should move into IDB
            store.sessions = { S: [
                { id: 'img1', type: 'image', imageUrl: 'https://x/a.png',
                  cachedDataUrl: 'data:image/png;base64,AAAA' },
                { id: 'txt1', type: 'text', content: 'hi' },
            ]};

            await Store.migrate();

            report('migrate: schemaVersion set', store.schemaVersion === Store.SCHEMA_VERSION);
            report('migrate: llmConfig built', store.llmConfig && store.llmConfig.apiKey === 'sk-legacy');
            report('migrate: model mapped', store.llmConfig.model === 'm1');
            report('migrate: legacy keys dropped', !('apiKey' in store) && !('modelName' in store));
            const cfg = await Store.getLlmConfig();
            report('getLlmConfig: merged with defaults', cfg.provider === 'openai' && cfg.maxTokens === 1234);

            const s0 = (await Store.getSession('S'))[0];
            report('migrate: image moved out of storage.local',
                !('cachedDataUrl' in s0) && s0.hasCachedImage === true);
            report('migrate: image stored in IDB',
                __images.get('img1').dataUrl === 'data:image/png;base64,AAAA');
            report('resolveImage: reads back from IDB',
                (await Store.resolveImage(s0)) === 'data:image/png;base64,AAAA');

            // migration is idempotent
            const v = store.schemaVersion;
            await Store.migrate();
            report('migrate: idempotent', store.schemaVersion === v);

            // addSnippet offloads images, leaves text inline
            await Store.addSnippet('S', {
                id: 'img2', type: 'image', imageUrl: 'https://x/b.png',
                cachedDataUrl: 'data:image/png;base64,BBBB',
            });
            const s2 = (await Store.getSession('S')).find((x) => x.id === 'img2');
            report('addSnippet: image offloaded to IDB',
                !('cachedDataUrl' in s2) && s2.hasCachedImage === true &&
                __images.get('img2').dataUrl === 'data:image/png;base64,BBBB');
            report('addSnippet: text snippet stays inline',
                (await Store.getSession('S')).some((x) => x.id === 'txt1'));

            // removeSnippet drops the snippet and its cached image
            await Store.removeSnippet('S', 'img2');
            report('removeSnippet: snippet gone',
                !(await Store.getSession('S')).some((x) => x.id === 'img2'));
            report('removeSnippet: cached image gone', !__images.has('img2'));

            // citations
            const snips = [
                { id: 'a', type: 'text', content: 'Alpha', sourceTitle: 'Src A', sourceUrl: 'https://a' },
                { id: 'b', type: 'text', content: 'Beta',  sourceTitle: 'Src B', sourceUrl: 'https://b' },
            ];
            const { contextText, indexMap } = Citations.buildContext(snips);
            report('citations: context numbered [S1]/[S2]',
                /\\[S1\\]/.test(contextText) && /\\[S2\\]/.test(contextText));
            report('citations: indexMap maps to snippet ids',
                indexMap.S1.id === 'a' && indexMap.S2.id === 'b');
            const dec = Citations.decorate('one [S1] two [S2][S9].', indexMap);
            report('citations: known marker becomes a chip',
                /weft-cite/.test(dec) && /data-snippet-id="a"/.test(dec));
            report('citations: unknown marker left as text', /\\[S9\\]/.test(dec));
            report('citations: markers are not double-decorated',
                (dec.match(/weft-cite/g) || []).length === 2);

            // markdown
            const md = renderMarkdown('# Title\\n\\n- a\\n- b\\n\\n**bold**');
            report('markdown: heading, list and bold render',
                /<h1/.test(md) && /<li/.test(md) && /<strong/.test(md));

            // An empty model reply must raise a typed error, never resolve blank.
            let emptyErr = null;
            try {
                await LLMClient.chat([{ role: 'user', content: 'hi' }], {
                    stream: false,
                    config: { provider: 'openai', apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
                });
            } catch (e) { emptyErr = e; }
            report('llm: empty reply raises empty_response',
                emptyErr && emptyErr.kind === 'empty_response');
            report('llm: empty_response carries an actionable hint',
                emptyErr && /Max Tokens|reasoning/i.test(emptyErr.hint || ''));
        };
    })();`
);

await ctx.__run((name, cond, extra) => ok(name, cond, extra));

// ── Report ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
for (const r of results) {
    console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
