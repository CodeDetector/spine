const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const { relevanceCheckPrompt } = require('./prompts');
const supabaseService = require('./supabaseService');

class IntelligenceService {
    constructor() {
        this.genAI = null;
        if (config.GEMINI_API_KEY) {
            this.genAI = new GoogleGenAI(config.GEMINI_API_KEY);
        }
    }

    // ── Business relevance gate ─────────────────────────────────────────────
    // Returns a score 0-100. Callers use >80 as the threshold for graph ingestion.
    async scoreEmailRelevance(emailText) {
        if (!this.genAI) return 100; // fail-open if AI not configured
        try {
            const prompt = relevanceCheckPrompt(emailText);
            const result = await this.genAI.models.generateContent({
                model: 'gemma-4-31b-it',
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
            });
            const raw = result.text.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(raw);
            const score = Number(parsed.score);
            console.log(`📊 Email relevance score: ${score} — ${parsed.reason}`);
            return isNaN(score) ? 0 : score;
        } catch (err) {
            console.warn('⚠️  scoreEmailRelevance failed, defaulting to 0:', err.message);
            return 0;
        }
    }

    // ── In-memory chat sessions ──────────────────────────────────────────────
    // Map<sessionId, { turns: [{role, text}], lastActive: Date }>
    // Sessions older than 2 hours are purged automatically.

    _ensureSessionStore() {
        if (!this._sessions) {
            this._sessions = new Map();
            // Sweep stale sessions every 30 minutes
            setInterval(() => {
                const cutoff = Date.now() - 2 * 60 * 60 * 1000;
                for (const [id, s] of this._sessions) {
                    if (s.lastActive < cutoff) this._sessions.delete(id);
                }
            }, 30 * 60 * 1000).unref();
        }
    }

    clearChatSession(sessionId) {
        this._ensureSessionStore();
        this._sessions.delete(sessionId);
    }

    async chatWithGraph(sessionId, userMessage, context) {
        if (!this.genAI) {
            return { reply: '❌ IntelligenceService: GEMINI_API_KEY not configured.' };
        }

        this._ensureSessionStore();

        // Retrieve or create session
        if (!this._sessions.has(sessionId)) {
            this._sessions.set(sessionId, { turns: [], lastActive: Date.now() });
        }
        const session = this._sessions.get(sessionId);
        session.lastActive = Date.now();

        console.log(`🧠 Knowledge-Map Chat [${sessionId.slice(0, 8)}]: turn ${session.turns.length / 2 + 1}`);

        const businessClient = require('./businessClient');
        const profile = await businessClient.readProfile();
        const profileBlock = businessClient.formatProfileForPrompt(profile);

        const systemInstruction = `You are a business intelligence assistant helping the employee of this business understand their knowledge graph.
${profileBlock ? '\n' + profileBlock + '\n' : ''}
=== Knowledge Graph Context ===
${context}
================================

Rules:
- Always respond with ONLY a valid JSON object — no markdown fences, no extra text.
- Format: { "reply": "<answer>", "graph_update": { "highlight_names": ["<exact name>", ...] } }
- "reply" is a plain string; you may use **bold** for entity names.
- "highlight_names" lists exact entity names from the context relevant to your answer. Use [] if none apply.
- Never invent entities that are not in the context.
- You have full memory of this conversation — refer back to earlier questions and answers when relevant.`;

        try {
            // Build Gemini contents from stored turns (strictly alternating user/model)
            const contents = session.turns.map(t => ({
                role: t.role,
                parts: [{ text: t.text }],
            }));
            contents.push({ role: 'user', parts: [{ text: userMessage }] });

            const client = this.genAI;
            const result = await client.models.generateContent({
                model: 'gemini-2.5-flash',
                config: { systemInstruction },
                contents,
            });

            const replyText = result.text;

            // Persist both turns — cap session at 40 turns (20 exchanges) to bound memory
            session.turns.push({ role: 'user',  text: userMessage });
            session.turns.push({ role: 'model', text: replyText   });
            if (session.turns.length > 40) session.turns.splice(0, 2);

            return { reply: replyText };
        } catch (err) {
            console.error('❌ chatWithGraph error:', err.message);
            return { reply: `Error: ${err.message}` };
        }
    }

    async chatWithAgent(prompt) {
        if (!this.genAI) {
            return { reply: "❌ IntelligenceService: GEMINI_API_KEY not configured." };
        }

        try {
            console.log('🤖 Omni-Brain Agent: Processing query...');
            
            // Get graph context
            const graph = await supabaseService.getFullGraph();
            const graphContext = JSON.stringify(graph); // compress slightly

            // If graph is too large, we might need to filter, but for now we send it all
            const systemPrompt = `You are an AI Business Agent. You have access to the following business knowledge map containing nodes (employees, clients, suppliers) and relationships:\n\n${graphContext}\n\nBased on this knowledge map, answer the user's query: "${prompt}".\nIf they ask about a specific client or supplier, analyze their relationships. Provide a helpful, clear, and professional response.`;

            const client = this.genAI;

            const result = await client.models.generateContent({
                model: 'gemma-4-31b-it',
                contents: [{ role: 'user', parts: [{ text: systemPrompt }] }]
            });
            
            return { reply: result.text };
        } catch (err) {
            console.error('❌ chatWithAgent error:', err.message);
            return { reply: `Error: ${err.message}` };
        }
    }

}

module.exports = new IntelligenceService();
