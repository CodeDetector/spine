// SynthesisAgent — the proactive agent. Reads BOTH graphs (BKG + scoped CG)
// and emits follow-ups for humans to action. Does NOT mutate either graph.
//
// Triggered by:
//   - the periodic cron in synthesisRunner.js (every 10 min per active employee)
//   - the on-demand endpoint GET /api/synthesis/refresh (60s cache)
//
// Per employee + downline: one synthesis pass that covers their visible scope.

const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const supabaseService = require('../supabaseService');

const MODEL = process.env.GEMINI_SYNTHESIS_MODEL || 'gemini-2.0-flash';

let _genAI = null;
function _client() {
    if (_genAI) return _genAI;
    if (!config.GEMINI_API_KEY) throw new Error('SynthesisAgent: GEMINI_API_KEY not configured');
    _genAI = new GoogleGenAI(config.GEMINI_API_KEY);
    return _genAI;
}

function _safeJSONParse(text) {
    return JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
}

async function _loadGraphSlices(visibleEmployeeIds) {
    if (!supabaseService.client) return { bkg: { nodes: [], edges: [] }, cg: { nodes: [], edges: [] } };

    // Business graph — small enough to fetch in full.
    const { data: bkgNodes } = await supabaseService.client
        .from('nodes').select('id, type, name, properties').eq('scope_type', 'business').limit(500);
    const { data: bkgEdges } = await supabaseService.client
        .from('edges').select('id, from_node_id, to_node_id, relationship_type').eq('scope_type', 'business').limit(500);

    // Comms graph — only the rows in the caller's visible scope.
    let cgNodes = [];
    let cgEdges = [];
    if (visibleEmployeeIds?.length) {
        const { data: nodes } = await supabaseService.client
            .from('nodes')
            .select('id, type, name, properties, scope_employee_id')
            .eq('scope_type', 'comms')
            .in('scope_employee_id', visibleEmployeeIds)
            .limit(400);
        cgNodes = nodes || [];
        const nodeIds = cgNodes.map(n => n.id);
        if (nodeIds.length) {
            const { data: edges } = await supabaseService.client
                .from('edges')
                .select('id, from_node_id, to_node_id, relationship_type')
                .eq('scope_type', 'comms')
                .in('scope_employee_id', visibleEmployeeIds)
                .limit(800);
            cgEdges = edges || [];
        }
    }

    return { bkg: { nodes: bkgNodes || [], edges: bkgEdges || [] }, cg: { nodes: cgNodes, edges: cgEdges } };
}

async function _loadOpenFollowUps(visibleEmployeeIds) {
    if (!supabaseService.client || !visibleEmployeeIds?.length) return [];
    const { data } = await supabaseService.client
        .from('follow_ups')
        .select('id, title, priority, status, employee_id, created_at')
        .in('employee_id', visibleEmployeeIds)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(50);
    return data || [];
}

function _formatGraphForPrompt(label, graph, maxLines = 60) {
    const out = [`=== ${label} ===`];
    out.push(`Nodes (${graph.nodes.length}):`);
    for (const n of graph.nodes.slice(0, maxLines)) {
        out.push(`- #${n.id} ${n.type}:${n.name}`);
    }
    if (graph.nodes.length > maxLines) out.push(`…and ${graph.nodes.length - maxLines} more`);
    out.push(`Edges (${graph.edges.length}):`);
    for (const e of graph.edges.slice(0, maxLines)) {
        out.push(`- #${e.from_node_id} -[${e.relationship_type}]-> #${e.to_node_id}`);
    }
    if (graph.edges.length > maxLines) out.push(`…and ${graph.edges.length - maxLines} more`);
    return out.join('\n');
}

function _formatOpenFollowUps(items) {
    if (!items.length) return '(none)';
    return items.map(f => `- #${f.id} [${f.priority}] ${f.title} (emp ${f.employee_id || '-'})`).join('\n');
}

function _buildPrompt({ employee, isManager, businessPrompt, bkg, cg, openFollowUps }) {
    return [
        `You are a proactive business assistant for ${employee.Name || 'an employee'}` +
            (employee.Role ? ` (${employee.Role})` : '') +
            (isManager ? ' — a manager. Your scope includes their direct and indirect reports.' : '.'),
        'Inputs:',
        '  - The BUSINESS knowledge graph (tenant-wide truth about the company).',
        '  - The COMMUNICATIONS graph slice this person is allowed to see (their inboxes' +
            (isManager ? " plus reports'." : '.') + ')',
        '  - The open follow-ups already proposed (do NOT duplicate these).',
        '',
        'Output JSON ONLY:',
        '{ "followUps": [{ "priority":"low|normal|high|urgent", "title":"...", "description":"...",',
        '                  "suggested_action":"reply|schedule|assign|investigate|other",',
        '                  "targetEmployeeName":"..." }],',
        '  "notes": "..." }',
        '',
        'Rules:',
        '- Be specific: cite the client/supplier/thread by name.',
        '- Skip if there is genuinely nothing actionable since the last run.',
        '- Don\'t duplicate any title from the OPEN FOLLOW-UPS list.',
        (isManager
            ? '- targetEmployeeName should be a specific report who should action it.'
            : `- targetEmployeeName should usually be "${employee.Name}".`),
        '- Prefer high-leverage items (overdue replies, broken commitments, stalled deals) over busywork.',
        '',
        businessPrompt || '(business context empty)',
        '',
        _formatGraphForPrompt('BUSINESS GRAPH', bkg),
        '',
        _formatGraphForPrompt('COMMUNICATIONS GRAPH (visible slice)', cg),
        '',
        '=== OPEN FOLLOW-UPS (do not duplicate) ===',
        _formatOpenFollowUps(openFollowUps),
        '',
        'Return JSON now.',
    ].join('\n');
}

/**
 * Run synthesis for a specific employee. Returns the inserted follow-ups (if any).
 *
 * @param {object} args
 * @param {object} args.employee   — the employee row (id, Name, Role, is_admin, ...)
 * @param {object} args.businessCtx — output of agents/businessContext.getContext()
 * @param {number[]} args.visibleEmployeeIds
 */
async function runFor({ employee, businessCtx, visibleEmployeeIds }) {
    const isManager = visibleEmployeeIds.length > 1 || !!employee.is_admin;

    const [{ bkg, cg }, openFollowUps] = await Promise.all([
        _loadGraphSlices(visibleEmployeeIds),
        _loadOpenFollowUps(visibleEmployeeIds),
    ]);

    if (cg.nodes.length === 0 && bkg.nodes.length === 0) {
        return { emitted: 0, skipped: 'empty graphs' };
    }

    const prompt = _buildPrompt({
        employee,
        isManager,
        businessPrompt: businessCtx?.promptBlock || '',
        bkg, cg, openFollowUps,
    });

    let raw = '';
    let parsed;
    const t0 = Date.now();
    try {
        const result = await _client().models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        raw = result?.text || '';
        parsed = _safeJSONParse(raw);
    } catch (err) {
        await _logRun({ employeeId: employee.id, emitted: 0, notes: `synthesis-error: ${err.message?.slice(0, 200)}`, started: t0 });
        return { emitted: 0, error: err.message };
    }

    const proposals = Array.isArray(parsed.followUps) ? parsed.followUps : [];
    if (!proposals.length) {
        await _logRun({ employeeId: employee.id, emitted: 0, notes: parsed.notes || 'no proposals', started: t0 });
        return { emitted: 0 };
    }

    // Map targetEmployeeName -> employee_id within visible scope only.
    const visibleSet = new Set(visibleEmployeeIds);
    const allEmployees = businessCtx?.employees || [];
    function findTargetId(name) {
        if (!name) return employee.id;
        const lc = String(name).trim().toLowerCase();
        const match = allEmployees.find(e => String(e.Name || '').trim().toLowerCase() === lc);
        if (match && visibleSet.has(match.id)) return match.id;
        return employee.id; // default to the requester
    }

    const rows = proposals.map(p => ({
        // follow_ups.business_id is NOT NULL. The synthesis run is scoped to
        // a single requesting employee, so their tenant is the row's tenant.
        business_id: employee.business_id,
        channel: 'synthesis',
        source_job_id: null,
        employee_id: findTargetId(p.targetEmployeeName),
        priority: ['low','normal','high','urgent'].includes(p.priority) ? p.priority : 'normal',
        title: String(p.title || '(untitled)').slice(0, 300),
        description: p.description ? String(p.description).slice(0, 2000) : null,
        suggested_action: p.suggested_action || null,
        related_node_ids: null,
    }));

    const { error: insErr } = await supabaseService.client.from('follow_ups').insert(rows);
    if (insErr) {
        await _logRun({ employeeId: employee.id, emitted: 0, notes: `insert-failed: ${insErr.message}`, started: t0 });
        return { emitted: 0, error: insErr.message };
    }

    await _logRun({ employeeId: employee.id, emitted: rows.length, notes: parsed.notes || null, started: t0 });
    return { emitted: rows.length };
}

async function _logRun({ employeeId, emitted, notes, started }) {
    if (!supabaseService.client) return;
    try {
        await supabaseService.client.from('synthesis_runs').insert([{
            employee_id: employeeId,
            started_at: new Date(started).toISOString(),
            completed_at: new Date().toISOString(),
            follow_ups_emitted: emitted,
            notes,
        }]);
    } catch (err) {
        console.error('SynthesisAgent: failed to log run:', err.message);
    }
}

async function lastRunWithin(employeeId, windowMs) {
    if (!supabaseService.client) return null;
    const since = new Date(Date.now() - windowMs).toISOString();
    const { data } = await supabaseService.client
        .from('synthesis_runs')
        .select('id, started_at')
        .eq('employee_id', employeeId)
        .gte('started_at', since)
        .order('started_at', { ascending: false })
        .limit(1);
    return (data || [])[0] || null;
}

module.exports = { runFor, lastRunWithin };
