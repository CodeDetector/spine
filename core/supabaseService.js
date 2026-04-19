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

                if (emp && last.sender.toLowerCase().trim() !== emp.emailId.toLowerCase().trim()) {
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

    async getDailyMessages() {
        if (!this.client) return [];
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            const { data, error } = await this.client
                .from('messages')
                .select('id, description, created_at, employees(Name)')
                .gte('created_at', today.toISOString())
                .order('created_at', { ascending: true });

            if (error) throw error;
            return data;
        } catch (err) {
            console.error('❌ getDailyMessages failed:', err.message);
            return [];
        }
    }

    async getDailyEmails() {
        if (!this.client) return [];
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const { data, error } = await this.client
                .from('emails')
                .select('id, sender, receiver, message, created_at, employees(Name)')
                .gte('created_at', today.toISOString())
                .order('created_at', { ascending: true });

            if (error) throw error;
            return data;
        } catch (err) {
            console.error('❌ getDailyEmails failed:', err.message);
            return [];
        }
    }

    // --- Knowledge Graph Operations ---

    async upsertNode(type, name, properties = {}) {
        if (!this.client) return null;
        try {
            // Find existing node by type and name
            const { data: existing, error: findError } = await this.client
                .from('nodes')
                .select('id')
                .eq('type', type)
                .eq('name', name)
                .maybeSingle();

            if (existing) {
                // Update properties
                const { data: updated, error: updateError } = await this.client
                    .from('nodes')
                    .update({ properties: { ...existing.properties, ...properties }, updated_at: new Date() })
                    .eq('id', existing.id)
                    .select()
                    .single();
                return updated.id;
            }

            // Create new node
            const { data: newNode, error: insertError } = await this.client
                .from('nodes')
                .insert([{ type, name, properties }])
                .select()
                .single();

            if (insertError) throw insertError;
            return newNode.id;
        } catch (err) {
            console.error(`❌ upsertNode failed (${type}:${name}):`, err.message);
            return null;
        }
    }

    // --- SECURED VAULT OPERATIONS (Supabase Vault Schema) ---

    async saveEmployeeToken(employeeId, provider, tokenData) {
        if (!this.client || provider !== 'gmail') return null;
        try {
            console.log(`🔐 Vault: Encrypting credentials for Employee ${employeeId}...`);
            const { error } = await this.client.rpc('save_gmail_secret', {
                emp_id: employeeId,
                token_json: JSON.stringify(tokenData)
            });

            if (error) throw error;
            console.log(`✅ Vault: Secret locked for Employee ${employeeId}.`);
            return true;
        } catch (err) {
            console.error(`❌ Vault RPC Error:`, err.message);
            return null;
        }
    }

    async getAuthenticatedEmployees(provider = 'gmail') {
        if (!this.client || provider !== 'gmail') return [];
        try {
            const { data, error } = await this.client.rpc('get_all_gmail_secrets');

            if (error) throw error;
            
            // Join with employees table to get extra metadata if needed locally
            // But for polling, we mainly need ID and Tokens
            return data.map(record => ({
                employee_id: record.employee_id,
                token_data: record.token_data
            }));
        } catch (err) {
            console.error(`❌ Vault Retrieval Error:`, err.message);
            return [];
        }
    }

    async createEdge(fromNodeId, toNodeId, relationshipType, properties = {}) {
        if (!this.client || !fromNodeId || !toNodeId) return null;
        try {
            const { data, error } = await this.client
                .from('edges')
                .insert([{
                    from_node_id: fromNodeId,
                    to_node_id: toNodeId,
                    relationship_type: relationshipType,
                    properties
                }])
                .select()
                .single();

            if (error) throw error;
            return data.id;
        } catch (err) {
            console.error(`❌ createEdge failed (${relationshipType}):`, err.message);
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
}

module.exports = new SupabaseService();
