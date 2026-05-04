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
        'ALLOWED_GROUPS', 'EXCEL_FILE_PATH', 'SUPABASE_URL', 'SUPABASE_KEY',
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

// ─── ALLOWED_GROUP_NAMES ──────────────────────────────────────────────────────

describe('ALLOWED_GROUP_NAMES', () => {
    test('returns empty array when ALLOWED_GROUPS is undefined (no crash)', () => {
        delete process.env.ALLOWED_GROUPS;
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual([]);
    });

    test('returns empty array when ALLOWED_GROUPS is empty string', () => {
        process.env.ALLOWED_GROUPS = '';
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual([]);
    });

    test('parses a single group name', () => {
        process.env.ALLOWED_GROUPS = 'SalesTeam';
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual(['salesteam']);
    });

    test('parses multiple comma-separated group names', () => {
        process.env.ALLOWED_GROUPS = 'SalesTeam,SupportTeam,DevTeam';
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual(['salesteam', 'supportteam', 'devteam']);
    });

    test('lowercases all group names', () => {
        process.env.ALLOWED_GROUPS = 'ALPHA,Bravo,CHARLIE';
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual(['alpha', 'bravo', 'charlie']);
    });

    test('trims whitespace around group names', () => {
        process.env.ALLOWED_GROUPS = '  GroupA , GroupB  ';
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual(['groupa', 'groupb']);
    });

    test('strips surrounding single quotes from each name', () => {
        process.env.ALLOWED_GROUPS = "'GroupA','GroupB'";
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual(['groupa', 'groupb']);
    });

    test('strips surrounding double quotes from each name', () => {
        process.env.ALLOWED_GROUPS = '"GroupA","GroupB"';
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual(['groupa', 'groupb']);
    });

    test('removes square brackets wrapping the list', () => {
        process.env.ALLOWED_GROUPS = '[GroupA,GroupB]';
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual(['groupa', 'groupb']);
    });

    test('filters out empty entries from trailing/double commas', () => {
        process.env.ALLOWED_GROUPS = 'GroupA,,GroupB,';
        const config = loadConfig();
        expect(config.ALLOWED_GROUP_NAMES).toEqual(['groupa', 'groupb']);
    });
});

// ─── Other config fields ──────────────────────────────────────────────────────

describe('EXCEL_FILE_PATH', () => {
    test('defaults to data.xlsx when env var is not set', () => {
        delete process.env.EXCEL_FILE_PATH;
        const config = loadConfig();
        expect(config.EXCEL_FILE_PATH).toBe('data.xlsx');
    });

    test('uses env var value when set', () => {
        process.env.EXCEL_FILE_PATH = '/tmp/my_data.xlsx';
        const config = loadConfig();
        expect(config.EXCEL_FILE_PATH).toBe('/tmp/my_data.xlsx');
    });
});

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
