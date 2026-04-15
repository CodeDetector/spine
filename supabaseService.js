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
            // Try matching against 'contact' (real number) or 'Mobile'
            const { data, error } = await this.client
                .from('employees')
                .select('id')
                .or(`contact.eq.${sender},Mobile.eq.${sender}`)
                .single();

            if (error) {
                console.warn(`⚠️ Could not find employee with number ${sender}: ${error.message}`);
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
                .select('id, Name, Mobile, contact');

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
}

module.exports = new SupabaseService();
