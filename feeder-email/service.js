const { google } = require('googleapis');
const config = require('../core/config');
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

class GmailService {
    constructor() {
        this.oAuth2Client = null;
        this.config = config;
    }

    createClient() {
        if (!this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET || !this.config.GOOGLE_REDIRECT_URI) {
            return null;
        }
        return new google.auth.OAuth2(
            this.config.GOOGLE_CLIENT_ID,
            this.config.GOOGLE_CLIENT_SECRET,
            this.config.GOOGLE_REDIRECT_URI
        );
    }

    getAuthUrl() {
        const client = this.createClient();
        if (!client) return null;
        return client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: SCOPES,
        });
    }

    async getTokens(code) {
        const client = this.createClient();
        if (!client) throw new Error('OAuth client not initialized');
        const { tokens } = await client.getToken(code);
        return tokens;
    }

    async listNewEmails(tokens) {
        const client = this.createClient();
        client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: client });

        
        const res = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 10,
            q: 'is:unread'
        });

        const messages = res.data.messages || [];
        const emailDetails = [];

        for (const msg of messages) {
            if (lastReadId && msg.id === lastReadId) break;
            
            const detail = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id
            });
            
            const headers = detail.data.payload.headers;
            const subject = headers.find(h => h.name === 'Subject')?.value;
            const from = headers.find(h => h.name === 'From')?.value;
            const to = headers.find(h => h.name === 'To')?.value;
            const deliveredTo = headers.find(h => h.name === 'Delivered-To')?.value;
            const attachments = [];
            let body = '';

            if (detail.data.payload.parts) {
                for (const part of detail.data.payload.parts) {
                    if (part.mimeType === 'text/plain' && part.body.data) {
                        body = Buffer.from(part.body.data, 'base64').toString();
                    } else if (part.filename && part.body.attachmentId) {
                        attachments.push({
                            id: part.body.attachmentId,
                            filename: part.filename,
                            mimeType: part.mimeType,
                            size: part.body.size
                        });
                    }
                }
            } else if (detail.data.payload.body.data) {
                body = Buffer.from(detail.data.payload.body.data, 'base64').toString();
            }

            emailDetails.push({
                id: msg.id,
                threadId: msg.threadId,
                subject,
                from,
                to,
                deliveredTo,
                body,
                attachments,
                timestamp: detail.data.internalDate
            });

            // Mark as read
            await gmail.users.messages.batchModify({
                userId: 'me',
                ids: [msg.id],
                resource: {
                    removeLabelIds: ['UNREAD']
                }
            });
        }
        return emailDetails;
    }

    async getAttachment(tokens, messageId, attachmentId) {
        const client = this.createClient();
        client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: client });
        
        const res = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: messageId,
            id: attachmentId
        });

        return Buffer.from(res.data.data, 'base64');
    }
}

module.exports = new GmailService();
