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

// In-memory state for WhatsApp (Microservice reporting)
const whatsappSessions = {};

// WhatsApp Status Endpoints (for UI and WhatsApp Service)
app.get('/api/whatsapp/status', (req, res) => {
    const { employeeId } = req.query;
    if (employeeId) {
        return res.json(whatsappSessions[employeeId] || { connected: false, qr: null });
    }
    res.json(whatsappSessions);
});

app.post('/api/whatsapp/update-status', (req, res) => {
    const { employeeId = 'default', connected, qr } = req.body;
    whatsappSessions[employeeId] = {
        connected: !!connected,
        qr: qr || null,
        lastUpdate: new Date().toISOString()
    };
    console.log(`📱 WhatsApp Status [${employeeId}]: ${connected ? 'Connected' : 'Disconnected (QR: ' + (qr ? 'Present' : 'None') + ')'}`);
    res.json({ success: true });
});

app.post('/api/whatsapp/start-session', async (req, res) => {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'Missing employeeId' });

    try {
        // Forward request to WhatsApp microservice (listening on 3001)
        const response = await fetch('http://localhost:3001/api/sessions/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employeeId })
        });
        const result = await response.json();
        res.json(result);
    } catch (err) {
        console.error('❌ Failed to start WhatsApp session:', err.message);
        res.status(500).json({ error: 'Failed to communicate with WhatsApp service' });
    }
});


// Secure API Endpoints (Proxies to Supabase)
app.get('/api/employees', async (req, res) => {
    const employees = await supabaseService.getAllEmployees();
    res.json(employees);
});

app.get('/api/stats', async (req, res) => {
    const stats = await supabaseService.getDashboardStats();
    res.json(stats);
});

app.get('/api/graph/full', async (req, res) => {
    const graph = await supabaseService.getFullGraph();
    res.json(graph);
});

app.post('/api/employees/toggle-integration', async (req, res) => {
    const { employeeId, provider, enabled } = req.body;
    if (!employeeId || !provider) return res.status(400).json({ error: 'Missing parameters' });
    const success = await supabaseService.toggleIntegration(employeeId, provider, enabled);
    res.json({ success });
});

app.post('/api/employees/remove-integration', async (req, res) => {
    const { employeeId, provider } = req.body;
    if (!employeeId || !provider) return res.status(400).json({ error: 'Missing parameters' });
    const success = await supabaseService.removeEmployeeSecret(employeeId, provider);
    res.json({ success });
});

app.get('/api/graph/context', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const context = await supabaseService.getGraphContext(name);
    res.json(context);
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
        res.status(500).send(`Error linking Gmail: ${err.message}`);
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
