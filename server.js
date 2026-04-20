const express = require('express');
const path = require('path');
const config = require('./core/config');
const gmailService = require('./feeder-email/service');
const supabaseService = require('./core/supabaseService');

const app = express();
const PORT = 3000;

// Middleware to serve static files
app.use(express.static('public'));

// Endpoint to provide safe config to the frontend
app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: config.SUPABASE_URL,
        supabaseKey: config.SUPABASE_KEY
    });
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
