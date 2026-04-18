const whatsappProcessor = require('./processor');

console.log('📱 Starting OMNI-BRAIN: WhatsApp Container...');

whatsappProcessor.connectToWhatsApp().catch(err => {
    console.error('❌ WhatsApp Container Crash:', err.message);
    process.exit(1);
});
