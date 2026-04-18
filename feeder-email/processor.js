const gmailService = require('./service');
const supabaseService = require('../core/supabaseService');
const intelligenceService = require('../core/intelligenceService');
const crypto = require('crypto');

async function connectToEmail() {
    console.log('📬 Starting Omni-Brain Multi-Inbox Polling...');
    
    const extractEmail = (str) => {
        if (!str) return null;
        const match = str.match(/<([^>]+)>/) || [null, str];
        return match[1].trim().toLowerCase();
    };

    setInterval(async () => {
        try {
            // 1. Fetch all employees who have authenticated Gmail
            const authRecords = await supabaseService.getAuthenticatedEmployees('gmail');
            console.log(`🔍 Omni-Brain: Polling ${authRecords.length} inboxes...`);

            for (const record of authRecords) {
                const { employee_id: currentEmployeeId, token_data: tokens } = record;
                console.log(`📧 Polling inbox for Employee ID: ${currentEmployeeId}...`);

                try {
                    const newEmails = await gmailService.listNewEmails(tokens);
                    
                    for (const email of newEmails) {
                        const receiverAddress = extractEmail(email.deliveredTo || email.to);
                        const senderAddress = extractEmail(email.from);
                        
                        console.log(`📧 Processing email for ${currentEmployeeId}: From ${senderAddress} to ${receiverAddress}`);

                        // 3. Resolve the "opposition" (can be Client, Supplier, or another Employee)
                        let otherSideEmail = (extractEmail(email.from) === (record.employees?.emailId)) 
                            ? receiverAddress 
                            : senderAddress;

                        let oppositionId = await supabaseService.getEmployeeId(otherSideEmail);
                        if (!oppositionId) {
                            oppositionId = await supabaseService.getIdByEmail(otherSideEmail, 'clients');
                        }
                        if (!oppositionId) {
                            oppositionId = await supabaseService.getIdByEmail(otherSideEmail, 'suppliers');
                        }

                        let mediaHash = null;
                        let mediaUrl = null;

                        if (email.attachments && email.attachments.length > 0) {
                            try {
                                const attachment = email.attachments[0];
                                const buffer = await gmailService.getAttachment(tokens, email.id, attachment.id);
                                mediaHash = crypto.createHash('sha256').update(buffer).digest('hex');
                                const fileName = `gmail_${email.id}_${attachment.filename}`;
                                const publicUrl = await supabaseService.uploadFile('artifacts', fileName, buffer, attachment.mimeType);
                                if (publicUrl) mediaUrl = publicUrl;
                            } catch (e) {}
                        }

                        const emailContext = `${senderAddress}|${receiverAddress}|${email.subject}|${email.body}|${email.timestamp}`;
                        const fullHexHash = crypto.createHash('sha256').update(emailContext).digest('hex');
                        const numericHash = BigInt('0x' + fullHexHash.substring(0, 15)).toString();

                        const emailPayload = {
                            sender: senderAddress,
                            receiver: receiverAddress,
                            message: `Subject: ${email.subject}\n\n${email.body}`,
                            employeeId: currentEmployeeId,
                            oppositionId: oppositionId,
                            mediaHash: mediaHash,
                            mediaUrl: mediaUrl,
                            hash: numericHash,
                            threadId: BigInt.asIntN(64, BigInt('0x' + email.threadId)).toString()
                        };

                        await supabaseService.logEmailToDatabase(emailPayload);
                        await intelligenceService.processMessageForGraph(
                            `Subject: ${email.subject}\n\n${email.body}`,
                            { messageId: `GMAIL-${email.id}`, sender: email.from }
                        );
                    }
                } catch (inboxErr) {
                    console.error(`❌ Error polling inbox for employee ${currentEmployeeId}:`, inboxErr.message);
                }
            }
        } catch (err) {
            console.error('❌ Omni-Brain Polling error:', err.message);
        }
    }, 60000); 
}

// Self-start if run directly
if (require.main === module) {
    connectToEmail();
}

module.exports = { connectToEmail };
