// Given a comms message job payload, return:
//   { threadId, participantEmployeeIds: number[] }
//
// Participant detection is the rule that decides whose comms-graph slice
// gets the resulting nodes/edges. See PRD §4 for the model.
//
// Channels:
//   - email: thread = emails.threadId; participants = employees whose emailId
//            matches any From/To/Cc address present in the payload.
//   - whatsapp group (jid ends @g.us): thread = chatJid; participants currently
//            limited to the session owner. TODO: expand via WA group metadata
//            to include all employees whose phone is in the group.
//   - whatsapp 1:1 (jid ends @s.whatsapp.net): thread = chatJid; participant =
//            the session owner only (correct by definition).

const supabaseService = require('../supabaseService');

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_DIGITS = (s) => String(s || '').replace(/\D+/g, '');

function _extractEmails(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(EMAIL_RE)) out.add(m[0].toLowerCase());
    return [...out];
}

async function _resolveEmailsToEmployeeIds(emails) {
    if (!emails.length || !supabaseService.client) return [];
    const lc = emails.map(e => e.toLowerCase());
    const { data, error } = await supabaseService.client
        .from('employees')
        .select('id, emailId')
        .in('emailId', lc);
    if (error) {
        console.error('threadResolver: employee lookup by emailId failed:', error.message);
        return [];
    }
    return (data || []).map(r => r.id);
}

async function _resolvePhonesToEmployeeIds(phones) {
    if (!phones.length || !supabaseService.client) return [];
    const normalized = phones.map(PHONE_DIGITS).filter(Boolean);
    if (!normalized.length) return [];
    // employees.Mobile may have formatting; match on normalized digits.
    // For simplicity, fetch all employees and filter in memory — small table.
    const { data, error } = await supabaseService.client
        .from('employees')
        .select('id, Mobile');
    if (error) {
        console.error('threadResolver: employee lookup by Mobile failed:', error.message);
        return [];
    }
    const targetSet = new Set(normalized);
    return (data || [])
        .filter(e => targetSet.has(PHONE_DIGITS(e.Mobile)))
        .map(e => e.id);
}

async function resolve({ channel, payload }) {
    const p = payload || {};

    if (channel === 'email') {
        const threadId = p.threadId || p.messageTraceId || `unknown-${Date.now()}`;
        // Pull every email address mentioned in the From/To/Cc, plus any addresses
        // that appear in the message body (defensive — sometimes headers are sparse).
        const candidates = new Set();
        for (const v of [p.sender, p.receiver]) {
            if (v) for (const e of _extractEmails(v)) candidates.add(e);
        }
        // Body scan is bounded — only first 4 KB to avoid pulling everything.
        for (const e of _extractEmails(String(p.message || '').slice(0, 4096))) candidates.add(e);
        const participantEmployeeIds = await _resolveEmailsToEmployeeIds([...candidates]);
        return { threadId, participantEmployeeIds };
    }

    if (channel === 'whatsapp') {
        const threadId = p.chatJid || `unknown-${Date.now()}`;
        // Session owner is always a participant — this is provided by mapMyWhatsapp.
        const ownerId = p.employeeId ? Number(p.employeeId) : null;
        const ids = ownerId ? new Set([ownerId]) : new Set();

        // Future: expand for @g.us — look up all employees whose Mobile is in
        // the group. Today we under-approximate and only attribute to the
        // session owner; that's correct for 1:1, incomplete for groups but
        // safe (we'd rather miss-share than over-share).

        // If the payload includes phone numbers (e.g. senderNumber for a participant),
        // resolve them too — covers the case where a *different* employee is the sender
        // in a group chat the current session owner is also in.
        if (p.senderNumber) {
            const extra = await _resolvePhonesToEmployeeIds([p.senderNumber]);
            for (const id of extra) ids.add(id);
        }

        return { threadId, participantEmployeeIds: [...ids] };
    }

    return { threadId: `unknown-${Date.now()}`, participantEmployeeIds: [] };
}

// Persist participants for a thread. Idempotent (unique constraint absorbs dupes).
async function recordParticipants(channel, threadId, employeeIds) {
    if (!supabaseService.client || !employeeIds?.length) return;
    const rows = employeeIds.map(employee_id => ({ channel, thread_id: threadId, employee_id }));
    const { error } = await supabaseService.client
        .from('thread_participants')
        .upsert(rows, { onConflict: 'channel,thread_id,employee_id', ignoreDuplicates: true });
    if (error) {
        console.error('threadResolver: thread_participants upsert failed:', error.message);
    }
}

module.exports = { resolve, recordParticipants };
