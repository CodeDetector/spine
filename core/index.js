const config = require('./config');
const supabaseService = require('./supabaseService');
const intelligenceService = require('./intelligenceService');
const MessageDTO = require('./dto');
const utils = require('./utils');
const prompts = require('./prompts'); // Expects core/prompts/index.js
const generateReport = require('./generateReport');

module.exports = {
    config,
    supabaseService,
    intelligenceService,
    MessageDTO,
    utils,
    prompts,
    generateReport
};
