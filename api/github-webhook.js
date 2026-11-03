// api/github-webhook.js
const crypto = require('crypto');

/**
 * Reads the raw stream into a Buffer for byte-accurate HMAC verification.
 */
async function getRawBody(readable) {
    const chunks = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * Validates GitHub's HMAC-SHA256 signature in constant time.
 */
function verifyGitHubSignature(rawBuffer, signatureHeader, secret) {
    if (!signatureHeader || !secret) return false;
    if (!signatureHeader.startsWith('sha256=')) return false;

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBuffer);
    const expectedSignature = `sha256=${hmac.digest('hex')}`;

    const sigBuffer = Buffer.from(signatureHeader, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (sigBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

/**
 * Escapes HTML entities to prevent malformed Telegram markup.
 */
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * PostgREST helper communicating directly with Supabase via service_role key.
 */
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

/**
 * Records execution telemetry without throwing fatal exceptions.
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
        console.error('Telemetry failed:', err.message);
    }
}

/**
 * Fetches failed jobs and step details from GitHub REST API.
 */
async function fetchFailedJobDetails(repoFullName, runId) {
    const pat = process.env.GITHUB_PAT;
    if (!pat || !runId) return null;

    try {
        const url = `https://api.github.com/repos/${repoFullName}/actions/runs/${runId}/jobs`;
        const res = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${pat}`,
                'User-Agent': 'OmniCommand-SentinelDev'
            },
            signal: AbortSignal.timeout(4000)
        });

        if (!res.ok) return null;
        const data = await res.json();

        // Find failed jobs and isolate failed steps
        const failedJobs = (data.jobs || []).filter(j => j.conclusion === 'failure');
        if (failedJobs.length === 0) return null;

        const summary = failedJobs.map(job => {
            const failedSteps = (job.steps || []).filter(s => s.conclusion === 'failure').map(s => s.name);
            return `Job "${job.name}" failed on steps: ${failedSteps.join(', ') || 'unknown'}`;
        }).join('\n');

        return summary;
    } catch (err) {
        console.error('GitHub API job fetch error:', err.message);
        return null;
    }
}

/**
 * Diagnoses build failure root cause using gemini-3.5-flash-lite.
 */
async function diagnoseFailureWithGemini(failureContext) {
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
    if (!apiKey) return null;

    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const systemPrompt = `You are SentinelDev, an expert CI/CD failure diagnostician.
Analyze the provided GitHub Actions workflow failure metadata.
Identify the root cause, the most likely culprit (file, package, or configuration), and a concrete fix command or code adjustment.
Keep the explanation direct, grounded, and concise.`;

    const responseSchema = {
        type: "OBJECT",
        properties: {
            root_cause: { type: "STRING" },
            likely_culprit: { type: "STRING" },
            suggested_fix: { type: "STRING" }
        },
        required: ["root_cause", "likely_culprit", "suggested_fix"]
    };

    const payload = {
        contents: [
            { role: "user", parts: [{ text: `${systemPrompt}\n\nFAILURE CONTEXT:\n${failureContext}` }] }
        ],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.1
        }
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(6000)
        });

        if (!res.ok) return null;
        const result = await res.json();
        const textOutput = result.candidates?.[0]?.content?.parts?.[0]?.text;
        return textOutput ? JSON.parse(textOutput) : null;
    } catch (err) {
        console.error('Gemini diagnostic triage error:', err.message);
        return null;
    }
}

/**
 * Dispatches an HTML-formatted notification to Telegram.
 */
async function sendTelegramAlert(chatId, htmlText) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return false;

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: htmlText,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        })
    });
    return res.ok;
}

module.exports = async function handler(req, res) {
    const startTime = Date.now();

    try {
        // 1. Health check for GET probes
        if (req.method === 'GET') {
            return res.status(200).json({ status: 'healthy', milestone: '5b', service: 'SentinelDev' });
        }

        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }

        // 2. Read raw buffer for byte-exact HMAC calculation
        const rawBuffer = await getRawBody(req);
        const signatureHeader = req.headers['x-hub-signature-256'];
        const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

        // 3. Cryptographic Signature Verification
        if (!verifyGitHubSignature(rawBuffer, signatureHeader, webhookSecret)) {
            await recordTelemetry('SentinelDev_Ingress', 'AUTH_REJECTED', Date.now() - startTime, 'Invalid or missing HMAC signature');
            return res.status(401).json({ error: 'Unauthorized: Invalid webhook signature' });
        }

        // 4. Parse JSON payload
        let payload = {};
        try {
            payload = JSON.parse(rawBuffer.toString('utf8'));
        } catch (parseErr) {
            return res.status(400).json({ error: 'Malformed JSON payload' });
        }

        const eventType = req.headers['x-github-event'] || 'unknown';
        const deliveryId = req.headers['x-github-delivery'] || crypto.randomUUID();

        // 5. Handle GitHub Webhook Ping
        if (eventType === 'ping') {
            await recordTelemetry('SentinelDev_Ingress', 'PING_RECEIVED', Date.now() - startTime, `Delivery: ${deliveryId}`);
            return res.status(200).json({ ok: true, message: 'pong', delivery_id: deliveryId });
        }

        // 6. Idempotency Check in Supabase webhook_events
        const eventInsert = await supabaseRequest('webhook_events', 'POST', {
            source: 'GITHUB',
            external_event_id: String(deliveryId),
            raw_payload: payload
        }, { Prefer: 'return=representation' });

        if (eventInsert.status === 409) {
            await recordTelemetry('SentinelDev_Ingress', 'DUPLICATE_SKIPPED', Date.now() - startTime, `delivery_id: ${deliveryId}`);
            return res.status(200).json({ ok: true, duplicate: true });
        }

        if (!eventInsert.ok) {
            await recordTelemetry('SentinelDev_Ingress', 'DB_ERROR', Date.now() - startTime, JSON.stringify(eventInsert.data));
            return res.status(500).json({ error: 'Failed to record event in database' });
        }

        // 7. Filter for workflow_run completion
        if (eventType !== 'workflow_run') {
            return res.status(200).json({ ok: true, ignored_event: eventType });
        }

        const action = payload.action;
        const run = payload.workflow_run;

        if (action !== 'completed' || !run) {
            return res.status(200).json({ ok: true, ignored_action: action });
        }

        const conclusion = run.conclusion;
        const repoName = payload.repository ? payload.repository.full_name : 'Unknown Repo';
        const workflowName = run.name || 'Unnamed Workflow';
        const branch = run.head_branch || 'unknown';
        const commitMsg = run.head_commit ? run.head_commit.message.split('\n')[0] : 'No commit message';
        const author = run.head_commit && run.head_commit.author ? run.head_commit.author.name : 'Unknown Author';
        const runUrl = run.html_url || '';
        const runId = run.id;

        if (conclusion !== 'failure' && conclusion !== 'timed_out') {
            await recordTelemetry('SentinelDev_Workflow', 'WORKFLOW_SUCCESS', Date.now() - startTime, `${repoName} - ${workflowName}: ${conclusion}`);
            return res.status(200).json({ ok: true, conclusion });
        }

        // 8. Triage & Root Cause Analysis via GitHub API + Gemini
        const stepDetails = await fetchFailedJobDetails(repoName, runId);
        const failureContext = `
Repository: ${repoName}
Workflow: ${workflowName}
Branch: ${branch}
Conclusion: ${conclusion}
Commit Message: "${commitMsg}"
Author: ${author}
Run URL: ${runUrl}
${stepDetails ? `Job Failure Details:\n${stepDetails}` : 'Job Details: Direct log step details not available'}
`;

        const triage = await diagnoseFailureWithGemini(failureContext);

        // 9. Workflow Failure Staging in automation_jobs
        const jobId = crypto.randomUUID();
        const jobInsert = await supabaseRequest(
            'automation_jobs',
            'POST',
            {
                job_id: jobId,
                source_event_id: String(deliveryId),
                workflow: 'SentinelDev',
                command_type: 'WORKFLOW_FAILURE',
                raw_input: `${repoName} | ${workflowName} | ${conclusion} | ${commitMsg}`,
                parsed_payload: {
                    repository: repoName,
                    workflow_name: workflowName,
                    branch,
                    conclusion,
                    run_url: runUrl,
                    commit: commitMsg,
                    author,
                    triage_diagnosis: triage || 'Diagnostic unavailable'
                },
                status: 'RECEIVED'
            },
            { Prefer: 'return=representation' }
        );

        if (!jobInsert.ok) {
            console.error('Failed to insert into automation_jobs:', jobInsert.data);
            await recordTelemetry('SentinelDev_Workflow', 'JOB_INSERT_FAILED', Date.now() - startTime, JSON.stringify(jobInsert.data));
            return res.status(500).json({
                error: 'Database persistence failed for automation_jobs',
                details: jobInsert.data
            });
        }

        // 10. Dispatch Enriched Read-Only Telegram Alert Card
        const targetChatId = process.env.ALLOWED_TELEGRAM_UID;

        let diagnosisBlock = '';
        if (triage) {
            diagnosisBlock = `\n🔍 <b>Root Cause:</b> ${escapeHtml(triage.root_cause)}\n` +
                `🎯 <b>Likely Culprit:</b> <code>${escapeHtml(triage.likely_culprit)}</code>\n` +
                `💡 <b>Recommended Fix:</b> <code>${escapeHtml(triage.suggested_fix)}</code>\n`;
        }

        const alertHtml = `🚨 <b>SentinelDev Alert: CI/CD Failure</b>\n\n` +
            `📦 <b>Repository:</b> <code>${escapeHtml(repoName)}</code>\n` +
            `⚙️ <b>Workflow:</b> ${escapeHtml(workflowName)}\n` +
            `🌿 <b>Branch:</b> <code>${escapeHtml(branch)}</code>\n` +
            `❌ <b>Conclusion:</b> <code>${escapeHtml(conclusion.toUpperCase())}</code>\n` +
            `👤 <b>Author:</b> ${escapeHtml(author)}\n` +
            `📝 <b>Commit:</b> ${escapeHtml(commitMsg)}\n` +
            diagnosisBlock +
            `\n🔗 <a href="${runUrl}">View GitHub Actions Run</a>\n\n` +
            `<i>SentinelDev read-only triage. Automated re-runs disabled.</i>`;

        if (targetChatId) {
            await sendTelegramAlert(targetChatId, alertHtml);
        }

        await recordTelemetry('SentinelDev_Workflow', 'FAILURE_TRIAGED', Date.now() - startTime, `Job: ${jobId} | ${repoName}`);

        return res.status(200).json({
            ok: true,
            job_id: jobId,
            status: 'RECEIVED',
            conclusion,
            triaged: Boolean(triage)
        });

    } catch (fatalError) {
        console.error('SentinelDev Invocation Crash:', fatalError);
        return res.status(500).json({ error: 'Internal Server Error', details: fatalError.message });
    }
};

module.exports.config = {
    api: {
        bodyParser: false,
    },
};