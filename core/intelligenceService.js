const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const { graphExtractionPrompt } = require('./prompts');
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
            
            const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
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

            await this.ingestGraphData(graphData, messageMetadata.messageId);

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

            const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
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

    async ingestGraphData(graphData, sourceId) {
        const { nodes = [], edges = [] } = graphData;
        const nodeMap = {}; 

        // 1. Ingest Nodes
        for (const node of nodes) {
            try {
                const nodeId = await supabaseService.upsertNode(node.type, node.name, {
                    ...node.properties,
                    lastMentionedIn: sourceId
                });
                if (nodeId) {
                    nodeMap[node.name] = nodeId;
                }
            } catch (e) {
                console.error(`❌ IngestNode Error (${node.name}):`, e.message);
            }
        }

        // 2. Ingest Edges
        for (const edge of edges) {
            try {
                const fromId = nodeMap[edge.from];
                const toId = nodeMap[edge.to];

                if (fromId && toId) {
                    await supabaseService.createEdge(fromId, toId, edge.type, {
                        ...edge.properties,
                        sourceId: sourceId,
                        timestamp: new Date()
                    });
                }
            } catch (e) {
                console.error(`❌ IngestEdge Error (${edge.from}->${edge.to}):`, e.message);
            }
        }
    }
}

module.exports = new IntelligenceService();
