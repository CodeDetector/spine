const fs   = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '..', 'data', 'business_profile.json');

const DEFAULT_PROFILE = {
    owner: {
        name:  '',
        role:  '',
        email: '',
        phone: '',
    },
    business: {
        name:        '',
        industry:    '',
        type:        '',
        description: '',
        website:     '',
        location:    '',
    },
};

function ensureDataDir() {
    const dir = path.dirname(PROFILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readProfile() {
    try {
        ensureDataDir();
        if (!fs.existsSync(PROFILE_PATH)) return { ...DEFAULT_PROFILE };
        return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
    } catch {
        return { ...DEFAULT_PROFILE };
    }
}

function writeProfile(profile) {
    ensureDataDir();
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf8');
    return profile;
}

// Returns a compact plain-text block suitable for injection into AI prompts.
function formatProfileForPrompt(profile) {
    const o = profile?.owner   || {};
    const b = profile?.business || {};

    const lines = [];
    if (b.name)        lines.push(`Business: ${b.name}`);
    if (b.industry)    lines.push(`Industry: ${b.industry}`);
    if (b.type)        lines.push(`Business type: ${b.type}`);
    if (b.description) lines.push(`What we do: ${b.description}`);
    if (b.location)    lines.push(`Location: ${b.location}`);
    if (b.website)     lines.push(`Website: ${b.website}`);
    if (o.name)        lines.push(`Owner: ${o.name}${o.role ? ` (${o.role})` : ''}`);
    if (o.email)       lines.push(`Owner email: ${o.email}`);
    if (o.phone)       lines.push(`Owner phone: ${o.phone}`);

    if (!lines.length) return '';
    return ['=== Business Owner Profile ===', ...lines, '=============================='].join('\n');
}

module.exports = { readProfile, writeProfile, formatProfileForPrompt };
