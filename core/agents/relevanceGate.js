// relevanceGate — cheap Gemini call that scores whether a message is worth
// extracting into the comms graph, given the business context.
//
// Two-call model (per PRD §6): junk filter is intentionally separate from the
// extractor so we burn cheap tokens on noise, expensive tokens only on signal.

const { GoogleGenAI } = require('@google/genai');
const config = require('../config');

const MODEL = process.env.GEMINI_GATE_MODEL || 'gemini-2.0-flash';
const DEFAULT_THRESHOLD = Number(process.env.RELEVANCE_THRESHOLD || 50);

let _genAI = null;
function _client() {
    if (_genAI) return _genAI;
    if (!config.GEMINI_API_KEY) throw new Error('relevanceGate: GEMINI_API_KEY not configured');
    _genAI = new GoogleGenAI(config.GEMINI_API_KEY);
    return _genAI;
}

function _safeJSONParse(text) {
    return JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
}

function _buildPrompt({ businessPrompt, channel, messageText }) {
    return [
        'You are a relevance scorer for a B2B business intelligence platform.',
        'Decide whether the message below is worth extracting into the company\'s',
        'knowledge graph, given the business context.',
        '',
        'Score 0-100:',
        '  90-100: directly mentions a client, supplier, product, price, or commitment',
        '  60-89:  business-related, but not yet specific (intro, scheduling, request)',
        '  30-59:  ambiguous — could matter, could be social/banter',
        '  0-29:   junk: spam, OTPs, transaction SMS, social chatter, marketing blast',
        '',
        'Output JSON ONLY: { "score": <int>, "reason": "<<= 25 words>>" }',
        '',
        businessPrompt || '(business context empty)',
        '',
        `=== INCOMING ${String(channel || 'COMMS').toUpperCase()} MESSAGE ===`,
        String(messageText || '').slice(0, 4000),
        '',
        'Return JSON now.',
    ].join('\n');
}

/**
 * @returns {Promise<{score:number, reason:string, passed:boolean, threshold:number}>}
 */
async function score({ channel, messageText, businessPrompt, threshold = DEFAULT_THRESHOLD }) {
    if (!messageText || !String(messageText).trim()) {
        return { score: 0, reason: 'empty message', passed: false, threshold };
    }

    const prompt = _buildPrompt({ businessPrompt, channel, messageText });

    let raw = '';
    try {
        const result = await _client().models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        raw = result?.text || '';
        const parsed = _safeJSONParse(raw);
        const numeric = Math.max(0, Math.min(100, Number(parsed.score) || 0));
        const reason = String(parsed.reason || '').slice(0, 200);
        return { score: numeric, reason, passed: numeric >= threshold, threshold };
    } catch (err) {
        // Fail-closed: if the gate itself errors, suppress the message rather
        // than letting it through unscored. Suppression is cheaper than a bad
        // extraction pass on junk.
        console.warn('relevanceGate: scoring failed, defaulting to score=0:', err.message);
        return { score: 0, reason: `gate-error: ${err.message?.slice(0, 100)}`, passed: false, threshold };
    }
}

module.exports = { score };
