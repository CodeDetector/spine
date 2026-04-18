const supabaseService = require('./core/supabaseService');

async function checkConversations() {
    console.log('📊 --- Conversation & SLA Report ---');
    console.log('Fetching pending replies...\n');

    const pending = await supabaseService.getPendingReplies();

    if (pending.length === 0) {
        console.log('✅ All conversations are up to date! No pending replies found.');
        return;
    }

    console.log(`⚠️ Found ${pending.length} client messages waiting for a reply:\n`);

    // Sort by wait time (longest first)
    pending.sort((a, b) => b.waitTime - a.waitTime);

    console.log(String('CLIENT').padEnd(30) + String('ASSIGNED TO').padEnd(20) + String('WAIT TIME').padEnd(15) + 'LAST MESSAGE');
    console.log('-'.repeat(85));

    pending.forEach(item => {
        const waitStr = item.waitTime > 24 
            ? `\x1b[31m${item.waitTime} hrs\x1b[0m` // Red for > 24h
            : `\x1b[33m${item.waitTime} hrs\x1b[0m`; // Yellow for <= 24h
            
        console.log(
            item.client.padEnd(30) + 
            (item.employee || 'Unassigned').padEnd(20) + 
            waitStr.padEnd(25) + // Extra space for ANSI codes
            new Date(item.lastMessage).toLocaleString()
        );
    });

    console.log('\n-------------------------------------');
}

if (require.main === module) {
    checkConversations().catch(err => console.error('Error running report:', err));
}

module.exports = { checkConversations };
