const express = require('express');
const path = require('path');
const config = require('./core/config');

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
