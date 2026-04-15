const { makeWASocket, useMultiFileAuthState, delay, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

async function migrate() {
    console.log('\n--- 🚀 WhatsApp Message Migration Tool ---');
    console.log('⚠️  IMPORTANT: Please ensure your main bot (index.js) is STOPPED before running this script to avoid session conflicts.\n');
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // Fetch latest version to avoid 405 error
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🌐 Using WhatsApp version: ${version.join('.')} (Latest: ${isLatest})`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false // Set to false to handle manually
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📌 Scan the QR code below to connect:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Connection closed. Status: ${statusCode}`);
            
            // 405 often means the version is outdated or the session is invalid
            if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
                console.error('❌ Connection rejected (405) or Logged out. Please delete auth_info_baileys and restart.');
                process.exit(1);
            } else {
                console.log('🔄 Reconnecting in 5 seconds...');
                setTimeout(migrate, 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ Connected successfully to WhatsApp!');

            try {
                // 1. Fetch all groups and log them for diagnostics
                console.log('🔍 Fetching participating groups...');
                const allGroups = await sock.groupFetchAllParticipating();
                
                let sourceJid = null;
                let destJid = null;
                
                const targetSourceName = 'iss daily reporting group';
                const targetDestName = 'privy';

                console.log(`\n📋 Groups Found (${Object.keys(allGroups).length}):`);
                for (const jid in allGroups) {
                    const subject = allGroups[jid].subject;
                    console.log(`   - ${subject}`);
                    
                    if (subject.toLowerCase().includes(targetSourceName)) sourceJid = jid;
                    if (subject.toLowerCase().includes(targetDestName)) destJid = jid;
                }

                if (!sourceJid) {
                    console.error(`❌ Error: Could not find source group containing "${targetSourceName}"`);
                    process.exit(1);
                }
                if (!destJid) {
                    console.error(`❌ Error: Could not find destination group containing "${targetDestName}"`);
                    process.exit(1);
                }

                console.log(`\n📍 SOURCE: ${allGroups[sourceJid].subject} [${sourceJid}]`);
                console.log(`📍 DESTINATION: ${allGroups[destJid].subject} [${destJid}]`);

                // 2. Fetch History
                console.log('\n📩 Fetching last 30 days of history...');
                const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
                
                // Note: Baileys history fetching can be tricky. 
                // We'll try to fetch messages in a loop.
                let messagesToForward = [];
                
                // Fetch up to 10 batches of 50 messages
                let lastMsgId = undefined;
                for (let i = 0; i < 10; i++) {
                    const messages = await sock.fetchMessagesFromWA(sourceJid, 50, lastMsgId ? { id: lastMsgId, fromMe: false } : undefined);
                    
                    if (!messages || messages.length === 0) {
                        console.log(`   (Batch ${i+1}: No more messages found)`);
                        break;
                    }
                    
                    console.log(`   (Batch ${i+1}: Found ${messages.length} messages)`);
                    
                    const batchInRange = messages.filter(m => (m.messageTimestamp * 1000) > thirtyDaysAgo);
                    messagesToForward = [...batchInRange, ...messagesToForward];
                    
                    lastMsgId = messages[0].key.id;
                    
                    // If the oldest message in the batch is already older than 30 days, we stop
                    if ((messages[0].messageTimestamp * 1000) < thirtyDaysAgo) break;
                }

                // Remove duplicates and sort
                messagesToForward = messagesToForward.filter((v, i, a) => a.findIndex(t => (t.key.id === v.key.id)) === i);
                messagesToForward.sort((a, b) => a.messageTimestamp - b.messageTimestamp);

                if (messagesToForward.length === 0) {
                    console.log('⚠️ No messages found in the last 30 days.');
                    process.exit(0);
                }

                console.log(`\n📦 Found ${messagesToForward.length} messages to migrate.`);

                // 3. Sequential Migration
                for (let idx = 0; idx < messagesToForward.length; idx++) {
                    const m = messagesToForward[idx];
                    const text = m.message?.conversation || 
                                 m.message?.extendedTextMessage?.text || 
                                 m.message?.imageMessage?.caption || 
                                 '(Non-text message)';
                    
                    if (text === '(Non-text message)') continue;

                    const sender = m.pushName || 'User';
                    const time = new Date(m.messageTimestamp * 1000).toLocaleString();
                    const payload = `*Migration [${idx+1}/${messagesToForward.length}]*\n*Sent by:* ${sender}\n*Time:* ${time}\n---\n${text}`;

                    try {
                        await sock.sendMessage(destJid, { text: payload });
                        process.stdout.write(`📤 [${idx+1}/${messagesToForward.length}] Sent...\r`);
                        await delay(1500); // 1.5s delay to be safe
                    } catch (sendErr) {
                        console.error(`\n❌ Failed to send message ${idx+1}:`, sendErr.message);
                    }
                }

                console.log('\n\n🏁 Migration finished successfully!');
                process.exit(0);

            } catch (err) {
                console.error('\n❌ An error occurred during migration:', err.message);
                process.exit(1);
            }
        }
    });
}

migrate();
