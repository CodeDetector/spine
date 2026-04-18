const readline = require('readline');
const gmailService = require('./gmailService');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

async function setup() {
    console.log('--- Gmail Authorization Setup ---');
    
    const authUrl = gmailService.getAuthUrl();
    
    if (!authUrl) {
        console.error('Error: Google API credentials not found in .env file.');
        console.log('Please ensure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI are set.');
        process.exit(1);
    }

    console.log('\n1. Open the following URL in your browser to authorize the app:');
    console.log('\x1b[36m%s\x1b[0m', authUrl); // Cyan color for the URL
    
    rl.question('\n2. After authorizing, paste the code from the redirected page here: ', async (code) => {
        try {
            console.log('\nExchanging code for tokens...');
            await gmailService.saveToken(code);
            console.log('\x1b[32m%s\x1b[0m', 'Successfully authorized! Gmail tokens saved to gmail-tokens.json');
        } catch (error) {
            console.error('\x1b[31m%s\x1b[0m', 'Error authorizing Gmail: ' + error.message);
        } finally {
            rl.close();
            process.exit(0);
        }
    });
}

setup().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});
