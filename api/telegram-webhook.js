// api/telegram-webhook.js
const crypto = require('crypto');

/**
 * Constant-time comparison to prevent header timing attacks.
 */
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Defensive PostgREST helper communicating directly with Supabase via service_role key.
 */
async function supabaseRequest(path, method, body, extraHeaders = {}) {
    const rawUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!rawUrl || !serviceKey) {
        console.warn('Supabase credentials missing from environment variables.');
        return { ok: false, status: 500, data: 'Missing Supabase credentials' };
    }

    const baseUrl = rawUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/rest/v1/${path}`;

    const response = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'apikey': serviceKey,
            'Authorization': `Bearer ${serviceKey}`,
            ...extraHeaders
        },
        body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (_) {
        data = text;
    }

    return { ok: response.ok, status: response.status, data };
}

/**
 * Persists latency and execution outcome to roi_telemetry without throwing.
 */
async function recordTelemetry(workflow, outcome, durationMs, notes) {
    try {
        await supabaseRequest('roi_telemetry', 'POST', {
            workflow,
            outcome,
            duration_ms: durationMs,
            notes: String(notes || '').slice(0, 500)
        });
    } catch (err) {
        console.error('Telemetry logging failed:', err.message);
    }
}

/**
 * Sends a plain-text message back to Telegram.
 */
async function sendTelegramMessage(chatId, text) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        console.error('TELEGRAM_BOT_TOKEN is missing.');
        return false;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
    });
    return res.ok;
}

module.exports = async function handler(req, res) {
    const startTime = Date.now();

    try {
        // 1. Health check for GET probes
        if (req.method === 'GET') {
            return res.status(200).json({ status: 'healthy', milestone: 1 });
        }

        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }

        // 2. Deterministic Secret Token Validation
        const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
        const expectedSecret = process.env.TG_SECRET_TOKEN;

        if (!expectedSecret || !safeCompare(incomingSecret, expectedSecret)) {
            await recordTelemetry('OmniCommand_Ingress', 'AUTH_REJECTED', Date.now() - startTime, 'Invalid secret token');
            return res.status(403).json({ error: 'Forbidden: Invalid secret token' });
        }

        const payload = req.body || {};
        const updateId = payload.update_id !== undefined ? String(payload.update_id) : null;
        const message = payload.message || payload.edited_message;

        if (!updateId) {
            return res.status(400).json({ error: 'Missing update_id' });
        }

        // Gracefully acknowledge non-text updates
        if (!message || typeof message.text !== 'string') {
            return res.status(200).json({ ok: true, ignored: 'non_text_update' });
        }

        const senderId = message.from && message.from.id ? String(message.from.id) : '';
        const chatId = message.chat && message.chat.id ? String(message.chat.id) : '';
        const text = message.text.trim();

        // 3. Deterministic User Authorization Allowlist
        const allowedUid = String(process.env.ALLOWED_TELEGRAM_UID || '').trim();
        if (!allowedUid || senderId !== allowedUid) {
            await recordTelemetry('OmniCommand_Ingress', 'UNAUTHORIZED_USER', Date.now() - startTime, `Sender: ${senderId}`);
            return res.status(200).json({ ok: true, rejected: 'unauthorized_user' });
        }

        // 4. Durable Idempotency Enforcement (Persist Before Acknowledging)
        const eventInsert = await supabaseRequest(
            'webhook_events',
            'POST',
            {
                source: 'TELEGRAM',
                external_event_id: updateId,
                raw_payload: payload
            },
            { Prefer: 'return=representation' }
        );

        if (eventInsert.status === 409) {
            await recordTelemetry('OmniCommand_Ingress', 'DUPLICATE_SKIPPED', Date.now() - startTime, `update_id: ${updateId}`);
            return res.status(200).json({ ok: true, duplicate: true });
        }

        if (!eventInsert.ok) {
            await recordTelemetry('OmniCommand_Ingress', 'DB_ERROR', Date.now() - startTime, JSON.stringify(eventInsert.data));
            return res.status(500).json({ error: 'Database persistence failed' });
        }

        // 5. Create Normalized Job Record
        const commandType = text.startsWith('/') ? text.split(' ')[0].toLowerCase() : 'TASK_CAPTURE';

        const jobInsert = await supabaseRequest(
            'automation_jobs',
            'POST',
            {
                source_event_id: updateId,
                workflow: 'OmniCommand',
                command_type: commandType,
                raw_input: text,
                status: 'RECEIVED'
            },
            { Prefer: 'return=representation' }
        );

        if (!jobInsert.ok || !Array.isArray(jobInsert.data) || !jobInsert.data[0]) {
            await recordTelemetry('OmniCommand_Ingress', 'JOB_CREATION_FAILED', Date.now() - startTime, JSON.stringify(jobInsert.data));
            return res.status(500).json({ error: 'Job persistence failed' });
        }

        const createdJob = jobInsert.data[0];

        // 6. Respond on Telegram
        const reply =
            commandType === '/ping'
                ? `✅ Pong! OmniCommand Milestone 1 is verified.\nJob ID: ${createdJob.job_id}\nStatus: ${createdJob.status}`
                : `📥 Task captured in database.\nJob ID: ${createdJob.job_id}\nType: ${commandType}\nStatus: ${createdJob.status}`;

        await sendTelegramMessage(chatId, reply);
        await recordTelemetry('OmniCommand_Ingress', 'SUCCESS', Date.now() - startTime, `job_id: ${createdJob.job_id}`);

        // 7. Acknowledge with HTTP 200 after successful commit
        return res.status(200).json({
            ok: true,
            job_id: createdJob.job_id,
            status: createdJob.status
        });

    } catch (fatalError) {
        console.error('Unhandled invocation crash:', fatalError);
        return res.status(500).json({
            error: 'Internal Server Error',
            details: fatalError.message
        });
    }
};