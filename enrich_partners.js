require('dotenv').config();
const { supabaseService } = require('./core');
const { GoogleGenAI } = require('@google/genai');

async function enrichSpecificProducts() {
    console.log("🚀 Starting enrichment of Baker Hughes / Waygate products...");
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    // The products extracted from qmindia.net
    const targetProducts = [
        "XL Detect/ Detect+",
        "Mentor Flex",
        "Mentor Visual iQ+",
        "USM 36",
        "USM/DMS Go+",
        "USM 100",
        "DM5E",
        "Mentor UT",
        "CL GO+",
        "RotoArray comPAct",
        "ERESCO",
        "ISOVOLT",
        "CRxVision",
        "DXR75P-HR / DXR140P-HC / DXR100P-HP"
    ];

    try {
        const businessNodeId = await supabaseService.upsertNode('Business', 'Quadrant Marketing', {
            website: 'https://qmindia.net',
            description: 'Precision Tools, Unmatched Service. NDT solutions.'
        });

        const supplierName = 'Baker Hughes / Waygate Technologies';
        const supplierNodeId = await supabaseService.upsertNode('Supplier', supplierName, {
            website: 'https://www.bakerhughes.com/waygate-technologies'
        });

        const supplierDbId = await supabaseService.upsertSupplier(supplierName, {
            website: 'https://www.bakerhughes.com/waygate-technologies',
            description: 'A provider of non-destructive testing (NDT) solutions.'
        });

        if (businessNodeId && supplierNodeId) {
            await supabaseService.createEdge(businessNodeId, supplierNodeId, 'HAS_SUPPLIER');
        }

        for (const productName of targetProducts) {
            console.log(`\n🔍 Researching: ${productName}...`);
            
            const prompt = `Search the official Baker Hughes or Waygate Technologies webpage for the product '${productName}'. 
            Analyze the information and provide:
            1. The product offering (a concise description)
            2. Its limitations (if not explicitly stated, infer reasonable industrial limitations, e.g., size, depth, temperature)
            3. Its primary usecases
            Return ONLY a JSON object with this schema: {"offering": "...", "limitations": ["..."], "usecases": ["..."]}`;

            try {
                const result = await client.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    tools: [{ googleSearch: {} }]
                });

                const responseText = result.text.replace(/```json|```/g, '').trim();
                const enrichmentData = JSON.parse(responseText);

                // Upsert the specific product node in the Knowledge Graph
                const productNodeId = await supabaseService.upsertNode('Product', productName, {
                    offering: enrichmentData.offering,
                    limitations: enrichmentData.limitations,
                    usecases: enrichmentData.usecases,
                    source: supplierName
                });

                // Link to supplier node in graph
                if (supplierNodeId && productNodeId) {
                    await supabaseService.createEdge(supplierNodeId, productNodeId, 'OFFERS_PRODUCT');
                }

                // Upsert into the new dedicated products table
                await supabaseService.upsertProduct(productName, supplierDbId, {
                    offering: enrichmentData.offering,
                    limitations: enrichmentData.limitations,
                    usecases: enrichmentData.usecases,
                    source: supplierName
                });

                // Link to business in graph
                if (businessNodeId && productNodeId) {
                    await supabaseService.createEdge(businessNodeId, productNodeId, 'HAS_PRODUCT');
                }

                console.log(`✅ Successfully enriched and ingested: ${productName}`);
            } catch (innerErr) {
                console.error(`❌ Failed to enrich ${productName}:`, innerErr.message);
            }
        }
        
        console.log("\n🎉 Finished enriching all specific partner products.");
    } catch (err) {
        console.error("❌ Enrichment failed:", err.message);
    }
}

enrichSpecificProducts();
