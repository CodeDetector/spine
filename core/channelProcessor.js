/**
 * Layer 2 — Channel Processor
 *
 * Called after Layer 1 (intake) has already written to `messages`.
 * Handles per-channel concerns:
 *
 *   processEmail(payload, messageTraceId)
 *     - Always writes to `emails` table (full email metadata)
 *     - Scores business relevance via Gemini
 *     - Only ingests into knowledge graph if score > RELEVANCE_THRESHOLD (80)
 *     - Marks knowledge map dirty
 *
 *   processWhatsApp(payload, messageTraceId)
 *     - Always writes to `Whatsapp` table (channel metadata)
 *     - Always ingests into knowledge graph (already filtered by tracked chats)
 *     - Marks knowledge map dirty
 *
 * Expected payload shapes:
 *
 *   Email payload:
 *   {
 *     sender, receiver, message, employeeId, oppositionId?,
 *     mediaHash?, mediaUrl?, hash?, threadId?
 *   }
 *
 *   WhatsApp payload:
 *   {
 *     employeeId, messageTraceId (same as passed arg), chatJid,
 *     senderName?, senderNumber?, messageText (for graph)
 *   }
 */

const supabaseService    = require('./supabaseService');
const intelligenceService = require('./intelligenceService');

const RELEVANCE_THRESHOLD = 80;

// ── Email ────────────────────────────────────────────────────────────────────

async function processEmail(payload, messageTraceId) {
    // 1. Always store in emails table
    await _writeToEmailsTable(payload);

    // 2. Mark knowledge map dirty regardless of relevance
    if (payload.employeeId) {
        await supabaseService.markKnowledgeMapDirty(payload.employeeId);
    }

    // 3. Relevance gate — only enrich graph if score > threshold
    const emailText = payload.message || '';
    const score = await intelligenceService.scoreEmailRelevance(emailText);

    if (score > RELEVANCE_THRESHOLD) {
        console.log(`✅ Email relevance ${score} > ${RELEVANCE_THRESHOLD} — enriching graph`);
        await intelligenceService.processMessageForGraph(emailText, {
            messageId: messageTraceId || `EMAIL-${Date.now()}`,
            sender: payload.sender,
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

// ── WhatsApp ─────────────────────────────────────────────────────────────────

async function processWhatsApp(payload, messageTraceId) {
    // 1. Always write WA channel metadata
    await _writeToWhatsAppTable(payload, messageTraceId);

    // 2. Mark knowledge map dirty
    if (payload.employeeId) {
        await supabaseService.markKnowledgeMapDirty(payload.employeeId);
    }

    // 3. Always enrich graph (WA messages are pre-filtered by tracked chats)
    const messageText = payload.messageText || '';
    if (messageText) {
        // Resolve phone → email identity so the graph node can be unified
        // with email interactions from the same person.
        let senderLabel = payload.senderName || payload.senderNumber;
        if (payload.senderNumber && payload.employeeId) {
            const identity = await supabaseService.resolvePhoneToEmail(
                payload.employeeId, payload.senderNumber
            );
            if (identity) {
                // Prefer display name; annotate the node with the linked email
                senderLabel = identity.display_name || payload.senderName || payload.senderNumber;
                // Upsert the node with email property so future email messages
                // that use the same email address will resolve to the same node.
                await supabaseService.upsertNode('Contact', senderLabel, {
                    phone: payload.senderNumber,
                    email: identity.email,
                });
            }
        }
        await intelligenceService.processMessageForGraph(messageText, {
            messageId: messageTraceId || `WA-${Date.now()}`,
            sender: senderLabel,
        });
    }
}

async function _writeToWhatsAppTable(payload, messageTraceId) {
    if (!supabaseService.client) return;
    try {
        const { error } = await supabaseService.client
            .from('Whatsapp')
            .upsert([{
                employeeID:     payload.employeeId,
                messageTraceId: messageTraceId,
                chatJid:        payload.chatJid        || null,
                senderName:     payload.senderName     || null,
                senderNumber:   payload.senderNumber   || null,
            }], { onConflict: 'messageTraceId' });
        if (error) console.error('❌ channelProcessor: Whatsapp upsert failed:', error.message);
    } catch (err) {
        console.error('❌ channelProcessor: _writeToWhatsAppTable failed:', err.message);
    }
}

module.exports = { processEmail, processWhatsApp };
