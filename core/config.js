require('dotenv').config();

module.exports = {
    // Supports multiple groups by parsing a comma-separated string from .env, or using the default)s.
    ALLOWED_GROUP_NAMES: process.env.ALLOWED_GROUPS
        .replace(/[\[\]]/g, "") // Remove brackets if present
        .split(",")
        .map(n => n.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
        .filter(n => n !== ""),
    EXCEL_FILE_PATH: process.env.EXCEL_FILE_PATH || 'data.xlsx',
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'
};
