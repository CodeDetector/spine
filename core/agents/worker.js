// Refinement-agent worker.
//
// Polls the agent_jobs queue and dispatches each job to its channel agent.
// Three-agent migration is in progress (see specs/2026-05-11-three-agent-architecture.md).
// Phase B: all channels currently route to NoopAgent — jobs drain harmlessly.
// Phase C: BusinessContextAgent replaces noop for 'business'.
// Phase D: CommunicationsAgent replaces noop for 'email' and 'whatsapp'.

const supabaseService = require('../supabaseService');
const businessContext = require('./businessContext');
const diffApplier = require('./diffApplier');
const BusinessContextAgent = require('./businessContextAgent');
const CommunicationsAgent = require('./communicationsAgent');

const POLL_INTERVAL_MS    = 5000;
const BATCH_SIZE          = 5;
const MAX_ATTEMPTS        = 3;
const STALE_RUNNING_MS    = 60 * 1000;

// Map of channel -> agent. Set via registerAgent().
const _agents = new Map();

function registerAgent(channel, agent) {
    if (!agent || typeof agent.refine !== 'function') {
        throw new Error(`registerAgent(${channel}): agent must have refine(job, ctx)`);
    }
    _agents.set(channel, agent);
    console.log(`🤖 agent registered for channel: ${channel} → ${agent.name || '(anonymous)'}`);
}

// Default no-op agent — produces an empty diff and zero follow-ups.
// Used for channels we haven't built a real agent for yet, so jobs don't pile up.
const NoopAgent = {
    name: 'NoopAgent',
    async refine() {
        return { graphDiff: { addedNodes: [], updatedNodes: [], addedEdges: [] }, followUps: [], notes: 'noop' };
    },
};

async function _resetStaleRunning() {
    if (!supabaseService.client) return;
    const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
    const { error, count } = await supabaseService.client
        .from('agent_jobs')
        .update({ status: 'pending' }, { count: 'exact' })
        .eq('status', 'running')
        .lt('started_at', cutoff);
    if (error) {
        console.error('worker: failed to reset stale running jobs:', error.message);
    } else if (count) {
        console.log(`worker: reset ${count} stale running job(s)`);
    }
}

async function _claimBatch() {
    if (!supabaseService.client) return [];
    // Two-step claim: read pending IDs, then update status='running'. We rely
    // on the unique nature of new inserts + low contention since we run a
    // single worker today. When we add concurrent workers we'll move to a
    // FOR UPDATE SKIP LOCKED pattern via an RPC.
    const { data: pending, error: selErr } = await supabaseService.client
        .from('agent_jobs')
        .select('id, channel, source_table, source_id, payload, attempts')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);
    if (selErr) {
        console.error('worker: select pending failed:', selErr.message);
        return [];
    }
    if (!pending || pending.length === 0) return [];

    const ids = pending.map(j => j.id);
    const { error: updErr } = await supabaseService.client
        .from('agent_jobs')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .in('id', ids)
        .eq('status', 'pending'); // guard against double-claim
    if (updErr) {
        console.error('worker: claim update failed:', updErr.message);
        return [];
    }
    return pending;
}

async function _markDone(jobId, durationMs) {
    await supabaseService.client.from('agent_jobs').update({
        status: 'done',
        completed_at: new Date().toISOString(),
    }).eq('id', jobId);
}

async function _markFailed(jobId, attempts, errMsg) {
    const next = attempts + 1;
    const isTerminal = next >= MAX_ATTEMPTS;
    await supabaseService.client.from('agent_jobs').update({
        status: isTerminal ? 'failed' : 'pending',
        attempts: next,
        last_error: errMsg?.slice(0, 1000) || 'unknown',
        completed_at: isTerminal ? new Date().toISOString() : null,
    }).eq('id', jobId);
    if (isTerminal) console.error(`worker: job ${jobId} marked failed after ${next} attempts`);
}

async function _writeAuditRow({ jobId, agent, model, durationMs, graphDiff, followUpCount, notes }) {
    try {
        await supabaseService.client.from('agent_runs').insert([{
            job_id: jobId,
            agent_name: agent,
            model: model || null,
            graph_diff: graphDiff || null,
            follow_ups_emitted: followUpCount || 0,
            duration_ms: durationMs,
            notes: notes || null,
        }]);
    } catch (err) {
        console.error('worker: audit insert failed:', err.message);
    }
}

async function _processOne(job, ctx) {
    const agent = _agents.get(job.channel) || NoopAgent;
    const t0 = Date.now();
    try {
        const result = await agent.refine(job, ctx);

        // Apply diff. Two modes:
        //  - default: the worker applies once with the scope on the result
        //    (or business-default scope if absent). Used by Business + Noop.
        //  - opt-out: agent sets result.alreadyApplied=true if it ran the
        //    applier itself per-participant. Used by CommunicationsAgent.
        let applied = { nodesAdded: 0, nodesUpdated: 0, edgesAdded: 0, followUpsAdded: 0 };
        if (!result?.alreadyApplied) {
            applied = await diffApplier.apply({
                jobId: job.id,
                channel: job.channel,
                agent: agent.name,
                result,
                businessCtx: ctx,
                scope: result?.scope,
            });
        } else if (result?.appliedSummary) {
            applied = result.appliedSummary; // agent reports what it applied
        }

        const duration = Date.now() - t0;
        await _writeAuditRow({
            jobId: job.id,
            agent: agent.name || 'unknown',
            model: result?.model,
            durationMs: duration,
            graphDiff: result?.graphDiff,
            followUpCount: applied.followUpsAdded,
            notes: [
                result?.notes,
                `applied: +${applied.nodesAdded}n / ~${applied.nodesUpdated}n / +${applied.edgesAdded}e / +${applied.followUpsAdded}f`,
            ].filter(Boolean).join(' | '),
        });
        await _markDone(job.id, duration);
    } catch (err) {
        console.error(`worker: job ${job.id} (${job.channel}) failed:`, err.message);
        await _markFailed(job.id, job.attempts || 0, err.message);
    }
}

async function _tick() {
    if (!supabaseService.client) return;
    const batch = await _claimBatch();
    if (batch.length === 0) return;

    // Cached for 60s — single fetch even if multiple ticks fire in that window.
    let ctx = null;
    try {
        ctx = await businessContext.getContext();
    } catch (err) {
        // Don't fail the tick — agents that need context will degrade gracefully.
        console.warn('worker: businessContext.getContext failed:', err.message);
    }

    for (const job of batch) {
        await _processOne(job, ctx);
    }
}

let _interval = null;
let _started = false;

function start() {
    if (_started) return;
    _started = true;
    console.log('🤖 agent worker starting…');
    // Phase D of the three-agent migration: all channel agents are live.
    // Synthesis runs on a separate cron (Phase F).
    if (!_agents.has('email'))    registerAgent('email',    CommunicationsAgent);
    if (!_agents.has('whatsapp')) registerAgent('whatsapp', CommunicationsAgent);
    if (!_agents.has('business')) registerAgent('business', BusinessContextAgent);

    _resetStaleRunning().catch(() => {});
    _interval = setInterval(() => {
        _tick().catch(err => console.error('worker tick error:', err.message));
    }, POLL_INTERVAL_MS);
}

function stop() {
    if (_interval) { clearInterval(_interval); _interval = null; }
    _started = false;
}

module.exports = { start, stop, registerAgent };
