// HTTP client for the omni-whatsapp microservice.
// All WA session management goes over /sessions/:employeeId/* on the bridge
// network, authenticated with the internal service token.

const BASE_URL = process.env.WA_SERVICE_URL || 'http://omni-whatsapp:3001';

async function call(path, init = {}) {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN || '',
            ...(init.headers || {}),
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`waClient ${init.method || 'GET'} ${path} ${res.status}: ${text}`);
    }
    return res.json();
}

// ─── Session lifecycle ──────────────────────────────────────────────────────
const startSession = (employeeId) =>
    call(`/sessions/${employeeId}/start`, { method: 'POST' });

const getStatus = (employeeId) =>
    call(`/sessions/${employeeId}/status`);

const disconnect = (employeeId) =>
    call(`/sessions/${employeeId}/disconnect`, { method: 'POST' });

// ─── Contacts / groups ──────────────────────────────────────────────────────
const listGroups = (employeeId) =>
    call(`/sessions/${employeeId}/groups`);

const listContacts = (employeeId) =>
    call(`/sessions/${employeeId}/contacts`);

const resolvePhone = (employeeId, phone) =>
    call(`/sessions/${employeeId}/contacts/resolve`, {
        method: 'POST',
        body: JSON.stringify({ phone }),
    });

// ─── Tracked chats ──────────────────────────────────────────────────────────
const listTracked = (employeeId) =>
    call(`/sessions/${employeeId}/tracked`);

const trackChat = (employeeId, jid, displayName, chatType = 'group') =>
    call(`/sessions/${employeeId}/track`, {
        method: 'POST',
        body: JSON.stringify({ jid, displayName, chatType }),
    });

const untrackChat = (employeeId, jid) =>
    call(`/sessions/${employeeId}/track`, {
        method: 'DELETE',
        body: JSON.stringify({ jid }),
    });

module.exports = {
    startSession, getStatus, disconnect,
    listGroups, listContacts, resolvePhone,
    listTracked, trackChat, untrackChat,
};
