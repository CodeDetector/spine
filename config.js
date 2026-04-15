require('dotenv').config();

module.exports = {
    // Supports multiple groups by parsing a comma-separated string from .env, or using the default)s.
    ALLOWED_GROUP_NAMES: process.env.ALLOWED_GROUP_NAMES.split(',').map(n => n.trim().toLowerCase()),
    EXCEL_FILE_PATH: process.env.EXCEL_FILE_PATH || 'data.xlsx',
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY
};
