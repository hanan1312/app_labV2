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

function escapeHtml(value) {
    return (value ?? '').toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Every timestamp from the API is already Africa/Cairo local time (see
// src/utils/timezone.py) — this only reformats the string for display, matching
// formatCairoDateTime() in script_lab.js.
function formatCairoDateTime(value, includeSeconds = true) {
    if (!value) return '';
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return String(value);
    const [, year, month, day, hour, minute, second] = match;
    const datePart = `${day}/${month}/${year}`;
    if (hour === undefined) return datePart;
    const timePart = includeSeconds && second ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;
    return `${datePart} ${timePart}`;
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
    let subtitle = `${schema.patient_name} — Visit ${schema.visit_code} — ${formatCairoDateTime(schema.date, false)}`;
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
                    <input type="text" id="re-input-${testIndex}-${paramIndex}" value="${escapeAttr(param.result_value)}"
                           oninput="handleParamInput(${testIndex})">
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
                <label class="re-comment-label" for="re-comment-${testIndex}">Comment (shown in the report footer)</label>
                <textarea id="re-comment-${testIndex}" class="re-comment" placeholder="Optional note from the technician about this test...">${escapeHtml(test.comment)}</textarea>
            </div>
        `;
    }).join('');

    content.innerHTML = cards + `
        <div class="re-actions">
            <button class="re-btn re-btn-ghost" onclick="previewReport()">
                👁️ Preview Report
            </button>
            <button class="re-btn re-btn-primary" onclick="saveResults()">
                💾 Save &amp; Finalize
            </button>
        </div>
        <div id="re-preview-panel"></div>
    `;
}

// --- PARAMETER AUTO-CALCULATION ("Formula" from the Result Parameters modal) ---
// Fires on every keystroke in any parameter's own input. A formula can reference any number
// of sibling parameters (each embedded as a "{id}" token — see relation_formula's docstring
// in src/models/test_parameter.py), so instead of tracing a single source -> dependent edge,
// every formula-bearing parameter in the test is recomputed from whatever's currently in its
// referenced inputs. Written values are the same as if the technician had typed them by hand
// — still overridable afterward, and picked up as-is by collectFormData().
function handleParamInput(testIndex) {
    recalcAllFormulas(testIndex);
}

function recalcAllFormulas(testIndex) {
    const test = schema.tests[testIndex];
    // Repeat passes so a chain (A feeds B, B feeds C) fully settles in one keystroke — capped
    // at parameters.length+1 as a safety net in case a cycle ever slips past server validation.
    const maxPasses = test.parameters.length + 1;
    for (let pass = 0; pass < maxPasses; pass++) {
        let changed = false;

        test.parameters.forEach((dependent, dependentIndex) => {
            if (!dependent.relation_formula) return;

            const referencedIds = extractReferencedIds(dependent.relation_formula);
            const values = {};
            let allNumeric = true;
            referencedIds.forEach((id) => {
                const sourceIndex = test.parameters.findIndex((p) => p.template_id === id);
                const sourceInput = sourceIndex >= 0 ? document.getElementById(`re-input-${testIndex}-${sourceIndex}`) : null;
                const numeric = parseFloat(sourceInput ? sourceInput.value : '');
                if (Number.isNaN(numeric)) allNumeric = false;
                else values[id] = numeric;
            });
            if (!allNumeric) return; // wait until every referenced field holds a real number

            const computed = evaluateFormula(dependent.relation_formula, values);
            if (computed === null) return;
            const dependentInput = document.getElementById(`re-input-${testIndex}-${dependentIndex}`);
            if (!dependentInput) return;
            const rounded = String(roundForDisplay(computed));
            if (dependentInput.value !== rounded) {
                dependentInput.value = rounded;
                changed = true;
            }
        });

        if (!changed) break;
    }
}

function roundForDisplay(value) {
    return Math.round(value * 1000) / 1000; // trims float noise (e.g. 2.9999999999996) without hiding real precision
}

function extractReferencedIds(formula) {
    const ids = [];
    const re = /\{(\d+)\}/g;
    let match;
    while ((match = re.exec(formula))) ids.push(parseInt(match[1], 10));
    return ids;
}

// Restricted arithmetic evaluator — mirrors _validate_formula_syntax/_ALLOWED_BIN_OPS in
// src/routes/reports.py. Deliberately not eval()/Function()-based: a formula is technician-
// authored config, but there's no reason to run it as arbitrary JS. Grammar: numbers, + - * /
// ** and parentheses, and any number of "{id}" reference tokens, each resolved from `values`
// (an id -> number map built by the caller from that referenced parameter's own input).
function evaluateFormula(formula, values) {
    if (!formula) return null;
    try {
        const tokens = tokenizeFormula(formula);
        let pos = 0;
        const peek = () => tokens[pos];
        const consume = () => tokens[pos++];

        const parseExpr = () => {
            let value = parseTerm();
            while (peek() && (peek().type === '+' || peek().type === '-')) {
                const op = consume().type;
                const rhs = parseTerm();
                value = op === '+' ? value + rhs : value - rhs;
            }
            return value;
        };
        const parseTerm = () => {
            let value = parseUnary();
            while (peek() && (peek().type === '*' || peek().type === '/')) {
                const op = consume().type;
                const rhs = parseUnary();
                value = op === '*' ? value * rhs : value / rhs;
            }
            return value;
        };
        // Matches Python's precedence: ** binds tighter than unary +/- on its LEFT but looser
        // on its RIGHT, so "-{55} ** 2" is "-({55} ** 2)" while "{55} ** -2" is "{55} ** (-2)"
        // — both fall out of parseUnary/parsePow calling each other rather than a linear chain.
        const parseUnary = () => {
            if (peek() && (peek().type === '+' || peek().type === '-')) {
                const op = consume().type;
                const value = parseUnary();
                return op === '-' ? -value : value;
            }
            return parsePow();
        };
        const parsePow = () => {
            const base = parseAtom();
            if (peek() && peek().type === '**') {
                consume();
                return Math.pow(base, parseUnary()); // right-associative, right side may be signed
            }
            return base;
        };
        const parseAtom = () => {
            const token = consume();
            if (!token) throw new Error('Unexpected end of formula');
            if (token.type === 'num') return token.value;
            if (token.type === 'ref') {
                const value = values[token.id];
                if (value === undefined) throw new Error('Missing value for referenced parameter');
                return value;
            }
            if (token.type === '(') {
                const value = parseExpr();
                if (!peek() || peek().type !== ')') throw new Error('Missing closing parenthesis');
                consume();
                return value;
            }
            throw new Error('Unexpected token in formula');
        };

        const result = parseExpr();
        if (pos !== tokens.length) throw new Error('Unexpected trailing tokens');
        return Number.isFinite(result) ? result : null;
    } catch (error) {
        return null; // malformed formula — already rejected at save time in the normal case
    }
}

function tokenizeFormula(formula) {
    const tokens = [];
    let i = 0;
    while (i < formula.length) {
        const ch = formula[i];
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === '{') {
            const close = formula.indexOf('}', i);
            if (close === -1) throw new Error('Unterminated reference token');
            const idStr = formula.slice(i + 1, close);
            if (!/^\d+$/.test(idStr)) throw new Error('Invalid reference token');
            tokens.push({ type: 'ref', id: parseInt(idStr, 10) });
            i = close + 1;
            continue;
        }
        if (ch === '*' && formula[i + 1] === '*') { tokens.push({ type: '**' }); i += 2; continue; }
        if ('+-*/()'.includes(ch)) { tokens.push({ type: ch }); i++; continue; }
        if (/[0-9.]/.test(ch)) {
            let j = i;
            while (j < formula.length && /[0-9.]/.test(formula[j])) j++;
            tokens.push({ type: 'num', value: parseFloat(formula.slice(i, j)) });
            i = j;
            continue;
        }
        throw new Error('Unexpected character in formula: ' + ch);
    }
    return tokens;
}

// Shared by previewReport() (non-destructive) and saveResults() (the real save) — same
// {results, comments} shape the backend expects for both /results/preview and /results.
function collectFormData() {
    const results = [];
    const comments = {};
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

        const commentInput = document.getElementById(`re-comment-${testIndex}`);
        const commentValue = commentInput ? commentInput.value.trim() : '';
        if (commentValue) comments[test.lab_test_id] = commentValue;
    });
    return { results, comments };
}

// Non-destructive: renders a preview of exactly what Save would produce right now, without
// writing anything to the database, changing the visit's status, or sending any message.
// Re-invoked automatically after saving a report layout so the preview reflects it
// immediately (see saveLayout() below).
async function previewReport() {
    const panel = document.getElementById('re-preview-panel');
    if (!panel) return; // not rendered yet (e.g. called before the form loaded)
    panel.innerHTML = '<p class="re-empty" style="padding: 10px 0;">Generating preview…</p>';

    try {
        const response = await apiFetch(`/api/visits/${visitId}/results/preview`, {
            method: 'POST',
            body: JSON.stringify(collectFormData()),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            panel.innerHTML = `<p class="re-empty" style="padding: 10px 0;">Could not generate preview: ${escapeHtml(body.error || 'unknown error')}</p>`;
            return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        panel.innerHTML = `
            <div class="re-preview-bar">
                <strong style="color: var(--teal);">Preview — not saved yet</strong>
                <button class="re-btn re-btn-ghost" onclick="document.getElementById('re-preview-panel').innerHTML = ''">✕ Close Preview</button>
            </div>
            <iframe class="re-preview-frame" src="${url}"></iframe>
        `;
    } catch (error) {
        panel.innerHTML = `<p class="re-empty" style="padding: 10px 0;">Error generating preview: ${escapeHtml(error.message)}</p>`;
    }
}

async function saveResults() {
    const { results, comments } = collectFormData();

    try {
        const response = await apiFetch(`/api/visits/${visitId}/results`, {
            method: 'POST',
            body: JSON.stringify({ results, comments }),
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

// --- REPORT LAYOUT EDITOR ("Organize Report Layout") ---
// Per-visit, one-off arrangement — not a reusable template. layoutState mirrors what
// gets POSTed: which page (or null = unassigned/default) each test sits on, plus each
// page's optional title/subtitle.
let layoutState = { pageOf: {}, pages: {} }; // pageOf: {lab_test_id: pageNumber|null}, pages: {pageNumber: {title, subtitle}}

async function openLayoutEditor() {
    if (!schema || !schema.tests.length) {
        alert('No tests booked for this visit yet.');
        return;
    }
    try {
        const response = await apiFetch(`/api/visits/${visitId}/report-layout`);
        const layout = response.ok ? await response.json() : { pages: [], unassigned_tests: [] };

        layoutState = { pageOf: {}, pages: {} };
        (layout.pages || []).forEach(p => {
            layoutState.pages[p.page_number] = { title: p.title || '', subtitle: p.subtitle || '' };
            (p.tests || []).forEach(t => { layoutState.pageOf[t.lab_test_id] = p.page_number; });
        });
    } catch (error) {
        layoutState = { pageOf: {}, pages: {} };
    }
    renderLayoutEditor();
    document.getElementById('re-layout-overlay').classList.add('open');
}

function closeLayoutEditor() {
    document.getElementById('re-layout-overlay').classList.remove('open');
}

function usedPageNumbers() {
    const nums = new Set(Object.values(layoutState.pageOf).filter(n => n !== null && n !== undefined));
    Object.keys(layoutState.pages).forEach(n => nums.add(parseInt(n, 10)));
    return Array.from(nums).sort((a, b) => a - b);
}

function renderLayoutEditor() {
    const pages = usedPageNumbers();

    const rows = schema.tests.map(test => {
        const current = layoutState.pageOf[test.lab_test_id];
        const options = ['<option value="">Unassigned</option>']
            .concat(pages.map(n => `<option value="${n}" ${current === n ? 'selected' : ''}>Page ${n}</option>`))
            .concat(['<option value="__new__">+ New Page</option>']);
        return `
            <div class="re-layout-row">
                <span>${escapeHtml(test.test_name)}</span>
                <select onchange="assignTestPage(${test.lab_test_id}, this.value)">${options.join('')}</select>
            </div>
        `;
    }).join('');
    document.getElementById('re-layout-rows').innerHTML = rows;

    const pageCards = pages.map(n => {
        const p = layoutState.pages[n] || { title: '', subtitle: '' };
        return `
            <div class="re-page-card">
                <label>Page ${n} Title</label>
                <input type="text" value="${escapeAttr(p.title)}" oninput="updatePageField(${n}, 'title', this.value)" placeholder="e.g. Hematology">
                <label>Page ${n} Subtitle</label>
                <input type="text" value="${escapeAttr(p.subtitle)}" oninput="updatePageField(${n}, 'subtitle', this.value)" placeholder="Optional">
            </div>
        `;
    }).join('');
    document.getElementById('re-layout-pages').innerHTML = pageCards;
}

function assignTestPage(labTestId, value) {
    if (value === '__new__') {
        const nextPage = usedPageNumbers().reduce((max, n) => Math.max(max, n), 0) + 1;
        layoutState.pageOf[labTestId] = nextPage;
        layoutState.pages[nextPage] = { title: '', subtitle: '' };
    } else if (value === '') {
        layoutState.pageOf[labTestId] = null;
    } else {
        layoutState.pageOf[labTestId] = parseInt(value, 10);
    }
    renderLayoutEditor();
}

function updatePageField(pageNumber, field, value) {
    if (!layoutState.pages[pageNumber]) layoutState.pages[pageNumber] = { title: '', subtitle: '' };
    layoutState.pages[pageNumber][field] = value;
}

async function saveLayout() {
    const pages = usedPageNumbers().map(n => ({
        page_number: n,
        title: (layoutState.pages[n] || {}).title || '',
        subtitle: (layoutState.pages[n] || {}).subtitle || '',
        lab_test_ids: Object.entries(layoutState.pageOf)
            .filter(([, pageNum]) => pageNum === n)
            .map(([labTestId]) => parseInt(labTestId, 10)),
    }));

    try {
        const response = await apiFetch(`/api/visits/${visitId}/report-layout`, {
            method: 'POST',
            body: JSON.stringify({ pages }),
        });
        if (!response.ok) throw new Error('Server rejected layout save');
        closeLayoutEditor();
        previewReport(); // "after organise another preview" — reflect the new layout immediately
    } catch (error) {
        alert('Error saving report layout: ' + error.message);
    }
}

async function resetLayout() {
    try {
        await apiFetch(`/api/visits/${visitId}/report-layout`, { method: 'DELETE' });
        layoutState = { pageOf: {}, pages: {} };
        renderLayoutEditor();
    } catch (error) {
        alert('Error resetting report layout: ' + error.message);
    }
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
