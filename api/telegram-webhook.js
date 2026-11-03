// api/telegram-webhook.js
const crypto = require('crypto');

const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MB boundary

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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

async function sendTelegramMessage(chatId, text, replyMarkup = null, parseMode = null) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const body = { chat_id: chatId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    if (parseMode) body.parse_mode = parseMode;

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

async function editTelegramMessage(chatId, messageId, text, parseMode = null) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    const body = { chat_id: chatId, message_id: messageId, text };
    if (parseMode) body.parse_mode = parseMode;

    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function executeCalendarWrite(jobId, eventData) {
    const workerUrl = process.env.APPS_SCRIPT_CALENDAR_URL;
    const workerSecret = process.env.APPS_SCRIPT_WORKER_SECRET;

    if (!workerUrl || !workerSecret) {
        throw new Error('Apps Script Calendar Worker environment variables not configured');
    }

    const res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            worker_secret: workerSecret,
            action: 'CREATE_EVENT',
            job_id: jobId,
            event_data: eventData
        }),
        redirect: 'follow'
    });

    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch (_) {
        throw new Error(`Invalid response from Calendar Worker: ${text.slice(0, 200)}`);
    }

    if (!json.ok) {
        throw new Error(json.error || 'Calendar worker reported failure');
    }

    return json;
}

/**
 * Extracts structured calendar parameters using Gemini API.
 */
async function parseEventWithGemini(userText) {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const nowAnchor = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });

    const systemPrompt = `You are a fast, precise calendar extraction engine.
Current date and time: ${nowAnchor} (Timezone: Asia/Kolkata, UTC+05:30).
Determine if the user wants to schedule a calendar event.
- If ambiguous or lacking date/time, set is_complete to false and state missing_info.
- Default duration is 60 minutes if unspecified.
- Dates must be ISO 8601 strings with +05:30 offset (e.g., 2026-11-04T16:00:00+05:30).
- Be strict: do not guess dates.`;

    const responseSchema = {
        type: "OBJECT",
        properties: {
            is_calendar_event: { type: "BOOLEAN" },
            is_complete: { type: "BOOLEAN" },
            title: { type: "STRING" },
            start_iso: { type: "STRING" },
            end_iso: { type: "STRING" },
            duration_minutes: { type: "INTEGER" },
            description: { type: "STRING" },
            missing_info: { type: "STRING" }
        },
        required: ["is_calendar_event", "is_complete"]
    };

    const payload = {
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nUser request: "${userText}"` }] }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.1
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const result = await response.json();
    const textOutput = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOutput) throw new Error('Empty response from Gemini');

    return JSON.parse(textOutput);
}

/**
 * Extracts structured revision & mistake takeaways using Gemini 3.5 Flash Lite.
 */
async function parseSynapseWithGemini(userText) {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const systemPrompt = `You are SynapsePrep, an expert technical learning and mistake-analysis engine for an AI & Data Science engineer.
Analyze the user's raw study note, bug experience, or practice problem mistake.
Extract:
1. category: Choose strictly from 'MISTAKE', 'CONCEPT', 'SYSTEM_DESIGN', 'TOOLING'. Default to 'MISTAKE' if an error occurred.
2. subject: Concise domain tag (e.g., 'DSA - Binary Trees', 'Python - AsyncIO', 'PostgreSQL - Indexing', 'Machine Learning - Loss Functions').
3. core_concept: Clear 1-sentence technical takeaway.
4. mistake_pattern: What went wrong, the faulty assumption, or the trap encountered (null if purely a concept note).
5. remedy_action: Concrete, actionable rule or mental check to execute next time to prevent this mistake or recall the concept.`;

    const responseSchema = {
        type: "OBJECT",
        properties: {
            category: { type: "STRING", enum: ["MISTAKE", "CONCEPT", "SYSTEM_DESIGN", "TOOLING"] },
            subject: { type: "STRING" },
            core_concept: { type: "STRING" },
            mistake_pattern: { type: "STRING" },
            remedy_action: { type: "STRING" }
        },
        required: ["category", "subject", "core_concept", "remedy_action"]
    };

    const payload = {
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nRAW INPUT:\n"${userText}"` }] }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.1
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const result = await response.json();
    const textOutput = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOutput) throw new Error('Empty response from Gemini');

    return JSON.parse(textOutput);
}

module.exports = async function handler(req, res) {
    const startTime = Date.now();

    try {
        if (req.method === 'GET') {
            return res.status(200).json({ status: 'healthy', milestone: '7a', service: 'OmniCommand+SynapsePrep' });
        }

        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }

        // 1. Payload size guard
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (contentLength > MAX_PAYLOAD_BYTES) {
            await recordTelemetry('OmniCommand_Ingress', 'PAYLOAD_TOO_LARGE', Date.now() - startTime, `Length: ${contentLength}`);
            return res.status(413).json({ error: 'Payload Too Large: Maximum allowed size is 1MB' });
        }

        // 2. Header Authentication Check
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

        // 3. Branch A: Handle Approval Callbacks (Calendar Approval)
        if (payload.callback_query) {
            const cb = payload.callback_query;
            const senderId = cb.from && cb.from.id ? String(cb.from.id) : '';
            const chatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : '';
            const messageId = cb.message ? cb.message.message_id : null;
            const callbackData = String(cb.data || '');

            if (!allowedUid || senderId !== allowedUid) {
                await answerCallbackQuery(cb.id, 'Unauthorized user', true);
                await recordTelemetry('OmniCommand_Approval', 'UNAUTHORIZED_CALLBACK', Date.now() - startTime, `Sender: ${senderId}`);
                return res.status(200).json({ ok: true, rejected: 'unauthorized_callback' });
            }

            const [action, jobId] = callbackData.split(':');
            if (!jobId || (action !== 'app' && action !== 'rej')) {
                await answerCallbackQuery(cb.id, 'Invalid action payload', true);
                return res.status(200).json({ ok: true, rejected: 'malformed_callback_data' });
            }

            const newStatus = action === 'app' ? 'APPROVED' : 'REJECTED';

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

            if (!outcome.success) {
                let alertMessage = 'Action could not be applied.';
                if (outcome.reason === 'INVALID_STATE_TRANSITION') {
                    alertMessage = `Already processed! Status: ${outcome.current_status}`;
                } else if (outcome.reason === 'APPROVAL_EXPIRED') {
                    alertMessage = 'Approval window expired.';
                }

                await answerCallbackQuery(cb.id, alertMessage, true);
                await recordTelemetry('OmniCommand_Approval', 'DUPLICATE_OR_INVALID_TRANSITION', Date.now() - startTime, `Job: ${jobId}, Reason: ${outcome.reason}`);
                return res.status(200).json({ ok: true, noop: outcome.reason });
            }

            const jobRecord = outcome.job;

            if (newStatus === 'REJECTED') {
                await answerCallbackQuery(cb.id, 'Action rejected');
                if (chatId && messageId) {
                    await editTelegramMessage(chatId, messageId, `❌ Event proposal rejected.\nJob ID: \`${jobId}\``, 'Markdown');
                }
                await recordTelemetry('OmniCommand_Approval', 'REJECTED', Date.now() - startTime, `Job: ${jobId}`);
                return res.status(200).json({ ok: true, job_id: jobId, status: 'REJECTED' });
            }

            await answerCallbackQuery(cb.id, 'Scheduling on Google Calendar...');

            try {
                const eventData = jobRecord.parsed_payload;
                const calendarResult = await executeCalendarWrite(jobId, eventData);

                await supabaseRequest(`automation_jobs?job_id=eq.${jobId}`, 'PATCH', {
                    status: 'EXECUTED',
                    parsed_payload: {
                        ...eventData,
                        calendar_event_id: calendarResult.calendar_event_id
                    },
                    updated_at: new Date().toISOString()
                });

                if (chatId && messageId) {
                    const successCard = `✅ *Scheduled on Google Calendar!*\n\n` +
                        `*Title:* ${calendarResult.title}\n` +
                        `*Start:* \`${calendarResult.start_iso}\`\n` +
                        `*End:* \`${calendarResult.end_iso}\`\n\n` +
                        `_Verified Event ID:_ \`${calendarResult.calendar_event_id}\``;

                    await editTelegramMessage(chatId, messageId, successCard, 'Markdown');
                }

                await recordTelemetry('OmniCommand_Execution', 'SUCCESS', Date.now() - startTime, `Job: ${jobId}, Event: ${calendarResult.calendar_event_id}`);
                return res.status(200).json({ ok: true, job_id: jobId, status: 'EXECUTED', calendar_event_id: calendarResult.calendar_event_id });

            } catch (execErr) {
                console.error('Calendar execution failure:', execErr);

                await supabaseRequest(`automation_jobs?job_id=eq.${jobId}`, 'PATCH', {
                    status: 'FAILED',
                    error_message: execErr.message,
                    updated_at: new Date().toISOString()
                });

                if (chatId && messageId) {
                    await editTelegramMessage(chatId, messageId, `⚠️ *Execution Failed*\n\nReason: ${execErr.message}\nJob ID: \`${jobId}\``, 'Markdown');
                }

                await recordTelemetry('OmniCommand_Execution', 'FAILED', Date.now() - startTime, execErr.message);
                return res.status(200).json({ ok: true, error: 'Calendar execution failed' });
            }
        }

        // 4. Branch B: Handle Standard Text Messages
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

        // Deduplication via webhook_events
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

        if (text === '/ping') {
            await sendTelegramMessage(chatId, '✅ Pong! OmniCommand Milestone 7A is live.');
            await recordTelemetry('OmniCommand_Ingress', 'SUCCESS', Date.now() - startTime, 'Ping command');
            return res.status(200).json({ ok: true, command: '/ping' });
        }

        // 5. DETERMINISTIC ROUTING: SynapsePrep (/prep, /mistake, #prep, #mistake)
        const isSynapseCommand = /^(\/mistake|\/prep|#mistake|#prep)\b/i.test(text);

        if (isSynapseCommand) {
            const cleanInput = text.replace(/^(\/mistake|\/prep|#mistake|#prep)\s*/i, '').trim();

            if (!cleanInput) {
                const usageHelp = `🧠 <b>SynapsePrep Usage</b>\n\nSend a mistake or study note after the command:\n<code>/mistake In sliding window, forgot to shrink window when sum >= target, causing infinite loop</code>`;
                await sendTelegramMessage(chatId, usageHelp, null, 'HTML');
                return res.status(200).json({ ok: true, status: 'empty_synapse_input' });
            }

            let synapseData = null;
            try {
                synapseData = await parseSynapseWithGemini(cleanInput);
            } catch (aiErr) {
                console.error('SynapsePrep AI Error:', aiErr);
                await sendTelegramMessage(chatId, `⚠️ SynapsePrep AI parsing failed: ${aiErr.message}`);
                await recordTelemetry('SynapsePrep_Parser', 'AI_ERROR', Date.now() - startTime, aiErr.message);
                return res.status(200).json({ ok: true, error: 'ai_parse_failed' });
            }

            // Persist to Supabase synapse_prep table
            const prepInsert = await supabaseRequest('synapse_prep', 'POST', {
                category: synapseData.category,
                subject: synapseData.subject,
                raw_input: cleanInput,
                core_concept: synapseData.core_concept,
                mistake_pattern: synapseData.mistake_pattern || null,
                remedy_action: synapseData.remedy_action
            }, { Prefer: 'return=representation' });

            if (!prepInsert.ok) {
                console.error('Failed to insert into synapse_prep:', prepInsert.data);
                await recordTelemetry('SynapsePrep_Storage', 'DB_ERROR', Date.now() - startTime, JSON.stringify(prepInsert.data));
                return res.status(500).json({ error: 'Database persistence failed' });
            }

            const savedRecord = Array.isArray(prepInsert.data) ? prepInsert.data[0] : prepInsert.data;
            const prepId = savedRecord ? savedRecord.prep_id : 'saved';

            // Send structured confirmation card to Telegram
            const cardHtml = `🧠 <b>SynapsePrep Captured: [${escapeHtml(synapseData.category)}]</b>\n\n` +
                `📚 <b>Subject:</b> <code>${escapeHtml(synapseData.subject)}</code>\n` +
                `💡 <b>Core Concept:</b> ${escapeHtml(synapseData.core_concept)}\n` +
                (synapseData.mistake_pattern ? `⚠️ <b>Mistake / Trap:</b> ${escapeHtml(synapseData.mistake_pattern)}\n` : '') +
                `🎯 <b>Remedy Action:</b> <code>${escapeHtml(synapseData.remedy_action)}</code>\n\n` +
                `📅 <i>Staged for first retrieval in 24 hours. (ID: <code>${prepId.substring(0, 8)}</code>)</i>`;

            await sendTelegramMessage(chatId, cardHtml, null, 'HTML');
            await recordTelemetry('SynapsePrep_Storage', 'SUCCESS', Date.now() - startTime, `Subject: ${synapseData.subject}`);

            return res.status(200).json({ ok: true, type: 'synapse_captured', prep_id: prepId });
        }

        // 6. DEFAULT ROUTING: Calendar Scheduling Pipeline
        let parsedData = null;
        try {
            parsedData = await parseEventWithGemini(text);
        } catch (aiErr) {
            console.error('Gemini parsing error:', aiErr);
            await sendTelegramMessage(chatId, `⚠️ AI Parsing Error: Service temporarily unavailable.`);
            await recordTelemetry('OmniCommand_Parser', 'AI_ERROR', Date.now() - startTime, aiErr.message);
            return res.status(200).json({ ok: true, error: 'ai_parse_failed' });
        }

        if (!parsedData.is_calendar_event) {
            await sendTelegramMessage(chatId, `ℹ️ Received: "${text}"\n\n(Not a calendar command. Use <code>/mistake</code> or <code>/prep</code> to save study notes.)`, null, 'HTML');
            await recordTelemetry('OmniCommand_Parser', 'NOT_AN_EVENT', Date.now() - startTime, text);
            return res.status(200).json({ ok: true, type: 'non_calendar' });
        }

        if (!parsedData.is_complete) {
            const clarifyText = `❓ *Need More Details to Schedule*\n\nPrompt: "${text}"\n\n*Missing:* ${parsedData.missing_info || 'Date or time not clearly specified.'}\nPlease rephrase with an exact date and time.`;
            await sendTelegramMessage(chatId, clarifyText, null, 'Markdown');
            await recordTelemetry('OmniCommand_Parser', 'INCOMPLETE_INPUT', Date.now() - startTime, parsedData.missing_info);
            return res.status(200).json({ ok: true, status: 'incomplete_input' });
        }

        const jobId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        const jobInsert = await supabaseRequest('automation_jobs', 'POST', {
            job_id: jobId,
            source_event_id: updateId,
            workflow: 'OmniCommand',
            command_type: 'CALENDAR_EVENT',
            raw_input: text,
            parsed_payload: parsedData,
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
                    { text: '✅ Approve & Schedule', callback_data: `app:${jobId}` },
                    { text: '❌ Reject', callback_data: `rej:${jobId}` }
                ]
            ]
        };

        const cardText = `📅 *Proposed Calendar Event*\n\n` +
            `*Title:* ${parsedData.title}\n` +
            `*Start:* \`${parsedData.start_iso}\`\n` +
            `*End:* \`${parsedData.end_iso}\`\n` +
            `*Duration:* ${parsedData.duration_minutes} mins\n` +
            `*Notes:* ${parsedData.description || 'None'}\n\n` +
            `_Job ID:_ \`${jobId}\``;

        await sendTelegramMessage(chatId, cardText, inlineKeyboard, 'Markdown');
        await recordTelemetry('OmniCommand_Parser', 'STAGED_EVENT_SUCCESS', Date.now() - startTime, `job_id: ${jobId}`);

        return res.status(200).json({ ok: true, job_id: jobId, status: 'PENDING_APPROVAL' });

    } catch (fatalError) {
        console.error('OmniCommand Fatal Crash:', fatalError);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};