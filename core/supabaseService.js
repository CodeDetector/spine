const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const MessageDTO = require('./dto');
const { damerauLevenshtein } = require('./utils');


class SupabaseService {
    constructor() {
        if (!config.SUPABASE_URL || !config.SUPABASE_KEY) {
            console.error('❌ Supabase credentials missing in .env');
            this.client = null;
        } else {
            this.client = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);
            console.log('✅ Supabase client initialized.');
        }
    }

    async getEmployeeId(sender) {
        if (!this.client) return null;
        try {
            let query = this.client.from('employees').select('id');

            // If it's an email, only check the emailId column to avoid bigint errors
            if (sender.includes('@')) {
                const { data, error } = await query.eq('emailId', sender).single();
                if (error) return null;
                return data.id;
            } 
            
            // If it's a number (for WhatsApp), check contact and Mobile
            const { data, error } = await query
                .or(`contact.eq.${sender},Mobile.eq.${sender}`)
                .single();

            if (error) {
                console.warn(`⚠️ Could not find employee with number/email ${sender}: ${error.message}`);
                return null;
            }
            return data.id;
        } catch (err) {
            console.error('❌ Error fetching employee ID:', err.message);
            return null;
        }
    }

    async logToMessagesTable(data) {
        if (!this.client) return;
        try {
            const employeeId = await this.getEmployeeId(data.sender);
            if (!employeeId) {
                console.error(`❌ Cannot log message: Employee ID not found for ${data.sender}`);
                return;
            }

            const { error } = await this.client
                .from('messages')
                .insert([{
                    messageType: data.messageType || 'Text',
                    description: data.description,
                    employeeId: employeeId,
                    objectId: data.objectId || null
                }]);

            if (error) console.error('❌ Error logging to messages table:', error.message);
            else console.log(`✅ Message logged to Supabase messages table.`);
        } catch (err) {
            console.error('❌ Supabase log failed:', err.message);
        }
    }

    async sendtoDatabase(message) {
        if (!this.client) return;

        try {
            // 1. Resolve Employee ID using phone number (Mobile)
            const employeeId = await this.getEmployeeId(message.senderNumber);
            
            if (!employeeId) {
                console.error(`❌ Cannot send to database: Employee ID not found for phone ${message.senderNumber}`);
                return;
            }

            // 2. Transform using DTO
            const dto = new MessageDTO(message, employeeId);
            const payload = dto.getPayload();

            // 3. Insert into 'messages' table
            const { error } = await this.client
                .from('messages')
                .insert([payload]);

            if (error) {
                console.error('❌ Error inserting into Supabase messages table:', error.message);
            } else {
                console.log(`✅ Message payload successfully sent to Supabase messages table.`);
            }
        } catch (err) {
            console.error('❌ sendtoDatabase failed:', err.message);
        }
    }

    async getIdByEmail(email, table) {
        if (!this.client || !email) return null;
        try {
            const { data, error } = await this.client
                .from(table)
                .select('id')
                .eq('emailId', email)
                .single();
            if (error) return null;
            return data.id;
        } catch (err) {
            return null;
        }
    }

    async logEmailToDatabase(emailData) {
        if (!this.client) return;
        try {
            // Check if hash already exists to prevent duplicates
            if (emailData.hash) {
                const { data: existing } = await this.client
                    .from('emails')
                    .select('id')
                    .eq('hash', emailData.hash)
                    .maybeSingle();
                
                if (existing) {
                    console.log(`⏭️ Email with hash ${emailData.hash.substring(0, 10)}... already exists. Skipping.`);
                    return;
                }
            }

            const { error } = await this.client
                .from('emails')
                .insert([{
                    sender: emailData.sender,
                    receiver: emailData.receiver,
                    message: emailData.message,
                    employeeId: emailData.employeeId,
                    oppositionId: emailData.oppositionId || null,
                    mediaHash: emailData.mediaHash || null,
                    mediaUrl: emailData.mediaUrl || null,
                    hash: emailData.hash || null,
                    threadId: emailData.threadId || null
                }]);

            if (error) {
                console.error('❌ Error inserting into Supabase emails table:', error.message);
            } else {
                console.log(`✅ Email successfully logged to Supabase emails table.`);
            }
        } catch (err) {
            console.error('❌ logEmailToDatabase failed:', err.message);
        }
    }

    async getPendingReplies() {
        if (!this.client) return [];
        try {
            // Fetch recent emails to analyze conversations
            const { data, error } = await this.client
                .from('emails')
                .select(`
                    id, 
                    created_at, 
                    sender, 
                    receiver, 
                    threadId, 
                    employeeId, 
                    oppositionId,
                    employees (Name, Mobile, contact, emailId)
                `)
                .order('created_at', { ascending: false })
                .limit(200);

            if (error) throw error;

            const conversations = {};
            data.forEach(email => {
                const tid = email.threadId || `no-thread-${email.sender}-${email.receiver}`;
                if (!conversations[tid]) {
                    conversations[tid] = {
                        messages: [],
                        lastMessage: email,
                        employee: email.employees?.Name || 'Unknown',
                        phone: email.employees?.Mobile || email.employees?.contact
                    };
                }
                conversations[tid].messages.push(email);
            });

            const pending = [];
            for (const tid in conversations) {
                const last = conversations[tid].lastMessage;
                const emp = last.employees;

                if (emp && emp.emailId && last.sender && last.sender.toLowerCase().trim() !== emp.emailId.toLowerCase().trim()) {
                    const waitTimeMs = new Date() - new Date(last.created_at);
                    const waitTimeMinutes = Math.floor(waitTimeMs / (1000 * 60));
                    
                    pending.push({
                        threadId: tid,
                        client: last.sender,
                        employeeInfo: emp,
                        waitTime: waitTimeMinutes,
                        lastMessage: last.created_at
                    });
                }
            }
            return pending;
        } catch (err) {
            console.error('❌ Error fetching pending replies:', err.message);
            return [];
        }
    }

    async uploadFile(bucket, path, buffer, contentType) {
        if (!this.client) return null;
        try {
            const { data, error } = await this.client.storage
                .from(bucket)
                .upload(path, buffer, {
                    contentType: contentType,
                    upsert: true
                });

            if (error) {
                console.error(`❌ Storage upload failed [${bucket}]:`, error.message);
                return null;
            }

            const { data: publicUrlData } = this.client.storage
                .from(bucket)
                .getPublicUrl(path);

            return publicUrlData.publicUrl;
        } catch (err) {
            console.error('❌ Storage error:', err.message);
            return null;
        }
    }

    async logLeave(employeeId, description, leaveStartDate, leaveEndDate) {
        if (!this.client) return;
        try {
            const { error } = await this.client
                .from('leaves')
                .insert([{
                    employeeId: employeeId,
                    description: description,
                    leave_start_date: leaveStartDate,
                    leave_end_date: leaveEndDate
                }]);

            if (error) {
                console.error('❌ Error logging to leaves table:', error.message);
            } else {
                console.log(`✅ Leave application logged for employee ID: ${employeeId}`);
            }
        } catch (err) {
            console.error('❌ Supabase leave log failed:', err.message);
        }
    }

    async logPayment(employeeId, paymentData) {
        if (!this.client) return;
        try {
            const { error } = await this.client
                .from('payment')
                .insert([{
                    EmployeeId: employeeId,
                    PaymentDate: paymentData.paymentDate,
                    PayeeName: paymentData.payeeName,
                    PayerName: paymentData.payerName,
                    Amount: paymentData.amount,
                    PaymentMethod: paymentData.paymentMethod
                }]);

            if (error) {
                console.error('❌ Error logging to payment table:', error.message);
            } else {
                console.log(`✅ Payment info logged for employee ID: ${employeeId}`);
            }
        } catch (err) {
            console.error('❌ Supabase payment log failed:', err.message);
        }
    }

    async getClientId(clientName) {
        if (!this.client || !clientName || clientName === 'Unknown') return null;
        try {
            // 1. Try direct ILIKE match first (Fastest)
            const { data: directData, error: directError } = await this.client
                .from('clients')
                .select('id, ClientName')
                .ilike('ClientName', `%${clientName}%`)
                .limit(1);

            if (!directError && directData && directData.length > 0) {
                return directData[0].id;
            }

            // 2. Fallback: Fuzzy matching for typos (Fetch potential candidates)
            const { data: allClients, error: fetchError } = await this.client
                .from('clients')
                .select('id, ClientName')
                .limit(200);

            if (fetchError || !allClients) return null;

            let bestMatch = null;
            let minDistance = 3; // Max threshold for typos

            const searchName = clientName.toLowerCase().trim();

            for (const client of allClients) {
                const targetName = client.ClientName.toLowerCase().trim();
                
                // Direct overlap (e.g. "Reliance Industries" contains "Reliance")
                if (targetName.includes(searchName) || searchName.includes(targetName)) {
                    return client.id;
                }

                const distance = damerauLevenshtein(searchName, targetName);
                if (distance < minDistance) {
                    minDistance = distance;
                    bestMatch = client.id;
                }
            }

            if (bestMatch) {
                console.log(`✨ Fuzzy matched client "${clientName}" to an existing ID.`);
            }

            return bestMatch;
        } catch (err) {
            console.error('❌ Error in fuzzy client resolution:', err.message);
            return null;
        }
    }

    async logVisit(employeeId, clientId,clientName,  description) {
        if (!this.client) return;
        try {
            const { error } = await this.client
                .from('visits')
                .insert([{
                    employeeId: employeeId,
                    clientId: clientId,
                    clientName : clientName , 
                    description: description
                }]);

            if (error) {
                console.error('❌ Error logging to visits table:', error.message);
            } else {
                console.log(`✅ Visit logged for employee ID: ${employeeId}`);
            }
        } catch (err) {
            console.error('❌ Supabase visit log failed:', err.message);
        }
    }

    async logRawMessage(data) {
        // Legacy support
    }

    async getEmployees() {
        if (!this.client) return [];
        try {
            const { data, error } = await this.client
                .from('employees')
                .select('id, Name, Mobile, contact, emailId');

            if (error) {
                console.error('❌ Error fetching employees:', error.message);
                return [];
            }
            return data;
        } catch (err) {
            console.error('❌ getEmployees failed:', err.message);
            return [];
        }
    }

    async getMessagesByEmployeeId(employeeId, days = 5) {
        if (!this.client) return [];
        try {
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - days);

            const { data, error } = await this.client
                .from('messages')
                .select('description, created_at, messageType')
                .eq('employeeId', employeeId)
                .gte('created_at', pastDate.toISOString())
                .order('created_at', { ascending: true });

            if (error) {
                console.error(`❌ Error fetching messages for employee ${employeeId}:`, error.message);
                return [];
            }
            return data;
        } catch (err) {
            console.error('❌ getMessagesByEmployeeId failed:', err.message);
            return [];
        }
    }

    // Messages for one tracked WhatsApp chat (by JID), most recent first.
    // Two-step fetch: WhatsApp metadata + messages bodies, joined in JS.
    // Avoids PostgREST schema-cache dependency on the FK relationship.
    async getWhatsAppMessages(employeeId, chatJid, limit = 200, after = null) {
        if (!this.client || !employeeId || !chatJid) return [];
        try {
            let query = this.client
                .from('Whatsapp')
                .select('id, created_at, messageTraceId, chatJid, senderName, senderNumber')
                .eq('employeeID', employeeId)
                .eq('chatJid', chatJid)
                .order('created_at', { ascending: after ? true : false })
                .limit(limit);
            if (after) query = query.gt('created_at', after);
            const { data: waRows, error: waErr } = await query;
            if (waErr) throw waErr;
            if (!waRows || waRows.length === 0) return [];

            const traceIds = [...new Set(waRows.map(r => r.messageTraceId).filter(Boolean))];
            const msgMap = {};
            if (traceIds.length > 0) {
                const { data: msgs, error: mErr } = await this.client
                    .from('messages')
                    .select('messageTraceId, description, messageType, mediaUrl')
                    .in('messageTraceId', traceIds);
                if (mErr) throw mErr;
                (msgs || []).forEach(m => { msgMap[m.messageTraceId] = m; });
            }

            const merged = waRows.map(r => {
                const body = msgMap[r.messageTraceId] || {};
                return {
                    id:             r.id,
                    created_at:     r.created_at,
                    messageTraceId: r.messageTraceId,
                    chatJid:        r.chatJid,
                    senderName:     r.senderName,
                    senderNumber:   r.senderNumber,
                    description:    body.description || '',
                    messageType:    body.messageType || 'Text',
                    mediaUrl:       body.mediaUrl    || null,
                };
            });
            // Full load comes back newest-first and needs reversing; incremental poll is already ascending
            return after ? merged : merged.reverse();
        } catch (err) {
            console.error('❌ getWhatsAppMessages failed:', err.message);
            return [];
        }
    }

    // Flat list of recent WA messages across all chats — used for graph enrichment.
    async getWhatsAppMessagesForEnrichment(employeeId, days = 30) {
        if (!this.client || !employeeId) return [];
        try {
            const since = new Date();
            since.setDate(since.getDate() - days);

            const { data: waRows, error: waErr } = await this.client
                .from('Whatsapp')
                .select('chatJid, senderName, senderNumber, messageTraceId, created_at')
                .eq('employeeID', employeeId)
                .gte('created_at', since.toISOString())
                .order('created_at', { ascending: true })
                .limit(500);
            if (waErr) throw waErr;
            if (!waRows || waRows.length === 0) return [];

            const traceIds = [...new Set(waRows.map(r => r.messageTraceId).filter(Boolean))];
            const msgMap = {};
            if (traceIds.length > 0) {
                const { data: msgs, error: mErr } = await this.client
                    .from('messages')
                    .select('messageTraceId, description')
                    .in('messageTraceId', traceIds);
                if (mErr) throw mErr;
                (msgs || []).forEach(m => { msgMap[m.messageTraceId] = m.description; });
            }

            return waRows.map(r => ({
                chatJid:      r.chatJid,
                senderName:   r.senderName,
                senderNumber: r.senderNumber,
                description:  msgMap[r.messageTraceId] || '',
                created_at:   r.created_at,
            })).filter(r => r.description);
        } catch (err) {
            console.error('❌ getWhatsAppMessagesForEnrichment failed:', err.message);
            return [];
        }
    }

    // Aggregate counts + last-message metadata per tracked chat for an employee.
    async getWhatsAppChatSummaries(employeeId) {
        if (!this.client || !employeeId) return [];
        try {
            const { data: waRows, error: waErr } = await this.client
                .from('Whatsapp')
                .select('chatJid, senderName, messageTraceId, created_at')
                .eq('employeeID', employeeId)
                .not('chatJid', 'is', null)
                .order('created_at', { ascending: false })
                .limit(2000);
            if (waErr) throw waErr;
            if (!waRows || waRows.length === 0) return [];

            // Find the latest messageTraceId per chat for the preview text.
            const latestPerChat = {};
            for (const row of waRows) {
                if (!latestPerChat[row.chatJid]) latestPerChat[row.chatJid] = row;
            }
            const previewTraceIds = Object.values(latestPerChat).map(r => r.messageTraceId).filter(Boolean);

            const previewMap = {};
            if (previewTraceIds.length > 0) {
                const { data: msgs, error: mErr } = await this.client
                    .from('messages')
                    .select('messageTraceId, description')
                    .in('messageTraceId', previewTraceIds);
                if (mErr) throw mErr;
                (msgs || []).forEach(m => { previewMap[m.messageTraceId] = m.description; });
            }

            const summary = {};
            for (const row of waRows) {
                if (!summary[row.chatJid]) {
                    summary[row.chatJid] = {
                        chatJid:       row.chatJid,
                        lastMessage:   previewMap[row.messageTraceId] || '',
                        lastSender:    row.senderName,
                        lastTimestamp: row.created_at,
                        count:         0,
                    };
                }
                summary[row.chatJid].count += 1;
            }
            return Object.values(summary);
        } catch (err) {
            console.error('❌ getWhatsAppChatSummaries failed:', err.message);
            return [];
        }
    }

    async getEmailsByEmployeeId(employeeId, days = 5) {
        if (!this.client) return [];
        try {
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - days);

            const { data, error } = await this.client
                .from('emails')
                .select('sender, receiver, message, created_at')
                .eq('employeeId', employeeId)
                .gte('created_at', pastDate.toISOString())
                .order('created_at', { ascending: true });

            if (error) {
                console.error(`❌ Error fetching emails for employee ${employeeId}:`, error.message);
                return [];
            }
            return data;
        } catch (err) {
            console.error('❌ getEmailsByEmployeeId failed:', err.message);
            return [];
        }
    }

    async getManagers() {
        if (!this.client) return [];
        try {
            // Fetch all employees who are a manager of someone else
            const { data: managedByList, error: managedByError } = await this.client
                .from('employees')
                .select('managedBy')
                .not('managedBy', 'is', null);

            if (managedByError) throw managedByError;

            const managerIds = [...new Set(managedByList.map(item => item.managedBy))];
            
            if (managerIds.length === 0) return [];

            const { data: managers, error: managerError } = await this.client
                .from('employees')
                .select('id, Name, Mobile, contact')
                .in('id', managerIds);

            if (managerError) throw managerError;
            return managers;
        } catch (err) {
            console.error('❌ getManagers failed:', err.message);
            return [];
        }
    }

    async getEmployeesByManager(managerId) {
        if (!this.client) return [];
        try {
            const { data, error } = await this.client
                .from('employees')
                .select('id, Name, Mobile, contact')
                .eq('managedBy', managerId);

            if (error) throw error;
            return data;
        } catch (err) {
            console.error(`❌ getEmployeesByManager failed for ${managerId}:`, err.message);
            return [];
        }
    }

    // --- Knowledge Graph Operations ---

    // Idempotent on (type, name, scope_type, scope_employee_id). Scope params
    // default to ('business', null) so legacy callers still target the BKG.
    // Comms-scope callers MUST pass scopeEmployeeId; agents own that contract.
    async upsertNode(type, name, properties = {}, scope = {}) {
        if (!this.client) return null;
        const scopeType = scope.scope_type || 'business';
        const scopeEmployeeId = scope.scope_employee_id ?? null;
        try {
            let query = this.client
                .from('nodes')
                .select('id, properties')
                .eq('type', type)
                .eq('name', name)
                .eq('scope_type', scopeType);
            query = scopeEmployeeId === null
                ? query.is('scope_employee_id', null)
                : query.eq('scope_employee_id', scopeEmployeeId);
            const { data: existing, error: findError } = await query.maybeSingle();
            if (findError) throw findError;

            if (existing) {
                const { data: updated, error: updateError } = await this.client
                    .from('nodes')
                    .update({ properties: { ...existing.properties, ...properties }, updated_at: new Date() })
                    .eq('id', existing.id)
                    .select()
                    .single();
                if (updateError) throw updateError;
                return updated.id;
            }

            const { data: newNode, error: insertError } = await this.client
                .from('nodes')
                .insert([{ type, name, properties, scope_type: scopeType, scope_employee_id: scopeEmployeeId }])
                .select()
                .single();
            if (insertError) throw insertError;
            return newNode.id;
        } catch (err) {
            console.error(`❌ upsertNode failed (${type}:${name}, scope=${scopeType}/${scopeEmployeeId}):`, err.message);
            return null;
        }
    }

    // --- SECURED VAULT OPERATIONS (Supabase Vault Schema) ---

    async saveEmployeeToken(employeeId, provider, tokenData) {
        if (!this.client) return null;
        try {
            console.log(`🔐 Vault: Saving ${provider} credentials for Employee ${employeeId}...`);
            const { error } = await this.client
                .from('vault_credentials')
                .upsert(
                    { employee_id: employeeId, provider, token_data: tokenData },
                    { onConflict: 'employee_id,provider' }
                );
            if (error) throw error;
            console.log(`✅ Vault: ${provider} credentials saved for Employee ${employeeId}.`);
            return true;
        } catch (err) {
            console.error(`❌ Vault Error:`, err.message);
            return null;
        }
    }


    async updateEmployeeEmail(employeeId, email) {
        if (!this.client || !employeeId || !email) return;
        try {
            const { error } = await this.client
                .from('employees')
                .update({ emailId: email })
                .eq('id', employeeId);

            if (error) throw error;
            console.log(`✅ Employee ${employeeId} email updated to: ${email}`);
        } catch (err) {
            console.error(`❌ Failed to update employee email:`, err.message);
        }
    }

    async getAuthenticatedEmployees(provider = 'gmail') {
        if (!this.client) return [];
        try {
            const { data, error } = await this.client
                .from('vault_credentials')
                .select('employee_id, token_data')
                .eq('provider', provider);
            if (error) throw error;
            return data || [];
        } catch (err) {
            console.error(`❌ Vault Retrieval Error:`, err.message);
            return [];
        }
    }

    async toggleIntegration(employeeId, provider, status) {
        if (!this.client) return null;
        try {
            const { error } = await this.client.rpc('toggle_integration', {
                emp_id: employeeId,
                integration_provider: provider,
                status: status
            });
            if (error) throw error;
            console.log(`🔌 Integration [${provider}] for employee ${employeeId} set to: ${status}`);
            return true;
        } catch (err) {
            console.error(`❌ Toggle Integration Error:`, err.message);
            return false;
        }
    }

    async removeEmployeeSecret(employeeId, provider = 'gmail') {
        if (!this.client) return false;
        try {
            console.log(`🗑️ Vault: Removing ${provider} credentials for Employee ${employeeId}...`);
            const { error } = await this.client
                .from('vault_credentials')
                .delete()
                .eq('employee_id', employeeId)
                .eq('provider', provider);
            if (error) throw error;
            await this.toggleIntegration(employeeId, provider, false);
            console.log(`✅ Vault: ${provider} credentials cleared for Employee ${employeeId}.`);
            return true;
        } catch (err) {
            console.error(`❌ Vault Removal Error:`, err.message);
            return false;
        }
    }

    // Scope params default to ('business', null) for legacy callers.
    async createEdge(fromNodeId, toNodeId, relationshipType, properties = {}, scope = {}) {
        if (!this.client || !fromNodeId || !toNodeId) return null;
        const scopeType = scope.scope_type || 'business';
        const scopeEmployeeId = scope.scope_employee_id ?? null;
        try {
            const { data, error } = await this.client
                .from('edges')
                .insert([{
                    from_node_id: fromNodeId,
                    to_node_id: toNodeId,
                    relationship_type: relationshipType,
                    properties,
                    scope_type: scopeType,
                    scope_employee_id: scopeEmployeeId,
                }])
                .select()
                .single();

            if (error) throw error;
            return data.id;
        } catch (err) {
            console.error(`❌ createEdge failed (${relationshipType}, scope=${scopeType}/${scopeEmployeeId}):`, err.message);
            return null;
        }
    }

    async getGraphContext(employeeName) {
        if (!this.client || !employeeName) return { nodes: [], edges: [] };
        try {
            // Find the employee node
            const { data: node, error: nodeError } = await this.client
                .from('nodes')
                .select('id, type, name, properties')
                .eq('name', employeeName)
                .maybeSingle();

            if (!node) return { nodes: [], edges: [] };

            // Find connected edges and nodes
            const { data: edges, error: edgeError } = await this.client
                .from('edges')
                .select(`
                    id, 
                    relationship_type, 
                    properties,
                    from_node:from_node_id(id, type, name, properties),
                    to_node:to_node_id(id, type, name, properties)
                `)
                .or(`from_node_id.eq.${node.id},to_node_id.eq.${node.id}`);

            if (edgeError) throw edgeError;

            return {
                mainNode: node,
                relationships: edges
            };
        } catch (err) {
            console.error(`❌ getGraphContext failed for ${employeeName}:`, err.message);
            return { nodes: [], edges: [] };
        }
    }

    // --- Management API Support ---

    async getAllEmployees() {
        if (!this.client) return [];
        try {
            const { data, error } = await this.client.from('employees').select('*').order('Name');
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('❌ getAllEmployees failed:', err.message);
            return [];
        }
    }

    async getEmployeeById(id) {
        if (!this.client || !id) return null;
        try {
            const { data, error } = await this.client
                .from('employees')
                .select('id, Name, Mobile, contact, emailId')
                .eq('id', id)
                .single();
            if (error) return null;
            return data;
        } catch (err) {
            console.error(`❌ getEmployeeById failed for id ${id}:`, err.message);
            return null;
        }
    }

    async getDashboardStats() {
        if (!this.client) return null;
        try {
            const { count: empCount } = await this.client.from('employees').select('*', { count: 'exact', head: true });
            const { count: msgCount } = await this.client.from('messages').select('*', { count: 'exact', head: true });
            const { count: nodeCount } = await this.client.from('nodes').select('*', { count: 'exact', head: true });
            const { count: edgeCount } = await this.client.from('edges').select('*', { count: 'exact', head: true });

            return {
                totalEmployees: empCount || 0,
                totalMessages: msgCount || 0,
                knowledgeNodes: nodeCount || 0,
                relationships: edgeCount || 0,
                systemHealth: 'Healthy'
            };
        } catch (err) {
            console.error('❌ getDashboardStats failed:', err.message);
            return null;
        }
    }

    // Scope-aware fetch: business-scope rows always pass; comms-scope rows
    // pass only if scope_employee_id ∈ visibleEmployeeIds.
    // If visibleEmployeeIds is undefined or null, no comms filter is applied
    // (legacy behavior — callers must opt out explicitly).
    _scopeFilter(rows, visibleEmployeeIds) {
        if (visibleEmployeeIds === undefined || visibleEmployeeIds === null) return rows;
        const set = new Set(visibleEmployeeIds.map(Number));
        return rows.filter(r =>
            r.scope_type === 'business'
            || (r.scope_type === 'comms' && set.has(Number(r.scope_employee_id)))
        );
    }

    async getFullGraph(visibleEmployeeIds) {
        if (!this.client) return { nodes: [], edges: [] };
        try {
            const { data: nodes, error: nErr } = await this.client.from('nodes').select('*');
            const { data: edges, error: eErr } = await this.client.from('edges').select('*');
            if (nErr || eErr) throw nErr || eErr;
            const filteredNodes = this._scopeFilter(nodes || [], visibleEmployeeIds);
            const nodeIds = new Set(filteredNodes.map(n => n.id));
            const filteredEdges = (edges || [])
                .filter(e => nodeIds.has(e.from_node_id) && nodeIds.has(e.to_node_id));
            return { nodes: filteredNodes, edges: filteredEdges };
        } catch (err) {
            console.error('❌ getFullGraph failed:', err.message);
            return { nodes: [], edges: [] };
        }
    }

    async getGraphByChannels(channels, visibleEmployeeIds) {
        if (!this.client) return { nodes: [], edges: [] };
        try {
            const { data: allNodes, error: nErr } = await this.client.from('nodes').select('*');
            const { data: allEdges, error: eErr } = await this.client.from('edges').select('*');
            if (nErr || eErr) throw nErr || eErr;

            if (!channels || channels.length === 0) {
                return { nodes: [], edges: [] };
            }

            // Node types surfaced by each channel
            const channelNodeTypes = {
                personal_whatsapp: ['Employee'],
                personal_email:    ['Employee'],
                business_whatsapp: ['Employee', 'Client', 'Product', 'Price', 'Deadline'],
                business_email:    ['Employee', 'Client', 'Price', 'Deadline'],
                business_info:     ['Client', 'Supplier', 'Product'],
            };

            const allowedTypes = new Set();
            channels.forEach(ch => (channelNodeTypes[ch] || []).forEach(t => allowedTypes.add(t)));

            const scopedNodes = this._scopeFilter(allNodes || [], visibleEmployeeIds);
            const filteredNodes = scopedNodes.filter(n => allowedTypes.has(n.type));
            const nodeIds = new Set(filteredNodes.map(n => n.id));
            const filteredEdges = (allEdges || []).filter(
                e => nodeIds.has(e.from_node_id) && nodeIds.has(e.to_node_id)
            );

            return { nodes: filteredNodes, edges: filteredEdges };
        } catch (err) {
            console.error('❌ getGraphByChannels failed:', err.message);
            return { nodes: [], edges: [] };
        }
    }

    async getPendingFollowups(employeeId) {
        if (!this.client || !employeeId) return { emails: [], commitments: [] };
        try {
            const employee = await this.getEmployeeById(employeeId);
            if (!employee) return { emails: [], commitments: [] };

            // ── 1. Pending email replies ─────────────────────────────────────
            // Threads where the most recent email was sent by someone other than
            // the employee — meaning the employee hasn't replied yet.
            const since = new Date();
            since.setDate(since.getDate() - 30);

            const { data: emailRows } = await this.client
                .from('emails')
                .select('id, sender, receiver, message, created_at, threadId')
                .eq('employeeId', employeeId)
                .gte('created_at', since.toISOString())
                .order('created_at', { ascending: false })
                .limit(200);

            const threads = {};
            for (const e of (emailRows || [])) {
                const tid = e.threadId || `${e.sender}__${e.receiver}`;
                if (!threads[tid]) threads[tid] = e; // first = most recent (desc order)
            }

            const pendingEmails = [];
            for (const last of Object.values(threads)) {
                const empEmail = (employee.emailId || '').toLowerCase().trim();
                const senderEmail = (last.sender || '').toLowerCase().trim();
                if (empEmail && senderEmail && senderEmail !== empEmail) {
                    const waitMs = Date.now() - new Date(last.created_at).getTime();
                    pendingEmails.push({
                        id:          last.id,
                        channel:     'email',
                        from:        last.sender,
                        preview:     (last.message || '').replace(/\s+/g, ' ').trim().slice(0, 140),
                        waitMinutes: Math.floor(waitMs / 60000),
                        createdAt:   last.created_at,
                    });
                }
            }
            // Sort most urgent first
            pendingEmails.sort((a, b) => b.waitMinutes - a.waitMinutes);

            // ── 2. Open KG commitments ───────────────────────────────────────
            // PROMISED / QUOTED / DEADLINE / DELIVERS edges where this employee
            // is one of the participants.
            const { data: empNode } = await this.client
                .from('nodes')
                .select('id')
                .eq('name', employee.Name)
                .maybeSingle();

            let commitments = [];
            if (empNode) {
                const { data: edges } = await this.client
                    .from('edges')
                    .select(`
                        id, relationship_type, properties, created_at,
                        from_node:from_node_id(id, name, type),
                        to_node:to_node_id(id, name, type)
                    `)
                    .or(`from_node_id.eq.${empNode.id},to_node_id.eq.${empNode.id}`)
                    .in('relationship_type', ['PROMISED', 'QUOTED', 'DEADLINE', 'DELIVERS', 'MENTIONS'])
                    .order('created_at', { ascending: false })
                    .limit(30);

                commitments = (edges || []).map(e => {
                    const waitMs = Date.now() - new Date(e.created_at).getTime();
                    return {
                        id:               e.id,
                        channel:          'graph',
                        relationshipType: e.relationship_type,
                        from:             e.from_node?.name,
                        fromType:         e.from_node?.type,
                        to:               e.to_node?.name,
                        toType:           e.to_node?.type,
                        messageText:      (e.properties?.message_text || '').slice(0, 140),
                        waitMinutes:      Math.floor(waitMs / 60000),
                        createdAt:        e.created_at,
                    };
                });
            }

            return { emails: pendingEmails, commitments };
        } catch (err) {
            console.error('❌ getPendingFollowups failed:', err.message);
            return { emails: [], commitments: [] };
        }
    }

    async getEmployeeByEmail(email) {
        if (!this.client || !email) return null;
        try {
            const { data, error } = await this.client
                .from('employees')
                .select('id, Name, Role, Mobile, contact, emailId, managedBy, is_admin, business_id')
                .eq('emailId', email)
                .maybeSingle();
            if (error) return null;
            return data;
        } catch (err) {
            return null;
        }
    }

    async createEmployee(employeeData) {
        if (!this.client) return null;
        try {
            const { data, error } = await this.client
                .from('employees')
                .insert([employeeData])
                .select()
                .single();
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('❌ createEmployee failed:', err.message);
            return null;
        }
    }

    async getAllClients() {
        if (!this.client) return [];
        try {
            const { data, error } = await this.client
                .from('clients')
                .select('id, businessName, location, description, emailId, managedBy, created_at')
                .order('businessName');
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('❌ getAllClients failed:', err.message);
            return [];
        }
    }

    async createClient(clientData) {
        if (!this.client) return null;
        try {
            const { data, error } = await this.client
                .from('clients')
                .insert([clientData])
                .select()
                .single();
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('❌ createClient failed:', err.message);
            return null;
        }
    }

    async updateClientManagedBy(clientId, employeeId) {
        if (!this.client) return false;
        try {
            const { error } = await this.client
                .from('clients')
                .update({ managedBy: employeeId })
                .eq('id', clientId);
            if (error) throw error;
            return true;
        } catch (err) {
            console.error('❌ updateClientManagedBy failed:', err.message);
            return false;
        }
    }

    async upsertSupplier(supplierName, properties = {}) {
        if (!this.client) return null;
        try {
            const { data: existing, error: checkError } = await this.client
                .from('suppliers')
                .select('id')
                .eq('name', supplierName)
                .maybeSingle();

            if (checkError && checkError.code === '42P01') {
                console.warn('⚠️ suppliers table does not exist yet.');
                return null;
            }

            if (existing) {
                const { data: updated, error: updateError } = await this.client
                    .from('suppliers')
                    .update({ ...properties })
                    .eq('id', existing.id)
                    .select()
                    .single();
                if (updateError) throw updateError;
                return updated.id;
            } else {
                const { data: inserted, error: insertError } = await this.client
                    .from('suppliers')
                    .insert([{ name: supplierName, ...properties }])
                    .select()
                    .single();
                if (insertError) throw insertError;
                return inserted.id;
            }
        } catch (err) {
            console.error(`❌ upsertSupplier failed for ${supplierName}:`, err.message);
            return null;
        }
    }

    async upsertProduct(productName, supplierId, properties = {}) {
        if (!this.client) return null;
        try {
            // Check if table exists by doing a quick select
            const { data: existing, error: checkError } = await this.client
                .from('products')
                .select('id')
                .eq('product_name', productName)
                .maybeSingle();

            if (checkError && checkError.code === '42P01') {
                console.warn('⚠️ products table does not exist yet. Please run create_products_table.sql');
                return null; // Table doesn't exist
            }

            if (existing) {
                // Update
                const { data: updated, error: updateError } = await this.client
                    .from('products')
                    .update({ 
                        ...properties,
                        supplier_id: supplierId,
                        updated_at: new Date() 
                    })
                    .eq('id', existing.id)
                    .select()
                    .single();
                if (updateError) throw updateError;
                return updated;
            } else {
                // Insert
                const { data: inserted, error: insertError } = await this.client
                    .from('products')
                    .insert([{
                        product_name: productName,
                        supplier_id: supplierId,
                        ...properties
                    }])
                    .select()
                    .single();
                if (insertError) throw insertError;
                return inserted;
            }
        } catch (err) {
            console.error(`❌ upsertProduct failed for ${productName}:`, err.message);
            return null;
        }
    }

    // ── Identity resolution — links phone ↔ email per employee ─────────────────

    async linkContactIdentity(employeeId, phone, email, displayName) {
        if (!this.client || !employeeId || !phone || !email) return null;
        const normalizedPhone = phone.replace(/\D/g, '');
        try {
            const { data, error } = await this.client
                .from('contact_identities')
                .upsert(
                    { employee_id: employeeId, phone: normalizedPhone, email, display_name: displayName || null },
                    { onConflict: 'employee_id,phone' }
                )
                .select()
                .single();
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('❌ linkContactIdentity failed:', err.message);
            return null;
        }
    }

    async getContactIdentities(employeeId) {
        if (!this.client || !employeeId) return [];
        try {
            const { data, error } = await this.client
                .from('contact_identities')
                .select('id, phone, email, display_name, created_at')
                .eq('employee_id', employeeId)
                .order('display_name');
            if (error) throw error;
            return data || [];
        } catch (err) {
            console.error('❌ getContactIdentities failed:', err.message);
            return [];
        }
    }

    async deleteContactIdentity(id, employeeId) {
        if (!this.client || !id || !employeeId) return false;
        try {
            const { error } = await this.client
                .from('contact_identities')
                .delete()
                .eq('id', id)
                .eq('employee_id', employeeId);
            if (error) throw error;
            return true;
        } catch (err) {
            console.error('❌ deleteContactIdentity failed:', err.message);
            return false;
        }
    }

    // Resolve a phone number to a known email identity for graph merging.
    async resolvePhoneToEmail(employeeId, phone) {
        if (!this.client || !employeeId || !phone) return null;
        const normalizedPhone = phone.replace(/\D/g, '');
        try {
            const { data, error } = await this.client
                .from('contact_identities')
                .select('email, display_name')
                .eq('employee_id', employeeId)
                .eq('phone', normalizedPhone)
                .maybeSingle();
            if (error) return null;
            return data || null;
        } catch {
            return null;
        }
    }

    async buildBusinessKnowledgeMap(businessName = 'My Business') {
        if (!this.client) return false;
        try {
            console.log(`🗺️ Building knowledge map for: ${businessName}`);
            
            // 1. Create central Business node
            const businessNodeId = await this.upsertNode('Business', businessName, { created_by: 'system' });
            if (!businessNodeId) throw new Error('Failed to create central business node');

            // 2. Fetch Clients
            const { data: clients, error: clientsError } = await this.client
                .from('clients')
                .select('*');
            
            if (clientsError && clientsError.code !== '42P01') { // Ignore missing table error
                console.error('❌ Error fetching clients:', clientsError.message);
            }

            // 3. Fetch Suppliers
            const { data: suppliers, error: suppliersError } = await this.client
                .from('suppliers')
                .select('*');

            if (suppliersError && suppliersError.code !== '42P01') { // Ignore missing table error
                console.error('❌ Error fetching suppliers:', suppliersError.message);
            }

            // 4. Map Clients
            if (clients && clients.length > 0) {
                for (const client of clients) {
                    const clientName = client.ClientName || client.name || `Client_${client.id}`;
                    const clientNodeId = await this.upsertNode('Client', clientName, client);
                    if (clientNodeId) {
                        await this.createEdge(businessNodeId, clientNodeId, 'HAS_CLIENT');
                    }
                }
                console.log(`✅ Mapped ${clients.length} clients to the knowledge map.`);
            }

            // 5. Map Suppliers
            if (suppliers && suppliers.length > 0) {
                for (const supplier of suppliers) {
                    const supplierName = supplier.SupplierName || supplier.name || `Supplier_${supplier.id}`;
                    const supplierNodeId = await this.upsertNode('Supplier', supplierName, supplier);
                    if (supplierNodeId) {
                        await this.createEdge(businessNodeId, supplierNodeId, 'HAS_SUPPLIER');
                    }
                }
                console.log(`✅ Mapped ${suppliers.length} suppliers to the knowledge map.`);
            }

            console.log(`✅ Successfully built business knowledge map for ${businessName}`);
            return true;
        } catch (err) {
            console.error('❌ buildBusinessKnowledgeMap failed:', err.message);
            return false;
        }
    }

    // Note: suppliers, clients (mutations), employee count, invitations, and
    // onboarding status are owned by the wa-field-tracker-mapmybusiness package.
}

module.exports = new SupabaseService();
