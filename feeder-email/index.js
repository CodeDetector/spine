const gmailProcessor = require('./processor');
const gmailService = require('./service');

console.log('📧 Starting OMNI-BRAIN: Gmail Container...');

async function run() {
    const isLoaded = await gmailService.loadSavedCredentials();
    if (isLoaded) {
        gmailProcessor.startGmailPolling();
    } else {
        console.error('❌ Gmail credentials not found. Use the WhatsApp container to !connect gmail first.');
        // Don't exit, wait for credentials to appear (could be linked via shared volume)
        setInterval(async () => {
            if (await gmailService.loadSavedCredentials()) {
                console.log('✅ Gmail credentials detected! Starting polling...');
                gmailProcessor.startGmailPolling();
            }
        }, 30000);
    }
}

run();
