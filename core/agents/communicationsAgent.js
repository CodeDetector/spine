// CommunicationsAgent — owns the Communications Graph (CG).
//
// Triggered by every new email or WhatsApp message that gets enqueued.
//
// Flow:
//   1. Resolve thread + participants via threadResolver.
//   2. Run the relevance gate against business context. Suppress if below threshold.
//   3. Extract proposed nodes/edges + follow-ups via the main agent prompt.
//   4. For each participant, call diffApplier with that participant's comms scope.
//      The same logical entity gets one row per employee — the duplication is
//      intentional (see PRD §4).
//
// Channel-agnostic: payload.channel tells us whether to render the email or
// WhatsApp variant of the extraction prompt.

const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const diffApplier = require('./diffApplier');
const threadResolver = require('./threadResolver');
const relevanceGate = require('./relevanceGate');
const graphSubset = require('./graphSubset');

const MODEL = process.env.GEMINI_AGENT_MODEL || 'gemini-2.0-flash';

let _genAI = null;
function _client() {
    if (_genAI) return _genAI;
    if (!config.GEMINI_API_KEY) throw new Error('CommunicationsAgent: GEMINI_API_KEY not configured');
    _genAI = new GoogleGenAI(config.GEMINI_API_KEY);
    return _genAI;
}

function _safeJSONParse(text) {
    return JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
}

function _buildPrompt({ channel, businessPrompt, graphSubsetPrompt, payload }) {
    const isEmail = channel === 'email';
    const messageBlob = isEmail
        ? [
              `From: ${payload.sender || '(unknown)'}`,
              `To: ${payload.receiver || '(unknown)'}`,
              payload.threadId ? `Thread: ${payload.threadId}` : null,
              '',
              payload.message || '',
          ].filter(x => x !== null).join('\n')
        : [
              `Chat: ${payload.chatJid || '(unknown)'}`,
              `From: ${payload.senderLabel || payload.senderName || payload.senderNumber || '(unknown)'}`,
              '',
              payload.messageText || '',
          ].join('\n');

    return [
        'You are the Communications Agent for a B2B intelligence platform.',
        'Extract entities and relationships from the message below into the',
        "COMMUNICATIONS knowledge graph (one employee's view of their inboxes).",
        '',
        'Output JSON ONLY, no markdown fences, matching this schema exactly:',
        '{',
        '  "addedNodes":   [{ "type": "Client|Supplier|Contact|Topic|Product|Commitment", "name": "...", "properties": { "email":"...", "phone":"..." } }],',
        '  "updatedNodes": [{ "match": { "type":"...", "name":"..." }, "properties": {} }],',
        '  "addedEdges":   [{ "fromType":"...", "fromName":"...", "toType":"...", "toName":"...", "relationship_type":"MENTIONED_IN|REQUESTED|PROMISED|REFERENCED", "properties":{} }],',
        '  "followUps":    [{ "priority":"low|normal|high|urgent", "title":"...", "description":"...", "suggested_action":"reply|schedule|assign|investigate|other", "targetEmployeeName":"..." }],',
        '  "notes": "..."',
        '}',
        '',
        'Rules:',
        '- Be CONSERVATIVE. Only propose changes you are highly confident about.',
        '- Prefer matching to an EXISTING node from the graph subset over creating duplicates.',
        '- Follow-ups must be specific. "Follow up with John" is bad; "Confirm Q3 delivery date with ACME by Friday" is good.',
        '- Cross-reference the business context: if a sender matches an existing client/supplier, link the new comms node to that business entity via a MENTIONED_IN edge.',
        '- All proposed entities will be written to the comms graph (scope=comms) — not the business graph.',
        '',
        businessPrompt || '(business context empty)',
        '',
        '=== EXISTING COMMS GRAPH (related slice) ===',
        graphSubsetPrompt || '(none)',
        '',
        `=== NEW ${isEmail ? 'EMAIL' : 'WHATSAPP MESSAGE'} ===`,
        messageBlob,
        '',
        'Return the JSON object now.',
    ].join('\n');
}

const CommunicationsAgent = {
    name: 'CommunicationsAgent',
    channel: 'comms', // matches BOTH 'email' and 'whatsapp' in the worker

    async refine(job, ctx) {
        const channel = job.channel; // 'email' or 'whatsapp'
        const payload = job.payload || {};
        const messageText = channel === 'email'
            ? (payload.message || '')
            : (payload.messageText || '');

        // 1. Thread + participants
        const { threadId, participantEmployeeIds } = await threadResolver.resolve({ channel, payload });

        if (!participantEmployeeIds.length) {
            return {
                alreadyApplied: true,
                appliedSummary: { nodesAdded: 0, nodesUpdated: 0, edgesAdded: 0, followUpsAdded: 0 },
                graphDiff: { addedNodes: [], updatedNodes: [], addedEdges: [] },
                followUps: [],
                notes: 'no resolved participants — message dropped',
                model: MODEL,
            };
        }

        // Record participation up front — even if we drop the message later via
        // the relevance gate, we still want the participant link for context.
        await threadResolver.recordParticipants(channel, threadId, participantEmployeeIds);

        // 2. Relevance gate
        const gate = await relevanceGate.score({
            channel,
            messageText,
            businessPrompt: ctx?.promptBlock || '',
        });
        if (!gate.passed) {
            return {
                alreadyApplied: true,
                appliedSummary: { nodesAdded: 0, nodesUpdated: 0, edgesAdded: 0, followUpsAdded: 0 },
                graphDiff: { addedNodes: [], updatedNodes: [], addedEdges: [] },
                followUps: [],
                notes: `gate suppressed (score=${gate.score}, ${gate.reason})`,
                model: MODEL,
            };
        }

        // 3. Build the related graph subset (across all comms-scope nodes — we
        //    don't filter by participant here since the agent only sees this
        //    once, even though it'll be written to multiple scopes).
        const subset = await graphSubset.build(messageText);

        const prompt = _buildPrompt({
            channel,
            businessPrompt: ctx?.promptBlock || '',
            graphSubsetPrompt: subset.promptBlock,
            payload,
        });

        const raw = (await _client().models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }))?.text || '';

        let parsed;
        try { parsed = _safeJSONParse(raw); }
        catch { throw new Error(`CommunicationsAgent: non-JSON output: ${raw.slice(0, 200)}`); }

        const result = {
            graphDiff: {
                addedNodes:   Array.isArray(parsed.addedNodes)   ? parsed.addedNodes   : [],
                updatedNodes: Array.isArray(parsed.updatedNodes) ? parsed.updatedNodes : [],
                addedEdges:   Array.isArray(parsed.addedEdges)   ? parsed.addedEdges   : [],
            },
            followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
            notes: parsed.notes || null,
        };

        // 4. Apply once per participant. The follow-ups land once total — they
        //    target a specific employee anyway. Nodes/edges get duplicated.
        let totalNodes = 0, totalUpdated = 0, totalEdges = 0;
        const followUpResult = { ...result, followUps: [] }; // suppress follow-ups in graph-only passes
        for (let i = 0; i < participantEmployeeIds.length; i++) {
            const empId = participantEmployeeIds[i];
            // Last participant carries the follow-up writes — keeps it to one insert batch.
            const passResult = (i === participantEmployeeIds.length - 1) ? result : followUpResult;
            const applied = await diffApplier.apply({
                jobId: job.id,
                channel,
                agent: 'CommunicationsAgent',
                result: passResult,
                businessCtx: ctx,
                scope: { scope_type: 'comms', scope_employee_id: empId },
            });
            totalNodes   += applied.nodesAdded;
            totalUpdated += applied.nodesUpdated;
            totalEdges   += applied.edgesAdded;
        }

        const followUpsCount = result.followUps.length; // emitted on last participant pass
        return {
            alreadyApplied: true,
            appliedSummary: {
                nodesAdded:    totalNodes,
                nodesUpdated:  totalUpdated,
                edgesAdded:    totalEdges,
                followUpsAdded: followUpsCount,
            },
            graphDiff: result.graphDiff, // for the audit row
            followUps: result.followUps, // for the audit row
            notes: [
                result.notes,
                `gate passed (score=${gate.score})`,
                `participants: ${participantEmployeeIds.length}`,
            ].filter(Boolean).join(' | '),
            model: MODEL,
        };
    },
};

module.exports = CommunicationsAgent;
