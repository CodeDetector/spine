# Omni-Brain Intelligence System 🧠

Omni-Brain is a powerful, multi-channel business intelligence tracker designed to monitor, analyze, and graph communications across **WhatsApp** and **Gmail**. It uses Gemini AI to extract entities, relationships, and business commitments into a persistent Knowledge Graph, providing automated daily reports to managers and employees.

## 🚀 Core Features

- **Multi-Channel Ingestion**: Seamlessly captures messages from WhatsApp groups and Gmail inboxes.
- **Knowledge Graph Extraction**: Real-time and daily batch processing of communications to build a Property Graph (Nodes & Edges) showing relationships between Employees, Clients, Products, and more.
- **AI-Driven Analytics**: Uses Google Gemini to classify messages, identify commitments, and detect business entities.
- **Automated Reporting**: Generates daily summary reports:
  - **Manager Report**: High-level executive summary with status updates and coaching insights.
  - **Employee Report**: Supportive Hinglish summaries to encourage productivity and track achievements.
- **SLA Monitoring**: Automatically alerts employees via WhatsApp if an email remains unreplied for more than 5 minutes.
- **Secure Credential Vault**: Stores Gmail OAuth tokens in an encrypted Supabase Vault via RPC.

## 📁 Project Structure

```text
├── core/                   # Shared Business Logic
│   ├── intelligenceService.js # Gemini AI & Graph Extraction
│   ├── supabaseService.js     # Database & Storage Operations
│   ├── generateReport.js      # Consolidated Reporting Engine
│   ├── messageParser.js       # WhatsApp Message Normalization
│   └── prompts/               # AI Prompt Templates (Markdown)
├── feeder-whatsapp/        # WhatsApp Bot Service (Baileys)
│   └── processor.js           # WA Event Handling & SLA Monitor
├── feeder-email/           # Gmail Ingestion Service
│   ├── service.js             # OAuth2 & Gmail API Wrapper
│   └── processor.js           # Multi-Inbox Polling Logic
├── auth_info_baileys/      # WhatsApp Session Data (Keep Secret)
└── index.js                # Master Orchestrator
```

## 🛠️ Setup & Installation

### 1. Prerequisites
- Node.js (v18+)
- Supabase Project (with Tables & Vault RPC enabled)
- Google Cloud Console Project (for Gmail API)
- Gemini API Key

### 2. Environment Variables
Create a `.env` file in the root directory:
```env
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_anon_or_service_key
GEMINI_API_KEY=your_gemini_api_key
ALLOW_PRIVATE_CHATS=false
ALLOWED_GROUP_NAMES=Group1,Group2
```

### 3. Database Setup
Ensure your Supabase instance has the following tables:
- `employees` (id, Name, Mobile, emailId, managedBy)
- `messages` (id, description, employeeId, messageType, created_at)
- `emails` (id, sender, receiver, message, employeeId, threadId, created_at)
- `nodes` (id, type, name, properties)
- `edges` (id, from_node_id, to_node_id, relationship_type, properties)

### 4. Running the System
```bash
# Install dependencies
npm install

# Start the full orchestrator (WhatsApp + Gmail)
npm start
```

## 🤖 Interaction

- **Gmail Connection**: Send `!connect gmail` in a WhatsApp chat to receive an authorization link. After authorizing, reply with `!gmail code YOUR_CODE` to secure your inbox in the vault.
- **Daily Reports**: Generated and sent automatically via WhatsApp based on the cron schedule in `feeder-whatsapp/processor.js`.
- **SLA Alerts**: The system checks for unreplied emails every 60 seconds and pings the respective employee on WhatsApp if needed.

## 🛡️ Security
- **Auth Tokens**: Gmail tokens are never stored in plain text in the main tables; they are managed via Supabase Vault.
- **WhatsApp**: Session data is stored locally in `auth_info_baileys`. Do not share this folder.

---
*Built with ❤️ for High-Performance Field Teams.*
