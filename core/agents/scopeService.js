// Scope service: resolves which employee IDs a caller is allowed to see.
//
// Used by /api/graph/*, /api/follow_ups, and the SynthesisAgent. Wraps the
// `visible_employee_ids(p_employee_id)` Postgres function from the migration.
//
// Caching: a 30-second per-process cache. The downline tree is slowly mutating
// (rare hires/manager changes) so a fresh value within 30s is fine. Cache
// keyed by employee_id; cleared on process restart.

const supabaseService = require('../supabaseService');

const CACHE_TTL_MS = 30 * 1000;
const _cache = new Map(); // employeeId -> { expiresAt, ids: number[] }

/**
 * Returns the array of employee IDs the given employee can see:
 * themselves + everyone reporting to them (recursively).
 *
 * Returns [] if the employee row doesn't exist or the RPC fails.
 */
async function visibleEmployeeIds(employeeId) {
    const empId = Number(employeeId);
    if (!empId || !supabaseService.client) return [];

    const cached = _cache.get(empId);
    if (cached && cached.expiresAt > Date.now()) return cached.ids;

    const { data, error } = await supabaseService.client
        .rpc('visible_employee_ids', { p_employee_id: empId });

    if (error) {
        console.error(`scopeService: rpc failed for ${empId}:`, error.message);
        // Fail-closed: return just the employee themselves rather than throwing,
        // so a single caller doesn't lose access to their own data on an RPC blip.
        return [empId];
    }

    const ids = (data || []).map(r => r.id);
    _cache.set(empId, { expiresAt: Date.now() + CACHE_TTL_MS, ids });
    return ids;
}

function invalidate(employeeId) {
    if (employeeId === undefined) _cache.clear();
    else _cache.delete(Number(employeeId));
}

module.exports = { visibleEmployeeIds, invalidate };
