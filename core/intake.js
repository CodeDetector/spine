/**
 * Layer 1 — Intake Middleware
 *
 * Receives a normalized canonical message from any channel (email, WhatsApp, IMAP…)
 * and writes it to the shared `messages` table. Always runs — no content filtering,
 * no channel-specific logic. Every message that enters the platform is stored here.
 *
 * Returns the messageTraceId so Layer 2 can reference it.
 *
 * Canonical message shape expected by this layer:
 * {
 *   messageId:    string   — unique trace ID (e.g. GMAIL-<id>, WA-<key.id>)
 *   format:       string   — 'text' | 'photo' | 'audio' | 'video' | 'pdf'
 *   messageDetails: string — text content of the message
 *   employeeId:   number   — owner employee's DB id
 *   mediaUrl?:    string
 *   mediaHash?:   string
 *   objectId?:    string
 * }
 */

const supabaseService = require('./supabaseService');
const MessageDTO      = require('./dto');

async function intake(message) {
    if (!message?.messageId || !message?.employeeId) {
        console.warn('⚠️  intake: missing messageId or employeeId — skipping write');
        return null;
    }

    const dto     = new MessageDTO(message, message.employeeId);
    const payload = dto.getPayload();

    const { error } = await supabaseService.client
        .from('messages')
        .insert([payload]);

    if (error) {
        // 23505 = unique_violation — already stored (e.g. retry / edit event)
        if (error.code === '23505') {
            console.log(`ℹ️  intake: message ${message.messageId} already in messages table`);
        } else {
            console.error('❌ intake: messages insert failed:', error.message);
            return null;
        }
    }

    return payload.messageTraceId;
}

module.exports = { intake };
