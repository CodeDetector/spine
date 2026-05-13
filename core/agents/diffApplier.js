// Applies an agent's graph diff + follow-ups to the database.
//
// - addedNodes:   upsertNode() — idempotent on (type, name, scope)
// - updatedNodes: upsertNode() with merged properties (same path)
// - addedEdges:   resolve endpoints, then insert edge with same scope
// - followUps:    insert into follow_ups table
//
// Scope: business-scope writes leave scope_employee_id NULL. Comms-scope writes
// require scope_employee_id. The agent passes a `scope` object to apply().
// For multi-participant comms writes, the agent calls apply() once per
// participant (the duplication is intentional — see PRD §4).
//
// Resolution of targetEmployeeName -> employee_id happens here so the agent
// only has to deal with names.

const supabaseService = require('../supabaseService');

async function _resolveNodeId({ type, name, properties }, scope) {
    if (!type || !name) return null;
    return supabaseService.upsertNode(type, String(name), properties || {}, scope);
}

function _findEmployeeIdByName(employees, name) {
    if (!name || !Array.isArray(employees)) return null;
    const target = String(name).trim().toLowerCase();
    const match = employees.find(e => String(e.Name || '').trim().toLowerCase() === target);
    return match?.id || null;
}

async function apply({ jobId, channel, agent, result, businessCtx, scope }) {
    const out = {
        nodesAdded: 0,
        nodesUpdated: 0,
        edgesAdded: 0,
        followUpsAdded: 0,
    };

    const { graphDiff = {}, followUps = [] } = result || {};
    // Default scope: business / no employee. Comms-scope callers must pass scope explicitly.
    const effectiveScope = scope || { scope_type: 'business', scope_employee_id: null };
    if (effectiveScope.scope_type === 'comms' && !effectiveScope.scope_employee_id) {
        throw new Error('diffApplier.apply: comms-scope writes require scope.scope_employee_id');
    }

    // 1. Added + updated nodes — both go through upsertNode (it merges within scope).
    const nodeIdByKey = new Map(); // "type|name" -> id, used by edge resolution
    for (const node of (graphDiff.addedNodes || [])) {
        const id = await _resolveNodeId(node, effectiveScope);
        if (id) {
            nodeIdByKey.set(`${node.type}|${node.name}`, id);
            out.nodesAdded++;
        }
    }
    for (const upd of (graphDiff.updatedNodes || [])) {
        if (!upd?.match) continue;
        const id = await _resolveNodeId({
            type: upd.match.type,
            name: upd.match.name,
            properties: upd.properties || {},
        }, effectiveScope);
        if (id) {
            nodeIdByKey.set(`${upd.match.type}|${upd.match.name}`, id);
            out.nodesUpdated++;
        }
    }

    // 2. Edges — resolve endpoints (may need to upsert nodes if missing) within scope.
    for (const edge of (graphDiff.addedEdges || [])) {
        if (!edge?.fromType || !edge?.fromName || !edge?.toType || !edge?.toName || !edge?.relationship_type) continue;
        const fromKey = `${edge.fromType}|${edge.fromName}`;
        const toKey   = `${edge.toType}|${edge.toName}`;
        let fromId = nodeIdByKey.get(fromKey) || await _resolveNodeId({ type: edge.fromType, name: edge.fromName }, effectiveScope);
        let toId   = nodeIdByKey.get(toKey)   || await _resolveNodeId({ type: edge.toType,   name: edge.toName }, effectiveScope);
        if (!fromId || !toId) continue;
        const edgeId = await supabaseService.createEdge(
            fromId, toId, edge.relationship_type, edge.properties || {}, effectiveScope
        );
        if (edgeId) out.edgesAdded++;
    }

    // 3. Follow-ups
    if (followUps.length && supabaseService.client) {
        const rows = followUps.map(f => ({
            channel,
            source_job_id: jobId,
            employee_id: _findEmployeeIdByName(businessCtx?.employees, f.targetEmployeeName),
            priority: ['low','normal','high','urgent'].includes(f.priority) ? f.priority : 'normal',
            title: String(f.title || '(untitled)').slice(0, 300),
            description: f.description ? String(f.description).slice(0, 2000) : null,
            suggested_action: f.suggested_action || null,
            related_node_ids: null,
        }));
        const { error } = await supabaseService.client.from('follow_ups').insert(rows);
        if (error) {
            console.error(`diffApplier: follow_ups insert failed for job ${jobId}:`, error.message);
        } else {
            out.followUpsAdded = rows.length;
        }
    }

    return out;
}

module.exports = { apply };
