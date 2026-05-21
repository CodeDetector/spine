/**
 * Layer 2 — Channel Processor
 *
 * Called after Layer 1 (intake) has already written to `messages`.
 * Handles per-channel concerns:
 *
 *   processEmail(payload, messageTraceId)
 *     - Always writes to `emails` table (full email metadata)
 *     - Scores business relevance via Gemini
 *     - Only enqueues a CommunicationsAgent job if score > RELEVANCE_THRESHOLD (80)
 *
 * Expected payload shapes:
 *
 *   Email payload:
 *   {
 *     sender, receiver, message, employeeId, oppositionId?,
 *     mediaHash?, mediaUrl?, hash?, threadId?
 *   }
 */

const supabaseService     = require('./supabaseService');
const intelligenceService = require('./intelligenceService');
const { enqueue: enqueueAgentJob } = require('./agents/queue');

const RELEVANCE_THRESHOLD = 80;

// ── Email ────────────────────────────────────────────────────────────────────

async function processEmail(payload, messageTraceId) {
    // 1. Always store in emails table
    await _writeToEmailsTable(payload);

    // 2. Relevance gate — only enrich graph if score > threshold
    const emailText = payload.message || '';
    const score = await intelligenceService.scoreEmailRelevance(emailText);

    if (score > RELEVANCE_THRESHOLD) {
        console.log(`✅ Email relevance ${score} > ${RELEVANCE_THRESHOLD} — enqueuing for CommunicationsAgent`);
        await enqueueAgentJob({
            channel: 'email',
            sourceTable: 'emails',
            sourceId: null,
            payload: {
                messageTraceId: messageTraceId || null,
                sender:       payload.sender       || null,
                receiver:     payload.receiver     || null,
                message:      emailText,
                employeeId:   payload.employeeId   || null,
                threadId:     payload.threadId     || null,
                relevanceScore: score,
            },
        });
    } else {
        console.log(`⏭️  Email relevance ${score} ≤ ${RELEVANCE_THRESHOLD} — skipping graph enrichment`);
    }
}

async function _writeToEmailsTable(payload) {
    if (!supabaseService.client) return;
    try {
        // Deduplicate by hash if provided
        if (payload.hash) {
            const { data: existing } = await supabaseService.client
                .from('emails')
                .select('id')
                .eq('hash', payload.hash)
                .maybeSingle();
            if (existing) {
                console.log(`⏭️  Email hash ${String(payload.hash).slice(0, 10)}… already stored`);
                return;
            }
        }
        const { error } = await supabaseService.client.from('emails').insert([{
            sender:       payload.sender       || null,
            receiver:     payload.receiver     || null,
            message:      payload.message      || null,
            employeeId:   payload.employeeId   || null,
            oppositionId: payload.oppositionId || null,
            mediaHash:    payload.mediaHash    || null,
            mediaUrl:     payload.mediaUrl     || null,
            hash:         payload.hash         || null,
            threadId:     payload.threadId     || null,
        }]);
        if (error) console.error('❌ channelProcessor: emails insert failed:', error.message);
    } catch (err) {
        console.error('❌ channelProcessor: _writeToEmailsTable failed:', err.message);
    }
}

// WhatsApp ingestion has moved to the omni-whatsapp container. The default
// handler in mapMyWhatsapp/messageHandler.js now writes to `messages` +
// `Whatsapp` tables and enqueues an agent_jobs row directly. Nothing for the
// backend to do beyond serving the proxy endpoints in server.js.

module.exports = { processEmail };
