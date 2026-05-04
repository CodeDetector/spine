'use strict';

const MessageDTO = require('../core/dto');

describe('MessageDTO', () => {
    // ─── constructor ─────────────────────────────────────────────────────────

    describe('constructor', () => {
        test('sets all fields from data and employeeId', () => {
            const dto = new MessageDTO(
                {
                    messageId: 'msg-001',
                    format: 'text',
                    messageDetails: 'Hello world',
                    mediaUrl: 'https://example.com/img.jpg',
                    mediaHash: 'abc123',
                    objectId: 'obj-1'
                },
                'emp-42'
            );

            expect(dto.messageTraceId).toBe('msg-001');
            expect(dto.messageType).toBe('Text');
            expect(dto.description).toBe('Hello world');
            expect(dto.employeeId).toBe('emp-42');
            expect(dto.mediaUrl).toBe('https://example.com/img.jpg');
            expect(dto.mediaHash).toBe('abc123');
        });

        test('sets objectId to null when messageType is Text', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'text', objectId: 'should-be-null' }, 'e1');
            expect(dto.objectId).toBeNull();
        });

        test('sets objectId from data when messageType is not Text', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'PHOTO', objectId: 'obj-99' }, 'e1');
            expect(dto.objectId).toBe('obj-99');
        });

        test('sets objectId to null when non-Text but objectId is missing', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'video' }, 'e1');
            expect(dto.objectId).toBeNull();
        });

        test('sets mediaUrl to null when not provided', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'text' }, 'e1');
            expect(dto.mediaUrl).toBeNull();
        });

        test('sets mediaHash to null when not provided', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'text' }, 'e1');
            expect(dto.mediaHash).toBeNull();
        });
    });

    // ─── mapFormatToType ─────────────────────────────────────────────────────

    describe('mapFormatToType', () => {
        const dto = new MessageDTO({ messageId: 'x', format: 'text' }, 'e');

        test.each([
            ['text',  'Text'],
            ['PHOTO', 'Image'],
            ['photo', 'Image'],
            ['audio', 'Audio'],
            ['pdf',   'Document'],
            ['video', 'Video'],
        ])('maps format %s → %s', (format, expected) => {
            expect(dto.mapFormatToType(format)).toBe(expected);
        });

        test('returns Text for unknown format', () => {
            expect(dto.mapFormatToType('gif')).toBe('Text');
        });

        test('returns Text for undefined format', () => {
            expect(dto.mapFormatToType(undefined)).toBe('Text');
        });

        test('returns Text for empty string format', () => {
            expect(dto.mapFormatToType('')).toBe('Text');
        });
    });

    // ─── getPayload ──────────────────────────────────────────────────────────

    describe('getPayload', () => {
        test('returns an object with all expected keys', () => {
            const dto = new MessageDTO(
                { messageId: 'msg-2', format: 'audio', messageDetails: 'Voice note' },
                'emp-7'
            );
            const payload = dto.getPayload();

            expect(payload).toHaveProperty('messageTraceId', 'msg-2');
            expect(payload).toHaveProperty('messageType', 'Audio');
            expect(payload).toHaveProperty('description', 'Voice note');
            expect(payload).toHaveProperty('employeeId', 'emp-7');
            expect(payload).toHaveProperty('objectId');
            expect(payload).toHaveProperty('mediaUrl');
            expect(payload).toHaveProperty('mediaHash');
        });

        test('payload contains exactly the documented 7 keys (no extras leaked)', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'text' }, 'e');
            const keys = Object.keys(dto.getPayload());
            expect(keys.sort()).toEqual(
                ['description', 'employeeId', 'mediaHash', 'mediaUrl', 'messageTraceId', 'messageType', 'objectId'].sort()
            );
        });

        test('payload for Text message has objectId null', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'text', objectId: 'should-not-appear' }, 'e');
            expect(dto.getPayload().objectId).toBeNull();
        });

        test('payload for Image message preserves objectId', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'PHOTO', objectId: 'img-99' }, 'e');
            expect(dto.getPayload().objectId).toBe('img-99');
        });

        test('getPayload returns a plain object (not a class instance)', () => {
            const dto = new MessageDTO({ messageId: 'x', format: 'text' }, 'e');
            expect(dto.getPayload().constructor).toBe(Object);
        });
    });
});
