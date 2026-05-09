/**
 * OMNI-BRAIN MASTER ENTRY POINT
 * ----------------------------
 * This file orchestrates the different intelligence layers:
 * 1. WhatsApp Bot (whatsappProcessor.js)
 * 2. Gmail Intelligence Feed (gmailProcessor.js)
 * 3. Management Analytics (server.js - can be started separately)
 */

const { intake }          = require('./core/intake');
const { processEmail, processWhatsApp } = require('./core/channelProcessor');

console.log('🚀 Starting Omni-Brain Intelligence System...');

// ── Wire the two-layer pipeline into each feeder BEFORE starting them ────────

// WhatsApp: intake → messages table, then WA channel processor
const waFeeder = require('wa-field-tracker-feeder-whatsapp');
waFeeder.setWhatsAppHandler(async (parsedMessage, ownerEmployeeId) => {
    const messageTraceId = await intake({ ...parsedMessage, employeeId: ownerEmployeeId });
    if (!messageTraceId) return;
    await processWhatsApp({
        employeeId:   ownerEmployeeId,
        chatJid:      parsedMessage.chatJid,
        senderName:   parsedMessage.sender,
        senderNumber: parsedMessage.senderNumber,
        messageText:  parsedMessage.messageDetails,
    }, messageTraceId);
});

// Email: intake → messages table, then email channel processor (with relevance gate)
const emailFeeder = require('wa-field-tracker-feeder-email');
emailFeeder.setEmailHandler(async (parsedEmail) => {
    const messageTraceId = await intake({
        messageId:      parsedEmail.messageId,
        format:         parsedEmail.format || 'text',
        messageDetails: parsedEmail.messageDetails || parsedEmail.message,
        employeeId:     parsedEmail.employeeId,
        mediaUrl:       parsedEmail.mediaUrl,
        mediaHash:      parsedEmail.mediaHash,
    });
    if (!messageTraceId) return;
    await processEmail(parsedEmail, messageTraceId);
});

// ── Start all feeders ────────────────────────────────────────────────────────

// 1. WhatsApp (Baileys multi-tenant, in-process)
waFeeder.run();

// 2. Gmail
emailFeeder.run();

// 3. IMAP (one.com, Outlook, Zoho, etc.)
require('wa-field-tracker-feeder-imap').run();

// 4. Management API & Dashboard Server
require('./server');

console.log('✅ Omni-Brain Orchestrator is running.');
