// api/telegram-webhook.js
const crypto = require('crypto');

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

async function supabaseRequest(path, method, body, extraHeaders = {}) {
    const rawUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!rawUrl || !serviceKey) {
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

async function recordTelemetry(workflow, outcome, durationMs, notes) {
    try {
        await supabaseRequest('roi_telemetry', 'POST', {
            workflow,
            outcome,
            duration_ms: durationMs,
            notes: String(notes || '').slice(0, 500)
        });
    } catch (err) {
        console.error('Telemetry failed:', err.message);
    }
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const body = { chat_id: chatId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;

    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text,
            show_alert: showAlert
        })
    });
}

async function editTelegramMessage(chatId, messageId, text) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text
        })
    });
}

module.exports = async function handler(req, res) {
    const startTime = Date.now();

    try {
        if (req.method === 'GET') {
            return res.status(200).json({ status: 'healthy', milestone: 2 });
        }

        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }

        // 1. Header Authentication Check
        const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
        const expectedSecret = process.env.TG_SECRET_TOKEN;

        if (!expectedSecret || !safeCompare(incomingSecret, expectedSecret)) {
            await recordTelemetry('OmniCommand_Ingress', 'AUTH_REJECTED', Date.now() - startTime, 'Invalid secret token');
            return res.status(403).json({ error: 'Forbidden: Invalid secret token' });
        }

        const payload = req.body || {};
        const updateId = payload.update_id !== undefined ? String(payload.update_id) : null;

        if (!updateId) {
            return res.status(400).json({ error: 'Missing update_id' });
        }

        const allowedUid = String(process.env.ALLOWED_TELEGRAM_UID || '').trim();

        // 2. Branch A: Handle Inline Button Callbacks (callback_query)
        if (payload.callback_query) {
            const cb = payload.callback_query;
            const senderId = cb.from && cb.from.id ? String(cb.from.id) : '';
            const chatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : '';
            const messageId = cb.message ? cb.message.message_id : null;
            const callbackData = String(cb.data || '');

            // Verify User Authorization
            if (!allowedUid || senderId !== allowedUid) {
                await answerCallbackQuery(cb.id, 'Unauthorized user', true);
                await recordTelemetry('OmniCommand_Approval', 'UNAUTHORIZED_CALLBACK', Date.now() - startTime, `Sender: ${senderId}`);
                return res.status(200).json({ ok: true, rejected: 'unauthorized_callback' });
            }

            // Parse Action and Job ID (Format: "app:<UUID>" or "rej:<UUID>")
            const [action, jobId] = callbackData.split(':');
            if (!jobId || (action !== 'app' && action !== 'rej')) {
                await answerCallbackQuery(cb.id, 'Invalid action payload', true);
                return res.status(200).json({ ok: true, rejected: 'malformed_callback_data' });
            }

            const newStatus = action === 'app' ? 'APPROVED' : 'REJECTED';

            // Atomic Transition via Supabase Stored Procedure
            const rpcResult = await supabaseRequest('rpc/transition_job_status', 'POST', {
                p_job_id: jobId,
                p_expected_status: 'PENDING_APPROVAL',
                p_new_status: newStatus,
                p_user_id: senderId
            });

            if (!rpcResult.ok || !rpcResult.data) {
                await answerCallbackQuery(cb.id, 'Database transition error', true);
                await recordTelemetry('OmniCommand_Approval', 'DB_TRANSITION_ERROR', Date.now() - startTime, JSON.stringify(rpcResult.data));
                return res.status(200).json({ ok: true, error: 'transition_error' });
            }

            const outcome = rpcResult.data;

            // Handle Idempotency / Double-Tap Rejection
            if (!outcome.success) {
                let alertMessage = 'Action could not be applied.';
                if (outcome.reason === 'INVALID_STATE_TRANSITION') {
                    alertMessage = `Already processed! Current status: ${outcome.current_status}`;
                } else if (outcome.reason === 'APPROVAL_EXPIRED') {
                    alertMessage = 'Approval window expired.';
                }

                await answerCallbackQuery(cb.id, alertMessage, true);
                await recordTelemetry('OmniCommand_Approval', 'DUPLICATE_OR_INVALID_TRANSITION', Date.now() - startTime, `Job: ${jobId}, Reason: ${outcome.reason}`);
                return res.status(200).json({ ok: true, noop: outcome.reason });
            }

            // Successful Transition: Answer Callback and Remove Inline Buttons
            await answerCallbackQuery(cb.id, `Status updated to ${newStatus}`);
            if (chatId && messageId) {
                const statusEmoji = newStatus === 'APPROVED' ? '✅' : '❌';
                await editTelegramMessage(
                    chatId,
                    messageId,
                    `${statusEmoji} Action ${newStatus}.\nJob ID: ${jobId}\nApprover: ${senderId}\nProcessed at: ${new Date().toISOString()}`
                );
            }

            await recordTelemetry('OmniCommand_Approval', 'TRANSITION_SUCCESS', Date.now() - startTime, `Job: ${jobId} -> ${newStatus}`);
            return res.status(200).json({ ok: true, job_id: jobId, status: newStatus });
        }

        // 3. Branch B: Handle Standard Message Updates (message)
        const message = payload.message || payload.edited_message;
        if (!message || typeof message.text !== 'string') {
            return res.status(200).json({ ok: true, ignored: 'non_text_update' });
        }

        const senderId = message.from && message.from.id ? String(message.from.id) : '';
        const chatId = message.chat && message.chat.id ? String(message.chat.id) : '';
        const text = message.text.trim();

        if (!allowedUid || senderId !== allowedUid) {
            await recordTelemetry('OmniCommand_Ingress', 'UNAUTHORIZED_USER', Date.now() - startTime, `Sender: ${senderId}`);
            return res.status(200).json({ ok: true, rejected: 'unauthorized_user' });
        }

        // Deduplication check
        const eventInsert = await supabaseRequest('webhook_events', 'POST', {
            source: 'TELEGRAM',
            external_event_id: updateId,
            raw_payload: payload
        }, { Prefer: 'return=representation' });

        if (eventInsert.status === 409) {
            await recordTelemetry('OmniCommand_Ingress', 'DUPLICATE_SKIPPED', Date.now() - startTime, `update_id: ${updateId}`);
            return res.status(200).json({ ok: true, duplicate: true });
        }

        if (!eventInsert.ok) {
            await recordTelemetry('OmniCommand_Ingress', 'DB_ERROR', Date.now() - startTime, JSON.stringify(eventInsert.data));
            return res.status(500).json({ error: 'Database persistence failed' });
        }

        // Ping Command
        if (text === '/ping') {
            await sendTelegramMessage(chatId, '✅ Pong! OmniCommand Milestone 2 is live.');
            await recordTelemetry('OmniCommand_Ingress', 'SUCCESS', Date.now() - startTime, 'Ping command');
            return res.status(200).json({ ok: true, command: '/ping' });
        }

        // Simulated Action Staging: Creates a PENDING_APPROVAL Job with Inline Buttons
        const jobId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24-hr window

        const jobInsert = await supabaseRequest('automation_jobs', 'POST', {
            job_id: jobId,
            source_event_id: updateId,
            workflow: 'OmniCommand',
            command_type: 'APPROVAL_GATE',
            raw_input: text,
            status: 'PENDING_APPROVAL',
            expires_at: expiresAt
        }, { Prefer: 'return=representation' });

        if (!jobInsert.ok) {
            await recordTelemetry('OmniCommand_Ingress', 'JOB_CREATION_FAILED', Date.now() - startTime, JSON.stringify(jobInsert.data));
            return res.status(500).json({ error: 'Failed to stage approval job' });
        }

        const inlineKeyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Approve', callback_data: `app:${jobId}` },
                    { text: '❌ Reject', callback_data: `rej:${jobId}` }
                ]
            ]
        };

        const promptText = `⚠️ *Approval Required*\n\nProposed Action: "${text}"\nJob ID: \`${jobId}\`\nExpires: 24h\n\nChoose an action:`;
        await sendTelegramMessage(chatId, promptText, inlineKeyboard);
        await recordTelemetry('OmniCommand_Approval', 'STAGED_PENDING_APPROVAL', Date.now() - startTime, `job_id: ${jobId}`);

        return res.status(200).json({ ok: true, job_id: jobId, status: 'PENDING_APPROVAL' });

    } catch (fatalError) {
        console.error('Unhandled invocation crash:', fatalError);
        return res.status(500).json({ error: 'Internal Server Error', details: fatalError.message });
    }
};