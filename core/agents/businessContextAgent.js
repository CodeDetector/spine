// BusinessContextAgent — owns the Business Knowledge Graph (BKG).
//
// Triggered by mapMyBusiness mutations: business profile upserts, supplier
// inserts, client inserts, employee inserts, invitation inserts.
//
// Reads:  the triggering row's `payload` + the current BKG slice.
// Writes: scope_type='business' nodes/edges + optional follow_ups.
//
// Distinct from CommunicationsAgent in two ways:
//   1. Inputs are structured rows, not free-text messages — so the prompt
//      can be much more deterministic.
//   2. No per-employee duplication — there is exactly one business graph.

const { GoogleGenAI } = require('@google/genai');
const config = require('../config');

const MODEL = process.env.GEMINI_AGENT_MODEL || 'gemini-2.0-flash';

let _genAI = null;
function _client() {
    if (_genAI) return _genAI;
    if (!config.GEMINI_API_KEY) throw new Error('BusinessContextAgent: GEMINI_API_KEY not configured');
    _genAI = new GoogleGenAI(config.GEMINI_API_KEY);
    return _genAI;
}

function _safeJSONParse(text) {
    return JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
}

function _buildPrompt({ businessPrompt, sourceTable, row, action }) {
    return [
        'You are the Business Context Agent for a B2B intelligence platform.',
        'A new business entity was created or updated. Your job: emit graph',
        'updates for the BUSINESS knowledge graph (tenant-wide), and propose',
        'any obvious follow-up tasks a human should action.',
        '',
        'Output JSON ONLY, no markdown fences, matching this schema exactly:',
        '{',
        '  "addedNodes":   [{ "type": "Business|Supplier|Client|Employee|Product|Industry", "name": "...", "properties": {} }],',
        '  "updatedNodes": [{ "match": { "type": "...", "name": "..." }, "properties": {} }],',
        '  "addedEdges":   [{ "fromType":"...", "fromName":"...", "toType":"...", "toName":"...", "relationship_type":"HAS_SUPPLIER|HAS_CLIENT|EMPLOYS|SUPPLIES|BUYS|IN_INDUSTRY", "properties":{} }],',
        '  "followUps":    [{ "priority":"low|normal|high|urgent", "title":"...", "description":"...", "suggested_action":"...", "targetEmployeeName":"..." }],',
        '  "notes": "..."',
        '}',
        '',
        'Rules:',
        '- The entity goes into the graph as a node of the obvious type (suppliers→Supplier, etc.)',
        "- The company itself is the 'Business' node — connect new suppliers/clients/employees TO it via HAS_SUPPLIER / HAS_CLIENT / EMPLOYS.",
        '- For suppliers and clients, emit one Product node per product they sell/buy and a SUPPLIES or BUYS edge to it.',
        "- Don't propose follow-ups for routine inserts. Only emit a follow-up when there's something obviously incomplete (no products listed, no contact info, no managedBy assignment) or genuinely actionable (intro call, KYC).",
        '- All graph writes will be made at scope_type=business (the tenant-wide graph) — do not propose comms-graph entries.',
        '',
        businessPrompt || '(business context empty)',
        '',
        '=== TRIGGER ===',
        `Action: ${action || 'unknown'} on table "${sourceTable}"`,
        'Row:',
        JSON.stringify(row || {}, null, 2),
        '',
        'Return the JSON object now.',
    ].join('\n');
}

const BusinessContextAgent = {
    name: 'BusinessContextAgent',
    channel: 'business',

    async refine(job, ctx) {
        const { payload = {} } = job;
        const row = payload.row || {};
        const action = payload.action || 'insert';
        const sourceTable = job.source_table;

        const prompt = _buildPrompt({
            businessPrompt: ctx?.promptBlock || '',
            sourceTable,
            row,
            action,
        });

        const result = await _client().models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        const raw = result?.text || '';
        let parsed;
        try { parsed = _safeJSONParse(raw); }
        catch { throw new Error(`BusinessContextAgent: non-JSON output: ${raw.slice(0, 200)}`); }

        return {
            model: MODEL,
            graphDiff: {
                addedNodes:   Array.isArray(parsed.addedNodes)   ? parsed.addedNodes   : [],
                updatedNodes: Array.isArray(parsed.updatedNodes) ? parsed.updatedNodes : [],
                addedEdges:   Array.isArray(parsed.addedEdges)   ? parsed.addedEdges   : [],
            },
            followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
            notes: parsed.notes || null,
        };
    },
};

module.exports = BusinessContextAgent;
