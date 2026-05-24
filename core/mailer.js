// Transactional email — currently used by the Request-to-join flow to notify
// the tenant admin and (on approval) the requester.
//
// Provider: Resend (chosen for the simple Node SDK + free tier covering the
// low admin-mail volume). If RESEND_API_KEY is unset the wrapper just logs
// to console and returns — useful in local/dev and as a safety net so a
// missing env var does NOT crash the join-request flow.
//
// SES / SendGrid swap point: replace the body of `_send` and keep the
// public function signatures stable.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM      = process.env.MAIL_FROM      || 'noreply@example.com';
const APP_BASE_URL   = process.env.APP_BASE_URL   || 'http://localhost:3000';

async function _send({ to, subject, html, text }) {
    if (!RESEND_API_KEY) {
        console.warn(`[mailer] RESEND_API_KEY unset — would have sent to=${to} subject="${subject}"`);
        return { ok: true, skipped: true };
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({ from: MAIL_FROM, to, subject, html, text }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Don't throw — email failure must not roll back the DB row that
        // triggered it. The admin can re-request, or we can retry later.
        console.error(`[mailer] Resend send failed (${res.status}): ${body}`);
        return { ok: false, status: res.status };
    }
    return { ok: true };
}

// Tenant admin receives this when someone with a matching email domain has
// asked to join. The link encodes the join_requests.token so the admin can
// approve without first logging in.
async function sendAdminJoinRequestEmail({ to, businessName, requesterEmail, joinRequestId, token }) {
    const approveUrl = `${APP_BASE_URL}/api/join-requests/${joinRequestId}/approve?token=${token}`;
    const rejectUrl  = `${APP_BASE_URL}/api/join-requests/${joinRequestId}/reject?token=${token}`;
    const subject = `${requesterEmail} wants to join ${businessName}`;
    const html = `
        <p><strong>${escapeHtml(requesterEmail)}</strong> has asked to join your workspace on Omni-Brain.</p>
        <p>
            <a href="${approveUrl}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Approve</a>
            &nbsp;
            <a href="${rejectUrl}" style="display:inline-block;padding:10px 18px;color:#475569;text-decoration:none;border:1px solid #e2e8f0;border-radius:8px;font-weight:600">Reject</a>
        </p>
        <p style="color:#64748b;font-size:12px">If you weren't expecting this, you can safely ignore the email — nothing will change until you click Approve.</p>
    `;
    const text = `${requesterEmail} has asked to join your workspace on Omni-Brain.\n\nApprove: ${approveUrl}\nReject:  ${rejectUrl}\n`;
    return _send({ to, subject, html, text });
}

// Sent after the admin approves the join request — the requester clicks
// this to finish their signup (login + accept invitation flow takes over).
async function sendApprovedNoticeEmail({ to, businessName }) {
    const subject = `You've been approved for ${businessName}`;
    const loginUrl = `${APP_BASE_URL}/`;
    const html = `
        <p>Your request to join <strong>${escapeHtml(businessName)}</strong> on Omni-Brain has been approved.</p>
        <p>Log in to finish setting up your account: <a href="${loginUrl}">${loginUrl}</a></p>
    `;
    const text = `Your request to join ${businessName} has been approved. Log in to finish: ${loginUrl}`;
    return _send({ to, subject, html, text });
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = {
    sendAdminJoinRequestEmail,
    sendApprovedNoticeEmail,
};
