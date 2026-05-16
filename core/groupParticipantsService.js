// Manages the `wa_group_participants` table — the per-(group, member) resolution
// state that gates whether a tracked group's messages are actually persisted.

const supabaseService = require('./supabaseService');
const waClient        = require('./waClient');

function client() {
    return supabaseService.client; // exposed via the existing wrapper
}

// ─── Seeding ────────────────────────────────────────────────────────────────
// Called when the user clicks "Track group". Fetches the live participant
// roster from WhatsApp, attempts to auto-match each participant against the
// `contacts` table, and writes one row per participant with the right
// resolved/unresolved state. The logged-in employee is always auto-resolved.

async function seedGroupParticipants(employeeId, groupJid, ownerEmployeeJid = null) {
    const sb = client();
    if (!sb) throw new Error('Supabase not configured');

    const participants = await waClient.getGroupParticipants(employeeId, groupJid);
    if (!participants) throw new Error('WA session not connected');

    // Bulk-pull contacts once and match in memory (avoids 50× round-trips)
    const { data: contacts = [] } = await sb.from('contacts').select('id, phone, wa_jid, wa_lid');
    const byPhone = new Map(); const byJid = new Map(); const byLid = new Map();
    for (const c of contacts) {
        if (c.phone)  byPhone.set(c.phone,  c.id);
        if (c.wa_jid) byJid.set(c.wa_jid,   c.id);
        if (c.wa_lid) byLid.set(c.wa_lid,   c.id);
    }

    const rows = participants.map(p => {
        const phoneJid = p.phone || (p.jid && !p.jid.endsWith('@lid') ? p.jid : null);
        const phoneNum = phoneJid ? phoneJid.split('@')[0] : null;
        const lid      = p.lid || (p.jid?.endsWith('@lid') ? p.jid : null);

        // Auto-match priority: phone > jid > lid
        let contactId =
            (phoneNum && byPhone.get(phoneNum)) ||
            (phoneJid && byJid.get(phoneJid))   ||
            (lid      && byLid.get(lid))        ||
            null;

        // The logged-in employee themselves — auto-resolve even if no contact row yet
        const isOwner = ownerEmployeeJid && (
            p.jid   === ownerEmployeeJid ||
            phoneJid === ownerEmployeeJid
        );

        return {
            employee_id:     employeeId,
            group_jid:       groupJid,
            participant_jid: p.jid,
            participant_lid: lid,
            notify_name:     p.notify || null,
            contact_id:      contactId,
            resolved:        Boolean(contactId || isOwner),
        };
    });

    // Upsert in one go; uniqueness is (employee_id, group_jid, participant_jid)
    const { error } = await sb
        .from('wa_group_participants')
        .upsert(rows, { onConflict: 'employee_id,group_jid,participant_jid' });
    if (error) throw error;

    return rows;
}

// ─── Listing ────────────────────────────────────────────────────────────────

async function listForGroup(employeeId, groupJid) {
    const sb = client();
    const { data, error } = await sb
        .from('wa_group_participants')
        .select('*, contact:contacts(id, name, category, role, email, phone)')
        .eq('employee_id', employeeId)
        .eq('group_jid',   groupJid);
    if (error) throw error;
    return data || [];
}

async function isGroupReady(employeeId, groupJid) {
    const sb = client();
    const { count, error } = await sb
        .from('wa_group_participants')
        .select('*', { count: 'exact', head: true })
        .eq('employee_id', employeeId)
        .eq('group_jid',   groupJid)
        .eq('resolved',    false);
    if (error) throw error;
    return (count || 0) === 0;
}

// ─── Resolution ─────────────────────────────────────────────────────────────
// Links an existing contact to a participant row.

async function resolveParticipant(employeeId, groupJid, participantJid, contactId) {
    const sb = client();
    const { error } = await sb
        .from('wa_group_participants')
        .update({ contact_id: contactId, resolved: true })
        .eq('employee_id',     employeeId)
        .eq('group_jid',       groupJid)
        .eq('participant_jid', participantJid);
    if (error) throw error;
}

// Returns the set of groups (for an employee) that have zero unresolved participants.
// Used by the WA message handler to gate persistence.

async function getReadyGroupSet(employeeId) {
    const sb = client();
    const { data, error } = await sb
        .from('wa_group_participants')
        .select('group_jid, resolved')
        .eq('employee_id', employeeId);
    if (error) throw error;

    const byGroup = new Map();
    for (const r of data || []) {
        const cur = byGroup.get(r.group_jid) || { total: 0, unresolved: 0 };
        cur.total      += 1;
        if (!r.resolved) cur.unresolved += 1;
        byGroup.set(r.group_jid, cur);
    }
    const ready = new Set();
    for (const [jid, s] of byGroup) if (s.total > 0 && s.unresolved === 0) ready.add(jid);
    return ready;
}

// For the Tracked tab: map of groupJid → unresolved count for one employee.
async function getUnresolvedCountsByEmployee(employeeId) {
    const sb = client();
    const { data, error } = await sb
        .from('wa_group_participants')
        .select('group_jid, resolved')
        .eq('employee_id', employeeId);
    if (error) throw error;

    const counts = {};
    for (const r of data || []) {
        if (!counts[r.group_jid]) counts[r.group_jid] = { total: 0, unresolved: 0 };
        counts[r.group_jid].total += 1;
        if (!r.resolved) counts[r.group_jid].unresolved += 1;
    }
    return counts;
}

module.exports = {
    seedGroupParticipants,
    listForGroup,
    isGroupReady,
    resolveParticipant,
    getReadyGroupSet,
    getUnresolvedCountsByEmployee,
};
