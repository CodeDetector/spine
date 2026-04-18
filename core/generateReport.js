const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const supabaseService = require('./supabaseService');
const { managerScreeningReportPrompt, employeeScreeningReportPrompt } = require('./prompts');

async function generateAndSendReport(sock) {
    if (!config.GEMINI_API_KEY) {
        console.error('❌ GEMINI_API_KEY is missing in .env');
        return;
    }

    const genAI = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const model = 'gemma-4-31b-it';

    console.log('📊 Scheduled Task: Generating Dual Summary Reports (Manager & Employee)...');

    try {
        const managers = await supabaseService.getManagers();
        
        if (managers.length === 0) {
            console.warn('⚠️ No managers found (no employees have a managedBy ID).');
            return;
        }

        for (const manager of managers) {
            console.log(`\n🏢 Processing reports for Manager: ${manager.Name} (${manager.contact})...`);
            
            const managerJid = `${manager.contact}@s.whatsapp.net`;
            const teamMembers = await supabaseService.getEmployeesByManager(manager.id);
            
            if (teamMembers.length === 0) {
                console.log(`ℹ️ Manager ${manager.Name} has no team members assigned.`);
                continue;
            }

            await sock.sendMessage(managerJid, { text: `📅 *Daily Team Summary Report* - ${new Date().toLocaleDateString()}\nGathering data for your team (${teamMembers.length} members) from the past 5 days...` });

            for (const employee of teamMembers) {
                console.log(`  🔍 Analyzing messages for: ${employee.Name}...`);
                const messages = await supabaseService.getMessagesByEmployeeId(employee.id, 5);
                
                if (messages.length === 0) {
                    console.log(`  ℹ️ No messages for ${employee.Name} in the last 5 days.`);
                    continue;
                }

                const formattedMessages = messages.map(m => {
                    const date = new Date(m.created_at).toLocaleString();
                    return `[${date}] (${m.messageType}): ${m.description}`;
                }).join('\n');

                const employeeJid = `${employee.contact}@s.whatsapp.net`;

                // 1. Generate Report for Manager
                try {
                    const managerPrompt = managerScreeningReportPrompt(employee, formattedMessages);
                    const managerResult = await genAI.models.generateContent({
                        model: model,
                        contents: [{ role: 'user', parts: [{ text: managerPrompt }] }]
                    });

                    const managerSummary = managerResult.text
                        .replace(/\*\*/g, '*')       // Fix double bold
                        .replace(/#+/g, '')          // Remove all markdown headers (#, ##, ###)
                        .trim();
                    await sock.sendMessage(managerJid, { text: managerSummary });
                    console.log(`  ✅ Sent manager report for ${employee.Name}.`);
                } catch (err) {
                    console.error(`  ❌ Failed manager report for ${employee.Name}:`, err.message);
                }

                // 2. Generate Supportive Hindi Report for Employee
                try {
                    const employeePrompt = employeeScreeningReportPrompt(employee, formattedMessages);
                    const employeeResult = await genAI.models.generateContent({
                        model: model,
                        contents: [{ role: 'user', parts: [{ text: employeePrompt }] }]
                    });

                    const employeeSummary = employeeResult.text
                        .replace(/\*\*/g, '*')       // Fix double bold
                        .replace(/#+/g, '')          // Remove all markdown headers (#, ##, ###)
                        .trim();
                    await sock.sendMessage(employeeJid, { text: employeeSummary });
                    console.log(`  ✅ Sent supportive Hindi report to ${employee.Name} directly.`);
                } catch (err) {
                    console.error(`  ❌ Failed employee report for ${employee.Name}:`, err.message);
                }
            }
        }

        console.log('\n✅ Scheduled dual report generation and delivery completed.');
    } catch (err) {
        console.error('❌ Error during scheduled report generation:', err.message);
    }
}

module.exports = { generateAndSendReport };
