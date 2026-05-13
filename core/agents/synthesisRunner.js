// synthesisRunner — drives the SynthesisAgent on a cron + on-demand.
//
// Periodic: every PERIODIC_INTERVAL_MS, scan employees who had comms activity
// since their last synthesis, and run synthesis for each.
//
// On-demand: runFor(employeeId) called from /api/synthesis/refresh. Returns
// cached result if a run completed in the last ON_DEMAND_CACHE_MS, else runs
// a fresh pass.

const supabaseService = require('../supabaseService');
const businessContext = require('./businessContext');
const scopeService = require('./scopeService');
const synthesisAgent = require('./synthesisAgent');

const PERIODIC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const ON_DEMAND_CACHE_MS   = 60 * 1000;       // 60 seconds
const PER_EMPLOYEE_RATE_MS = 5 * 60 * 1000;   // hard floor between runs per employee

let _interval = null;
let _started = false;

async function _employeesNeedingPeriodic() {
    // Pull every employee. Smart skipping is delegated to lastRunWithin().
    // At our scale this is < 1000 rows; if it grows, switch to filtering by
    // comms-graph activity timestamp.
    const { data } = await supabaseService.client
        .from('employees')
        .select('id, Name, Role, is_admin, "managedBy"');
    return data || [];
}

async function _runOne(employee, ctx) {
    // Hard rate limit: skip if a run completed for this employee within the
    // PER_EMPLOYEE_RATE_MS floor. Survives crashes — read from synthesis_runs.
    const recent = await synthesisAgent.lastRunWithin(employee.id, PER_EMPLOYEE_RATE_MS);
    if (recent) return { skipped: 'rate-limited' };

    const visible = await scopeService.visibleEmployeeIds(employee.id);
    if (!visible.length) return { skipped: 'no visible scope' };

    return synthesisAgent.runFor({ employee, businessCtx: ctx, visibleEmployeeIds: visible });
}

async function _tick() {
    if (!supabaseService.client) return;
    let ctx;
    try { ctx = await businessContext.getContext(); }
    catch (err) { console.warn('synthesisRunner: context load failed:', err.message); return; }

    const employees = await _employeesNeedingPeriodic();
    if (!employees.length) return;

    for (const emp of employees) {
        try {
            const r = await _runOne(emp, ctx);
            if (r?.emitted) {
                console.log(`🧠 synthesis emitted ${r.emitted} follow-up(s) for ${emp.Name}`);
            }
        } catch (err) {
            console.error(`synthesisRunner: ${emp.Name} failed:`, err.message);
        }
    }
}

function start() {
    if (_started) return;
    _started = true;
    console.log('🧠 synthesis runner starting (every 10 min)…');
    _interval = setInterval(() => {
        _tick().catch(err => console.error('synthesis tick error:', err.message));
    }, PERIODIC_INTERVAL_MS);
}

function stop() {
    if (_interval) { clearInterval(_interval); _interval = null; }
    _started = false;
}

/**
 * Run synthesis on demand for a specific employee. Honors the 60s cache.
 * Returns the emitted count + a `cached` flag so the caller can tell the UI.
 */
async function runOnDemand(employeeId) {
    if (!supabaseService.client) return { emitted: 0, cached: false };

    const recent = await synthesisAgent.lastRunWithin(employeeId, ON_DEMAND_CACHE_MS);
    if (recent) return { emitted: 0, cached: true, lastRunAt: recent.started_at };

    const { data: empRow } = await supabaseService.client
        .from('employees')
        .select('id, Name, Role, is_admin, "managedBy"')
        .eq('id', employeeId)
        .maybeSingle();
    if (!empRow) return { emitted: 0, cached: false, error: 'employee not found' };

    const ctx = await businessContext.getContext();
    const visible = await scopeService.visibleEmployeeIds(employeeId);
    const r = await synthesisAgent.runFor({ employee: empRow, businessCtx: ctx, visibleEmployeeIds: visible });
    return { ...r, cached: false };
}

module.exports = { start, stop, runOnDemand };
