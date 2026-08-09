// Standalone page (opened in a new window from the pending-samples "Enter Results" action).
// Deliberately not part of script_lab.js's SPA — no shared state needed beyond the visit id.

const visitId = window.location.pathname.split('/').filter(Boolean).pop();
let schema = null;

async function apiFetch(url, options = {}) {
    options.headers = options.headers || {};
    options.headers['X-App-Mode'] = 'lab';
    if (options.body && !options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
    }
    return fetch(url, options);
}

function escapeAttr(value) {
    return (value ?? '').toString().replace(/"/g, '&quot;');
}

async function loadSchema() {
    try {
        const response = await apiFetch(`/api/visits/${visitId}/results-schema`);
        if (!response.ok) {
            document.getElementById('re-subtitle').textContent = 'Visit not found.';
            return;
        }
        schema = await response.json();
        render();
    } catch (error) {
        document.getElementById('re-subtitle').textContent = 'Error loading visit: ' + error.message;
    }
}

function render() {
    let subtitle = `${schema.patient_name} — Visit ${schema.visit_code} — ${schema.date || ''}`;
    if (schema.status === 'partially_delivered') {
        subtitle += ` — ${completionStatusLine(schema)}`;
    }
    document.getElementById('re-subtitle').textContent = subtitle;

    const content = document.getElementById('re-content');

    if (!schema.tests.length) {
        content.innerHTML = '<div class="re-empty">No tests booked for this visit.</div>';
        return;
    }

    const cards = schema.tests.map((test, testIndex) => {
        if (!test.parameters.length) {
            return `
                <div class="re-test-card">
                    <h3>${test.test_name}</h3>
                    <p class="re-empty" style="padding: 10px 0;">
                        No parameters defined for this test yet — add them in Settings &gt; Test List &gt; Parameters.
                    </p>
                </div>
            `;
        }

        const rows = test.parameters.map((param, paramIndex) => `
            <tr>
                <td>
                    ${param.name}
                    ${param.method ? `<span class="re-method">Method: ${param.method}</span>` : ''}
                </td>
                <td>
                    <input type="text" id="re-input-${testIndex}-${paramIndex}" value="${escapeAttr(param.result_value)}">
                </td>
                <td class="re-unit">${param.unit || '-'}</td>
                <td class="re-range">${param.reference_range_text || '-'}</td>
            </tr>
        `).join('');

        return `
            <div class="re-test-card">
                <h3>${test.test_name}</h3>
                <table class="re-table">
                    <thead>
                        <tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Ref. Range</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }).join('');

    content.innerHTML = cards + `
        <div class="re-actions">
            <button class="re-btn re-btn-primary" onclick="saveResults()">
                💾 Save &amp; Generate Report
            </button>
        </div>
    `;
}

async function saveResults() {
    const results = [];
    schema.tests.forEach((test, testIndex) => {
        test.parameters.forEach((param, paramIndex) => {
            const input = document.getElementById(`re-input-${testIndex}-${paramIndex}`);
            const value = input ? input.value.trim() : '';
            if (!value) return; // blank — skip, matches backend's "skip blanks" behavior
            results.push({
                lab_test_id: test.lab_test_id,
                test_name: test.test_name,
                template_id: param.template_id,
                name: param.name,
                unit: param.unit,
                reference_range_text: param.reference_range_text,
                result_value: value,
            });
        });
    });

    try {
        const response = await apiFetch(`/api/visits/${visitId}/results`, {
            method: 'POST',
            body: JSON.stringify({ results }),
        });
        const body = await response.json();
        if (!response.ok || !body.success) {
            alert('Failed to save results: ' + (body.error || 'unknown error'));
            return;
        }

        let messagingResult = null;
        if (body.is_complete && body.messaging && body.messaging.enabled) {
            messagingResult = await sendCompletionMessage(body.messaging, body.report_url);
        }

        // This page is a separate popup window (see docs/summary.md) — nothing here is
        // visible in the main app unless we reach across via window.opener. That includes
        // the on-screen toast: handleFileUpload()'s "Upload PDF Report" flow shows one via
        // showAlert() after sending, and this flow's own WhatsApp send needs the same
        // on-screen confirmation, not just this popup's own (easy-to-miss) subtitle text.
        if (window.opener && !window.opener.closed) {
            if (typeof window.opener.refreshAfterResultsEntry === 'function') {
                window.opener.refreshAfterResultsEntry();
            }
            if (messagingResult && typeof window.opener.showAlert === 'function') {
                window.opener.showAlert(
                    messagingResult.ok
                        ? `Message sent successfully via ${messagingResult.method.toUpperCase()}!`
                        : `Failed to send ${messagingResult.method.toUpperCase()} message. Ensure Node server is running.`,
                    messagingResult.ok ? 'success' : 'error'
                );
            }
        }

        showSuccess(body, messagingResult);
    } catch (error) {
        alert('Error saving results: ' + error.message);
    }
}

// Fires the same Node WhatsApp/SMS bot the "Upload PDF Report" flow uses
// (see handleFileUpload() in script_lab.js) — only reached once every booked test has a
// saved result (save_results() only returns messaging.enabled when is_complete is true),
// so a partial save never messages the client.
async function sendCompletionMessage(messaging, reportUrl) {
    const liveServer = `${window.location.protocol}//${window.location.hostname}:${window.APP_PORTS.backend}`;
    const nodeServer = `${window.location.protocol}//${window.location.hostname}:${window.APP_PORTS.node}`;
    const endpoint = messaging.method === 'sms' ? '/api/sms/send' : '/api/whatsapp/send';

    let cleanUrl = encodeURI(reportUrl.trim());
    if (!cleanUrl.startsWith('/')) cleanUrl = '/' + cleanUrl;

    const message = `Hello ${messaging.patient_name || 'Patient'},\n\nYour results are ready:\n\n📄 Report: ${liveServer}${cleanUrl}\n\nHistory: ${liveServer}/patient-history/${messaging.patient_id}`;

    const payload = { centerId: 'lab', phone: messaging.phone, message };
    if (messaging.method !== 'sms') {
        payload.pdfUrl = `${liveServer}${cleanUrl}`;
    }

    try {
        const response = await fetch(`${nodeServer}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return { ok: response.ok, method: messaging.method };
    } catch (error) {
        console.error('Messaging error:', error);
        return { ok: false, method: messaging.method };
    }
}

function completionStatusLine(body) {
    if (body.is_complete) return 'delivered'; // sentinel; caller appends messaging outcome
    const remaining = (body.all_tests || []).filter(t => !(body.completed_tests || []).includes(t));
    const doneText = (body.completed_tests || []).join(', ') || 'No tests';
    const remainingText = remaining.length ? ` — ${remaining.join(', ')} still pending.` : '.';
    return `🧪 ${doneText} delivered${remainingText}`;
}

function showSuccess(body, messagingResult) {
    const reportUrl = body.report_url;

    let statusLine;
    if (body.is_complete) {
        if (messagingResult) {
            statusLine = messagingResult.ok
                ? `✅ All results delivered — message sent via ${messagingResult.method.toUpperCase()}.`
                : `✅ All results delivered — sending the ${messagingResult.method.toUpperCase()} message failed (is the Node bot running?).`;
        } else {
            statusLine = '✅ All results delivered.';
        }
    } else {
        statusLine = completionStatusLine(body);
    }
    document.getElementById('re-subtitle').textContent = statusLine;

    const content = document.getElementById('re-content');

    if (!reportUrl) {
        content.innerHTML = '<div class="re-empty">Results saved, but the report PDF could not be generated.</div>';
        return;
    }

    content.innerHTML = `
        <div class="re-preview-bar">
            <a class="re-btn re-btn-ghost" href="/">&larr; Back to Dashboard</a>
            <div style="display: flex; gap: 10px;">
                <a class="re-btn re-btn-ghost" href="/report/${visitId}" target="_blank">🔗 Public Report Link</a>
                <button class="re-btn re-btn-primary" onclick="printReport()">🖨️ Print</button>
            </div>
        </div>
        <iframe id="re-pdf-frame" class="re-preview-frame" src="/${reportUrl}"></iframe>
    `;
}

function printReport() {
    const frame = document.getElementById('re-pdf-frame');
    try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
    } catch (error) {
        // Cross-origin or browser blocked in-frame printing — fall back to opening the PDF
        // directly, where the browser's own PDF viewer print button is always available.
        window.open(frame.src, '_blank');
    }
}

loadSchema();
