const { supabaseService } = require('./core');

async function seedQMind() {
    console.log("Seeding QMind India Knowledge Graph...");
    try {
        const businessNodeId = await supabaseService.upsertNode('Business', 'Quadrant Marketing', {
            website: 'https://qmindia.net',
            description: 'Precision Tools, Unmatched Service. NDT solutions.'
        });

        const products = [
            {
                name: 'Ultrasonic Testing (UT) Solutions',
                description: 'Ultrasonic testing equipment, testing machines, instrumentation, transducers, and software for industrial applications requiring internal defect detection and sizing.'
            },
            {
                name: 'Radiographic Testing (RT) Solutions',
                description: 'Comprehensive range of industrial radiographic equipment and techniques from film to digital and X-ray generators to integrated test machines.'
            },
            {
                name: 'Remote Visual Inspection (RVI) Solutions',
                description: 'Comprehensive selection of remote viewing equipment from basic borescopes and fiberscope to measurement capable digital video borescopes.'
            }
        ];

        for (const product of products) {
            const productNodeId = await supabaseService.upsertNode('Product', product.name, {
                description: product.description
            });
            if (productNodeId && businessNodeId) {
                await supabaseService.createEdge(businessNodeId, productNodeId, 'OFFERS_PRODUCT');
                console.log(`Linked product: ${product.name}`);
            }
        }

        console.log("✅ Successfully seeded qmindia.net knowledge graph.");
    } catch (err) {
        console.error("❌ Seed failed:", err);
    }
}

seedQMind();
