/**
 * DTO for transforming WhatsApp message data into the Supabase 'messages' table format.
 */
class MessageDTO {
    constructor(data, employeeId) {
        this.messageTraceId = data.messageId;
        this.messageType = this.mapFormatToType(data.format);
        this.description = data.messageDetails;
        this.employeeId = employeeId;
        this.mediaUrl = data.mediaUrl || null;
        this.mediaHash = data.mediaHash || null;
        
        // If messageType is Text, objectId must be null
        if (this.messageType === 'Text') {
            this.objectId = null;
        } else {
            this.objectId = data.objectId || null;
        }
    }

    mapFormatToType(format) {
        const types = { 'text': 'Text', 'PHOTO': 'Image', 'photo': 'Image', 'audio': 'Audio', 'pdf': 'Document', 'video': 'Video' };
        return types[format] || 'Text';
    }

    getPayload() {
        return {
            messageTraceId: this.messageTraceId,
            messageType: this.messageType,
            description: this.description,
            employeeId: this.employeeId,
            objectId: this.objectId,
            mediaUrl: this.mediaUrl,
            mediaHash: this.mediaHash
        };
    }
}

module.exports = MessageDTO;
