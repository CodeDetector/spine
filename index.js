/**
 * OMNI-BRAIN MASTER ENTRY POINT
 * ----------------------------
 * This file orchestrates the different intelligence layers:
 * 1. WhatsApp Bot (whatsappProcessor.js)
 * 2. Gmail Intelligence Feed (gmailProcessor.js)
 * 3. Management Analytics (server.js - can be started separately)
 */

const whatsappProcessor = require('./feeder-whatsapp/processor');
const emailProcessor = require('./feeder-email/processor');

console.log('🚀 Starting Omni-Brain Intelligence System...');

// 1. Initialize WhatsApp and its cross-channel monitors (SLA)
whatsappProcessor.connectToWhatsApp().catch(err => {
    console.error('❌ Critical WhatsApp Startup Error:', err.message);
});

// 2. Initialize Email Ingestion
emailProcessor.connectToEmail().catch(err => {
    console.error('❌ Critical Email Startup Error:', err.message);
});

console.log('✅ Omni-Brain Orchestrator is running.');
