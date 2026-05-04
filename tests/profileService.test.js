'use strict';

// Mock 'fs' before requiring the module under test
jest.mock('fs');

const fs = require('fs');
const profileService = require('../core/profileService');

// Helper: the resolved absolute path the module uses internally.
// We do NOT import PROFILE_PATH directly, so we match any path argument.
const ANY_PATH = expect.any(String);

const DEFAULT_PROFILE = {
    owner:    { name: '', role: '', email: '', phone: '' },
    business: { name: '', industry: '', type: '', description: '', website: '', location: '' },
};

// ─── readProfile ─────────────────────────────────────────────────────────────

describe('readProfile', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns DEFAULT_PROFILE when file does not exist', () => {
        fs.existsSync.mockReturnValue(false);
        const result = profileService.readProfile();
        expect(result).toEqual(DEFAULT_PROFILE);
    });

    test('returns parsed JSON when file exists', () => {
        const stored = {
            owner:    { name: 'Alice', role: 'CEO', email: 'a@b.com', phone: '1234' },
            business: { name: 'Acme', industry: 'Tech', type: 'B2B', description: 'Builds things', website: 'acme.com', location: 'NY' }
        };
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(stored));
        expect(profileService.readProfile()).toEqual(stored);
    });

    test('returns DEFAULT_PROFILE when file is corrupted JSON', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('{ broken json ');
        expect(profileService.readProfile()).toEqual(DEFAULT_PROFILE);
    });

    test('returns DEFAULT_PROFILE when readFileSync throws', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
        expect(profileService.readProfile()).toEqual(DEFAULT_PROFILE);
    });

    test('calls mkdirSync when data directory does not exist', () => {
        // First existsSync call = directory check; second = file check
        fs.existsSync
            .mockReturnValueOnce(false)  // dir does not exist
            .mockReturnValueOnce(false); // file does not exist
        profileService.readProfile();
        expect(fs.mkdirSync).toHaveBeenCalledWith(ANY_PATH, { recursive: true });
    });

    test('does not call mkdirSync when data directory already exists', () => {
        fs.existsSync
            .mockReturnValueOnce(true)  // dir exists
            .mockReturnValueOnce(false); // file does not exist
        profileService.readProfile();
        expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
});

// ─── writeProfile ─────────────────────────────────────────────────────────────

describe('writeProfile', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        fs.existsSync.mockReturnValue(true); // dir exists by default
    });

    test('writes JSON with 2-space indent to the profile path', () => {
        const profile = { owner: { name: 'Bob' }, business: { name: 'BobCo' } };
        profileService.writeProfile(profile);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            ANY_PATH,
            JSON.stringify(profile, null, 2),
            'utf8'
        );
    });

    test('returns the profile that was written', () => {
        const profile = { owner: { name: 'Carol' }, business: {} };
        fs.writeFileSync.mockReturnValue(undefined);
        const result = profileService.writeProfile(profile);
        expect(result).toBe(profile);
    });

    test('creates the data directory when it is missing before writing', () => {
        fs.existsSync.mockReturnValue(false); // dir does not exist
        profileService.writeProfile(DEFAULT_PROFILE);
        expect(fs.mkdirSync).toHaveBeenCalledWith(ANY_PATH, { recursive: true });
    });
});

// ─── formatProfileForPrompt ──────────────────────────────────────────────────

describe('formatProfileForPrompt', () => {
    test('returns empty string for empty profile', () => {
        expect(profileService.formatProfileForPrompt(DEFAULT_PROFILE)).toBe('');
    });

    test('returns empty string for null profile', () => {
        expect(profileService.formatProfileForPrompt(null)).toBe('');
    });

    test('returns empty string for undefined profile', () => {
        expect(profileService.formatProfileForPrompt(undefined)).toBe('');
    });

    test('includes header and footer when there is content', () => {
        const profile = { owner: {}, business: { name: 'Acme' } };
        const result = profileService.formatProfileForPrompt(profile);
        expect(result).toContain('=== Business Owner Profile ===');
        expect(result).toContain('==============================');
    });

    test('includes business name line when set', () => {
        const profile = { owner: {}, business: { name: 'Acme Corp' } };
        expect(profileService.formatProfileForPrompt(profile)).toContain('Business: Acme Corp');
    });

    test('includes industry line when set', () => {
        const profile = { owner: {}, business: { industry: 'Manufacturing' } };
        expect(profileService.formatProfileForPrompt(profile)).toContain('Industry: Manufacturing');
    });

    test('includes business type line when set', () => {
        const profile = { owner: {}, business: { type: 'B2C' } };
        expect(profileService.formatProfileForPrompt(profile)).toContain('Business type: B2C');
    });

    test('includes description line when set', () => {
        const profile = { owner: {}, business: { description: 'We sell widgets' } };
        expect(profileService.formatProfileForPrompt(profile)).toContain('What we do: We sell widgets');
    });

    test('includes location line when set', () => {
        const profile = { owner: {}, business: { location: 'Mumbai' } };
        expect(profileService.formatProfileForPrompt(profile)).toContain('Location: Mumbai');
    });

    test('includes website line when set', () => {
        const profile = { owner: {}, business: { website: 'acme.com' } };
        expect(profileService.formatProfileForPrompt(profile)).toContain('Website: acme.com');
    });

    test('includes owner name without role when role is empty', () => {
        const profile = { owner: { name: 'Dave', role: '' }, business: {} };
        const result = profileService.formatProfileForPrompt(profile);
        expect(result).toContain('Owner: Dave');
        expect(result).not.toContain('(');
    });

    test('includes owner name with role in parentheses when role is set', () => {
        const profile = { owner: { name: 'Eve', role: 'CTO' }, business: {} };
        expect(profileService.formatProfileForPrompt(profile)).toContain('Owner: Eve (CTO)');
    });

    test('includes owner email when set', () => {
        const profile = { owner: { name: 'Frank', email: 'f@co.com' }, business: {} };
        expect(profileService.formatProfileForPrompt(profile)).toContain('Owner email: f@co.com');
    });

    test('includes owner phone when set', () => {
        const profile = { owner: { name: 'Gina', phone: '+91-9999999999' }, business: {} };
        expect(profileService.formatProfileForPrompt(profile)).toContain('Owner phone: +91-9999999999');
    });

    test('omits lines for empty/falsy fields', () => {
        const profile = { owner: { name: 'Harry' }, business: { name: 'HarryCo', website: '' } };
        const result = profileService.formatProfileForPrompt(profile);
        expect(result).not.toContain('Website:');
    });

    test('full profile produces all expected lines', () => {
        const profile = {
            owner:    { name: 'Alice', role: 'CEO', email: 'a@b.com', phone: '1234' },
            business: { name: 'Acme', industry: 'Tech', type: 'B2B', description: 'Builds things', website: 'acme.com', location: 'NY' }
        };
        const result = profileService.formatProfileForPrompt(profile);
        expect(result).toContain('Business: Acme');
        expect(result).toContain('Industry: Tech');
        expect(result).toContain('Business type: B2B');
        expect(result).toContain('What we do: Builds things');
        expect(result).toContain('Location: NY');
        expect(result).toContain('Website: acme.com');
        expect(result).toContain('Owner: Alice (CEO)');
        expect(result).toContain('Owner email: a@b.com');
        expect(result).toContain('Owner phone: 1234');
    });
});
