const fs = require('fs');
const path = require('path');

const screeningTemplate = fs.readFileSync(path.join(__dirname, 'screening.md'), 'utf-8');
const leaveTemplate = fs.readFileSync(path.join(__dirname, 'leave_extraction.md'), 'utf-8');
const paymentTemplate = fs.readFileSync(path.join(__dirname, 'payment_extraction.md'), 'utf-8');
const visitTemplate = fs.readFileSync(path.join(__dirname, 'visit_extraction.md'), 'utf-8');
const managerSummaryTemplate = fs.readFileSync(path.join(__dirname, '.', 'reports', 'managerScreeningReport.md'), 'utf-8');
const employeeSummaryTemplate = fs.readFileSync(path.join(__dirname, '.', 'reports', 'employeeScreeningReport.md'), 'utf-8');

const screeningPrompt = (messageText) => {
    return screeningTemplate.replace(/{{messageText}}/g, messageText);
};

const leaveExtractionPrompt = (messageText) => {
    const currentDate = new Date().toISOString().split('T')[0];
    return leaveTemplate
        .replace(/{{messageText}}/g, messageText)
        .replace(/{{currentDate}}/g, currentDate);
};

const paymentExtractionPrompt = (messageText) => {
    const currentDate = new Date().toISOString().split('T')[0];
    return paymentTemplate
        .replace(/{{messageText}}/g, messageText)
        .replace(/{{currentDate}}/g, currentDate);
};

const visitExtractionPrompt = (messageText) => {
    return visitTemplate.replace(/{{messageText}}/g, messageText);
};

const managerScreeningReportPrompt = (employeeData, messagesText) => {
    const reportDate = new Date().toLocaleDateString();
    return managerSummaryTemplate
        .replace(/{{employeeName}}/g, employeeData.Name)
        .replace(/{{employeeMobile}}/g, employeeData.Mobile)
        .replace(/{{messages}}/g, messagesText)
        .replace(/{{reportDate}}/g, reportDate);
};

const employeeScreeningReportPrompt = (employeeData, messagesText) => {
    const reportDate = new Date().toLocaleDateString();
    return employeeSummaryTemplate
        .replace(/{{employeeName}}/g, employeeData.Name)
        .replace(/{{messages}}/g, messagesText)
        .replace(/{{reportDate}}/g, reportDate);
};

module.exports = {
    screeningPrompt,
    leaveExtractionPrompt,
    paymentExtractionPrompt,
    visitExtractionPrompt,
    managerScreeningReportPrompt,
    employeeScreeningReportPrompt
};
