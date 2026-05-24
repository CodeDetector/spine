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

// ─── Onboarding landing ──────────────────────────────────────────────────────
// Public surfaces that drive the three-CTA AuthPage (Login / Onboard your
// business / Request to join). All public — no JWT required, and lightly
// rate-limited (in-memory counter, sufficient for the auth-page surface).

const PERSONAL_DOMAINS = new Set([
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
    'icloud.com', 'protonmail.com',
]);
function _domainFromEmail(email) {
    return String(email || '').toLowerCase().split('@')[1] || '';
}
function _isPersonalDomain(domain) {
    return PERSONAL_DOMAINS.has(String(domain || '').toLowerCase());
}

const _ipHits = new Map(); // ip -> { count, resetAt }
function _rateLimit(req, res, max = 20, windowMs = 60_000) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'unknown';
    const now = Date.now();
    const entry = _ipHits.get(ip);
    if (!entry || now > entry.resetAt) {
        _ipHits.set(ip, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (entry.count >= max) {
        res.status(429).json({ error: 'Too many requests — slow down and try again in a minute.' });
        return false;
    }
    entry.count++;
    return true;
}

// Public — does a tenant own this domain? Used by AuthPage to branch the
// visitor between Onboard-your-business and Request-to-join, and by the
// Onboard form to give an instant client-side warning. Leaks "is this
// domain a customer" by design.
app.get('/api/onboarding/lookup-domain', async (req, res) => {
    if (!_rateLimit(req, res)) return;
    const domain = String(req.query.domain || '').toLowerCase().trim();
    if (!domain) return res.status(400).json({ error: 'domain required' });
    try {
        const { data, error } = await supabaseService.client
            .from('businesses')
            .select('name')
            .eq('email_domain', domain)
            .maybeSingle();
        if (error) throw error;
        res.json({ exists: !!data, businessName: data?.name || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create a brand-new tenant + its first admin atomically.
//
// Two callers:
//  1. Anonymous (no Authorization header). Body must include email + password;
//     we run Supabase Auth signUp first, then call the DB RPC.
//  2. Orphan (Authorization: Bearer <JWT>). The Supabase Auth user already
//     exists — we skip signUp, derive email from the JWT, and only run the
//     RPC. This is the "PostLoginChooser → Onboard" flow.
app.post('/api/onboarding/business', async (req, res) => {
    if (!_rateLimit(req, res, 6)) return;
    const { businessName, emailDomain, email: bodyEmail, password } = req.body || {};
    if (!businessName || !emailDomain) {
        return res.status(400).json({ error: 'businessName and emailDomain are required' });
    }
    const normalizedDomain = String(emailDomain).toLowerCase().trim();
    if (_isPersonalDomain(normalizedDomain)) {
        return res.status(400).json({ error: 'Personal email domains are not allowed — use your company domain.' });
    }

    // Path selection: Bearer token wins over body-supplied email/password.
    const bearer = req.headers.authorization?.replace('Bearer ', '');
    let authedEmail = null;
    let authedUserId = null;
    if (bearer) {
        try {
            const { data: { user }, error } = await supabaseService.client.auth.getUser(bearer);
            if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
            authedEmail  = user.email.toLowerCase();
            authedUserId = user.id;
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
    }

    const normalizedEmail = (authedEmail || String(bodyEmail || '').toLowerCase().trim());
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (_domainFromEmail(normalizedEmail) !== normalizedDomain) {
        return res.status(400).json({ error: 'Your business email must match the company email domain.' });
    }

    // Anonymous path requires password; authed path skips signUp.
    if (!authedEmail) {
        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }
    }

    let needsConfirmation = false;
    try {
        if (!authedEmail) {
            // Anonymous → create the Supabase Auth user. Fresh client so the
            // server's persistent client doesn't carry the new session.
            const { createClient } = require('@supabase/supabase-js');
            const tempClient = createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const { data: signUpData, error: signUpErr } = await tempClient.auth.signUp({
                email: normalizedEmail, password,
            });
            if (signUpErr) {
                if (isAlreadyRegisteredError(signUpErr.message)) {
                    return res.status(409).json({ error: 'ALREADY_REGISTERED' });
                }
                if (isRateLimitError(signUpErr.message)) {
                    return res.status(429).json({ error: 'EMAIL_RATE_LIMIT' });
                }
                return res.status(400).json({ error: signUpErr.message });
            }
            needsConfirmation = !signUpData.session;
        }

        // Create the businesses + employees rows in one transaction.
        // The RPC validates the domain match server-side too.
        const { data: rpcRows, error: rpcErr } = await supabaseService.client
            .rpc('onboard_business', {
                p_business_name: businessName,
                p_email_domain:  normalizedDomain,
                p_admin_email:   normalizedEmail,
                p_admin_name:    null,
                p_admin_role:    null,
                p_admin_mobile:  null,
            });
        if (rpcErr) {
            // 23505 = unique violation on businesses.email_domain — race lost.
            if (rpcErr.code === '23505' || /already exists|duplicate/i.test(rpcErr.message)) {
                return res.status(409).json({ error: 'DOMAIN_ALREADY_REGISTERED' });
            }
            return res.status(500).json({ error: rpcErr.message });
        }
        const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;

        // Invalidate the tenant cache so subsequent authed calls pick up the
        // newly-created employees row instead of seeing the cached "orphan".
        // Only relevant on the authed path — on the anonymous path the auth
        // user is brand-new and can't be in the cache.
        if (authedUserId) _tenantCache.delete(authedUserId);

        res.status(201).json({
            success: true,
            needsConfirmation,
            businessId: row?.business_id || null,
            employeeId: row?.employee_id || null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public — submit a join request. The admin gets an email with an approve
// link. If no business owns this domain, return 404 NO_BUSINESS_FOR_DOMAIN
// so the UI can suggest the Onboard flow instead.
app.post('/api/onboarding/join-request', async (req, res) => {
    if (!_rateLimit(req, res, 10)) return;
    const { email } = req.body || {};
    const normalizedEmail = String(email || '').toLowerCase().trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return res.status(400).json({ error: 'A valid email is required.' });
    }
    const domain = _domainFromEmail(normalizedEmail);
    if (_isPersonalDomain(domain)) {
        return res.status(400).json({ error: 'Personal email domains are not allowed — use your work email.' });
    }
    try {
        const { data: business, error: lookupErr } = await supabaseService.client
            .from('businesses')
            .select('id, name, admin_employee_id')
            .eq('email_domain', domain)
            .maybeSingle();
        if (lookupErr) throw lookupErr;
        if (!business) {
            return res.status(404).json({ error: 'NO_BUSINESS_FOR_DOMAIN', domain });
        }

        // Upsert into join_requests. Only one pending row per (business, email)
        // is allowed by the partial unique index. ON CONFLICT DO NOTHING +
        // re-select handles the "user clicked twice" case gracefully.
        const { data: inserted, error: insErr } = await supabaseService.client
            .from('join_requests')
            .insert({ business_id: business.id, email: normalizedEmail })
            .select('id, token')
            .maybeSingle();

        let row = inserted;
        if (insErr && insErr.code === '23505') {
            const { data: existing } = await supabaseService.client
                .from('join_requests')
                .select('id, token')
                .eq('business_id', business.id)
                .eq('email', normalizedEmail)
                .eq('status', 'pending')
                .maybeSingle();
            row = existing;
        } else if (insErr) {
            throw insErr;
        }

        if (!row) {
            return res.status(500).json({ error: 'Could not record the join request.' });
        }

        // Email the admin. Failures are logged but don't roll back the row —
        // the admin can still see the request in the dashboard, and the
        // requester can re-submit which is a no-op upsert.
        if (business.admin_employee_id) {
            const { data: admin } = await supabaseService.client
                .from('employees')
                .select('emailId')
                .eq('id', business.admin_employee_id)
                .maybeSingle();
            if (admin?.emailId) {
                const mailer = require('./core/mailer');
                mailer.sendAdminJoinRequestEmail({
                    to: admin.emailId,
                    businessName:   business.name,
                    requesterEmail: normalizedEmail,
                    joinRequestId:  row.id,
                    token:          row.token,
                }).catch(err => console.error('join-request email send failed:', err.message));
            }
        }

        res.status(201).json({ success: true, businessName: business.name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function _approvalPageHtml(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
        <style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
        .card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08);max-width:480px;text-align:center}
        h1{margin:0 0 12px;font-size:20px}p{color:#475569;line-height:1.5}</style></head>
        <body><div class="card">${body}</div></body></html>`;
}

// Token-gated approve link, clicked from the admin's email. Idempotent:
// re-clicking shows "already approved" rather than re-issuing an invitation.
app.get('/api/join-requests/:id/approve', async (req, res) => {
    const id = Number(req.params.id);
    const token = String(req.query.token || '');
    if (!id || !token) return res.status(400).send(_approvalPageHtml('Invalid link', '<h1>Invalid link</h1><p>This approval link is malformed.</p>'));
    try {
        const { data: jr, error } = await supabaseService.client
            .from('join_requests')
            .select('id, business_id, email, status, token')
            .eq('id', id)
            .maybeSingle();
        if (error) throw error;
        if (!jr || jr.token !== token) {
            return res.status(404).send(_approvalPageHtml('Not found', '<h1>Not found</h1><p>This approval link is not valid.</p>'));
        }
        if (jr.status !== 'pending') {
            return res.status(200).send(_approvalPageHtml('Already handled', `<h1>Already ${jr.status}</h1><p>This request was already ${jr.status}.</p>`));
        }

        // Mark approved, create the invitation, notify the requester.
        await supabaseService.client.from('join_requests')
            .update({ status: 'approved', decided_at: new Date().toISOString() })
            .eq('id', id);

        await supabaseService.client.from('employee_invitations').upsert({
            business_id: jr.business_id,
            email:       jr.email,
            role:        'member',
            is_admin:    false,
            status:      'pending',
            invited_by:  null,
        }, { onConflict: 'business_id,email' });

        const { data: business } = await supabaseService.client
            .from('businesses')
            .select('name').eq('id', jr.business_id).maybeSingle();

        const mailer = require('./core/mailer');
        mailer.sendApprovedNoticeEmail({
            to: jr.email,
            businessName: business?.name || 'your team',
        }).catch(err => console.error('approval-notice email failed:', err.message));

        res.send(_approvalPageHtml('Approved', `<h1>Approved ✓</h1><p>${jr.email} can now finish signing up.</p>`));
    } catch (err) {
        res.status(500).send(_approvalPageHtml('Error', `<h1>Something went wrong</h1><p>${err.message}</p>`));
    }
});

// Token-gated reject — matches the second button in the admin's email.
app.get('/api/join-requests/:id/reject', async (req, res) => {
    const id = Number(req.params.id);
    const token = String(req.query.token || '');
    if (!id || !token) return res.status(400).send(_approvalPageHtml('Invalid link', '<h1>Invalid link</h1>'));
    try {
        const { data: jr } = await supabaseService.client
            .from('join_requests')
            .select('id, status, token, email')
            .eq('id', id).maybeSingle();
        if (!jr || jr.token !== token) {
            return res.status(404).send(_approvalPageHtml('Not found', '<h1>Not found</h1>'));
        }
        if (jr.status === 'pending') {
            await supabaseService.client.from('join_requests')
                .update({ status: 'rejected', decided_at: new Date().toISOString() })
                .eq('id', id);
        }
        res.send(_approvalPageHtml('Rejected', `<h1>Rejected</h1><p>${jr.email} will not be added.</p>`));
    } catch (err) {
        res.status(500).send(_approvalPageHtml('Error', `<h1>Something went wrong</h1><p>${err.message}</p>`));
    }
});

// Admin-only — list pending requests for the caller's tenant.
app.get('/api/join-requests', requireTenantAuth, async (req, res) => {
    if (!req.employee.is_admin) return res.status(403).json({ error: 'Admin only' });
    const { data, error } = await supabaseService.client
        .from('join_requests')
        .select('id, email, status, requested_at, decided_at')
        .eq('business_id', req.business_id)
        .eq('status', 'pending')
        .order('requested_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
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
            employee: employee || null,
            // 'orphan' = Supabase Auth user exists but no employees row scoped
            // to a business. The UI uses this to render PostLoginChooser
            // (Onboard your business / Request to join) instead of trying
            // to load the dashboard.
            accountStatus: (employee && employee.business_id) ? 'active' : 'orphan',
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
        const accountStatus = (employee && employee.business_id) ? 'active' : 'orphan';
        // Skip the onboarding-status round-trip for orphans — they're going
        // to PostLoginChooser, not the wizard, so the counts don't matter.
        let onboarding = null;
        if (accountStatus === 'active') {
            const businessClient = require('./core/businessClient');
            onboarding = await businessClient.getOnboardingStatus(employee.business_id);
        }
        res.json({
            user: { id: user.id, email: user.email },
            employee: employee || null,
            accountStatus,
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
