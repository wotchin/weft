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
        labelKey: 'provider_openai',
        dialect: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-5.6-luna',
        needsKey: true,
    },
    anthropic: {
        label: 'Anthropic Claude',
        labelKey: 'provider_anthropic',
        dialect: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-sonnet-5',
        needsKey: true,
    },
    gemini: {
        label: 'Google Gemini',
        labelKey: 'provider_gemini',
        dialect: 'openai', // official OpenAI-compatible endpoint
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-3.6-flash',
        needsKey: true,
    },
    deepseek: {
        label: 'DeepSeek',
        labelKey: 'provider_deepseek',
        dialect: 'openai',
        // DeepSeek V4 dropped the /v1 suffix — base path is now the host root
        // and the chat endpoint resolves to /chat/completions directly.
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-v4-flash',
        needsKey: true,
        // Thinking is disabled unless the user explicitly opts in.
        defaultReasoning: 'off',
    },
    moonshot: {
        label: 'Moonshot (Kimi)',
        labelKey: 'provider_moonshot',
        dialect: 'openai',
        // The Moonshot platform was rebranded to Kimi; the API host is
        // unchanged, but the model family is now kimi-k* rather than
        // moonshot-v1-*. API keys are still issued as MOONSHOT_API_KEY.
        baseUrl: 'https://api.moonshot.cn/v1',
        defaultModel: 'kimi-k3',
        needsKey: true,
        // Kimi K3 cannot fully disable thinking; strict-off mode maps it to
        // the model's lowest supported reasoning effort instead.
        defaultReasoning: 'off',
    },
    qwen: {
        label: 'Qwen (DashScope)',
        labelKey: 'provider_qwen',
        dialect: 'openai',
        // DashScope's OpenAI-compatible mode. Users outside mainland China
        // may need the international host instead; the field stays editable.
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen3.7-flash',
        needsKey: true,
    },
    ollama: {
        label: 'Ollama (local)',
        labelKey: 'provider_ollama',
        dialect: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        defaultModel: 'llama3.1',
        needsKey: false,
    },
    builtin: {
        label: 'Chrome Built-in AI',
        labelKey: 'provider_builtin',
        dialect: 'builtin',
        baseUrl: '',
        defaultModel: 'gemini-nano',
        needsKey: false,
    },
    custom: {
        label: 'Custom (OpenAI-compatible)',
        labelKey: 'provider_custom',
        dialect: 'openai',
        baseUrl: '',
        defaultModel: '',
        needsKey: true,
    },
};

function getProvider(id) {
    return PROVIDERS[id] || PROVIDERS.custom;
}
