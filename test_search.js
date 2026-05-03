require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

async function testSearch() {
    console.log("Testing Gemini Search Grounding...");
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    try {
        const result = await client.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: "Search the official Baker Hughes webpage for the product 'XL Detect'. What is the product offering, its limitations, and usecases? Return a short summary." }] }],
            tools: [{ googleSearch: {} }]
        });
        
        console.log(result.text);
    } catch(err) {
        console.error("Failed:", err.message);
    }
}
testSearch();
