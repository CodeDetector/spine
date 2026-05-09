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
        res.json({ user: { id: user.id, email: user.email }, employee: employee || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── WhatsApp (Baileys multi-tenant, in-process) ──────────────────────────────
// The feeder runs in this same Node process — call its sessionManager directly.
const { sessionManager: waSessions } = require('wa-field-tracker-feeder-whatsapp');

app.post('/api/whatsapp/connect', requireAuth, async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    waSessions.startSession(Number(employeeId)).catch(err =>
        console.error(`startSession ${employeeId}:`, err.message)
    );
    res.json({ ok: true });
});

app.get('/api/whatsapp/status', requireAuth, (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    res.json(waSessions.getStatus(employeeId));
});

app.post('/api/whatsapp/disconnect', requireAuth, async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        await waSessions.disconnect(Number(employeeId));
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/whatsapp/groups', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        res.json(await waSessions.listGroups(employeeId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/whatsapp/contacts', requireAuth, (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    res.json(waSessions.listContacts(employeeId));
});

// Manually add a contact by phone number (resolves JID without relying on contact-sync cache)
app.post('/api/whatsapp/contacts/resolve', requireAuth, async (req, res) => {
    const { employeeId, phone } = req.body;
    if (!employeeId || !phone) return res.status(400).json({ error: 'employeeId and phone required' });
    try {
        const results = await waSessions.resolvePhone(Number(employeeId), phone);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/whatsapp/tracked', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        res.json(await waSessions.listTracked(employeeId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/whatsapp/track', requireAuth, async (req, res) => {
    const { employeeId, jid, displayName, chatType = 'group' } = req.body;
    if (!employeeId || !jid) return res.status(400).json({ error: 'employeeId and jid required' });
    try {
        await waSessions.trackChat(Number(employeeId), jid, displayName, chatType);
        const tracked = await waSessions.listTracked(Number(employeeId));
        res.json({ ok: true, trackedCount: tracked.length });
    } catch (err) {
        console.error(`/track failed for emp ${employeeId}, jid ${jid}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/whatsapp/track', requireAuth, async (req, res) => {
    const { employeeId, jid } = req.body;
    if (!employeeId || !jid) return res.status(400).json({ error: 'employeeId and jid required' });
    try {
        await waSessions.untrackChat(Number(employeeId), jid);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

app.post('/api/employees', requireAuth, async (req, res) => {
    const employeeData = req.body;
    if (!employeeData.Name || !employeeData.Mobile) {
        return res.status(400).json({ error: 'Name and Mobile are required' });
    }
    const newEmployee = await supabaseService.createEmployee(employeeData);
    if (newEmployee) {
        res.status(201).json(newEmployee);
    } else {
        res.status(500).json({ error: 'Failed to create employee' });
    }
});

app.get('/api/stats', requireAuth, async (req, res) => {
    const stats = await supabaseService.getDashboardStats();
    res.json(stats);
});

app.get('/api/graph/full', requireAuth, async (req, res) => {
    const graph = await supabaseService.getFullGraph();
    res.json(graph);
});

app.get('/api/graph/channels', requireAuth, async (req, res) => {
    const channels = (req.query.channels || '').split(',').map(s => s.trim()).filter(Boolean);
    const graph = await supabaseService.getGraphByChannels(channels);
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
app.get('/api/followups', requireAuth, async (req, res) => {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    const data = await supabaseService.getPendingFollowups(employeeId);
    res.json(data);
});

// Enrich knowledge graph from employee's email history
app.post('/api/graph/enrich', async (req, res) => {
    const { employeeId, employeeName } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        const { intelligenceService } = require('./core');
        const emails = await supabaseService.getEmailsByEmployeeId(employeeId, 30);

        if (emails.length === 0) {
            return res.json({ success: true, processed: 0 });
        }

        let logBlob = `--- EMAIL HISTORY FOR: ${employeeName || 'Employee'} ---\n\n`;
        emails.forEach(e => {
            logBlob += `[EMAIL] From: ${e.sender || ''} To: ${e.receiver || ''}\nContent: ${e.message || ''}\n\n`;
        });

        await intelligenceService.processMessageForGraph(logBlob, {
            messageId: `EMAIL-ENRICH-${employeeId}-${Date.now()}`
        });

        res.json({ success: true, processed: emails.length });
    } catch (err) {
        console.error('❌ /api/graph/enrich error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Enrich knowledge graph from employee's WhatsApp message history
app.post('/api/graph/enrich-whatsapp', async (req, res) => {
    const { employeeId, employeeName } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
    try {
        const { intelligenceService } = require('./core');
        const messages = await supabaseService.getWhatsAppMessagesForEnrichment(employeeId, 30);

        if (messages.length === 0) {
            return res.json({ success: true, processed: 0 });
        }

        let logBlob = `--- WHATSAPP HISTORY FOR: ${employeeName || 'Employee'} ---\n\n`;
        messages.forEach(m => {
            logBlob += `[WHATSAPP] Chat: ${m.chatJid || ''} | From: ${m.senderName || m.senderNumber || ''}\nContent: ${m.description || ''}\n\n`;
        });

        await intelligenceService.processMessageForGraph(logBlob, {
            messageId: `WA-ENRICH-${employeeId}-${Date.now()}`
        });

        res.json({ success: true, processed: messages.length });
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

// Business profile — persisted to data/business_profile.json
app.get('/api/business/profile', requireAuth, (req, res) => {
    const { profileService } = require('./core');
    res.json(profileService.readProfile());
});

app.put('/api/business/profile', requireAuth, (req, res) => {
    const { profileService } = require('./core');
    const updated = profileService.writeProfile(req.body);
    res.json(updated);
});

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

app.post('/api/agent/upload', requireAuth, upload.single('document'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No document uploaded' });
    
    try {
        const { intelligenceService, supabaseService } = require('./core');
        
        // Save to bucket
        const bucket = 'documents';
        const uploadPath = `uploads/${Date.now()}_${req.file.originalname}`;
        await supabaseService.uploadFile(bucket, uploadPath, req.file.buffer, req.file.mimetype);
        
        // Parse doc and update map
        const textContent = req.file.buffer.toString('utf8'); // basic parse for text/csv
        await intelligenceService.parseDocumentForGraph(textContent, req.file.originalname);
        
        res.json({ success: true, message: 'Document parsed and knowledge map updated.' });
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

// Client Endpoints
app.get('/api/clients', requireAuth, async (req, res) => {
    const clients = await supabaseService.getAllClients();
    res.json(clients);
});

app.post('/api/clients', requireAuth, async (req, res) => {
    const { businessName, location, description, emailId, contacts, managedBy } = req.body;
    if (!businessName) return res.status(400).json({ error: 'businessName is required' });
    if (!managedBy)    return res.status(400).json({ error: 'managedBy (employeeId) is required' });
    const client = await supabaseService.createClient({ businessName, location, description, emailId, contacts, managedBy });
    if (client) res.status(201).json(client);
    else res.status(500).json({ error: 'Failed to create client' });
});

app.patch('/api/clients/:id/assign', requireAuth, async (req, res) => {
    const clientId = Number(req.params.id);
    const { managedBy } = req.body;
    if (!clientId || !managedBy) return res.status(400).json({ error: 'clientId and managedBy are required' });
    const ok = await supabaseService.updateClientManagedBy(clientId, managedBy);
    if (ok) res.json({ success: true });
    else res.status(500).json({ error: 'Failed to assign client' });
});

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
