/**
 * OMNI-BRAIN MASTER ENTRY POINT
 * ----------------------------
 * This file orchestrates the different intelligence layers:
 * 1. WhatsApp Bot (whatsappProcessor.js)
 * 2. Gmail Intelligence Feed (gmailProcessor.js)
 * 3. Management Analytics (server.js - can be started separately)
 */

const { whatsappProcessor } = require('wa-field-tracker-feeder-whatsapp');
const { gmailProcessor } = require('wa-field-tracker-feeder-email');

console.log('🚀 Starting Omni-Brain Intelligence System...');

// 1. Initialize WhatsApp and its cross-channel monitors (SLA)
require('wa-field-tracker-feeder-whatsapp').run();

// 2. Initialize Email Ingestion
require('wa-field-tracker-feeder-email').run();

// 3. Initialize Management API & Dashboard Server
require('./server');

console.log('✅ Omni-Brain Orchestrator is running.');
