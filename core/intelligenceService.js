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

            const { nodes = [], edges = [] } = graphData;
            const nodeMap = {}; // Maps "Standardized Name" to Database UUID

            // 1. Ingest Nodes
            for (const node of nodes) {
                const nodeId = await supabaseService.upsertNode(node.type, node.name, {
                    ...node.properties,
                    lastMentionedIn: messageMetadata.messageId
                });
                if (nodeId) {
                    nodeMap[node.name] = nodeId;
                }
            }

            // 2. Ingest Edges
            for (const edge of edges) {
                const fromId = nodeMap[edge.from];
                const toId = nodeMap[edge.to];

                if (fromId && toId) {
                    await supabaseService.createEdge(fromId, toId, edge.type, {
                        ...edge.properties,
                        messageId: messageMetadata.messageId,
                        timestamp: new Date()
                    });
                    console.log(`🔗 Omni-Brain: Ingested Edge [${edge.from}] --(${edge.type})--> [${edge.to}]`);
                } else {
                    console.warn(`⚠️ Omni-Brain: Could not resolve nodes for edge [${edge.from}] -> [${edge.to}]`);
                }
            }

            console.log(`✅ Omni-Brain: Successfully processed message. Ingested ${nodes.length} nodes and ${edges.length} edges.`);
        } catch (err) {
            console.error('❌ IntelligenceService error:', err.message);
        }
    }
}

module.exports = new IntelligenceService();
