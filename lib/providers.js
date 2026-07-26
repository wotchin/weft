/**
 * Weft — Provider presets.
 *
 * Each provider maps to one of three protocol dialects:
 *   - 'openai'    : OpenAI-compatible /chat/completions (covers most vendors)
 *   - 'anthropic' : Anthropic /messages
 *   - 'builtin'   : Chrome built-in AI (Prompt API) — implemented in llm-client
 *
 * Default model names change often; treat them as editable hints in the UI,
 * never as hard-coded truth.
 */
/* exported PROVIDERS, getProvider */

const PROVIDERS = {
    openai: {
        label: 'OpenAI',
        dialect: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        needsKey: true,
    },
    anthropic: {
        label: 'Anthropic Claude',
        dialect: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-3-5-sonnet-latest',
        needsKey: true,
    },
    gemini: {
        label: 'Google Gemini',
        dialect: 'openai', // official OpenAI-compatible endpoint
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-1.5-flash',
        needsKey: true,
    },
    deepseek: {
        label: 'DeepSeek',
        dialect: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-chat',
        needsKey: true,
    },
    moonshot: {
        label: 'Moonshot (Kimi)',
        dialect: 'openai',
        baseUrl: 'https://api.moonshot.cn/v1',
        defaultModel: 'moonshot-v1-8k',
        needsKey: true,
    },
    ollama: {
        label: 'Ollama (local)',
        dialect: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        defaultModel: 'llama3.1',
        needsKey: false,
    },
    builtin: {
        label: 'Chrome Built-in AI',
        dialect: 'builtin',
        baseUrl: '',
        defaultModel: 'gemini-nano',
        needsKey: false,
    },
    custom: {
        label: 'Custom (OpenAI-compatible)',
        dialect: 'openai',
        baseUrl: '',
        defaultModel: '',
        needsKey: true,
    },
};

function getProvider(id) {
    return PROVIDERS[id] || PROVIDERS.custom;
}
