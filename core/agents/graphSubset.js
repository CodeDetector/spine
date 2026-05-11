// Graph subset extractor.
//
// Given a message (email or WA), pull the slice of the knowledge graph that
// might relate to it: nodes that match emails, phone numbers, or named
// entities mentioned in the text, plus one hop of edges.
//
// This keeps the agent prompt bounded as the graph grows. For very large
// graphs we'll eventually want a vector index instead of string matching.

const supabaseService = require('../supabaseService');

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?<!\d)(\+?\d[\d\s().-]{7,}\d)(?!\d)/g;

function _normPhone(s) {
    return String(s || '').replace(/\D+/g, '');
}

function _extractIdentifiers(text) {
    const t = String(text || '');
    const emails = new Set();
    const phones = new Set();
    for (const m of t.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
    for (const m of t.matchAll(PHONE_RE)) {
        const n = _normPhone(m[1]);
        if (n.length >= 8) phones.add(n);
    }
    return { emails: [...emails], phones: [...phones] };
}

async function _findNodesByIdentifiers({ emails, phones }) {
    if (!supabaseService.client) return [];
    if (!emails.length && !phones.length) return [];

    // We match against the JSONB `properties` column: properties->>email and ->>phone.
    // Supabase's PostgREST `or()` lets us OR these filters in one round-trip.
    const filters = [];
    for (const e of emails) filters.push(`properties->>email.eq.${e}`);
    for (const p of phones) filters.push(`properties->>phone.eq.${p}`);
    if (!filters.length) return [];

    const { data, error } = await supabaseService.client
        .from('nodes')
        .select('id, type, name, properties')
        .or(filters.join(','))
        .limit(50);
    if (error) {
        console.error('graphSubset: nodes lookup failed:', error.message);
        return [];
    }
    return data || [];
}

async function _findNodesByNameHints(message) {
    // Capitalized multi-word phrases are a cheap proxy for proper nouns.
    // Avoids running an NER model in the hot path.
    const phrases = new Set();
    const re = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})\b/g;
    for (const m of String(message || '').matchAll(re)) {
        const p = m[1].trim();
        if (p.length >= 3 && p.length <= 60) phrases.add(p);
    }
    if (!phrases.size) return [];

    const list = [...phrases].slice(0, 15);
    const { data, error } = await supabaseService.client
        .from('nodes')
        .select('id, type, name, properties')
        .in('name', list)
        .limit(30);
    if (error) {
        console.error('graphSubset: name hint lookup failed:', error.message);
        return [];
    }
    return data || [];
}

async function _fetchEdgesForNodes(nodeIds) {
    if (!nodeIds.length) return [];
    const { data, error } = await supabaseService.client
        .from('edges')
        .select('id, from_node_id, to_node_id, relationship_type, properties')
        .or(`from_node_id.in.(${nodeIds.join(',')}),to_node_id.in.(${nodeIds.join(',')})`)
        .limit(100);
    if (error) {
        console.error('graphSubset: edges lookup failed:', error.message);
        return [];
    }
    return data || [];
}

/**
 * Build a bounded graph slice relevant to the message.
 * Returns { nodes: [...], edges: [...], promptBlock: string }.
 */
async function build(messageText) {
    const ids = _extractIdentifiers(messageText);
    const [byIds, byName] = await Promise.all([
        _findNodesByIdentifiers(ids),
        _findNodesByNameHints(messageText),
    ]);
    const byNodeId = new Map();
    for (const n of [...byIds, ...byName]) byNodeId.set(n.id, n);
    const nodes = [...byNodeId.values()];
    const edges = nodes.length ? await _fetchEdgesForNodes(nodes.map(n => n.id)) : [];

    return { nodes, edges, promptBlock: _formatForPrompt(nodes, edges) };
}

function _formatForPrompt(nodes, edges) {
    if (!nodes.length) return '(no existing graph nodes appear related to this message)';
    const lines = [];
    lines.push(`Existing nodes (${nodes.length}):`);
    for (const n of nodes) {
        const props = [];
        if (n.properties?.email) props.push(`email=${n.properties.email}`);
        if (n.properties?.phone) props.push(`phone=${n.properties.phone}`);
        const propStr = props.length ? ` {${props.join(', ')}}` : '';
        lines.push(`- #${n.id} ${n.type}:${n.name}${propStr}`);
    }
    if (edges.length) {
        lines.push(`Existing edges (${edges.length}):`);
        for (const e of edges) {
            lines.push(`- #${e.from_node_id} -[${e.relationship_type}]-> #${e.to_node_id}`);
        }
    }
    return lines.join('\n');
}

module.exports = { build };
