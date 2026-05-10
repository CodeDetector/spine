const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const { graphExtractionPrompt, relevanceCheckPrompt } = require('./prompts');
const supabaseService = require('./supabaseService');

class IntelligenceService {
    constructor() {
        this.genAI = null;
        if (config.GEMINI_API_KEY) {
            this.genAI = new GoogleGenAI(config.GEMINI_API_KEY);
        }
    }

    async processMessageForGraph(messageText, messageMetadata = {}) {
        if (!this.genAI) {
            console.error('❌ IntelligenceService: GEMINI_API_KEY not configured.');
            return;
        }

        try {
            console.log('🧠 Omni-Brain: Analyzing message for Knowledge Graph extraction...');
            
            const client = this.genAI;
            const prompt = graphExtractionPrompt(messageText);

            const result = await client.models.generateContent({
                model: 'gemma-4-31b-it',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            
            const responseText = result.text.replace(/```json|```/g, '').trim();
            
            let graphData;
            try {
                graphData = JSON.parse(responseText);
            } catch (jsonErr) {
                console.error('❌ IntelligenceService: Failed to parse AI JSON output:', responseText);
                return;
            }

            await this.ingestGraphData(graphData, messageMetadata.messageId, messageText);

            console.log(`✅ Omni-Brain: Successfully processed message. Ingested ${graphData.nodes?.length || 0} nodes and ${graphData.edges?.length || 0} edges.`);
        } catch (err) {
            console.error('❌ IntelligenceService error:', err.message);
        }
    }

    async runDailyGraphUpdate() {
        if (!this.genAI) {
            console.error('❌ IntelligenceService: GEMINI_API_KEY not configured.');
            return;
        }

        try {
            console.log('🗓️ Omni-Brain: Starting daily batch Knowledge Graph update...');
            
            const messages = await supabaseService.getDailyMessages();
            const emails = await supabaseService.getDailyEmails();

            if (messages.length === 0 && emails.length === 0) {
                console.log('⏭️ No new messages or emails today. Skipping graph update.');
                return;
            }

            let logBlob = "--- DAILY COMMUNICATION LOGS ---\n\n";
            
            messages.forEach(m => {
                logBlob += `[WHATSAPP] [${m.created_at}] Sender: ${m.employees?.Name || 'Unknown'}\nContent: ${m.description}\n\n`;
            });

            emails.forEach(e => {
                logBlob += `[EMAIL] [${e.created_at}] From: ${e.sender} To: ${e.receiver}\nContent: ${e.message}\n\n`;
            });

            console.log(`🧠 Omni-Brain: Sending ${messages.length + emails.length} records to Gemini...`);

            const client = this.genAI;
            const prompt = graphExtractionPrompt(logBlob);

            const result = await client.models.generateContent({
                model: 'gemma-4-31b-it',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            const responseText = result.text.replace(/```json|```/g, '').trim();

            let graphData;
            try {
                graphData = JSON.parse(responseText);
            } catch (jsonErr) {
                console.error('❌ IntelligenceService: Failed to parse Batch AI JSON output:', responseText);
                return;
            }

            await this.ingestGraphData(graphData, 'DAILY-BATCH-' + new Date().toISOString().split('T')[0]);

            console.log(`✅ Omni-Brain: Daily Graph Update Complete. Ingested ${graphData.nodes?.length || 0} nodes and ${graphData.edges?.length || 0} edges.`);
        } catch (err) {
            console.error('❌ Daily Graph Update Error:', err.message);
        }
    }

    async ingestGraphData(graphData, sourceId, messageText = '') {
        const { nodes = [], edges = [] } = graphData;
        const nodeMap = {};

        // Truncate raw message to a concise snippet stored on every edge from this message
        const snippet = messageText
            ? messageText.replace(/\s+/g, ' ').trim().slice(0, 400)
            : '';

        // 1. Ingest Nodes
        for (const node of nodes) {
            try {
                const nodeId = await supabaseService.upsertNode(node.type, node.name, {
                    ...node.properties,
                    lastMentionedIn: sourceId
                });
                if (nodeId) nodeMap[node.name] = nodeId;
            } catch (e) {
                console.error(`❌ IngestNode Error (${node.name}):`, e.message);
            }
        }

        // 2. Ingest Edges — store the source message snippet so the chatbot can quote it
        for (const edge of edges) {
            try {
                const fromId = nodeMap[edge.from];
                const toId   = nodeMap[edge.to];
                if (fromId && toId) {
                    await supabaseService.createEdge(fromId, toId, edge.type, {
                        ...edge.properties,
                        sourceId,
                        timestamp:    new Date(),
                        message_text: snippet || undefined,
                    });
                }
            } catch (e) {
                console.error(`❌ IngestEdge Error (${edge.from}->${edge.to}):`, e.message);
            }
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

    async parseDocumentForGraph(textContent, fileName) {
        if (!this.genAI) {
            console.error('❌ IntelligenceService: GEMINI_API_KEY not configured.');
            return;
        }

        try {
            console.log(`🤖 Omni-Brain Agent: Parsing document ${fileName} in the background...`);
            
            const prompt = `Extract knowledge graph nodes and edges from the following document text. Return ONLY valid JSON matching this schema: {"nodes":[{"type":"Client|Supplier|Employee|Business|Other","name":"...","properties":{}}],"edges":[{"from":"...","to":"...","type":"..."}]}.\n\nDocument Context: ${textContent.substring(0, 50000)}`;

            const client = this.genAI;

            const result = await client.models.generateContent({
                model: 'gemma-4-31b-it',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            
            const responseText = result.text.replace(/```json|```/g, '').trim();
            
            let graphData;
            try {
                graphData = JSON.parse(responseText);
            } catch (jsonErr) {
                console.error('❌ IntelligenceService: Failed to parse Document AI JSON output:', responseText);
                return;
            }

            await this.ingestGraphData(graphData, `DOC-${fileName}`);
            console.log(`✅ Omni-Brain Agent: Automatically updated knowledge map from document ${fileName}.`);
            
        } catch (err) {
            console.error('❌ parseDocumentForGraph error:', err.message);
        }
    }
}

module.exports = new IntelligenceService();
