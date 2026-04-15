function parseMessage(msg) {
    if (!msg.message) return null; // No message content
    
    // Determine the type of message and format
    let action = 'NEW';
    let format = 'unknown';
    let messageDetails = '';

    // Handle Edit (protocolMessage, type 14 is editedMessage)
    if (msg.message.protocolMessage && msg.message.protocolMessage.type === 14) {
        action = 'edit';
        const editedMsg = msg.message.protocolMessage.editedMessage;
        if (editedMsg) {
            const parsedEdited = extractFormatAndDetails({ message: editedMsg });
            format = parsedEdited.format;
            messageDetails = parsedEdited.messageDetails;
            
            return {
                messageId: msg.message.protocolMessage.key.id,
                action,
                format,
                messageDetails
            };
        }
    }

    // Handle Delete (protocolMessage, type 0 is revoke)
    // Wait, revoke could be type 0 but Baileys might just show it as msg.message.protocolMessage.type === 0 (REVOKE)
    if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
        action = 'DELETE';
        return {
            messageId: msg.message.protocolMessage.key.id,
            action,
            format: 'none',
            messageDetails: 'Message Deleted'
        };
    }

    const standardParsed = extractFormatAndDetails(msg);
    format = standardParsed.format;
    messageDetails = standardParsed.messageDetails;

    return {
        messageId: msg.key.id,
        action,
        format,
        messageDetails
    };
}

function extractFormatAndDetails(msg) {
    let format = 'UNKNOWN';
    let messageDetails = '';

    const messageContent = msg.message;
    
    if (messageContent.conversation) {
        format = 'text';
        messageDetails = messageContent.conversation;
    } else if (messageContent.extendedTextMessage) {
        format = 'text';
        messageDetails = messageContent.extendedTextMessage.text;
    } else if (messageContent.imageMessage) {
        format = 'photo';
        messageDetails = messageContent.imageMessage.caption || '[Image]';
    } else if (messageContent.audioMessage) {
        format = 'audio';
        messageDetails = '[Audio message]';
    } else if (messageContent.documentMessage) {
        format = 'pdf'; // or generic document
        messageDetails = messageContent.documentMessage.fileName || '[Document]';
    } else if (messageContent.documentWithCaptionMessage) {
        format = 'pdf';
        const docMsg = messageContent.documentWithCaptionMessage.message.documentMessage;
        messageDetails = (docMsg && docMsg.fileName ? docMsg.fileName : '[Document]') + ' - ' + (docMsg && docMsg.caption ? docMsg.caption : '');
    } else if (messageContent.videoMessage) {
        format = 'video';
        messageDetails = messageContent.videoMessage.caption || '[Video]';
    }

    return { format, messageDetails };
}

module.exports = {
    parseMessage
};
