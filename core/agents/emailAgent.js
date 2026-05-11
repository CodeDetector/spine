// EmailAgent — refines the knowledge graph for incoming emails and proposes
// proactive follow-ups. Called by the worker; never invoked inline.

const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const graphSubset = require('./graphSubset');

const MODEL = process.env.GEMINI_AGENT_MODEL || 'gemini-2.0-flash';

let _genAI = null;
function _client() {
    if (_genAI) return _genAI;
    if (!config.GEMINI_API_KEY) throw new Error('EmailAgent: GEMINI_API_KEY not configured');
    _genAI = new GoogleGenAI(config.GEMINI_API_KEY);
    return _genAI;
}

function _buildPrompt({ businessPrompt, graphPrompt, payload }) {
    const messageBlob = [
        `From: ${payload.sender || '(unknown)'}`,
        `To: ${payload.receiver || '(unknown)'}`,
        payload.threadId ? `Thread: ${payload.threadId}` : null,
        '',
        payload.message || '',
    ].filter(x => x !== null).join('\n');

    return [
        'You are a knowledge-graph refinement agent for a B2B business intelligence platform.',
        'Your job: given a new EMAIL plus the existing business context and any related graph nodes,',
        'propose a GRAPH DIFF (additions/updates) and zero-or-more FOLLOW-UP suggestions for a human to action.',
        '',
        'Output JSON ONLY, no markdown fences, matching this schema exactly:',
        '{',
        '  "addedNodes":   [{ "type": "Client|Supplier|Contact|Employee|Organization|Topic", "name": "...", "properties": { "email": "...", "phone": "..." } }],',
        '  "updatedNodes": [{ "match": { "type": "...", "name": "..." }, "properties": { "...": "..." } }],',
        '  "addedEdges":   [{ "fromType": "...", "fromName": "...", "toType": "...", "toName": "...", "relationship_type": "...", "properties": {} }],',
        '  "followUps":    [{ "priority": "low|normal|high|urgent", "title": "...", "description": "...", "suggested_action": "reply|schedule|assign|investigate|other", "targetEmployeeName": "..." }],',
        '  "notes": "(brief reasoning, optional)"',
        '}',
        '',
        'Rules:',
        '- Be CONSERVATIVE. Only propose changes you are highly confident about.',
        '- If the email is purely social, marketing spam, or unrelated to the business, return all-empty arrays.',
        '- Prefer matching to an EXISTING node (in the graph subset below) over creating a duplicate.',
        '- Follow-ups must be specific and actionable — "follow up with John" is bad, "Confirm Q3 delivery date with ACME (vendor) by Friday" is good.',
        '- targetEmployeeName should match an existing employee name from the business context, or be null.',
        '',
        businessPrompt || '(no business context yet)',
        '',
        '=== EXISTING GRAPH (related slice) ===',
        graphPrompt,
        '',
        '=== NEW EMAIL ===',
        messageBlob,
        '',
        'Return the JSON object now.',
    ].join('\n');
}

function _safeJSONParse(text) {
    const stripped = String(text || '').replace(/```json|```/g, '').trim();
    return JSON.parse(stripped);
}

const EmailAgent = {
    name: 'EmailAgent',
    channel: 'email',

    async refine(job, ctx) {
        const payload = job.payload || {};
        const businessPrompt = ctx?.promptBlock || '';
        const subset = await graphSubset.build(payload.message || '');

        const prompt = _buildPrompt({
            businessPrompt,
            graphPrompt: subset.promptBlock,
            payload,
        });

        const client = _client();
        const result = await client.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        const raw = result?.text || '';
        let parsed;
        try {
            parsed = _safeJSONParse(raw);
        } catch (err) {
            throw new Error(`EmailAgent: model returned non-JSON: ${raw.slice(0, 200)}`);
        }

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

module.exports = EmailAgent;
