'use strict';

// config.js is evaluated once at require-time, so we must reset the module
// registry and restore env vars around each test that needs different values.

// Mock dotenv so it does NOT try to load an actual .env file during tests.
jest.mock('dotenv', () => ({ config: jest.fn() }));

// Helper: load a fresh config module in the current process.env state.
function loadConfig() {
    jest.resetModules();
    // dotenv must be re-mocked after resetModules
    jest.mock('dotenv', () => ({ config: jest.fn() }));
    return require('../core/config');
}

// Save the original env vars we will manipulate.
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    // Restore every key we may have mutated
    const keysToRestore = [
        'SUPABASE_URL', 'SUPABASE_KEY',
        'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'
    ];
    keysToRestore.forEach(k => {
        if (ORIGINAL_ENV[k] === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = ORIGINAL_ENV[k];
        }
    });
});

// ─── Config fields ────────────────────────────────────────────────────────────

describe('GOOGLE_REDIRECT_URI', () => {
    test('defaults to urn:ietf:wg:oauth:2.0:oob when env var is not set', () => {
        delete process.env.GOOGLE_REDIRECT_URI;
        const config = loadConfig();
        expect(config.GOOGLE_REDIRECT_URI).toBe('urn:ietf:wg:oauth:2.0:oob');
    });

    test('uses env var value when set', () => {
        process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/callback';
        const config = loadConfig();
        expect(config.GOOGLE_REDIRECT_URI).toBe('http://localhost:3000/callback');
    });
});

describe('Pass-through env vars (SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, etc.)', () => {
    test('SUPABASE_URL reflects env var', () => {
        process.env.SUPABASE_URL = 'https://xyz.supabase.co';
        const config = loadConfig();
        expect(config.SUPABASE_URL).toBe('https://xyz.supabase.co');
    });

    test('SUPABASE_URL is undefined when env var is not set', () => {
        delete process.env.SUPABASE_URL;
        const config = loadConfig();
        expect(config.SUPABASE_URL).toBeUndefined();
    });

    test('SUPABASE_KEY reflects env var', () => {
        process.env.SUPABASE_KEY = 'my-super-secret-key';
        const config = loadConfig();
        expect(config.SUPABASE_KEY).toBe('my-super-secret-key');
    });

    test('GEMINI_API_KEY reflects env var', () => {
        process.env.GEMINI_API_KEY = 'gemini-key-123';
        const config = loadConfig();
        expect(config.GEMINI_API_KEY).toBe('gemini-key-123');
    });

    test('GOOGLE_CLIENT_ID reflects env var', () => {
        process.env.GOOGLE_CLIENT_ID = 'gci-abc';
        const config = loadConfig();
        expect(config.GOOGLE_CLIENT_ID).toBe('gci-abc');
    });

    test('GOOGLE_CLIENT_SECRET reflects env var', () => {
        process.env.GOOGLE_CLIENT_SECRET = 'gcs-secret';
        const config = loadConfig();
        expect(config.GOOGLE_CLIENT_SECRET).toBe('gcs-secret');
    });
});
