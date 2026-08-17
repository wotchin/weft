/**
 * Weft — small, dependency-injected tools for the research agent.
 *
 * This module deliberately has no access to Chrome APIs, storage, or an LLM.
 * Callers supply the two search functions and keep policy/permission decisions
 * outside the tool implementation.
 *
 * Usage:
 *   const tools = AgentTools.create({
 *       searchSession: (query, topK) => [...],
 *       webSearch: (query, maxResults) => [...],
 *   });
 *   await tools.execute('session_search', { query: 'topic', topK: 5 });
 *   await tools.execute('web_search', { query: 'topic' }, { approved: true });
 */
/* exported AgentTools */

const AgentTools = (() => {
    'use strict';

    const DEFAULT_CHARACTER_BUDGET = 12000;
    const MIN_CHARACTER_BUDGET = 1000;
    const MAX_CHARACTER_BUDGET = 50000;
    const MAX_QUERY_LENGTH = 240;
    const MAX_SUMMARY_LENGTH = 600;
    const MAX_VALUE_DEPTH = 6;
    const MAX_OBJECT_KEYS = 40;
    const MAX_ARRAY_ITEMS = 32;
    const FORBIDDEN_KEYS = Object.freeze(new Set(['__proto__', 'prototype', 'constructor']));
    const CONTROL_AND_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
    const HAS_OWN = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

    const CALCULATION_OPERATIONS = Object.freeze([
        'add',
        'subtract',
        'multiply',
        'divide',
        'percent_change',
        'percentage_of',
        'date_diff_days',
    ]);

    const NUMBER_SCHEMA = Object.freeze({ type: 'number' });
    const DATE_SCHEMA = Object.freeze({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

    function freezeDeep(value, seen = new WeakSet()) {
        if (!value || typeof value !== 'object' || seen.has(value)) return value;
        seen.add(value);
        Object.freeze(value);
        for (const child of Object.values(value)) freezeDeep(child, seen);
        return value;
    }

    const TOOL_DEFINITIONS = freezeDeep([
        {
            name: 'session_search',
            description: 'Search only the user-curated fragments in the current session.',
            external: false,
            needsApproval: false,
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['query'],
                properties: {
                    query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
                    topK: { type: 'integer', minimum: 1, maximum: 8, default: 5 },
                },
            },
        },
        {
            name: 'calculate',
            description: 'Run one deterministic arithmetic, percentage, or ISO-date calculation.',
            external: false,
            needsApproval: false,
            inputSchema: {
                oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['operation', 'a', 'b'],
                        properties: {
                            operation: { enum: ['add', 'subtract', 'multiply', 'divide'] },
                            a: NUMBER_SCHEMA,
                            b: NUMBER_SCHEMA,
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['operation', 'from', 'to'],
                        properties: {
                            operation: { const: 'percent_change' },
                            from: NUMBER_SCHEMA,
                            to: NUMBER_SCHEMA,
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['operation', 'percentage', 'value'],
                        properties: {
                            operation: { const: 'percentage_of' },
                            percentage: NUMBER_SCHEMA,
                            value: NUMBER_SCHEMA,
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['operation', 'startDate', 'endDate'],
                        properties: {
                            operation: { const: 'date_diff_days' },
                            startDate: DATE_SCHEMA,
                            endDate: DATE_SCHEMA,
                        },
                    },
                ],
            },
        },
        {
            name: 'web_search',
            description: 'Search an injected external provider when session evidence is insufficient.',
            external: true,
            needsApproval: true,
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['query'],
                properties: {
                    query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
                    maxResults: { type: 'integer', minimum: 1, maximum: 6, default: 6 },
                },
            },
        },
    ]);

    const TOOL_ALLOWLIST = freezeDeep(Object.assign(Object.create(null), {
        session_search: { external: false, needsApproval: false },
        calculate: { external: false, needsApproval: false },
        web_search: { external: true, needsApproval: true },
    }));

    class ToolInputError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'ToolInputError';
            this.code = code;
        }
    }

    function cleanText(value) {
        if (typeof value !== 'string') return '';
        return value.replace(CONTROL_AND_BIDI, '').normalize('NFC');
    }

    function takeCharacters(value, limit) {
        const characters = Array.from(value);
        if (characters.length <= limit) return { value, truncated: false };
        if (limit <= 1) return { value: characters.slice(0, Math.max(0, limit)).join(''), truncated: true };
        return { value: `${characters.slice(0, limit - 1).join('')}…`, truncated: true };
    }

    function isPlainRecord(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        if (prototype === null || prototype === Object.prototype) return true;
        // Plain records passed across a browser realm (or a Node vm in tests)
        // have a different Object.prototype, whose own prototype is still null.
        return Object.getPrototypeOf(prototype) === null
            && HAS_OWN(prototype, 'toString')
            && HAS_OWN(prototype, 'valueOf');
    }

    function assertSafeRecord(value, label) {
        if (!isPlainRecord(value)) {
            throw new ToolInputError('INVALID_ARGUMENTS', `${label} must be a plain object.`);
        }
        for (const key of Object.keys(value)) {
            if (FORBIDDEN_KEYS.has(key)) {
                throw new ToolInputError('UNSAFE_ARGUMENTS', `${label} contains a forbidden key.`);
            }
        }
    }

    function assertExactKeys(value, required, optional = []) {
        const allowed = new Set([...required, ...optional]);
        for (const key of Object.keys(value)) {
            if (!allowed.has(key)) {
                throw new ToolInputError('UNKNOWN_ARGUMENT', `Unexpected argument: ${cleanText(key) || '(invalid key)'}.`);
            }
        }
        for (const key of required) {
            if (!HAS_OWN(value, key)) {
                throw new ToolInputError('MISSING_ARGUMENT', `Missing required argument: ${key}.`);
            }
        }
    }

    function readQuery(value) {
        if (typeof value !== 'string') {
            throw new ToolInputError('INVALID_QUERY', 'query must be a string.');
        }
        const query = cleanText(value).trim();
        const length = Array.from(query).length;
        if (length < 1 || length > MAX_QUERY_LENGTH) {
            throw new ToolInputError('INVALID_QUERY', `query must contain 1–${MAX_QUERY_LENGTH} characters.`);
        }
        return query;
    }

    function readInteger(value, name, minimum, maximum, fallback) {
        if (value === undefined) return fallback;
        if (!Number.isInteger(value) || value < minimum || value > maximum) {
            throw new ToolInputError('INVALID_NUMBER', `${name} must be an integer from ${minimum} to ${maximum}.`);
        }
        return value;
    }

    function readFiniteNumber(value, name) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new ToolInputError('INVALID_NUMBER', `${name} must be a finite number.`);
        }
        return value;
    }

    function readIsoDate(value, name) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            throw new ToolInputError('INVALID_DATE', `${name} must use YYYY-MM-DD.`);
        }
        const timestamp = Date.parse(`${value}T00:00:00.000Z`);
        const date = new Date(timestamp);
        if (!Number.isFinite(timestamp) || date.toISOString().slice(0, 10) !== value) {
            throw new ToolInputError('INVALID_DATE', `${name} is not a valid calendar date.`);
        }
        return { value, timestamp };
    }

    function validateSessionSearch(args) {
        assertSafeRecord(args, 'arguments');
        assertExactKeys(args, ['query'], ['topK']);
        return {
            query: readQuery(args.query),
            topK: readInteger(HAS_OWN(args, 'topK') ? args.topK : undefined, 'topK', 1, 8, 5),
        };
    }

    function validateWebSearch(args) {
        assertSafeRecord(args, 'arguments');
        assertExactKeys(args, ['query'], ['maxResults']);
        return {
            query: readQuery(args.query),
            maxResults: readInteger(
                HAS_OWN(args, 'maxResults') ? args.maxResults : undefined,
                'maxResults',
                1,
                6,
                6
            ),
        };
    }

    function validateCalculation(args) {
        assertSafeRecord(args, 'arguments');
        if (!HAS_OWN(args, 'operation') || typeof args.operation !== 'string'
            || !CALCULATION_OPERATIONS.includes(args.operation)) {
            throw new ToolInputError('INVALID_OPERATION', 'operation is not allowed.');
        }

        switch (args.operation) {
            case 'add':
            case 'subtract':
            case 'multiply':
            case 'divide':
                assertExactKeys(args, ['operation', 'a', 'b']);
                return {
                    operation: args.operation,
                    a: readFiniteNumber(args.a, 'a'),
                    b: readFiniteNumber(args.b, 'b'),
                };
            case 'percent_change':
                assertExactKeys(args, ['operation', 'from', 'to']);
                return {
                    operation: args.operation,
                    from: readFiniteNumber(args.from, 'from'),
                    to: readFiniteNumber(args.to, 'to'),
                };
            case 'percentage_of':
                assertExactKeys(args, ['operation', 'percentage', 'value']);
                return {
                    operation: args.operation,
                    percentage: readFiniteNumber(args.percentage, 'percentage'),
                    value: readFiniteNumber(args.value, 'value'),
                };
            case 'date_diff_days': {
                assertExactKeys(args, ['operation', 'startDate', 'endDate']);
                const start = readIsoDate(args.startDate, 'startDate');
                const end = readIsoDate(args.endDate, 'endDate');
                return {
                    operation: args.operation,
                    startDate: start.value,
                    endDate: end.value,
                };
            }
            default:
                throw new ToolInputError('INVALID_OPERATION', 'operation is not allowed.');
        }
    }

    function calculate(args) {
        let result;
        let unit = null;
        switch (args.operation) {
            case 'add': result = args.a + args.b; break;
            case 'subtract': result = args.a - args.b; break;
            case 'multiply': result = args.a * args.b; break;
            case 'divide':
                if (args.b === 0) throw new ToolInputError('DIVIDE_BY_ZERO', 'Cannot divide by zero.');
                result = args.a / args.b;
                break;
            case 'percent_change':
                if (args.from === 0) {
                    throw new ToolInputError('DIVIDE_BY_ZERO', 'Percent change is undefined when from is zero.');
                }
                result = ((args.to - args.from) / Math.abs(args.from)) * 100;
                unit = 'percent';
                break;
            case 'percentage_of':
                result = (args.percentage / 100) * args.value;
                break;
            case 'date_diff_days':
                result = (Date.parse(`${args.endDate}T00:00:00.000Z`)
                    - Date.parse(`${args.startDate}T00:00:00.000Z`)) / 86400000;
                unit = 'days';
                break;
            default:
                throw new ToolInputError('INVALID_OPERATION', 'operation is not allowed.');
        }
        if (!Number.isFinite(result)) {
            throw new ToolInputError('NON_FINITE_RESULT', 'The calculation produced a non-finite result.');
        }
        return { result, unit };
    }

    function createBudget(limit) {
        return { remaining: limit, truncated: false, seen: new WeakSet() };
    }

    function budgetedText(value, budget, maximum = budget.remaining) {
        const cleaned = cleanText(String(value));
        const allowed = Math.max(0, Math.min(maximum, budget.remaining));
        const output = takeCharacters(cleaned, allowed);
        budget.remaining -= Array.from(output.value).length;
        if (output.truncated) budget.truncated = true;
        return output.value;
    }

    function sanitizeValue(value, budget, depth = 0) {
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'string') return budgetedText(value, budget);
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'bigint') return budgetedText(value.toString(), budget);
        if (typeof value === 'undefined') return null;
        if (typeof value !== 'object') {
            budget.truncated = true;
            return null;
        }
        if (depth >= MAX_VALUE_DEPTH || budget.seen.has(value)) {
            budget.truncated = true;
            return null;
        }
        budget.seen.add(value);

        if (Array.isArray(value)) {
            if (value.length > MAX_ARRAY_ITEMS) budget.truncated = true;
            return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, budget, depth + 1));
        }

        if (!isPlainRecord(value)) {
            budget.truncated = true;
            return null;
        }
        const output = {};
        const keys = Object.keys(value);
        if (keys.length > MAX_OBJECT_KEYS) budget.truncated = true;
        for (const rawKey of keys.slice(0, MAX_OBJECT_KEYS)) {
            if (FORBIDDEN_KEYS.has(rawKey)) {
                budget.truncated = true;
                continue;
            }
            const key = cleanText(rawKey).slice(0, 120);
            if (!key || FORBIDDEN_KEYS.has(key) || HAS_OWN(output, key)) {
                budget.truncated = true;
                continue;
            }
            output[key] = sanitizeValue(value[rawKey], budget, depth + 1);
        }
        return output;
    }

    function findEvidence(raw) {
        if (Array.isArray(raw)) return raw;
        if (!isPlainRecord(raw)) return null;
        for (const key of ['evidence', 'results', 'matches', 'items']) {
            if (HAS_OWN(raw, key) && Array.isArray(raw[key])) return raw[key];
        }
        return null;
    }

    function adaptSearchResult(raw, limit, fallbackSummary) {
        const sourceEvidence = findEvidence(raw);
        const evidence = sourceEvidence ? sourceEvidence.slice(0, limit) : [];
        const wasLimited = !!sourceEvidence && sourceEvidence.length > limit;
        let summary = fallbackSummary(evidence.length);
        let data = { count: evidence.length };

        if (isPlainRecord(raw)) {
            if (HAS_OWN(raw, 'summary') && typeof raw.summary === 'string') summary = raw.summary;
            if (HAS_OWN(raw, 'data')) data = raw.data;
            else if (!sourceEvidence) data = raw;
            if (HAS_OWN(raw, 'total') && Number.isFinite(raw.total)) {
                data = isPlainRecord(data) ? { ...data, total: raw.total } : { value: data, total: raw.total };
            }
        }
        return { summary, evidence, data, wasLimited };
    }

    function combineSearchData(metadata, data) {
        if (isPlainRecord(data)) return { ...data, ...metadata };
        return data === null || data === undefined
            ? metadata
            : { ...metadata, payload: data };
    }

    function buildResult(tool, ok, summary, evidence, data, characterBudget, alreadyTruncated = false) {
        const budget = createBudget(characterBudget);
        const safeSummary = budgetedText(summary, budget, MAX_SUMMARY_LENGTH);
        const safeEvidence = sanitizeValue(evidence, budget);
        const safeData = sanitizeValue(data, budget);
        return {
            ok,
            tool: cleanText(tool).slice(0, 80),
            summary: safeSummary,
            evidence: Array.isArray(safeEvidence) ? safeEvidence : [],
            data: safeData,
            untrusted: true,
            truncated: alreadyTruncated || budget.truncated,
        };
    }

    function failure(tool, error, characterBudget) {
        const code = typeof error?.code === 'string' ? error.code : 'TOOL_FAILED';
        const message = cleanText(error?.message || 'The tool failed.');
        return buildResult(
            tool,
            false,
            message,
            [],
            { error: { code, message } },
            characterBudget
        );
    }

    function getDefinition(name) {
        return TOOL_DEFINITIONS.find((definition) => definition.name === name) || null;
    }

    function create(dependencies = {}, options = {}) {
        assertSafeRecord(dependencies, 'dependencies');
        assertSafeRecord(options, 'options');
        assertExactKeys(dependencies, [], ['searchSession', 'webSearch']);
        assertExactKeys(options, [], ['characterBudget']);

        for (const name of ['searchSession', 'webSearch']) {
            if (HAS_OWN(dependencies, name) && typeof dependencies[name] !== 'function') {
                throw new TypeError(`${name} must be a function.`);
            }
        }

        const requestedBudget = options.characterBudget ?? DEFAULT_CHARACTER_BUDGET;
        if (!Number.isInteger(requestedBudget)
            || requestedBudget < MIN_CHARACTER_BUDGET
            || requestedBudget > MAX_CHARACTER_BUDGET) {
            throw new TypeError(`characterBudget must be an integer from ${MIN_CHARACTER_BUDGET} to ${MAX_CHARACTER_BUDGET}.`);
        }

        /** Validate and normalize arguments without executing a tool. */
        function validate(toolName, args) {
            if (typeof toolName !== 'string'
                || toolName !== cleanText(toolName)
                || !HAS_OWN(TOOL_ALLOWLIST, toolName)) {
                throw new ToolInputError('UNKNOWN_TOOL', 'Tool is not allowed.');
            }
            switch (toolName) {
                case 'session_search': return validateSessionSearch(args);
                case 'calculate': return validateCalculation(args);
                case 'web_search': return validateWebSearch(args);
                default: throw new ToolInputError('UNKNOWN_TOOL', 'Tool is not allowed.');
            }
        }

        async function execute(toolName, args, context = {}) {
            const originalToolName = typeof toolName === 'string' ? toolName : '';
            const safeToolName = cleanText(originalToolName);

            try {
                // Validate before approval or execution so malformed input never
                // reaches a cache key, approval prompt, or injected dependency.
                const input = validate(originalToolName, args);
                assertSafeRecord(context, 'context');
                assertExactKeys(context, [], ['approved', 'signal']);
                const policy = TOOL_ALLOWLIST[originalToolName];
                if (policy.needsApproval && (!HAS_OWN(context, 'approved') || context.approved !== true)) {
                    throw new ToolInputError('APPROVAL_REQUIRED', 'This external tool requires explicit user approval.');
                }

                if (originalToolName === 'calculate') {
                    const output = calculate(input);
                    const suffix = output.unit ? ` ${output.unit}` : '';
                    return buildResult(
                        originalToolName,
                        true,
                        `Calculation result: ${output.result}${suffix}.`,
                        [],
                        { operation: input.operation, ...output },
                        requestedBudget
                    );
                }

                if (originalToolName === 'session_search') {
                    if (typeof dependencies.searchSession !== 'function') {
                        throw new ToolInputError('TOOL_UNAVAILABLE', 'Session search is not available.');
                    }
                    const raw = await dependencies.searchSession(
                        input.query,
                        input.topK,
                        { signal: context.signal }
                    );
                    const adapted = adaptSearchResult(raw, input.topK, (count) => `Found ${count} session result${count === 1 ? '' : 's'}.`);
                    return buildResult(
                        originalToolName,
                        true,
                        adapted.summary,
                        adapted.evidence,
                        combineSearchData({ query: input.query, topK: input.topK }, adapted.data),
                        requestedBudget,
                        adapted.wasLimited
                    );
                }

                if (typeof dependencies.webSearch !== 'function') {
                    throw new ToolInputError('TOOL_UNAVAILABLE', 'Web search is not available.');
                }
                const raw = await dependencies.webSearch(
                    input.query,
                    input.maxResults,
                    { signal: context.signal }
                );
                const adapted = adaptSearchResult(raw, input.maxResults, (count) => `Found ${count} web result${count === 1 ? '' : 's'}.`);
                return buildResult(
                    originalToolName,
                    true,
                    adapted.summary,
                    adapted.evidence,
                    combineSearchData({ query: input.query, maxResults: input.maxResults }, adapted.data),
                    requestedBudget,
                    adapted.wasLimited
                );
            } catch (error) {
                return failure(safeToolName, error, requestedBudget);
            }
        }

        return freezeDeep({
            definitions: TOOL_DEFINITIONS,
            listDefinitions: () => TOOL_DEFINITIONS,
            getDefinition,
            validate,
            execute,
        });
    }

    return freezeDeep({
        create,
        definitions: TOOL_DEFINITIONS,
        listDefinitions: () => TOOL_DEFINITIONS,
        getDefinition,
        isAllowed: (name) => typeof name === 'string' && HAS_OWN(TOOL_ALLOWLIST, name),
    });
})();
