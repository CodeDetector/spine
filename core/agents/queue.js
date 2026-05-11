// Enqueue helper for the refinement-agent job queue.
//
// Channel processors and external services call enqueue() after persisting
// a message; the worker (worker.js) drains the queue.

const supabaseService = require('../supabaseService');

/**
 * Enqueue a refinement job.
 *
 * @param {object} job
 * @param {'email'|'whatsapp'|'business'} job.channel
 * @param {string} job.sourceTable - e.g. 'emails', 'Whatsapp', 'suppliers'
 * @param {number|string|null} job.sourceId - PK of the source row, if known
 * @param {object} job.payload - snapshot of the row + any extra context
 * @returns {Promise<{id:number}|null>} - inserted job row, or null on failure
 */
async function enqueue({ channel, sourceTable, sourceId, payload }) {
    if (!supabaseService.client) {
        console.warn('agents/queue: supabase client unavailable, skipping enqueue');
        return null;
    }
    if (!channel || !sourceTable) {
        console.error('agents/queue.enqueue: channel and sourceTable required');
        return null;
    }
    try {
        const { data, error } = await supabaseService.client
            .from('agent_jobs')
            .insert([{
                channel,
                source_table: sourceTable,
                source_id: sourceId ?? null,
                payload: payload || {},
            }])
            .select('id')
            .single();
        if (error) throw error;
        return data;
    } catch (err) {
        // Never let queue failures break the ingest path — they are logged
        // and the message remains in the source table; we can backfill later.
        console.error('agents/queue.enqueue failed:', err.message);
        return null;
    }
}

module.exports = { enqueue };
