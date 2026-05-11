// Applies an agent's graph diff + follow-ups to the database.
//
// - addedNodes:   upsertNode() — idempotent on (type, name)
// - updatedNodes: upsertNode() with merged properties (same path)
// - addedEdges:   resolve endpoints by (type, name), then insert edge
// - followUps:    insert into follow_ups table
//
// Resolution of targetEmployeeName -> employee_id happens here so the agent
// only has to deal with names.

const supabaseService = require('../supabaseService');

async function _resolveNodeId({ type, name, properties }) {
    if (!type || !name) return null;
    // upsertNode is idempotent: if a node with (type, name) exists, properties merge.
    return supabaseService.upsertNode(type, String(name), properties || {});
}

function _findEmployeeIdByName(employees, name) {
    if (!name || !Array.isArray(employees)) return null;
    const target = String(name).trim().toLowerCase();
    const match = employees.find(e => String(e.Name || '').trim().toLowerCase() === target);
    return match?.id || null;
}

async function apply({ jobId, channel, agent, result, businessCtx }) {
    const out = {
        nodesAdded: 0,
        nodesUpdated: 0,
        edgesAdded: 0,
        followUpsAdded: 0,
    };

    const { graphDiff = {}, followUps = [] } = result || {};

    // 1. Added + updated nodes — both go through upsertNode (it merges).
    const nodeIdByKey = new Map(); // "type|name" -> id, used by edge resolution
    for (const node of (graphDiff.addedNodes || [])) {
        const id = await _resolveNodeId(node);
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
        });
        if (id) {
            nodeIdByKey.set(`${upd.match.type}|${upd.match.name}`, id);
            out.nodesUpdated++;
        }
    }

    // 2. Edges — resolve endpoints (may need to upsert nodes if missing).
    for (const edge of (graphDiff.addedEdges || [])) {
        if (!edge?.fromType || !edge?.fromName || !edge?.toType || !edge?.toName || !edge?.relationship_type) continue;
        const fromKey = `${edge.fromType}|${edge.fromName}`;
        const toKey   = `${edge.toType}|${edge.toName}`;
        let fromId = nodeIdByKey.get(fromKey) || await _resolveNodeId({ type: edge.fromType, name: edge.fromName });
        let toId   = nodeIdByKey.get(toKey)   || await _resolveNodeId({ type: edge.toType,   name: edge.toName });
        if (!fromId || !toId) continue;
        const edgeId = await supabaseService.createEdge(fromId, toId, edge.relationship_type, edge.properties || {});
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
