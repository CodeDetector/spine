const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');
const config = require('./config');
const { parseMessage } = require('./messageParser');
const supabaseService = require('./supabaseService');
const { fuzzyMatch } = require('./utils');
const { screeningPrompt, leaveExtractionPrompt, paymentExtractionPrompt, visitExtractionPrompt } = require('./prompts');
const cron = require('node-cron');
const { generateAndSendReport } = require('./generateReport');

const groupNameCache = {};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Connection closed. Status: ${statusCode}`);

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 405;
            
            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 5 seconds...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.error('❌ Connection dead (Logged out or 405 error). Please delete auth_info_baileys and restart.');
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log('✅ Opened connection successfully. WhatsApp Bot is ready!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const messages = m.messages;
        if (m.type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.key || msg.key.remoteJid === 'status@broadcast') continue;
            if (!msg.key.remoteJid.endsWith('@g.us')) continue;

            let groupName = msg.key.remoteJid;
            if (!groupNameCache[msg.key.remoteJid]) {
                try {
                    const groupMeta = await sock.groupMetadata(msg.key.remoteJid);
                    groupName = groupMeta.subject || msg.key.remoteJid;
                    groupNameCache[msg.key.remoteJid] = groupName;
                } catch (e) {}
            } else {
                groupName = groupNameCache[msg.key.remoteJid];
            }

            if (config.ALLOWED_GROUP_NAMES && config.ALLOWED_GROUP_NAMES.length > 0) {
                if (!config.ALLOWED_GROUP_NAMES.includes(groupName.toLowerCase().trim())) continue;
            }
            // console.log("msg " , msg )
            const rawSender = msg.key.participant || msg.key.remoteJid;
            const sender = msg.pushName || rawSender.split('@')[0] || rawSender;
            const groupId = "GID" + msg.key.remoteJid.split('@')[0];

            console.log("Sender is:", sender);

            const parsedData = parseMessage(msg);
            if (!parsedData) continue;

            const message = {
                ...parsedData,
                groupId: groupId,
                sender: sender,
                senderNumber: msg.key.participant.split('@')[0],
                timestamp: new Date().toLocaleString(),
                mediaUrl: null,
                mediaHash: null
            };

            // 📸 Handle Image Processing (Hash & Upload)
            if (parsedData.format === 'photo') {
                try {
                    console.log('📸 Photo detected, processing media...');
                    const buffer = await downloadMediaMessage(
                        msg,
                        'buffer',
                        {},
                        {
                            logger: pino({ level: 'silent' }),
                            reuploadRequest: sock.updateMediaMessage
                        }
                    );

                    // Store buffer for Gemini Vision
                    message.buffer = buffer;
                    message.mimeType = 'image/jpeg';

                    // 1. Generate SHA-256 Hash
                    message.mediaHash = crypto.createHash('sha256').update(buffer).digest('hex');
                    console.log(`✅ Generated Hash: ${message.mediaHash}`);

                    // 2. Upload to Supabase Storage
                    const fileName = `${message.messageId || Date.now()}.jpg`;
                    const publicUrl = await supabaseService.uploadFile('artifacts', fileName, buffer, 'image/jpeg');
                    
                    if (publicUrl) {
                        message.mediaUrl = publicUrl;
                        console.log(`✅ Uploaded to Storage: ${publicUrl}`);
                    }
                } catch (imgErr) {
                    console.error('❌ Failed to process image:', imgErr.message);
                }
            }

            // 🤖 Multimodal AI Screener (Categorization + Extraction)
            let category = 'other';
            if (config.GEMINI_API_KEY && (message.messageDetails || message.buffer)) {
                try {
                    console.log(`🔍 [Multimodal Screener] Analyzing message from ${message.sender}...`);
                    const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
                    
                    const promptParts = [
                        { text: screeningPrompt(message.messageDetails || "") }
                    ];

                    if (message.buffer) {
                        promptParts.push({
                            inlineData: {
                                data: message.buffer.toString('base64'),
                                mimeType: message.mimeType
                            }
                        });
                    }

                    const screenResult = await client.models.generateContent({
                        model: 'gemma-4-31b-it',
                        contents: [{ role: 'user', parts: promptParts }]
                    });

                    const responseText = screenResult.text.replace(/```json|```/g, '').trim();
                    const screenData = JSON.parse(responseText);

                    category = screenData.category || 'other';
                    // Update details with the vision-extracted text
                    message.messageDetails = screenData.extractedDetails || message.messageDetails;
                    
                    console.log(`✅ Categorized as: ${category}`);
                    console.log(`✅ Extracted Details: ${message.messageDetails.substring(0, 100)}...`);
                } catch (screenErr) {
                    console.error('❌ Multimodal screening failed:', screenErr.message);
                }
            }

            // Update messageType for DB
            message.messageType = category;

            console.log("message ", message);
            
            // 🚀 Send final payload to Supabase
            await supabaseService.sendtoDatabase(message);

            // 📅 Detail Step: If confirmed as 'leaves', perform specialized extraction
            if (category === 'leaves' && config.GEMINI_API_KEY) {
                try {
                    console.log('📝 Performing detailed leave extraction...');
                    const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

                    const detailResult = await client.models.generateContent({
                        model: 'gemma-4-31b-it',
                        contents: [{ role: 'user', parts: [{ text: leaveExtractionPrompt(message.messageDetails) }] }]
                    });

                    const analysis = JSON.parse(detailResult.text.replace(/```json|```/g, '').trim());

                    console.log('✅ Leave Details extracted:', analysis);
                    const employeeId = await supabaseService.getEmployeeId(message.senderNumber);
                    if (employeeId) {
                        await supabaseService.logLeave(
                            employeeId, 
                            analysis.description || message.messageDetails, 
                            analysis.startDate, 
                            analysis.endDate
                        );
                    }
                } catch (detailErr) {
                    console.error('❌ Detailed leave extraction failed:', detailErr.message);
                }
            }

            // 💰 Detail Step: If confirmed as 'payment info', perform specialized extraction
            if (category === 'payment info' && config.GEMINI_API_KEY) {
                try {
                    console.log('📝 Performing detailed payment extraction...');
                    const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

                    const detailResult = await client.models.generateContent({
                        model: 'gemma-4-31b-it',
                        contents: [{ role: 'user', parts: [{ text: paymentExtractionPrompt(message.messageDetails) }] }]
                    });

                    const analysis = JSON.parse(detailResult.text.replace(/```json|```/g, '').trim());

                    console.log('✅ Payment Details extracted:', analysis);
                    const employeeId = await supabaseService.getEmployeeId(message.senderNumber);
                    if (employeeId) {
                        await supabaseService.logPayment(employeeId, analysis);
                    }
                } catch (detailErr) {
                    console.error('❌ Detailed payment extraction failed:', detailErr.message);
                }
            }

            // 🤝 Detail Step: If confirmed as 'visits', perform specialized extraction
            if (category === 'visits' && config.GEMINI_API_KEY) {
                try {
                    console.log('📝 Performing detailed visit extraction...');
                    const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

                    const detailResult = await client.models.generateContent({
                        model: 'gemma-4-31b-it',
                        contents: [{ role: 'user', parts: [{ text: visitExtractionPrompt(message.messageDetails) }] }]
                    });

                    const analysis = JSON.parse(detailResult.text.replace(/```json|```/g, '').trim());

                    console.log('✅ Visit Details extracted:', analysis);
                    const employeeId = await supabaseService.getEmployeeId(message.senderNumber);
                    const clientId = await supabaseService.getClientId(analysis.clientName);

                    if (employeeId) {
                        await supabaseService.logVisit(employeeId, clientId, analysis.clientName, analysis.description);
                    }
                } catch (detailErr) {
                    console.error('❌ Detailed visit extraction failed:', detailErr.message);
                }
            }
        }
    });

    // 📅 Schedule Daily Executive Summary Report at 21:41 PM (9:41 PM)
    cron.schedule('41 21 * * *', async () => {
        console.log('⏰ Triggering scheduled 21:41 PM report...');
        await generateAndSendReport(sock);
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata" 
    });
}

connectToWhatsApp();
