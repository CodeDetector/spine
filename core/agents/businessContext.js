// BusinessContext: profile + suppliers + clients + employees, plus a
// prompt-formatted text block for LLM injection.
//
// Cached for CACHE_TTL_MS so a busy worker tick doesn't hammer the
// mapMyBusiness service. Expires on time, not on writes — the staleness
// window (60s default) is well under any user-perceptible lag.

const businessClient = require('../businessClient');

const CACHE_TTL_MS = 60 * 1000;

let _cache = null;
let _expiresAt = 0;
let _inflight = null;

async function _fetch() {
    const raw = await businessClient.getBusinessContext();
    return {
        profile: raw.profile || null,
        suppliers: raw.suppliers || [],
        clients: raw.clients || [],
        employees: raw.employees || [],
        promptBlock: _formatForPrompt(raw),
    };
}

async function getContext({ force = false } = {}) {
    if (!force && _cache && Date.now() < _expiresAt) return _cache;
    if (_inflight) return _inflight;
    _inflight = _fetch()
        .then(ctx => {
            _cache = ctx;
            _expiresAt = Date.now() + CACHE_TTL_MS;
            _inflight = null;
            return ctx;
        })
        .catch(err => {
            _inflight = null;
            // Serve stale cache if we have one, otherwise propagate.
            if (_cache) {
                console.warn('businessContext: refresh failed, serving stale cache:', err.message);
                return _cache;
            }
            throw err;
        });
    return _inflight;
}

function invalidate() {
    _cache = null;
    _expiresAt = 0;
}

// ─── Prompt formatter ──────────────────────────────────────────────────────
// Bounded by simple length cuts so a giant supplier list doesn't blow the
// prompt budget. For larger orgs we'll want a vector-retrieval step instead.

const MAX_SUPPLIERS = 30;
const MAX_CLIENTS = 30;
const MAX_EMPLOYEES = 50;

function _formatForPrompt({ profile, suppliers = [], clients = [], employees = [] }) {
    const lines = [];

    if (profile) {
        lines.push('=== Business Profile ===');
        if (profile.name)        lines.push(`Business: ${profile.name}`);
        if (profile.industry)    lines.push(`Industry: ${profile.industry}`);
        if (profile.description) lines.push(`What we do: ${profile.description}`);
        if (profile.hq_location) lines.push(`Headquarters: ${profile.hq_location}`);
        if (profile.website)     lines.push(`Website: ${profile.website}`);
        lines.push('');
    }

    if (suppliers.length) {
        lines.push(`=== Suppliers (${suppliers.length}) ===`);
        for (const s of suppliers.slice(0, MAX_SUPPLIERS)) {
            const products = Array.isArray(s.products) && s.products.length
                ? ` [${s.products.map(p => p.name).filter(Boolean).join(', ')}]`
                : '';
            lines.push(`- ${s.name}${s.description ? ` — ${s.description}` : ''}${products}`);
        }
        if (suppliers.length > MAX_SUPPLIERS) lines.push(`…and ${suppliers.length - MAX_SUPPLIERS} more`);
        lines.push('');
    }

    if (clients.length) {
        lines.push(`=== Clients (${clients.length}) ===`);
        for (const c of clients.slice(0, MAX_CLIENTS)) {
            const loc = c.location ? ` (${c.location})` : '';
            const industry = c.industry ? ` — ${c.industry}` : '';
            lines.push(`- ${c.businessName || '(unnamed)'}${loc}${industry}`);
        }
        if (clients.length > MAX_CLIENTS) lines.push(`…and ${clients.length - MAX_CLIENTS} more`);
        lines.push('');
    }

    if (employees.length) {
        lines.push(`=== Employees (${employees.length}) ===`);
        for (const e of employees.slice(0, MAX_EMPLOYEES)) {
            const role = e.Role ? ` — ${e.Role}` : '';
            const admin = e.is_admin ? ' (admin)' : '';
            lines.push(`- ${e.Name}${role}${admin}`);
        }
        if (employees.length > MAX_EMPLOYEES) lines.push(`…and ${employees.length - MAX_EMPLOYEES} more`);
    }

    return lines.join('\n');
}

module.exports = { getContext, invalidate };
