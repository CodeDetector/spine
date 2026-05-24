const express = require('express');
const path = require('path');
const { config, supabaseService } = require('./core');
const { gmailService } = require('wa-field-tracker-feeder-email');

const cors = require('cors');
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Auth middleware — validates the Bearer JWT from Supabase
async function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { data: { user }, error } = await supabaseService.client.auth.getUser(token);
        if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// Tenant resolution cache. Keyed by JWT sub (auth user id). Saves the DB hop
// on every authed request — without this, requireTenantAuth doubles the
// latency of every endpoint. 60s TTL is short enough that role/admin/business
// changes propagate quickly and long enough to absorb burst traffic.
const TENANT_CACHE_TTL_MS = 60_000;
const _tenantCache = new Map(); // sub -> { employee, business_id, ts }

function _cachedTenant(sub) {
    const hit = _tenantCache.get(sub);
    if (!hit) return null;
    if (Date.now() - hit.ts > TENANT_CACHE_TTL_MS) {
        _tenantCache.delete(sub);
        return null;
    }
    return hit;
}

// Chain after requireAuth. Resolves the JWT user to an employee row, derives
// business_id, and exposes both on req. Returns 403 NO_EMPLOYEE_RECORD for
// authenticated users with no employees row (the PostLoginChooser UI handles
// this case once shipped; until then orphans simply see a 403).
async function _resolveTenant(req, res, next) {
    const sub = req.user?.id;
    if (!sub) return res.status(401).json({ error: 'Unauthorized' });
    const cached = _cachedTenant(sub);
    if (cached) {
        req.employee = cached.employee;
        req.business_id = cached.business_id;
        return next();
    }
    try {
        const employee = await supabaseService.getEmployeeByEmail(req.user.email);
        if (!employee || !employee.business_id) {
            return res.status(403).json({ error: 'NO_EMPLOYEE_RECORD' });
        }
        _tenantCache.set(sub, {
            employee,
            business_id: employee.business_id,
            ts: Date.now(),
        });
        req.employee = employee;
        req.business_id = employee.business_id;
        next();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

function requireTenantAuth(req, res, next) {
    requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (res.headersSent) return;
        _resolveTenant(req, res, next);
    });
}

// Chain after requireAuth (or requireTenantAuth). Gates the request on
// is_admin=true. Reuses req.employee if requireTenantAuth already populated it.
async function requireAdmin(req, res, next) {
    try {
        const employee = req.employee
            || await supabaseService.getEmployeeByEmail(req.user.email);
        if (!employee || !employee.is_admin) {
            return res.status(403).json({ error: 'Admin only' });
        }
        req.employee = employee;
        next();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// ─── Proxy: business onboarding paths -> omni-business container ──────────────
// JWT is validated here; the downstream service trusts the X-Internal-User-* headers
// because omni-business is only reachable on the omni-network bridge (not exposed).
const BUSINESS_SERVICE_URL = process.env.BUSINESS_SERVICE_URL || 'http://omni-business:3002';
const BUSINESS_PROXY_PATHS = [
    '/api/business/profile',
    '/api/suppliers',
    '/api/clients',                    // GET, POST (PATCH /:id/assign matched by prefix below)
    '/api/employees/invite',           // future-proof if you rename
    '/api/invitations',
    '/api/onboarding/status',
];

async function proxyToBusinessService(req, res) {
    try {
        const url = `${BUSINESS_SERVICE_URL}${req.originalUrl}`;
        const init = {
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN || '',
                'X-Internal-User-Email': req.user.email,
                'X-Internal-User-Id': req.user.id,
                // Lets the downstream service skip its own employees lookup.
                // Absent on POST /api/employees (the orphan invite-accept path)
                // where the caller has no employees row yet.
                ...(req.business_id ? { 'X-Internal-Business-Id': String(req.business_id) } : {}),
            },
        };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            init.body = JSON.stringify(req.body || {});
        }
        const upstream = await fetch(url, init);
        const body = await upstream.text();
        res.status(upstream.status);
        const ct = upstream.headers.get('content-type');
        if (ct) res.set('content-type', ct);
        res.send(body);
    } catch (err) {
        console.error('proxyToBusinessService failed:', err.message);
        res.status(502).json({ error: 'Business service unreachable' });
    }
}

for (const p of BUSINESS_PROXY_PATHS) {
    app.use(p, requireTenantAuth, proxyToBusinessService);
}

// Special case: POST /api/employees is the invite-accepting registration path.
// At this point the caller has a Supabase Auth user but no employees row yet,
// so requireTenantAuth would 403. Use plain requireAuth — the downstream
// service derives business_id from the pending invitation row.
app.post('/api/employees', requireAuth, proxyToBusinessService);

// Health check — unauthenticated, used by docker-compose to gate omni-ui on
// omni-backend being actually ready (not just started).
app.get('/health', (req, res) => res.json({ ok: true, service: 'omni-backend' }));

// Public business-existence check — used by the auth page to decide whether
// the visitor is registering a brand-new business (first admin) or signing
// into an existing one. Returns only the boolean, never counts or details.
app.get('/api/onboarding/has-business', async (req, res) => {
    try {
        const businessClient = require('./core/businessClient');
        const status = await businessClient.getOnboardingStatus();
        res.json({ hasBusiness: !!status.hasBusiness });
    } catch (err) {
        // Fail-open: if the service is down, fall back to "no business" so the
        // auth page still renders. Better than blocking the entire UI.
        res.json({ hasBusiness: false });
    }
});

// Auth Endpoints
// In-memory cooldown: track last confirmation email sent per address (60-second window)
const emailCooldowns = {};
function isRateLimitError(msg = '') {
    return /rate.?limit|too many|over.*limit/i.test(msg);
}
function isSmtpError(msg = '') {
    return /sending confirmation|smtp|email.*send|send.*email/i.test(msg);
}
function isAlreadyRegisteredError(msg = '') {
    return /security purposes|only request this after|already registered|user already exists/i.test(msg);
}

app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    try {
        const { createClient } = require('@supabase/supabase-js');
        const tempClient = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data, error } = await tempClient.auth.signUp({ email, password });
        if (error) {
            if (isAlreadyRegisteredError(error.message)) {
                return res.status(409).json({ error: 'ALREADY_REGISTERED' });
            }
            if (isRateLimitError(error.message)) {
                return res.status(429).json({ error: 'EMAIL_RATE_LIMIT' });
            }
            if (isSmtpError(error.message)) {
                return res.status(502).json({ error: 'EMAIL_SMTP_MISCONFIGURED' });
            }
            return res.status(400).json({ error: error.message });
        }
        emailCooldowns[email] = Date.now();
        res.json({ success: true, needsConfirmation: !data.session });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    try {
        const { createClient } = require('@supabase/supabase-js');
        const tempClient = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data, error } = await tempClient.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ error: error.message });
        const employee = await supabaseService.getEmployeeByEmail(email);
        res.json({
            user: { id: data.user.id, email: data.user.email },
            session: data.session,
            employee: employee || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/resend-confirmation', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Enforce 60-second client-side cooldown before hitting Supabase again
    const lastSent = emailCooldowns[email] || 0;
    const secondsLeft = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
    if (secondsLeft > 0) {
        return res.status(429).json({ error: 'EMAIL_RATE_LIMIT', secondsLeft });
    }

    try {
        const { createClient } = require('@supabase/supabase-js');
        const tempClient = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { error } = await tempClient.auth.resend({ type: 'signup', email });
        if (error) {
            if (isRateLimitError(error.message)) {
                return res.status(429).json({ error: 'EMAIL_RATE_LIMIT' });
            }
            return res.status(400).json({ error: error.message });
        }
        emailCooldowns[email] = Date.now();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });
    try {
        const { createClient } = require('@supabase/supabase-js');
        const tempClient = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data, error } = await tempClient.auth.refreshSession({ refresh_token });
        if (error || !data.session) return res.status(401).json({ error: 'Refresh failed — please log in again.' });
        res.json({
            access_token:  data.session.access_token,
            refresh_token: data.session.refresh_token,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { data: { user }, error } = await supabaseService.client.auth.getUser(token);
        if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
        const employee = await supabaseService.getEmployeeByEmail(user.email);
        const businessClient = require('./core/businessClient');
        const onboarding = await businessClient.getOnboardingStatus();
        res.json({
            user: { id: user.id, email: user.email },
            employee: employee || null,
            onboarding,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── WhatsApp (multi-tenant, in omni-whatsapp container) ──────────────────────
// Session management is owned by the omni-whatsapp service. Each endpoint here
// is a thin proxy that validates the user's JWT then makes an internal-token
// call to omni-whatsapp:3001/sessions/:employeeId/*.
const waClient = require('./core/waClient');

function _waError(res, err) {
    console.error('WA proxy error:', err.message);
    res.status(502).json({ error: 'WhatsApp service unreachable: ' + err.message });
}

app.post('/api/whatsapp/connect', requireAuth, async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        await waClient.startSession(Number(employeeId));
        res.json({ ok: true });
    } catch (err) { _waError(res, err); }
});

app.get('/api/whatsapp/status', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        res.json(await waClient.getStatus(employeeId));
    } catch (err) { _waError(res, err); }
});

app.post('/api/whatsapp/disconnect', requireAuth, async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        await waClient.disconnect(Number(employeeId));
        res.json({ ok: true });
    } catch (err) { _waError(res, err); }
});

app.get('/api/whatsapp/groups', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        res.json(await waClient.listGroups(employeeId));
    } catch (err) { _waError(res, err); }
});

app.get('/api/whatsapp/contacts', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        res.json(await waClient.listContacts(employeeId));
    } catch (err) { _waError(res, err); }
});

app.post('/api/whatsapp/contacts/resolve', requireAuth, async (req, res) => {
    const { employeeId, phone } = req.body;
    if (!employeeId || !phone) return res.status(400).json({ error: 'employeeId and phone required' });
    try {
        res.json(await waClient.resolvePhone(Number(employeeId), phone));
    } catch (err) { _waError(res, err); }
});

app.get('/api/whatsapp/tracked', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        const { groupParticipantsService } = require('./core');
        const [tracked, readyGroups] = await Promise.all([
            waClient.listTracked(employeeId),
            groupParticipantsService.getReadyGroupSet(employeeId),
        ]);
        // Surface a group only once every participant is resolved; 1:1 chats pass through.
        const filtered = tracked.filter(t =>
            !t.jid?.endsWith('@g.us') || readyGroups.has(t.jid)
        );
        res.json(filtered);
    } catch (err) { _waError(res, err); }
});
+
app.post('/api/whatsapp/track', requireAuth, async (req, res) => {
    const { employeeId, jid, displayName, chatType = 'group' } = req.body;
    if (!employeeId || !jid) return res.status(400).json({ error: 'employeeId and jid required' });
    try {
        res.json(await waClient.trackChat(Number(employeeId), jid, displayName, chatType));
    } catch (err) { _waError(res, err); }
});

// Tracked groups for an employee, annotated with unresolved-participant counts.
app.get('/api/whatsapp/tracked-with-status', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        const { groupParticipantsService } = require('./core');
        const tracked = await waClient.listTracked(employeeId);
        const counts  = await groupParticipantsService.getUnresolvedCountsByEmployee(employeeId);
        res.json(tracked.map(t => ({
            ...t,
            unresolved: counts[t.jid]?.unresolved || 0,
            totalMembers: counts[t.jid]?.total || 0,
        })));
    } catch (err) { _waError(res, err); }
});

// ─── Group identification (participant resolution) ────────────────────────

// Seed wa_group_participants for a tracked group — called right after track,
// returns the list of participants the user must resolve in the wizard.
app.post('/api/whatsapp/groups/seed-participants', requireAuth, async (req, res) => {
    const { employeeId, jid, ownerJid } = req.body;
    if (!employeeId || !jid) return res.status(400).json({ error: 'employeeId and jid required' });
    try {
        const { groupParticipantsService } = require('./core');
        await groupParticipantsService.seedGroupParticipants(Number(employeeId), jid, ownerJid || null);
        const rows = await groupParticipantsService.listForGroup(Number(employeeId), jid);
        res.json(rows);
    } catch (err) { _waError(res, err); }
});

app.get('/api/whatsapp/groups/:jid/participants', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        const { groupParticipantsService } = require('./core');
        res.json(await groupParticipantsService.listForGroup(employeeId, req.params.jid));
    } catch (err) { _waError(res, err); }
});

app.post('/api/whatsapp/groups/:jid/resolve', requireAuth, async (req, res) => {
    const { employeeId, participantJid, contactId } = req.body;
    if (!employeeId || !participantJid || !contactId) {
        return res.status(400).json({ error: 'employeeId, participantJid, contactId required' });
    }
    try {
        const { groupParticipantsService } = require('./core');
        await groupParticipantsService.resolveParticipant(
            Number(employeeId), req.params.jid, participantJid, contactId
        );
        const ready = await groupParticipantsService.isGroupReady(Number(employeeId), req.params.jid);
        // Tell the WA service to re-read the ready-set so the message gate updates
        waClient.refreshReadyCache(Number(employeeId)).catch(() => {});
        res.json({ ok: true, ready });
    } catch (err) { _waError(res, err); }
});

app.delete('/api/whatsapp/track', requireAuth, async (req, res) => {
    const { employeeId, jid } = req.body;
    if (!employeeId || !jid) return res.status(400).json({ error: 'employeeId and jid required' });
    try {
        await waClient.untrackChat(Number(employeeId), jid);
        res.json({ ok: true });
    } catch (err) { _waError(res, err); }
});

// Per-chat message viewers (read directly from Supabase — no feeder hop).
app.get('/api/whatsapp/messages', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    const jid        = req.query.jid;
    const limit      = Math.min(Number(req.query.limit) || 200, 1000);
    const after      = req.query.after || null;  // ISO timestamp — return only rows newer than this
    if (!employeeId || !jid) return res.status(400).json({ error: 'employeeId and jid required' });
    const messages = await supabaseService.getWhatsAppMessages(employeeId, jid, limit, after);
    res.json(messages);
});

app.get('/api/whatsapp/chat-summaries', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    const summaries = await supabaseService.getWhatsAppChatSummaries(employeeId);
    res.json(summaries);
});


// Secure API Endpoints (Proxies to Supabase)
app.get('/api/employees', requireAuth, async (req, res) => {
    const employees = await supabaseService.getAllEmployees();
    res.json(employees);
});

app.get('/api/stats', requireAuth, async (req, res) => {
    const stats = await supabaseService.getDashboardStats();
    res.json(stats);
});

// Scope helper used by graph + follow_ups reads. Returns the set of employee
// IDs the caller is allowed to see (themselves + transitive reports).
// Returns null if the caller has no employee row — caller decides how to handle.
async function _callerVisibleEmployees(req) {
    const scopeService = require('./core/agents/scopeService');
    const caller = await supabaseService.getEmployeeByEmail(req.user.email);
    if (!caller) return null;
    return scopeService.visibleEmployeeIds(caller.id);
}

app.get('/api/graph/full', requireAuth, async (req, res) => {
    const visible = await _callerVisibleEmployees(req);
    if (visible === null) return res.status(403).json({ error: 'no employee record for caller' });
    const graph = await supabaseService.getFullGraph(visible);
    res.json(graph);
});

app.get('/api/graph/channels', requireAuth, async (req, res) => {
    const visible = await _callerVisibleEmployees(req);
    if (visible === null) return res.status(403).json({ error: 'no employee record for caller' });
    const channels = (req.query.channels || '').split(',').map(s => s.trim()).filter(Boolean);
    const graph = await supabaseService.getGraphByChannels(channels, visible);
    res.json(graph);
});

app.post('/api/employees/toggle-integration', requireAuth, async (req, res) => {
    const { employeeId, provider, enabled } = req.body;
    if (!employeeId || !provider) return res.status(400).json({ error: 'Missing parameters' });
    const success = await supabaseService.toggleIntegration(employeeId, provider, enabled);
    res.json({ success });
});

app.post('/api/employees/remove-integration', requireAuth, async (req, res) => {
    const { employeeId, provider } = req.body;
    if (!employeeId || !provider) return res.status(400).json({ error: 'Missing parameters' });
    const success = await supabaseService.removeEmployeeSecret(employeeId, provider);
    res.json({ success });
});

app.get('/api/graph/context', requireAuth, async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const context = await supabaseService.getGraphContext(name);
    res.json(context);
});

// Pending follow-ups for an employee (email threads + KG commitments)
// LEGACY shape, derived signals. Will be removed in Phase H once the UI
// migrates to /api/follow_ups (agent-emitted).
app.get('/api/followups', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    const data = await supabaseService.getPendingFollowups(employeeId);
    res.json(data);
});

// Agent-emitted follow-ups (the new path). Scoped to caller + their downline.
// Manager-action endpoints (dismiss / done) live alongside.
app.get('/api/follow_ups', requireAuth, async (req, res) => {
    try {
        const visible = await _callerVisibleEmployees(req);
        if (visible === null) return res.status(403).json({ error: 'no employee record for caller' });
        let query = supabaseService.client
            .from('follow_ups')
            .select('*')
            .in('employee_id', visible)
            .order('created_at', { ascending: false })
            .limit(200);
        const status = String(req.query.status || 'open');
        if (status !== 'all') query = query.eq('status', status);
        const { data, error } = await query;
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function _resolveFollowUpForCaller(req, followUpId) {
    const visible = await _callerVisibleEmployees(req);
    if (visible === null) return { error: { status: 403, body: 'no employee record for caller' } };
    const { data, error } = await supabaseService.client
        .from('follow_ups')
        .select('id, employee_id, status')
        .eq('id', followUpId)
        .maybeSingle();
    if (error) return { error: { status: 500, body: error.message } };
    if (!data) return { error: { status: 404, body: 'follow-up not found' } };
    const visibleSet = new Set(visible.map(Number));
    if (data.employee_id !== null && !visibleSet.has(Number(data.employee_id))) {
        return { error: { status: 403, body: 'follow-up out of scope' } };
    }
    return { row: data };
}

app.post('/api/follow_ups/:id/dismiss', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'follow-up id required' });
    const { row, error } = await _resolveFollowUpForCaller(req, id);
    if (error) return res.status(error.status).json({ error: error.body });
    const { error: updErr } = await supabaseService.client
        .from('follow_ups')
        .update({ status: 'dismissed', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
    if (updErr) return res.status(500).json({ error: updErr.message });
    res.json({ ok: true });
});

app.post('/api/follow_ups/:id/done', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'follow-up id required' });
    const { row, error } = await _resolveFollowUpForCaller(req, id);
    if (error) return res.status(error.status).json({ error: error.body });
    const { error: updErr } = await supabaseService.client
        .from('follow_ups')
        .update({ status: 'done', resolved_at: new Date().toISOString() })
        .eq('id', row.id);
    if (updErr) return res.status(500).json({ error: updErr.message });
    res.json({ ok: true });
});

// On-demand synthesis. Honors a 60s cache so users hammering the panel don't
// burn tokens. Triggered when the UI opens the follow-ups view.
app.post('/api/synthesis/refresh', requireAuth, async (req, res) => {
    try {
        const caller = await supabaseService.getEmployeeByEmail(req.user.email);
        if (!caller) return res.status(403).json({ error: 'no employee record for caller' });
        const synthesisRunner = require('./core/agents/synthesisRunner');
        const r = await synthesisRunner.runOnDemand(caller.id);
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Enrich knowledge graph from employee's email history. Enqueues one
// agent_jobs row per historical email; CommunicationsAgent then writes
// the comms graph the same way it does for live messages.
app.post('/api/graph/enrich', async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        const { enqueue: enqueueAgentJob } = require('./core/agents/queue');
        const emails = await supabaseService.getEmailsByEmployeeId(employeeId, 30);

        if (emails.length === 0) {
            return res.json({ success: true, enqueued: 0 });
        }

        let enqueued = 0;
        for (const e of emails) {
            const job = await enqueueAgentJob({
                channel: 'email',
                sourceTable: 'emails',
                sourceId: null,
                payload: {
                    sender:     e.sender   || null,
                    receiver:   e.receiver || null,
                    message:    e.message  || '',
                    employeeId,
                    threadId:   null,
                    historical: true,
                },
            });
            if (job) enqueued++;
        }

        res.json({ success: true, enqueued });
    } catch (err) {
        console.error('❌ /api/graph/enrich error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Enrich knowledge graph from employee's WhatsApp message history. Same
// per-message enqueue pattern as the email enrich endpoint.
app.post('/api/graph/enrich-whatsapp', async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        const { enqueue: enqueueAgentJob } = require('./core/agents/queue');
        const messages = await supabaseService.getWhatsAppMessagesForEnrichment(employeeId, 30);

        if (messages.length === 0) {
            return res.json({ success: true, enqueued: 0 });
        }

        let enqueued = 0;
        for (const m of messages) {
            const job = await enqueueAgentJob({
                channel: 'whatsapp',
                sourceTable: 'Whatsapp',
                sourceId: null,
                payload: {
                    chatJid:      m.chatJid      || null,
                    senderName:   m.senderName   || null,
                    senderNumber: m.senderNumber || null,
                    messageText:  m.description  || '',
                    employeeId,
                    historical:   true,
                },
            });
            if (job) enqueued++;
        }

        res.json({ success: true, enqueued });
    } catch (err) {
        console.error('❌ /api/graph/enrich-whatsapp error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/agent/chat', requireAuth, async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Dynamically import intelligence service to use it
    const { intelligenceService } = require('./core');
    const result = await intelligenceService.chatWithAgent(prompt);
    res.json(result);
});

// Business profile, suppliers, employee invitations, onboarding status
// are owned by the mapMyBusiness package (mounted near app initialization).

// Knowledge-map chat — session memory held in-process on the backend
app.post('/api/graph/chat', requireAuth, async (req, res) => {
    const { sessionId, userMessage, context } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
    if (!sessionId)   return res.status(400).json({ error: 'sessionId is required' });

    const { intelligenceService } = require('./core');
    const result = await intelligenceService.chatWithGraph(sessionId, userMessage, context || '');
    res.json(result);
});

app.delete('/api/graph/chat/session/:sessionId', requireAuth, (req, res) => {
    const { intelligenceService } = require('./core');
    intelligenceService.clearChatSession(req.params.sessionId);
    res.json({ cleared: true });
});

// Admin-only: upload a document to enrich the BUSINESS knowledge graph.
// We persist the file to the documents bucket and enqueue a business-channel
// agent_jobs row; BusinessContextAgent then writes the graph. Direct writes
// from this endpoint are not allowed — agents own the graph.
app.post('/api/agent/upload', requireAuth, requireAdmin, upload.single('document'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No document uploaded' });

    try {
        const { supabaseService } = require('./core');
        const { enqueue: enqueueAgentJob } = require('./core/agents/queue');

        const bucket = 'documents';
        const uploadPath = `uploads/${Date.now()}_${req.file.originalname}`;
        const storageUrl = await supabaseService.uploadFile(
            bucket, uploadPath, req.file.buffer, req.file.mimetype
        );

        const textContent = req.file.buffer.toString('utf8'); // basic parse for text/csv

        const job = await enqueueAgentJob({
            channel: 'business',
            sourceTable: 'document_uploads',
            sourceId: null,
            payload: {
                action: 'document_upload',
                row: {
                    fileName:    req.file.originalname,
                    mimeType:    req.file.mimetype,
                    storageUrl:  storageUrl || null,
                    uploadedBy:  req.employee.id,
                    textContent: textContent.slice(0, 50000),
                },
            },
        });

        res.status(202).json({
            success: true,
            jobId: job?.id || null,
            message: 'Document queued for graph enrichment.',
        });
    } catch (err) {
        console.error('❌ Document upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Contact Identity Endpoints ──────────────────────────────────────────────
// Links a WhatsApp phone number to an email address so the graph can unify them.

app.get('/api/contacts/identities', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    const links = await supabaseService.getContactIdentities(employeeId);
    res.json(links);
});

app.post('/api/contacts/identities', requireAuth, async (req, res) => {
    const { employeeId, phone, email, displayName } = req.body;
    if (!employeeId || !phone || !email) {
        return res.status(400).json({ error: 'employeeId, phone and email required' });
    }
    const link = await supabaseService.linkContactIdentity(employeeId, phone, email, displayName);
    if (link) res.status(201).json(link);
    else res.status(500).json({ error: 'Failed to link contact identity' });
});

app.delete('/api/contacts/identities/:id', requireAuth, async (req, res) => {
    const id         = Number(req.params.id);
    const employeeId = Number(req.query.employeeId);
    if (!id || !employeeId) return res.status(400).json({ error: 'id and employeeId required' });
    const ok = await supabaseService.deleteContactIdentity(id, employeeId);
    if (ok) res.json({ success: true });
    else res.status(500).json({ error: 'Failed to remove identity link' });
});

// Client endpoints are owned by the mapMyBusiness package.

// IMAP Endpoints
app.post('/api/imap/test', requireAuth, async (req, res) => {
    const { host, port, secure, user, pass } = req.body;
    if (!host || !user || !pass) return res.status(400).json({ error: 'host, user and pass are required' });
    try {
        const { ImapFlow } = require('imapflow');
        const client = new ImapFlow({
            host,
            port:   port  || 993,
            secure: secure !== false,
            auth:   { user, pass },
            logger: false,
            tls:    { rejectUnauthorized: false },
        });
        await client.connect();
        await client.logout();
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: `Connection failed: ${err.message}` });
    }
});

app.post('/api/imap/connect', requireAuth, async (req, res) => {
    const { employeeId, host, port, secure, user, pass } = req.body;
    if (!employeeId || !host || !user || !pass) {
        return res.status(400).json({ error: 'employeeId, host, user and pass are required' });
    }
    try {
        const credentials = { host, port: port || 993, secure: secure !== false, user, pass };
        const saved = await supabaseService.saveEmployeeToken(employeeId, 'imap', credentials);
        if (!saved) return res.status(500).json({ error: 'Failed to save IMAP credentials' });
        await supabaseService.toggleIntegration(employeeId, 'imap', true);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/imap/disconnect', requireAuth, async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    const ok = await supabaseService.removeEmployeeSecret(employeeId, 'imap');
    res.json({ success: ok });
});

app.get('/api/imap/status', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        const records = await supabaseService.getAuthenticatedEmployees('imap');
        const connected = records.some(r => r.employee_id === employeeId);
        res.json({ connected });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Gmail Auth Endpoints
app.get('/api/gmail-auth-url', (req, res) => {
    const { employeeId } = req.query;
    if (!employeeId) return res.status(400).json({ error: 'Missing employeeId' });

    const authUrl = gmailService.getAuthUrl();
    const stateAuthUrl = `${authUrl}&state=${employeeId}`;
    res.json({ url: stateAuthUrl });
});

app.get('/api/gmail-callback', async (req, res) => {
    const { code, state: employeeId } = req.query;
    if (!code || !employeeId) return res.status(400).send('Invalid callback parameters.');

    try {
        const tokens = await gmailService.getTokens(code);
        const success = await supabaseService.saveEmployeeToken(employeeId, 'gmail', tokens);

        if (success) {
            res.send('<h1>✅ Gmail Linked Successfully!</h1><p>You can close this window now.</p><script>setTimeout(() => window.close(), 3000)</script>');
        } else {
            throw new Error('Failed to save to Vault.');
        }
    } catch (err) {
        console.error('❌ UI Auth Error:', err.message);
        res.status(500).json({ error: `Error linking Gmail: ${err.message}` });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, () => {
    console.log(`
🚀 Omni-Brain Intelligence Dashboard is LIVE!
----------------------------------------------
🔗 Access here: http://localhost:${PORT}
----------------------------------------------
    `);
});
