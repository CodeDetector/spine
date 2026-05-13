/**
 * OMNI-BRAIN MASTER ENTRY POINT
 * ----------------------------
 * This file orchestrates the different intelligence layers:
 * 1. WhatsApp Bot (whatsappProcessor.js)
 * 2. Gmail Intelligence Feed (gmailProcessor.js)
 * 3. Management Analytics (server.js - can be started separately)
 */

const { intake }      = require('./core/intake');
const { processEmail } = require('./core/channelProcessor');

console.log('🚀 Starting Omni-Brain Intelligence System...');

// ── Wire the email pipeline ──────────────────────────────────────────────────
// WhatsApp ingestion is owned by the omni-whatsapp container now; nothing to
// wire here. omni-whatsapp persists messages + enqueues agent_jobs directly.

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

// ── Start feeders ────────────────────────────────────────────────────────────

// 1. Gmail (in-process)
emailFeeder.run();

// 2. IMAP (in-process)
require('wa-field-tracker-feeder-imap').run();

// 3. Management API & Dashboard Server
require('./server');

// 4. Refinement-agent worker — polls agent_jobs, dispatches to per-channel agents.
const agentWorker = require('./core/agents/worker');
agentWorker.start();

// 5. Synthesis runner — periodic cross-graph proactive agent.
const synthesisRunner = require('./core/agents/synthesisRunner');
synthesisRunner.start();

console.log('✅ Omni-Brain Orchestrator is running.');
