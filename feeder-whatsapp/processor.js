const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');
const config = require('../core/config');
const { parseMessage } = require('../core/messageParser');
const supabaseService = require('../core/supabaseService');
const { screeningPrompt, leaveExtractionPrompt, paymentExtractionPrompt, visitExtractionPrompt } = require('../core/prompts');
const cron = require('node-cron');
const { generateAndSendReport } = require('../core/generateReport');
const gmailService = require('../feeder-email/service');
const gmailProcessor = require('../feeder-email/processor');
const intelligenceService = require('../core/intelligenceService');

const groupNameCache = {};
let slaMonitorStarted = false;
let cronJobsStarted = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        connectTimeoutMs: 60000, // Increase timeout to 60s to handle 408
        defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ WhatsApp Connection closed. Status: ${statusCode}`);

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 405;
            
            if (shouldReconnect) {
                console.log('🔄 Reconnecting WhatsApp in 5 seconds...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.error('❌ WhatsApp Session dead. Please delete auth_info_baileys and restart.');
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot is ready and connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 📊 SLA Monitor & WhatsApp Notification Logic
    const lastSlaNotification = {};

    async function startSLAMonitor() {
        console.log('📊 Starting SLA Monitor (Rule: 5min reply required)...');
        
        setInterval(async () => {
            try {
                const pending = await supabaseService.getPendingReplies();
                
                for (const item of pending) {
                    if (item.waitTime >= 5) {
                        const employeePhone = item.employeeInfo.Mobile || item.employeeInfo.contact;
                        if (!employeePhone) continue;

                        const jid = employeePhone.includes('@s.whatsapp.net') 
                            ? employeePhone 
                            : `${employeePhone.replace(/\D/g, '')}@s.whatsapp.net`;

                        const now = Date.now();
                        const lastNotified = lastSlaNotification[item.threadId] || 0;
                        
                        if (now - lastNotified > 15 * 60 * 1000) {
                            console.log(`🚨 SLA Breach! Notifying ${item.employeeInfo.Name} about thread ${item.threadId}...`);
                            
                            const alertMessage = `🚨 *SLA ALERT* 🚨\n\nHi ${item.employeeInfo.Name},\n\nYou have an unread email from *${item.client}* waiting for a reply for *${item.waitTime} minutes*.\n\nPlease respond as soon as possible to maintain our 5-min SLA.`;
                            
                            await sock.sendMessage(jid, { text: alertMessage });
                            lastSlaNotification[item.threadId] = now;
                        }
                    }
                }
            } catch (err) {
                console.error('❌ SLA Monitor error:', err.message);
            }
        }, 60000);
    }

    // Start SLA Sub-service
    // Note: This monitors the database for pending replies and sends WhatsApp alerts.
    // It works as long as the WhatsApp connection is open.
    if (!slaMonitorStarted) {
        console.log('📊 Initializing SLA Monitor...');
        startSLAMonitor();
        slaMonitorStarted = true;
    }

    sock.ev.on('messages.upsert', async m => {
        const messages = m.messages;
        if (m.type !== 'notify') return;

        for (const msg of messages) {
            const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            const text = rawText.trim();
            const remoteJid = msg.key.remoteJid;

            // 🛑 CRITICAL INTERCEPTION: Don't let commands reach the DB Logger
            if (text.startsWith('!')) {
                console.log(`🤖 Command detected: ${text}`);

                if (text.startsWith('!connect gmail')) {
                    const authUrl = gmailService.getAuthUrl();
                    if (authUrl) {
                        await sock.sendMessage(remoteJid, { text: `🔗 *OMNI-BRAIN AUTH* 🔗\n\n1. Open: ${authUrl}\n\n2. Authorize and copy the code.\n\n3. Reply here with: !gmail code YOUR_CODE` });
                    }
                }

                if (text.startsWith('!gmail code ')) {
                    const code = text.replace('!gmail code ', '').trim();
                    // Resolve sender: participant for groups, remoteJid for DMs
                    const senderNum = (msg.key.participant || remoteJid).split('@')[0];
                    
                    console.log(`🔐 Attempting Vault Save for ${senderNum}...`);
                    try {
                        const employeeId = await supabaseService.getEmployeeId(senderNum);
                        if (!employeeId) throw new Error(`Phone number ${senderNum} is not registered in the Employees table.`);

                        const tokens = await gmailService.getTokens(code);
                        const success = await supabaseService.saveEmployeeToken(employeeId, 'gmail', tokens);
                        
                        if (success) {
                            // NEW: Fetch and update emailId in employees table
                            try {
                                const profile = await gmailService.getProfile(tokens);
                                if (profile && profile.emailAddress) {
                                    await supabaseService.updateEmployeeEmail(employeeId, profile.emailAddress);
                                    await sock.sendMessage(remoteJid, { text: `✅ *VAULT SECURED* ✅\n\nYour inbox (*${profile.emailAddress}*) is now connected. OMNI-BRAIN is monitoring your Gmail.` });
                                } else {
                                    await sock.sendMessage(remoteJid, { text: '✅ *VAULT SECURED* ✅\n\nYour Gmail credentials have been moved to the encrypted vault.' });
                                }
                            } catch (profErr) {
                                console.error('⚠️ Could not fetch Gmail profile:', profErr.message);
                                await sock.sendMessage(remoteJid, { text: '✅ *VAULT SECURED* ✅\n\nCredentials saved, but could not verify email address.' });
                            }
                        } else {
                            throw new Error('Database Vault RPC failed. Did you run the SQL script?');
                        }
                    } catch (err) {
                        console.error('❌ Vault Error:', err.message);
                        await sock.sendMessage(remoteJid, { text: `❌ *VAULT ERROR*\n\nReason: ${err.message}` });
                    }
                }
                
                // Skip further processing (DB logging, AI analysis) for all commands
                continue;
            }

            if (!msg.key || remoteJid === 'status@broadcast') continue;
            // From this point on, we only log ACTUAL business messages
            if (!remoteJid.endsWith('@g.us') && !config.ALLOW_PRIVATE_CHATS) continue;


            let groupName = msg.key.remoteJid;
            try {
                if (!groupNameCache[msg.key.remoteJid]) {
                    const groupMeta = await sock.groupMetadata(msg.key.remoteJid);
                    groupName = groupMeta.subject || msg.key.remoteJid;
                    groupNameCache[msg.key.remoteJid] = groupName;
                } else {
                    groupName = groupNameCache[msg.key.remoteJid];
                }
            } catch (e) {}

            if (config.ALLOWED_GROUP_NAMES?.length > 0) {
                if (!config.ALLOWED_GROUP_NAMES.includes(groupName.toLowerCase().trim())) continue;
            }

            const rawSender = msg.key.participant || msg.key.remoteJid;
            const sender = msg.pushName || rawSender.split('@')[0] || rawSender;
            const groupId = "GID" + msg.key.remoteJid.split('@')[0];

            const parsedData = parseMessage(msg);
            if (!parsedData) continue;

            const message = {
                ...parsedData,
                groupId: groupId,
                sender: sender,
                senderNumber: msg.key.participant.split('@')[0],
                timestamp: new Date().toLocaleString()
            };

            if (parsedData.format === 'photo') {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    message.buffer = buffer;
                    message.mimeType = 'image/jpeg';
                    message.mediaHash = crypto.createHash('sha256').update(buffer).digest('hex');
                    const publicUrl = await supabaseService.uploadFile('artifacts', `${Date.now()}.jpg`, buffer, 'image/jpeg');
                    if (publicUrl) message.mediaUrl = publicUrl;
                } catch (e) {}
            }

            let category = 'other';
            if (config.GEMINI_API_KEY && (message.messageDetails || message.buffer)) {
                try {
                    console.log(`🔍 Analyzing message from ${message.sender}...`);
                    const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
                    const promptParts = [{ text: screeningPrompt(message.messageDetails || "") }];
                    if (message.buffer) promptParts.push({ inlineData: { data: message.buffer.toString('base64'), mimeType: message.mimeType } });

                    const screenResult = await client.models.generateContent({
                        model: 'gemma-4-31b-it',
                        contents: [{ role: 'user', parts: promptParts }]
                    });

                    const screenData = JSON.parse(screenResult.text.replace(/```json|```/g, '').trim());
                    category = screenData.category || 'other';
                    message.messageDetails = screenData.extractedDetails || message.messageDetails;
                } catch (e) {}
            }

            message.messageType = category;
            await supabaseService.sendtoDatabase(message);

            await intelligenceService.processMessageForGraph(
                message.messageDetails,
                { messageId: message.messageId, sender: message.sender }
            );
        }
    });


    
    // 📊 Daily Reports
    if (!cronJobsStarted) {
        cron.schedule('41 21 * * *', async () => {
            console.log('⏰ Sending daily report...');
            await generateAndSendReport(sock);
        }, { scheduled: true, timezone: "Asia/Kolkata" });

        // 🕸️ Daily Knowledge Graph Batch Update
        cron.schedule('30 23 * * *', async () => {
            console.log('⏰ Starting Daily Knowledge Graph Batch Update...');
            await intelligenceService.runDailyGraphUpdate();
        }, { scheduled: true, timezone: "Asia/Kolkata" });
        cronJobsStarted = true;

    }
}

module.exports = { connectToWhatsApp };
