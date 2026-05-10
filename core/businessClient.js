// HTTP client for the mapMyBusiness microservice (omni-business container).
// Used by wa-field-tracker for internal calls that don't go through a user request
// (e.g. enriching the AI prompt with business profile, fetching onboarding status).
//
// User-initiated calls go via the proxy in server.js, which forwards the user's
// JWT. This client uses an internal service token instead.

const BASE_URL = process.env.BUSINESS_SERVICE_URL || 'http://omni-business:3002';

async function call(path, init = {}) {
    const url = `${BASE_URL}${path}`;
    const headers = {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN || '',
        ...(init.headers || {}),
    };
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`mapMyBusiness ${path} ${res.status}: ${text}`);
    }
    return res.json();
}

async function readProfile() {
    try { return await call('/internal/business/profile'); }
    catch (err) { console.error('businessClient.readProfile:', err.message); return null; }
}

async function getOnboardingStatus() {
    try { return await call('/internal/onboarding/status'); }
    catch (err) {
        console.error('businessClient.getOnboardingStatus:', err.message);
        return { hasBusiness: false, supplierCount: 0, clientCount: 0, hasAdmin: false, employeeCount: 0 };
    }
}

function formatProfileForPrompt(profile) {
    if (!profile) return '';
    const lines = [];
    if (profile.name)        lines.push(`Business: ${profile.name}`);
    if (profile.industry)    lines.push(`Industry: ${profile.industry}`);
    if (profile.description) lines.push(`What we do: ${profile.description}`);
    if (profile.hq_location) lines.push(`Headquarters: ${profile.hq_location}`);
    if (profile.website)     lines.push(`Website: ${profile.website}`);
    if (profile.linkedin)    lines.push(`LinkedIn: ${profile.linkedin}`);
    if (!lines.length) return '';
    return ['=== Business Profile ===', ...lines, '========================'].join('\n');
}

module.exports = { readProfile, getOnboardingStatus, formatProfileForPrompt };
