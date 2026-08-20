// Lab Management System Frontend Script

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/static/sw.js')
            .then(reg => console.log('Service Worker registered!', reg))
            .catch(err => console.error('Service Worker failed!', err));
    });
}

let clients = [];
let currentUser = null;
let labConfig = null;
let testResults = [];
let serviceTypes = [];
let currentClientDetails = null;
let editingClientId = null;
let allVisits = [];
let revChartInstance = null;
let genderChartInstance = null;
let testChartInstance = null;
let warehouseItems = [];


// --- WORKSPACE LOGIC ---
let currentWorkspace = localStorage.getItem('app_workspace') || 'lab';

// --- i18n LANGUAGE LOGIC ---
let translations = {};
let currentLang = localStorage.getItem('app_lang') || 'EN'; // Default to English

// Open local database
const dbPromise = indexedDB.open('HelixOfflineDB', 1);

dbPromise.onupgradeneeded = function(event) {
    const db = event.target.result;
    // Create an "outbox" to store API requests we couldn't send
    if (!db.objectStoreNames.contains('sync-outbox')) {
        db.createObjectStore('sync-outbox', { autoIncrement: true });
    }
};

let systemPolicies = {
    forceLogoutTime: '',
    loginResumeTime: '',
    idleLogoutMs: 0
};
let isLoggingOut = false;

// Function triggered by the new "Save Policies" button
async function saveSessionPolicies() {
    const payload = {
        force_logout_time: document.getElementById('hr-force-logout-time').value,
        login_resume_time: document.getElementById('hr-login-resume-time').value,
        idle_logout_timeout: document.getElementById('hr-idle-logout-timeout').value
    };
    
    try {
        const response = await apiFetch('/api/lab/settings', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        
        if (response.ok) {
            showAlert(t('hr_policies_saved', 'Security policies updated successfully!'), 'success');
            applyGlobalSettings(); // Reloads settings into memory
        }
    } catch (error) {
        showAlert(t('hr_policies_save_failed', 'Failed to save policies.'), 'error');
    }
}

function saveToOfflineQueue(url, method, payload) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('HelixOfflineDB', 1);
        request.onsuccess = function(event) {
            const db = event.target.result;
            const tx = db.transaction('sync-outbox', 'readwrite');
            const store = tx.objectStore('sync-outbox');
            
            store.add({
                url: url,
                method: method,
                body: payload,
                timestamp: new Date().getTime()
            });
            
            tx.oncomplete = () => {
                showAlert(t('offline_saved_locally', 'You are offline. Data saved locally and will sync later.'), 'warn');
                resolve();
            };
        };
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.querySelector('.main');
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');

    // Close sidebar when tapping the main content area
    mainContent.addEventListener('click', (e) => {
        // Only close if it's currently open
        if (sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
        }
    });

    // Ensure the hamburger button doesn't trigger the "close" event immediately
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Stop the event from bubbling up to mainContent
            sidebar.classList.toggle('open');
        });
    }
});

async function initializeTopbar() {
    try {
        const response = await apiFetch('/api/check-admin');
        const data = await response.json();
        
        const workspaceSelector = document.getElementById('workspace-selector');
        
        // Hide the selector if user is not an admin
        if (data.is_admin) {
            workspaceSelector.style.display = 'block'; // Or 'inline-block'
        } else {
            workspaceSelector.style.display = 'none';
        }
    } catch (error) {
        console.error("Error checking admin status:", error);
        addNotification(t('generic_error_colon', 'Error: {msg}', {msg: error}), 'danger');
    }
}

// Add this to your DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    initializeTopbar();
    applyGlobalSettings();
});
// Every timestamp arriving from the API is already Africa/Cairo local time — the backend
// converts before serializing (see src/utils/timezone.py) and stamps booking/transaction/
// warehouse timestamps in Cairo time at creation, never trusting the client's own clock. So
// this only reformats the string for display: it deliberately never builds a Date object or
// does any timezone math of its own, meaning display is correct regardless of the viewing
// browser's own clock/timezone (unlike the old approach of re-parsing as UTC and converting
// to the browser's local time, which double-shifted values that were already Cairo-local).
// "YYYY-MM-DD" for a given instant (default: right now) as it reads in Africa/Cairo local
// time — used to compute "today"/"this month"/"this year" boundaries so they agree with the
// server-stamped Cairo-local date/date_time strings (see formatCairoDateTime above),
// regardless of the viewing browser's own OS timezone (Intl's timeZone option ignores that
// entirely, unlike toISOString(), which is always UTC, or getFullYear()/getDate(), which are
// always the browser's local timezone).
function cairoDateStr(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(date);
}

function formatCairoDateTime(value, includeSeconds = true) {
    if (!value || value === 'N/A') return 'N/A';
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return String(value); // not a recognized server timestamp shape — show as-is
    const [, year, month, day, hour, minute, second] = match;
    const datePart = `${day}/${month}/${year}`;
    if (hour === undefined) return datePart; // date-only value (e.g. a chart label with no time)
    const timePart = includeSeconds && second ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;
    return `${datePart} ${timePart}`;
}

// Helper function to check if a date string falls within a from/to range
function isDateInRange(targetDateStr, fromDateStr, toDateStr) {
    if (!targetDateStr) return false;
    
    // Extract just the YYYY-MM-DD part for comparison
    let targetDate = '';
    if (targetDateStr.includes('T')) {
        targetDate = targetDateStr.split('T')[0];
    } else {
        targetDate = targetDateStr.split(' ')[0];
    }
    
    if (fromDateStr && targetDate < fromDateStr) return false;
    if (toDateStr && targetDate > toDateStr) return false;

    return true;
}

// Renders Prev/Next + numbered page buttons into `containerId` from a paginated API
// response's {page, total_pages, total}. `onPageChangeFnName` is the NAME (string) of a
// global function to call with the target page number — matches this codebase's existing
// inline onclick-by-name convention rather than passing function references around.
function renderPaginationControls(containerId, state, onPageChangeFnName) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const page = state.page || 1;
    const totalPages = state.total_pages || 1;
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    const maxButtons = 7;
    let pages;
    if (totalPages <= maxButtons) {
        pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    } else {
        const keep = new Set([1, totalPages, page, page - 1, page + 1].filter(p => p >= 1 && p <= totalPages));
        pages = [...keep].sort((a, b) => a - b);
    }

    let html = `<button class="btn ghost" style="padding: 6px 12px;" ${page <= 1 ? 'disabled' : ''} onclick="${onPageChangeFnName}(${page - 1})">&larr; Prev</button>`;
    let lastPage = 0;
    pages.forEach(p => {
        if (p - lastPage > 1) html += `<span style="padding: 0 4px; color: var(--muted);">&hellip;</span>`;
        html += `<button class="btn ${p === page ? '' : 'ghost'}" style="padding: 6px 12px; min-width: 38px;" onclick="${onPageChangeFnName}(${p})">${p}</button>`;
        lastPage = p;
    });
    html += `<button class="btn ghost" style="padding: 6px 12px;" ${page >= totalPages ? 'disabled' : ''} onclick="${onPageChangeFnName}(${page + 1})">Next &rarr;</button>`;
    html += `<span style="margin-left: 10px; color: var(--muted); font-size: 12px;">Page ${page} of ${totalPages} (${state.total} total)</span>`;

    container.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 15px; flex-wrap: wrap;';
    container.innerHTML = html;
}

// 1. Fetch the JSON file from your static folder
async function loadTranslations() {
    try {
        // Adjust this path if your Flask static folder is configured differently
        const response = await fetch('/static/translations.json'); 
        if (!response.ok) throw new Error("Could not load translations file.");
        
        translations = await response.json();
        
        // Ensure the dropdown matches the saved preference
        const langSelector = document.getElementById('language-selector');
        if (langSelector) langSelector.value = currentLang;
        
        // Apply translations immediately on load
        applyTranslations(currentLang);
    } catch (error) {
        console.error("Translation Error:", error);
        
    }
}

// 2. Handle the Dropdown Change
function changeLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('app_lang', lang); // Save preference
    applyTranslations(lang);
}

// 3. The Engine: Swap the text in the DOM
function applyTranslations(lang) {
    if (!translations[lang]) return;

    // Set Right-to-Left for Arabic, Left-to-Right for English
    document.body.dir = lang === 'AR' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang === 'AR' ? 'ar' : 'en';

    // Optional: Add a CSS class to body if you need to adjust specific fonts for Arabic
    if (lang === 'AR') {
        document.body.classList.add('arabic-layout');
    } else {
        document.body.classList.remove('arabic-layout');
    }

    // Find all elements with the data-i18n attribute
    const elements = document.querySelectorAll('[data-i18n]');
    
    elements.forEach(el => {
        // e.g., "sidebar.dashboard" becomes ["sidebar", "dashboard"]
        const keys = el.getAttribute('data-i18n').split('.'); 
        let value = translations[lang];

        // Drill down into the JSON object
        keys.forEach(k => {
            if (value) value = value[k];
        });

        // If a translation exists, apply it
        if (value) {
            // Check if it's an input field (we need to change the placeholder, not textContent)
            if (el.tagName === 'INPUT' && el.hasAttribute('placeholder')) {
                el.placeholder = value;
            } else {
                el.textContent = value;
            }
        }
    });
}

// --- Dynamic (runtime-composed) string translations — toast/alert/confirm messages built
// in JS rather than sitting in the DOM already, so data-i18n (which only rewrites elements
// already present in the page) can't reach them. Looks up
// translations[currentLang].alerts[key]; {name}-style placeholders in the template are
// substituted from `vars`. Falls back to `fallback` (the original English text) if the key
// or the whole translations file isn't loaded yet, so a bad/missing key degrades to English
// instead of showing "undefined".
function t(key, fallback, vars) {
    let template = translations && translations[currentLang] && translations[currentLang].alerts
        ? translations[currentLang].alerts[key]
        : undefined;
    if (template === undefined || template === null) template = fallback;
    if (vars) {
        Object.keys(vars).forEach(k => {
            template = template.split(`{${k}}`).join(vars[k]);
        });
    }
    return template;
}

function initializeWorkspaceDropdown() {
    const selector = document.getElementById('workspace-selector');
    if (selector) {
        selector.value = currentWorkspace;
    }
}

async function changeWorkspace() {
    const selector = document.getElementById('workspace-selector');
    currentWorkspace = selector.value;
    localStorage.setItem('app_workspace', currentWorkspace);
    
    // Update the backend session workspace
    try {
        const response = await apiFetch('/api/auth/update_workspace', {
            method: 'POST',
            body: JSON.stringify({ workspace: currentWorkspace })
        });
        
        if (response.ok) {
            // Full page reload to serve the correct HTML shell from the backend
            window.location.reload();
        } else {
            showAlert(t('workspace_update_failed', 'Failed to update workspace on server.'), 'danger');
        }
    } catch (error) {
        console.error('Error updating workspace:', error);
        showAlert(t('workspace_switch_error', 'An error occurred while switching workspaces.'), 'danger');
    }
}


window.addEventListener('online', syncOfflineData);

async function syncOfflineData() {
    showAlert(t('internet_restored', 'Internet restored! Syncing data in background...'), 'info');
    
    // 1. THE DELAY FIX: Wait 2 seconds for the internet routing to actually wake up
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const request = indexedDB.open('HelixOfflineDB', 1);
    request.onsuccess = function(event) {
        const db = event.target.result;
        const tx = db.transaction('sync-outbox', 'readwrite');
        const store = tx.objectStore('sync-outbox');
        
        const getAll = store.getAll();
        
        getAll.onsuccess = function() {
            const items = getAll.result;
            const getKeys = store.getAllKeys();
            
            getKeys.onsuccess = async function() {
                const keys = getKeys.result;
                if (items.length === 0) return; 
                
                let successCount = 0;
                
                for (let i = 0; i < items.length; i++) {
                    try {
                        // 2. THE HEADER FIX: Added X-App-Mode so Flask accepts it
                        const response = await fetch(items[i].url, {
                            method: items[i].method,
                            headers: { 
                                'Content-Type': 'application/json',
                                'X-App-Mode': typeof currentWorkspace !== 'undefined' ? currentWorkspace : 'lab'
                            },
                            body: JSON.stringify(items[i].body)
                        });
                        
                        if (response.ok) {
                            const deleteTx = db.transaction('sync-outbox', 'readwrite');
                            deleteTx.objectStore('sync-outbox').delete(keys[i]);
                            successCount++;
                        } else {
                            console.error("Server rejected synced item:", await response.text());
                        }
                        
                    } catch (err) {
                        console.error("Sync failed for an item", err);
                    }
                }
                
                if (successCount > 0) {
                    showAlert(t('offline_sync_success', 'Successfully synced {count} offline actions!', {count: successCount}), 'success');
                    if (typeof loadInitialData === 'function') await loadInitialData(); 
                }
            };
        };
    };
}
async function apiFetch(endpoint, options = {}) {
    // 1. Prepare Headers (Your existing logic)
    if (!options.headers) {
        options.headers = {};
    }
    
    // Inject dynamic workspace header
    options.headers['X-App-Mode'] = typeof currentWorkspace !== 'undefined' ? currentWorkspace : 'clinic';
    
    // Ensure JSON content type if sending data
    if (options.body && !options.headers['Content-Type'] && !(options.body instanceof FormData)) {
        options.headers['Content-Type'] = 'application/json';
    }

    // 2. Execute Fetch with Offline Interception
    try {
        const response = await fetch(endpoint, options);
        if (response.status === 401 && endpoint !== '/api/auth/login') {
            console.warn("Session killed by server (Offline/Timeout). Redirecting to login.");
            window.location.replace('/login');
            return response;
        }        
        return response;
    } catch (error) {
        // 3. Detect Network Failure
        if (!navigator.onLine || error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            console.warn(`[Offline Mode] Network down. Intercepting request to ${endpoint}...`);

            const method = options.method ? options.method.toUpperCase() : 'GET';

            // 4. Handle Data Modifying Requests (POST, PUT, DELETE)
            if (method !== 'GET') {
                let payload = null;
                
                // We only parse JSON payloads for the queue, skip FormData (like PDF uploads) for now
                if (options.body && typeof options.body === 'string') {
                    payload = JSON.parse(options.body);
                }

                // Save to our IndexedDB outbox (Requires the Phase 2 code)
                await saveToOfflineQueue(endpoint, method, payload);

                // Return a fake "success" response so your UI doesn't crash or show an error
                return { 
                    ok: true, 
                    status: 200,
                    json: async () => ({ success: true, message: 'Saved offline. Will sync when connected.' }) 
                };
            } else {
                // 5. Handle Data Fetching Requests (GET) gracefully
                if (typeof showAlert === 'function') {
                    showAlert(t('offline_cached_data', 'You are offline. Showing cached data.'), 'warn');
                }
                
                // Return a safe "failed" response instead of crashing
                // This allows 'if (response.ok)' checks in your app to quietly skip
                return {
                    ok: false,
                    status: 503,
                    json: async () => ({ error: "Offline mode", data: [] })
                };
            }
        }
        
        // If it's a different kind of error (e.g., CORS), throw it normally
        throw error;
    }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', main);

async function main() {
    try {
        // 1. Attempt to fetch current user data
        const response = await apiFetch('/api/auth/current_user', { 
            method: 'GET',
            credentials: 'include'
        });
        
        // 2. Handle Authentication
        if (!response.ok) {
            console.warn('User not logged in, redirecting...');
            window.location.href = '/login';
            return; 
        }
        
        // 3. Populate global user object
        currentUser = await response.json();
        console.log("User Loaded:", currentUser);
        console.log("Current Permissions:", currentUser.permissions);

        // 4. Initialize the rest of the application
        await initializeApp();
        
        // 5. Apply UI restrictions AFTER user is fully loaded
        setupUIForRole();

        // 6. Reveal the sidebar only after permissions are applied
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            sidebar.style.visibility = 'visible';
        }

    } catch (error) {
        console.error('Initialization failed:', error);
        // Optional: Add a UI alert here if the server is down
    }
}

// ==========================================
// HR & EMPLOYEE MANAGEMENT (UPGRADED)
// ==========================================
let employees = [];

async function fetchHRData() {
    console.log("Fetching HR data from database..."); // Debugging log

    try {
        const response = await apiFetch('/api/hr/employees');
        if (response.ok) {
            employees = await response.json();
            console.log(`Success! Loaded ${employees.length} employees.`);
            renderHRTable();
            fetchAttendanceConfig();
            fetchAttendancePercentageReport();
        } else {
            // If Python throws an error, catch it and show it!
            const errorText = await response.text();
            console.error("Backend Error:", errorText);
            showAlert(t('server_error_console', 'Server Error: Check Python Console'), 'error');
        }
    } catch (error) {
        console.error("Failed to load HR data", error);
        showAlert(t('hr_load_network_error', 'Network error loading employee data'), 'error');
    }
}

function renderHRTable() {
    let container = document.getElementById('hr-list-container');
    
    if (!container) {
        container = document.createElement('div');
        container.id = 'hr-list-container';
        const hrTab = document.getElementById('hr-management');
        if (hrTab) hrTab.appendChild(container);
        else return;
    }
    
    // 1. Get the current filter values
    const presenceFilter = document.getElementById('hr-filter-presence')?.value || "";
    const attendanceFilter = document.getElementById('hr-filter-attendance')?.value || "";

    // 2. Apply the filters
    let filteredEmployees = employees;
    if (presenceFilter) {
        filteredEmployees = filteredEmployees.filter(emp => {
            // Default to 'offline' if the backend hasn't provided this data yet
            const currentPresence = emp.presence_status || 'offline';
            return currentPresence === presenceFilter;
        });
    }
    if (attendanceFilter) {
        filteredEmployees = filteredEmployees.filter(emp => {
            const att = emp.attendance_status || {};
            if (attendanceFilter === 'vacation') return !!att.on_vacation;
            if (attendanceFilter === 'in') return att.clocked_in && !att.on_vacation;
            if (attendanceFilter === 'out') return !att.clocked_in && !att.on_vacation;
            return true;
        });
    }

    if (filteredEmployees.length === 0) {
        container.innerHTML = `<div class="table-container"><table style="width:100%;"><tr><td style="text-align:center; padding: 30px; color: var(--muted);">${t('empty_no_employees_filtered', 'No employees found matching your filters.')}</td></tr></table></div>`;
        return;
    }

    // 3. Render the filtered rows
    let rows = filteredEmployees.map((emp, index) => {
        let safeSalary = parseFloat(emp.salary) || 0;

        // Determine presence status and corresponding CSS class
        let presence = emp.presence_status || 'offline'; // Fallback
        let presenceClass = 'presence-offline';
        let presenceText = 'Offline';

        if (presence === 'online') {
            presenceClass = 'presence-online';
            presenceText = 'Online';
        } else if (presence === 'idle') {
            presenceClass = 'presence-idle';
            presenceText = 'Idle';
        }

        // Style the username column nicely
        let usernameDisplay = emp.username
            ? `<span style="color: var(--teal); font-weight: 500;">${emp.username}</span>`
            : `<span style="color: var(--muted); font-style: italic; font-size: 12px;">Not assigned</span>`;

        // Status is now fully derived live from attendance clock-in/out + vacations — admin/HR
        // clocks employees in/out directly here, regardless of whether they have a system
        // login (see clockInEmployee/clockOutEmployee). There is no manually-set status
        // anymore (see the Add/Edit Employee form).
        const att = emp.attendance_status || { clocked_in: false, since: null, on_vacation: false };
        let statusBadge;
        if (att.on_vacation) {
            statusBadge = '<span class="pill info">On Vacation</span>';
        } else if (att.clocked_in) {
            statusBadge = `<span class="pill ok">In since ${formatCairoDateTime(att.since, false)}</span>`;
        } else {
            statusBadge = '<span class="pill ghost">Out</span>';
        }
        const clockBtn = att.clocked_in
            ? `<button class="btn ghost" style="padding: 4px 10px; font-size: 12px; color: var(--danger);" onclick="clockOutEmployee(${emp.id})">Clock Out</button>`
            : `<button class="btn ghost" style="padding: 4px 10px; font-size: 12px; color: var(--ok);" onclick="clockInEmployee(${emp.id})">Clock In</button>`;

        return `
        <tr>
            <td><input type="checkbox" class="hr-checkbox" data-id="${emp.id}" data-email="${emp.email || ''}" data-phone="${emp.phone || ''}" data-name="${emp.name || ''}" onchange="updateHRBulkActions()"></td>
            <td>${index + 1}</td>
            <td>
                <div style="display: flex; align-items: center; gap: 10px;">
                    ${renderAvatarHtml(emp.photo_path, emp.name, 36)}
                    <div>
                        <div style="display: flex; align-items: center;">
                            <span class="presence-dot ${presenceClass}" title="${presenceText}"></span>
                            <strong>${emp.name}</strong>
                        </div>
                        <small style="color: var(--muted); font-size: 11px;">${emp.email || 'No email'}</small>
                    </div>
                </div>
            </td>
            <td>${usernameDisplay}</td> <!-- NEW USERNAME COLUMN -->
            <td style="color: var(--muted);">${emp.role}</td>
            <td>${emp.phone || 'N/A'}</td>
            <td><strong>${safeSalary.toFixed(2)} EGP</strong></td>
            <td>${statusBadge}</td>
            <td>
                <div style="display: flex; gap: 4px;">
                    ${clockBtn}
                    <button class="btn ghost" style="padding: 4px 10px; font-size: 12px;" onclick="openEmployeeAttendanceModal(${emp.id})">Manage</button>
                </div>
            </td>
            <td style="text-align: right;">
                <button class="btn ghost" style="padding: 4px 10px; font-size: 12px;" onclick="openEmployeeModal(${emp.id})">Edit</button>
            </td>
        </tr>
    `}).join('');

    container.innerHTML = `
        <div style="display: flex; gap: 10px; margin-bottom: 15px; min-height: 38px;">
            <button id="btn-hr-bulk-delete" class="btn btn-danger" style="display: none;" onclick="handleBulkDeleteHR()">🗑️ Delete Selected</button>
            <button id="btn-hr-bulk-email" class="btn" style="background: #3b82f6; color: white; border: none; display: none;" onclick="handleBulkEmailHR()">✉️📱 Notify Selected</button>
        </div>
        
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th style="width: 40px;"><input type="checkbox" id="selectAllHR" onclick="toggleAllHREmployees(this)"></th>
                        <th style="width: 50px;">#</th>
                        <th>Name & Activity</th>
                        <th>System Username</th> <!-- NEW HEADER -->
                        <th>Role</th>
                        <th>Phone</th>
                        <th>Salary</th>
                        <th>Status</th>
                        <th>Attendance</th>
                        <th style="text-align: right;">Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
    
    // Ensure bulk actions hide/show correctly after redrawing
    updateHRBulkActions();
}

// ==========================================
// HR BULK ACTIONS LOGIC
// ==========================================

function toggleAllHREmployees(masterCheckbox) {
    document.querySelectorAll('.hr-checkbox').forEach(cb => cb.checked = masterCheckbox.checked);
    updateHRBulkActions();
}

function updateHRBulkActions() {
    const checkedCount = document.querySelectorAll('.hr-checkbox:checked').length;
    document.getElementById('btn-hr-bulk-delete').style.display = checkedCount > 0 ? 'block' : 'none';
    document.getElementById('btn-hr-bulk-email').style.display = checkedCount > 0 ? 'block' : 'none';
}

async function handleBulkDeleteHR() {
    const checkboxes = document.querySelectorAll('.hr-checkbox:checked');
    const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
    
    if (ids.length === 0) return;
    if (!confirm(t('confirm_delete_employees', 'Are you sure you want to delete {count} employee(s)? This cannot be undone.', {count: ids.length}))) return;

    try {
        let successCount = 0;
        for (const id of ids) {
            const response = await apiFetch(`/api/hr/employees/${id}`, { method: 'DELETE' });
            if (response.ok) successCount++;
        }
        showAlert(t('hr_employees_deleted', 'Successfully deleted {count} employees!', {count: successCount}), 'success');
        fetchHRData(); // Refresh the table
    } catch (error) {
        showAlert(t('hr_employees_delete_error', 'Error deleting employees.'), 'error');
    }
}

// Sends the same notification over both channels the app already has wired up: real SMTP
// email via the Flask backend (send_hr_email()), and WhatsApp via the Node bot — reusing the
// exact same direct-to-Node-service call shape the results-delivery flow already uses
// (script_lab.js's upload handler), rather than inventing a second pattern.
async function handleBulkEmailHR() {
    const checkboxes = document.querySelectorAll('.hr-checkbox:checked');
    if (checkboxes.length === 0) return;

    const recipients = Array.from(checkboxes).map(cb => ({
        name: cb.dataset.name || 'Employee',
        email: (cb.dataset.email || '').trim(),
        phone: (cb.dataset.phone || '').trim(),
    }));

    const emailRecipients = recipients.filter(r => r.email && r.email !== 'null');
    const phoneRecipients = recipients.filter(r => r.phone && r.phone !== 'null');

    if (emailRecipients.length === 0 && phoneRecipients.length === 0) {
        showAlert(t('hr_no_contact_info', 'None of the selected employees have an email or phone number saved.'), 'warn');
        return;
    }

    const subject = prompt(`Draft a notification for ${recipients.length} employee(s). Enter subject:`, "Lab Notification");
    if (!subject) return;

    const message = prompt("Enter your message:");
    if (!message) return;

    // --- Email, via the backend's real SMTP sender ---
    let emailResultText;
    let emailFailed = false;
    if (emailRecipients.length > 0) {
        try {
            const response = await apiFetch('/api/hr/employees/email', {
                method: 'POST',
                body: JSON.stringify({ emails: emailRecipients.map(r => r.email), subject, message })
            });
            const body = await response.json();
            if (response.ok) {
                const hadPartialFailure = body.failed && body.failed.length;
                emailFailed = !!hadPartialFailure;
                emailResultText = `${t('hr_email_sent', 'Email: sent to {count}', {count: body.sent ?? emailRecipients.length})}${hadPartialFailure ? t('hr_email_failed_count', ', failed for {count}', {count: body.failed.length}) : ''}.`;
            } else {
                emailFailed = true;
                emailResultText = t('hr_email_failed_reason', 'Email: failed — {reason}.', {reason: body.error || t('hr_unknown_error', 'unknown error')});
            }
        } catch (error) {
            emailFailed = true;
            emailResultText = t('hr_email_failed_network', 'Email: failed — network error.');
        }
    } else {
        emailResultText = t('hr_email_skipped', 'Email: skipped (no addresses saved).');
    }

    // --- WhatsApp, direct to the Node bot (same pattern as the results-delivery flow) ---
    let waSent = 0, waFailed = 0;
    if (phoneRecipients.length > 0) {
        const nodeServer = `http://${window.location.hostname}:${window.APP_PORTS.node}`;
        for (const r of phoneRecipients) {
            try {
                const waResponse = await fetch(`${nodeServer}/api/whatsapp/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ centerId: 'lab', phone: r.phone, message: `Hello ${r.name},\n\n${message}` }),
                });
                if (waResponse.ok) waSent++; else waFailed++;
            } catch (error) {
                waFailed++;
            }
        }
    }
    const waResultText = phoneRecipients.length === 0
        ? t('hr_whatsapp_skipped', 'WhatsApp: skipped (no phone numbers saved).')
        : `${t('hr_whatsapp_sent', 'WhatsApp: sent to {count}', {count: waSent})}${waFailed ? t('hr_whatsapp_failed_count', ', failed for {count}', {count: waFailed}) : ''}.`;

    const hadFailure = emailFailed || waFailed > 0;
    showAlert(`${emailResultText} ${waResultText}`, hadFailure ? 'warn' : 'success');

    document.querySelectorAll('.hr-checkbox').forEach(cb => cb.checked = false);
    if (document.getElementById('selectAllHR')) document.getElementById('selectAllHR').checked = false;
    updateHRBulkActions();
}

function openEmployeeModal(empId = null) {
    const title = document.getElementById('emp-modal-title');
    document.getElementById('employee-form').reset();
    document.getElementById('emp-id').value = '';
    document.getElementById('emp-username').value = ''; // Reset new field
    document.getElementById('emp-photo-path').value = '';

    if (empId) {
        title.textContent = 'Edit Employee';
        const emp = employees.find(e => e.id === empId);
        if (emp) {
            document.getElementById('emp-id').value = emp.id;
            document.getElementById('emp-name').value = emp.name;
            document.getElementById('emp-role').value = emp.role;
            document.getElementById('emp-phone').value = emp.phone || '';
            document.getElementById('emp-salary').value = emp.salary || '';
            document.getElementById('emp-email').value = emp.email || '';
            // Load existing username if it exists
            document.getElementById('emp-username').value = emp.username || '';
            document.getElementById('emp-photo-path').value = emp.photo_path || '';
        }
    } else {
        title.textContent = 'Add New Employee';
    }

    refreshEmployeePhotoPreview();
    document.getElementById('employee-modal').style.display = 'block';
}

function closeEmployeeModal() {
    document.getElementById('employee-modal').style.display = 'none';
}

// --- Employee photo upload / initials-avatar fallback ---
const AVATAR_COLORS = ['#F87171', '#FB923C', '#FBBF24', '#34D399', '#22D3EE', '#60A5FA', '#A78BFA', '#F472B6', '#4ADE80', '#38BDF8'];

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    const first = parts[0] ? parts[0][0] : '';
    const second = parts[1] ? parts[1][0] : '';
    return (first + second).toUpperCase() || '?';
}

function avatarColorForName(name) {
    let hash = 0;
    const str = name || '';
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function renderAvatarHtml(photoPath, name, sizePx) {
    if (photoPath) {
        return `<img src="${photoPath}" class="employee-avatar" style="width:${sizePx}px;height:${sizePx}px;">`;
    }
    const fontSize = Math.round(sizePx * 0.4);
    return `<div class="employee-avatar" style="width:${sizePx}px;height:${sizePx}px;font-size:${fontSize}px;background:${avatarColorForName(name)};">${getInitials(name)}</div>`;
}

function refreshEmployeePhotoPreview() {
    const preview = document.getElementById('emp-photo-preview');
    if (!preview) return;
    const photoPath = document.getElementById('emp-photo-path').value;
    const name = document.getElementById('emp-name').value;
    preview.innerHTML = renderAvatarHtml(photoPath, name, 64);
    const removeBtn = document.getElementById('emp-photo-remove-btn');
    if (removeBtn) removeBtn.style.display = photoPath ? 'inline-block' : 'none';
}

function handleEmployeePhotoSelected(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('emp-photo-path').value = e.target.result;
        refreshEmployeePhotoPreview();
    };
    reader.readAsDataURL(file);
}

function removeEmployeePhoto() {
    document.getElementById('emp-photo-path').value = '';
    document.getElementById('emp-photo-input').value = '';
    refreshEmployeePhotoPreview();
}

async function saveEmployeeRecord(event) {
    event.preventDefault();

    const payload = {
        id: document.getElementById('emp-id').value,
        name: document.getElementById('emp-name').value,
        role: document.getElementById('emp-role').value,
        phone: document.getElementById('emp-phone').value,
        salary: document.getElementById('emp-salary').value,
        email: document.getElementById('emp-email').value,
        username: document.getElementById('emp-username').value, // Send new field to backend
        photo_path: document.getElementById('emp-photo-path').value,
    };

    try {
        const response = await apiFetch('/api/hr/employees', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        
        if (response.ok) {
            showAlert(t('hr_employee_saved', 'Employee saved successfully!'), 'success');
            closeEmployeeModal();
            fetchHRData(); // Refresh the table
        } else {
            showAlert(t('hr_employee_save_failed', 'Failed to save employee.'), 'error');
        }
    } catch (error) {
        showAlert(t('hr_employee_save_error', 'Error saving employee data.'), 'error');
    }
}

async function deleteEmployee(empId) {
    if (!confirm(t('confirm_delete_employee_record', 'Are you sure you want to delete this employee record?'))) return;

    try {
        const response = await apiFetch(`/api/hr/employees/${empId}`, { method: 'DELETE' });
        if (response.ok) {
            showAlert(t('hr_employee_deleted', 'Employee deleted.'), 'success');
            fetchHRData();
        }
    } catch (error) {
        showAlert(t('hr_employee_delete_error', 'Error deleting employee.'), 'error');
    }
}

// ==========================================
// ATTENDANCE — managed entirely by admin/HR per employee (not all employees have a system
// login, so this is never self-service; see src/models/attendance.py).
// ==========================================
let attendanceConfig = { weekly_days_off: [], standard_work_hours_per_day: 8, holidays: [] };
let eamSessions = [];
let eamPermissions = [];
let eamVacations = [];
let eamEditingSessionId = null;

// Fills the from/to inputs for a given picker (`report`/`eam`) with a preset range —
// 'today' / 'week' (Mon-Sun) / 'month' / 'year' — using pure UTC-based arithmetic on
// cairoDateStr()'s components — never a local Date getter — so the boundary isn't skewed by
// the viewer's own browser timezone.
function attendancePresetRange(preset, refDateStr) {
    const [y, m, d] = (refDateStr || cairoDateStr()).split('-').map(Number);
    if (preset === 'today') {
        const today = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        return { from: today, to: today };
    }
    if (preset === 'week') {
        const refUTC = Date.UTC(y, m - 1, d);
        const weekday = new Date(refUTC).getUTCDay(); // 0=Sun..6=Sat
        const isoWeekday = weekday === 0 ? 7 : weekday; // 1=Mon..7=Sun
        const mondayMs = refUTC - (isoWeekday - 1) * 86400000;
        const sundayMs = mondayMs + 6 * 86400000;
        return { from: new Date(mondayMs).toISOString().slice(0, 10), to: new Date(sundayMs).toISOString().slice(0, 10) };
    }
    if (preset === 'year') {
        return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    // 'month' (default)
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { from: first, to: last };
}

function setAttendanceRangePreset(scope, preset) {
    if (!preset) return;
    const { from, to } = attendancePresetRange(preset);
    const fromInput = document.getElementById(`att-${scope}-from`);
    const toInput = document.getElementById(`att-${scope}-to`);
    if (fromInput) fromInput.value = from;
    if (toInput) toInput.value = to;
}

function attendanceRangeQuery(scope) {
    const from = document.getElementById(`att-${scope}-from`)?.value;
    const to = document.getElementById(`att-${scope}-to`)?.value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
}

function renderPercentageCard(containerId, data) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const pctColor = data.percentage >= 90 ? 'var(--ok)' : (data.percentage >= 70 ? 'var(--warn)' : 'var(--danger)');
    container.innerHTML = `
        <div style="text-align: center;">
            <div style="font-size: 12px; color: var(--muted);">Attendance %</div>
            <div style="font-size: 30px; font-weight: bold; color: ${pctColor};">${data.percentage}%</div>
        </div>
        <div style="text-align: center;">
            <div style="font-size: 12px; color: var(--muted);">Worked</div>
            <div style="font-size: 18px; font-weight: bold; color: var(--text);">${data.worked_hours}h</div>
        </div>
        <div style="text-align: center;">
            <div style="font-size: 12px; color: var(--muted);">Credited</div>
            <div style="font-size: 18px; font-weight: bold; color: var(--text);">${data.credited_hours}h</div>
        </div>
        <div style="text-align: center;">
            <div style="font-size: 12px; color: var(--muted);">Expected</div>
            <div style="font-size: 18px; font-weight: bold; color: var(--text);">${data.expected_hours}h</div>
        </div>
    `;
}

// --- HR row quick actions ---
async function clockInEmployee(empId) {
    try {
        const response = await apiFetch(`/api/hr/employees/${empId}/attendance/clock-in`, { method: 'POST' });
        const data = await response.json();
        if (response.ok) {
            fetchHRData();
        } else {
            showAlert(data.error || t('attendance_clockin_failed', 'Failed to clock in.'), 'error');
        }
    } catch (error) {
        showAlert(t('attendance_clockin_network_error', 'Network error clocking in.'), 'error');
    }
}

async function clockOutEmployee(empId) {
    try {
        const response = await apiFetch(`/api/hr/employees/${empId}/attendance/clock-out`, { method: 'POST' });
        const data = await response.json();
        if (response.ok) {
            fetchHRData();
        } else {
            showAlert(data.error || t('attendance_clockout_failed', 'Failed to clock out.'), 'error');
        }
    } catch (error) {
        showAlert(t('attendance_clockout_network_error', 'Network error clocking out.'), 'error');
    }
}

// --- Per-employee attendance drill-down modal ---
function openEmployeeAttendanceModal(empId) {
    const emp = employees.find(e => e.id === empId);
    document.getElementById('eam-employee-id').value = empId;
    document.getElementById('eam-employee-name').textContent = emp ? emp.name : '';
    const avatarSlot = document.getElementById('eam-employee-avatar');
    if (avatarSlot) avatarSlot.innerHTML = emp ? renderAvatarHtml(emp.photo_path, emp.name, 40) : '';
    eamEditingSessionId = null;
    if (!document.getElementById('att-eam-from').value) setAttendanceRangePreset('eam', 'month');
    document.getElementById('eam-best-practice-panel').style.display = 'none';
    document.getElementById('employee-attendance-modal').style.display = 'block';
    loadEmployeeAttendanceModalData();

    eamCalendarView = 'month';
    eamCalendarRefDate = cairoDateStr();
    updateEamCalendarViewButtons();
    loadEamCalendar();
}

function closeEmployeeAttendanceModal() {
    document.getElementById('employee-attendance-modal').style.display = 'none';
    if (eamTrendChartInstance) {
        eamTrendChartInstance.destroy();
        eamTrendChartInstance = null;
    }
}

async function loadEmployeeAttendanceModalData() {
    const empId = document.getElementById('eam-employee-id').value;
    if (!empId) return;
    const range = attendanceRangeQuery('eam');
    try {
        const [sessionsRes, permissionsRes, vacationsRes, percentageRes, trendRes] = await Promise.all([
            apiFetch(`/api/hr/employees/${empId}/attendance/sessions?${range}`),
            apiFetch(`/api/hr/employees/${empId}/attendance/permissions`),
            apiFetch(`/api/hr/employees/${empId}/attendance/vacations`),
            apiFetch(`/api/hr/employees/${empId}/attendance/percentage?${range}`),
            apiFetch(`/api/hr/employees/${empId}/attendance/trend?${range}`),
        ]);
        eamSessions = sessionsRes.ok ? await sessionsRes.json() : [];
        eamPermissions = permissionsRes.ok ? await permissionsRes.json() : [];
        eamVacations = vacationsRes.ok ? await vacationsRes.json() : [];
        renderEamSessionsTable();
        renderEamPermissionsTable();
        renderEamVacationsTable();
        if (percentageRes.ok) renderPercentageCard('eam-percentage-card', await percentageRes.json());
        if (trendRes.ok) renderEamTrendChart(await trendRes.json());
    } catch (error) {
        console.error('Failed to load employee attendance data', error);
    }
}

// --- Attendance performance line chart ---
let eamTrendChartInstance = null;

function renderEamTrendChart(trend) {
    const canvas = document.getElementById('eam-trend-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (eamTrendChartInstance) {
        eamTrendChartInstance.destroy();
        eamTrendChartInstance = null;
    }
    // Read the app's own theme tokens so the chart matches dark/light mode automatically
    // instead of hardcoding colors that would clash if the user toggles theme.
    const style = getComputedStyle(document.documentElement);
    const teal = style.getPropertyValue('--teal').trim() || '#5cbdb9';
    const muted = style.getPropertyValue('--muted').trim() || '#8aa6b8';
    const border = style.getPropertyValue('--border').trim() || 'rgba(255,255,255,.07)';

    const dense = trend.length > 45; // hide point markers when the range is long (e.g. a year)

    eamTrendChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: trend.map(t => t.date.slice(5)), // MM-DD, compact
            datasets: [{
                label: 'Attendance %',
                data: trend.map(t => t.percentage),
                borderColor: teal,
                backgroundColor: teal + '26', // ~15% alpha fill under the line
                borderWidth: 2,
                pointRadius: dense ? 0 : 3,
                pointHoverRadius: 5,
                pointBackgroundColor: teal,
                tension: 0.25,
                fill: true,
            }],
        },
        options: {
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }, // single series — the section title already names it
                tooltip: {
                    callbacks: {
                        title: (items) => trend[items[0].dataIndex].date,
                        label: (item) => {
                            const t = trend[item.dataIndex];
                            return [`Attendance: ${t.percentage}%`, `Worked: ${t.worked_hours}h`, `Expected: ${t.expected_hours}h`];
                        },
                    },
                },
            },
            scales: {
                y: {
                    min: 0, max: 100,
                    ticks: { color: muted, callback: (v) => v + '%' },
                    grid: { color: border },
                },
                x: {
                    ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
                    grid: { display: false },
                },
            },
        },
    });
}

// --- Calendar (day/week/month), Jira-Tempo-style heatmap of hours worked ---
let eamCalendarView = 'month';
let eamCalendarRefDate = null;
let eamCalendarDaySessions = [];

function updateEamCalendarViewButtons() {
    ['day', 'week', 'month'].forEach(v => {
        const btn = document.getElementById(`eam-cal-btn-${v}`);
        if (!btn) return;
        btn.style.background = (v === eamCalendarView) ? 'var(--teal)' : '';
        btn.style.color = (v === eamCalendarView) ? '#04121d' : '';
    });
}

function setEamCalendarView(view) {
    eamCalendarView = view;
    updateEamCalendarViewButtons();
    loadEamCalendar();
}

function shiftEamCalendar(direction) {
    const [y, m, d] = eamCalendarRefDate.split('-').map(Number);
    let newMs;
    if (eamCalendarView === 'month') newMs = Date.UTC(y, m - 1 + direction, 1);
    else if (eamCalendarView === 'week') newMs = Date.UTC(y, m - 1, d + direction * 7);
    else newMs = Date.UTC(y, m - 1, d + direction);
    eamCalendarRefDate = new Date(newMs).toISOString().slice(0, 10);
    loadEamCalendar();
}

function viewEamCalendarDay(dateStr) {
    eamCalendarView = 'day';
    eamCalendarRefDate = dateStr;
    updateEamCalendarViewButtons();
    loadEamCalendar();
}

async function loadEamCalendar() {
    const empId = document.getElementById('eam-employee-id').value;
    if (!empId || !eamCalendarRefDate) return;
    const { from, to } = attendancePresetRange(eamCalendarView === 'day' ? 'today' : eamCalendarView, eamCalendarRefDate);
    try {
        const requests = [apiFetch(`/api/hr/employees/${empId}/attendance/trend?from=${from}&to=${to}`)];
        if (eamCalendarView === 'day') {
            requests.push(apiFetch(`/api/hr/employees/${empId}/attendance/sessions?from=${from}&to=${to}`));
        }
        const [trendRes, sessionsRes] = await Promise.all(requests);
        const trend = trendRes.ok ? await trendRes.json() : [];
        eamCalendarDaySessions = (sessionsRes && sessionsRes.ok) ? await sessionsRes.json() : [];
        renderEamCalendar(trend, from, to);
    } catch (error) {
        console.error('Failed to load calendar', error);
    }
}

function renderEamCalendar(trend, from, to) {
    const container = document.getElementById('eam-calendar-grid');
    const label = document.getElementById('eam-calendar-label');
    if (!container) return;

    const byDate = {};
    trend.forEach(t => { byDate[t.date] = t; });

    if (eamCalendarView === 'month') {
        const [y, m] = from.split('-').map(Number);
        label.textContent = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } else if (eamCalendarView === 'week') {
        label.textContent = `${from} → ${to}`;
    } else {
        label.textContent = from;
    }

    if (eamCalendarView === 'day') {
        const t = byDate[from] || { worked_hours: 0, expected_hours: 0, percentage: 0 };
        const sessionRows = eamCalendarDaySessions.length
            ? eamCalendarDaySessions.map(s => `<div style="padding: 6px 0; border-bottom: 1px solid var(--border);">${formatCairoDateTime(s.clock_in)} → ${s.clock_out ? formatCairoDateTime(s.clock_out) : 'Open'}</div>`).join('')
            : '<p style="color: var(--muted); font-size: 12px;">No sessions this day.</p>';
        container.innerHTML = `
            <div style="text-align: center; padding: 15px 0;">
                <div style="font-size: 32px; font-weight: bold; color: var(--teal);">${t.worked_hours}h</div>
                <div style="color: var(--muted); font-size: 12px;">worked of ${t.expected_hours}h expected — ${t.percentage}%</div>
            </div>
            ${sessionRows}`;
        return;
    }

    const startWeekday = eamCalendarView === 'month' ? (new Date(from + 'T00:00:00Z').getUTCDay() + 6) % 7 : 0;
    const cells = Array(startWeekday).fill(null);
    for (let ms = new Date(from + 'T00:00:00Z').getTime(); ms <= new Date(to + 'T00:00:00Z').getTime(); ms += 86400000) {
        cells.push(new Date(ms).toISOString().slice(0, 10));
    }

    const maxHours = Math.max(1, ...trend.map(t => t.worked_hours));
    const dayCells = cells.map(dateStr => {
        if (!dateStr) return '<div></div>';
        const t = byDate[dateStr] || { worked_hours: 0, expected_hours: 0, percentage: 0 };
        const intensity = Math.min(1, t.worked_hours / maxHours);
        const bg = t.worked_hours > 0 ? `rgba(92, 209, 163, ${0.12 + intensity * 0.55})` : 'rgba(128,128,128,0.06)';
        const dayNum = parseInt(dateStr.slice(8, 10), 10);
        const isToday = dateStr === cairoDateStr();
        return `
        <div onclick="viewEamCalendarDay('${dateStr}')" style="background: ${bg}; border-radius: 6px; padding: 8px; min-height: ${eamCalendarView === 'month' ? '56px' : '80px'}; cursor: pointer; border: 1px solid ${isToday ? 'var(--teal)' : 'transparent'};" title="${dateStr}">
            <div style="font-size: 11px; color: var(--muted);">${dayNum}</div>
            <div style="font-size: 13px; font-weight: bold; color: var(--text);">${t.worked_hours > 0 ? t.worked_hours + 'h' : ''}</div>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin-bottom: 6px; font-size: 11px; color: var(--muted); text-align: center;">
            <div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>
        </div>
        <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px;">${dayCells}</div>`;
}

function toggleAttendanceBestPractice() {
    const panel = document.getElementById('eam-best-practice-panel');
    if (!panel) return;
    const isHidden = panel.style.display === 'none' || !panel.style.display;
    if (isHidden) {
        panel.innerHTML = `
            <h4 style="color: var(--gold); margin-bottom: 8px;">💡 Attendance Best Practices</h4>
            <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: var(--text); line-height: 1.6;">
                <li>Keep a single continuous shift where possible — several short split sessions in one day usually signal a forgotten clock-out rather than an intentional schedule.</li>
                <li>Flag any session left open longer than ~12–16 hours for correction — it's almost always a missed clock-out, not real hours worked.</li>
                <li>Wait for at least a month of data before relying on the percentage for a performance conversation — a single bad week can skew a short window.</li>
                <li>Use "Excused Hours" for occasional lateness/early leave, and "Vacations" for planned multi-day leave — mixing the two makes the monthly percentage harder to read.</li>
                <li>Revisit the weekly-days-off policy each quarter — a mismatch between the configured day off and actual staffing patterns quietly drags every employee's percentage down.</li>
            </ul>`;
        panel.style.display = 'block';
    } else {
        panel.style.display = 'none';
    }
}

function renderEamSessionsTable() {
    const container = document.getElementById('eam-sessions-container');
    if (!container) return;
    if (!eamSessions.length) {
        container.innerHTML = `<p style="color: var(--muted); font-size: 12px;">${t('empty_no_sessions', 'No sessions found.')}</p>`;
        return;
    }
    const rows = eamSessions.map(s => {
        const durationHours = s.clock_out
            ? ((new Date(s.clock_out.replace(' ', 'T')) - new Date(s.clock_in.replace(' ', 'T'))) / 3600000).toFixed(2)
            : '—';
        const openBadge = s.is_open ? '<span class="pill warn">Open</span>' : '<span class="pill ok">Closed</span>';
        return `
        <tr>
            <td>${formatCairoDateTime(s.clock_in)}</td>
            <td>${s.clock_out ? formatCairoDateTime(s.clock_out) : '—'}</td>
            <td>${durationHours}</td>
            <td>${openBadge}</td>
            <td style="color: var(--muted); font-size: 12px;">${s.note || ''}</td>
            <td style="text-align: right;">
                <button type="button" class="btn ghost" style="padding: 4px 10px; font-size: 12px;" onclick="startEditEamSession(${s.id})">Edit</button>
                <button type="button" class="btn ghost" style="padding: 4px 10px; font-size: 12px; color: var(--danger);" onclick="deleteEamSession(${s.id})">Delete</button>
            </td>
        </tr>`;
    }).join('');
    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead><tr><th>Clock In</th><th>Clock Out</th><th>Hours</th><th>Status</th><th>Note</th><th style="text-align:right;">Action</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

function startEditEamSession(id) {
    const row = eamSessions.find(s => s.id === id);
    if (!row) return;
    eamEditingSessionId = id;
    document.getElementById('eam-new-clock-in').value = row.clock_in.replace(' ', 'T').slice(0, 16);
    document.getElementById('eam-new-clock-out').value = row.clock_out ? row.clock_out.replace(' ', 'T').slice(0, 16) : '';
    document.getElementById('eam-new-note').value = row.note || '';
}

async function addEmployeeAttendanceSession(event) {
    event.preventDefault();
    const empId = document.getElementById('eam-employee-id').value;
    const toServerFormat = (val) => val ? val.replace('T', ' ') : '';
    const payload = {
        clock_in: toServerFormat(document.getElementById('eam-new-clock-in').value),
        clock_out: toServerFormat(document.getElementById('eam-new-clock-out').value),
        note: document.getElementById('eam-new-note').value,
    };
    const isEdit = !!eamEditingSessionId;
    const endpoint = isEdit ? `/api/hr/attendance/sessions/${eamEditingSessionId}` : `/api/hr/employees/${empId}/attendance/sessions`;
    try {
        const response = await apiFetch(endpoint, { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        const data = await response.json();
        if (response.ok) {
            showAlert(isEdit ? t('attendance_session_updated', 'Session updated.') : t('attendance_session_added', 'Session added.'), 'success');
            eamEditingSessionId = null;
            document.getElementById('eam-new-clock-in').value = '';
            document.getElementById('eam-new-clock-out').value = '';
            document.getElementById('eam-new-note').value = '';
            loadEmployeeAttendanceModalData();
            fetchHRData();
        } else {
            showAlert(data.error || t('attendance_session_save_failed', 'Failed to save session.'), 'error');
        }
    } catch (error) {
        showAlert(t('attendance_session_save_network_error', 'Network error saving session.'), 'error');
    }
}

async function deleteEamSession(id) {
    if (!confirm(t('confirm_delete_session', 'Delete this session?'))) return;
    try {
        const response = await apiFetch(`/api/hr/attendance/sessions/${id}`, { method: 'DELETE' });
        if (response.ok) {
            loadEmployeeAttendanceModalData();
            fetchHRData();
        }
    } catch (error) {
        showAlert(t('attendance_session_delete_error', 'Error deleting session.'), 'error');
    }
}

function renderEamPermissionsTable() {
    const container = document.getElementById('eam-permissions-container');
    if (!container) return;
    if (!eamPermissions.length) {
        container.innerHTML = '<p style="color: var(--muted); font-size: 12px;">No excused-hours entries.</p>';
        return;
    }
    const rows = eamPermissions.map(p => `
        <tr>
            <td>${p.permission_date}</td>
            <td>${p.start_time} - ${p.end_time}</td>
            <td>${p.credited_hours}h</td>
            <td>${p.reason || ''}</td>
            <td style="text-align: right;"><button type="button" class="btn ghost" style="padding: 4px 10px; font-size: 12px; color: var(--danger);" onclick="deleteEamPermission(${p.id})">Delete</button></td>
        </tr>`).join('');
    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead><tr><th>Date</th><th>Time</th><th>Hours</th><th>Reason</th><th style="text-align:right;">Action</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

async function addEmployeePermission(event) {
    event.preventDefault();
    const empId = document.getElementById('eam-employee-id').value;
    const payload = {
        permission_date: document.getElementById('eam-perm-date').value,
        start_time: document.getElementById('eam-perm-start').value,
        end_time: document.getElementById('eam-perm-end').value,
        reason: document.getElementById('eam-perm-reason').value,
    };
    try {
        const response = await apiFetch(`/api/hr/employees/${empId}/attendance/permissions`, { method: 'POST', body: JSON.stringify(payload) });
        const data = await response.json();
        if (response.ok) {
            showAlert(t('attendance_excused_recorded', 'Excused hours recorded.'), 'success');
            document.getElementById('eam-perm-date').value = '';
            document.getElementById('eam-perm-start').value = '';
            document.getElementById('eam-perm-end').value = '';
            document.getElementById('eam-perm-reason').value = '';
            loadEmployeeAttendanceModalData();
        } else {
            showAlert(data.error || t('attendance_excused_failed', 'Failed to record excused hours.'), 'error');
        }
    } catch (error) {
        showAlert(t('attendance_excused_network_error', 'Network error recording excused hours.'), 'error');
    }
}

async function deleteEamPermission(id) {
    if (!confirm(t('confirm_delete_entry', 'Delete this entry?'))) return;
    try {
        const response = await apiFetch(`/api/hr/attendance/permissions/${id}`, { method: 'DELETE' });
        if (response.ok) loadEmployeeAttendanceModalData();
    } catch (error) {
        showAlert(t('attendance_entry_delete_error', 'Error deleting entry.'), 'error');
    }
}

function renderEamVacationsTable() {
    const container = document.getElementById('eam-vacations-container');
    if (!container) return;
    if (!eamVacations.length) {
        container.innerHTML = `<p style="color: var(--muted); font-size: 12px;">${t('empty_no_vacations', 'No vacations recorded.')}</p>`;
        return;
    }
    const rows = eamVacations.map(v => `
        <tr>
            <td>${v.start_date} → ${v.end_date}</td>
            <td>${v.reason || ''}</td>
            <td style="text-align: right;"><button type="button" class="btn ghost" style="padding: 4px 10px; font-size: 12px; color: var(--danger);" onclick="deleteEamVacation(${v.id})">Delete</button></td>
        </tr>`).join('');
    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead><tr><th>Dates</th><th>Reason</th><th style="text-align:right;">Action</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

async function addEmployeeVacation(event) {
    event.preventDefault();
    const empId = document.getElementById('eam-employee-id').value;
    const payload = {
        start_date: document.getElementById('eam-vac-start').value,
        end_date: document.getElementById('eam-vac-end').value,
        reason: document.getElementById('eam-vac-reason').value,
    };
    try {
        const response = await apiFetch(`/api/hr/employees/${empId}/attendance/vacations`, { method: 'POST', body: JSON.stringify(payload) });
        const data = await response.json();
        if (response.ok) {
            showAlert(t('vacation_added', 'Vacation added.'), 'success');
            document.getElementById('eam-vac-start').value = '';
            document.getElementById('eam-vac-end').value = '';
            document.getElementById('eam-vac-reason').value = '';
            loadEmployeeAttendanceModalData();
            fetchHRData();
        } else {
            showAlert(data.error || t('vacation_add_failed', 'Failed to add vacation.'), 'error');
        }
    } catch (error) {
        showAlert(t('vacation_add_network_error', 'Network error adding vacation.'), 'error');
    }
}

async function deleteEamVacation(id) {
    if (!confirm(t('confirm_delete_vacation', 'Delete this vacation?'))) return;
    try {
        const response = await apiFetch(`/api/hr/attendance/vacations/${id}`, { method: 'DELETE' });
        if (response.ok) {
            loadEmployeeAttendanceModalData();
            fetchHRData();
        }
    } catch (error) {
        showAlert(t('vacation_delete_error', 'Error deleting vacation.'), 'error');
    }
}

// --- Company-wide policy (weekly days off, standard hours/day, holidays) ---
async function fetchAttendanceConfig() {
    try {
        const response = await apiFetch('/api/hr/attendance/config');
        if (!response.ok) return;
        attendanceConfig = await response.json();
        document.querySelectorAll('#att-weekly-days-off input[type="checkbox"]').forEach(cb => {
            cb.checked = attendanceConfig.weekly_days_off.includes(parseInt(cb.value, 10));
        });
        const hoursInput = document.getElementById('att-standard-hours');
        if (hoursInput) hoursInput.value = attendanceConfig.standard_work_hours_per_day;
        renderHolidaysList();
    } catch (error) {
        console.error('Failed to load attendance config', error);
    }
}

function renderHolidaysList() {
    const container = document.getElementById('att-holidays-list');
    if (!container) return;
    if (!attendanceConfig.holidays || !attendanceConfig.holidays.length) {
        container.innerHTML = '<p style="color: var(--muted); font-size: 12px;">No holidays configured.</p>';
        return;
    }
    container.innerHTML = attendanceConfig.holidays.map(h => `
        <span class="pill ghost" style="margin: 3px; display: inline-flex; align-items: center; gap: 6px;">
            ${h.date}${h.name ? ' — ' + h.name : ''}
            <span style="cursor: pointer; color: var(--danger);" onclick="deleteHoliday(${h.id})">✕</span>
        </span>
    `).join('');
}

async function saveAttendanceConfig() {
    const days = Array.from(document.querySelectorAll('#att-weekly-days-off input[type="checkbox"]:checked')).map(cb => parseInt(cb.value, 10));
    const hours = parseFloat(document.getElementById('att-standard-hours').value);
    try {
        const response = await apiFetch('/api/hr/attendance/config', {
            method: 'POST',
            body: JSON.stringify({ weekly_days_off: days, standard_work_hours_per_day: hours }),
        });
        const data = await response.json();
        if (response.ok) {
            showAlert(t('attendance_policy_saved', 'Attendance policy saved.'), 'success');
            fetchAttendanceConfig();
            fetchAttendancePercentageReport();
        } else {
            showAlert(data.error || t('attendance_policy_save_failed', 'Failed to save policy.'), 'error');
        }
    } catch (error) {
        showAlert(t('attendance_policy_network_error', 'Network error saving policy.'), 'error');
    }
}

async function addHoliday() {
    const date = document.getElementById('att-new-holiday-date').value;
    const name = document.getElementById('att-new-holiday-name').value;
    if (!date) { showAlert(t('pick_date_first', 'Pick a date first.'), 'error'); return; }
    try {
        const response = await apiFetch('/api/hr/attendance/holidays', {
            method: 'POST', body: JSON.stringify({ date, name }),
        });
        const data = await response.json();
        if (response.ok) {
            document.getElementById('att-new-holiday-date').value = '';
            document.getElementById('att-new-holiday-name').value = '';
            fetchAttendanceConfig();
            fetchAttendancePercentageReport();
        } else {
            showAlert(data.error || t('holiday_add_failed', 'Failed to add holiday.'), 'error');
        }
    } catch (error) {
        showAlert(t('holiday_add_network_error', 'Network error adding holiday.'), 'error');
    }
}

async function deleteHoliday(id) {
    if (!confirm(t('confirm_remove_holiday', 'Remove this holiday?'))) return;
    try {
        const response = await apiFetch(`/api/hr/attendance/holidays/${id}`, { method: 'DELETE' });
        if (response.ok) {
            fetchAttendanceConfig();
            fetchAttendancePercentageReport();
        }
    } catch (error) {
        showAlert(t('holiday_remove_error', 'Error removing holiday.'), 'error');
    }
}

// --- All-employees percentage report ---
async function fetchAttendancePercentageReport() {
    if (!document.getElementById('att-report-from').value) setAttendanceRangePreset('report', 'month');
    const params = new URLSearchParams(attendanceRangeQuery('report'));
    try {
        const response = await apiFetch(`/api/hr/attendance/percentage?${params.toString()}`);
        if (!response.ok) return;
        renderAttendancePercentageReportTable(await response.json());
    } catch (error) {
        console.error('Failed to load attendance percentage report', error);
    }
}

function renderAttendancePercentageReportTable(report) {
    const container = document.getElementById('att-percentage-report-container');
    if (!container) return;
    if (!report.length) {
        container.innerHTML = `<div class="table-container"><table style="width:100%;"><tr><td style="text-align:center; padding: 20px; color: var(--muted);">${t('empty_no_employees', 'No employees found.')}</td></tr></table></div>`;
        return;
    }
    const rows = report.slice().sort((a, b) => a.percentage - b.percentage).map(r => {
        const pctColor = r.percentage >= 90 ? 'var(--ok)' : (r.percentage >= 70 ? 'var(--warn)' : 'var(--danger)');
        return `
        <tr>
            <td><strong>${r.name}</strong></td>
            <td style="color: var(--muted);">${r.role || ''}</td>
            <td>${r.worked_hours}h</td>
            <td>${r.credited_hours}h</td>
            <td>${r.expected_hours}h</td>
            <td><strong style="color: ${pctColor};">${r.percentage}%</strong></td>
            <td style="text-align: right;"><button type="button" class="btn ghost" style="padding: 4px 10px; font-size: 12px;" onclick="openEmployeeAttendanceModal(${r.employee_id})">Manage</button></td>
        </tr>`;
    }).join('');
    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead>
                    <tr><th>Name</th><th>Role</th><th>Worked</th><th>Credited</th><th>Expected</th><th>%</th><th style="text-align:right;">Action</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// ==========================================
// HR EXCEL IMPORT ENGINE
// ==========================================
async function processHRExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    showAlert(t('excel_reading_hr', 'Reading HR Excel file... Please wait.'), 'info');

    // Helper: Converts Arabic numerals (٤٥٠٠) to English (4500) so JS can read them
    const parseArabicNumbers = (str) => {
        if (!str) return 0;
        const arabicNumbers = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
        let englishStr = String(str).replace(/[٠-٩]/g, w => arabicNumbers.indexOf(w));
        return parseFloat(englishStr.replace(/[^0-9.]/g, '')) || 0;
    };

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array'});
            const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
            
            if (json.length === 0) {
                showAlert(t('excel_sheet_empty', 'The Excel sheet is empty.'), 'warn');
                return;
            }

            let successCount = 0;
            let skippedCount = 0;

            for (let row of json) {
                const cleanRow = {};
                for (let key in row) {
                    let cleanKey = key.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').toLowerCase();
                    cleanRow[cleanKey] = row[key];
                }

                const name = cleanRow["name"] || cleanRow["employeename"] || cleanRow["firstname"] || cleanRow["الاسم"];
                if (!name) continue;

                const role = cleanRow["role"] || cleanRow["position"] || cleanRow["الوظيفة"] || "Lab Technician";
                const status = cleanRow["status"] || cleanRow["الحالة"] || "Active";
                let phone = cleanRow["phone"] || cleanRow["phonenumber"] || cleanRow["رقم"] || "";
                
                // 🚨 Apply the new Arabic number converter to the salary
                let salary = parseArabicNumbers(cleanRow["salary"] || cleanRow["الراتب"]);

                const payload = {
                    name: String(name).trim(),
                    role: String(role).trim(),
                    status: String(status).trim(),
                    phone: String(phone).trim(),
                    salary: salary
                };

                const response = await apiFetch('/api/hr/employees', {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
                
                if (response.ok) {
                    successCount++;
                } else {
                    console.error("Backend rejected row:", await response.text());
                    skippedCount++;
                }
            }

            event.target.value = ''; 

            if (successCount > 0) {
                showAlert(t('hr_import_complete', 'Import complete: {count} employees added.', {count: successCount}), 'success');
            } else if (skippedCount > 0) {
                showAlert(t('hr_import_failed_rows', 'Failed to import {count} rows. Check console.', {count: skippedCount}), 'error');
            }

            await fetchHRData(); 

        } catch (error) {
            console.error("Excel Error:", error);
            showAlert(t('excel_parse_failed', 'Failed to parse Excel file.'), 'error');
        }
    };
    
    reader.readAsArrayBuffer(file);
}

async function initializeApp() {
    setupEventListeners();
    await loadFeatures();
    initializeWorkspaceDropdown();

    await loadTranslations();
    
    await loadInitialData();
    setupUIForRole();
    updateUserInfo();
}

async function loadFeatures() {
    try {
        const response = await apiFetch('/api/features');
        if (response.ok) {
            const features = await response.json();
            const selector = document.getElementById('workspace-selector');
            
            if (selector && features.workspace_switcher === true) {
                selector.style.display = 'block'; 
            }
        }
    } catch (error) {
        console.error('Failed to load features:', error);
    }
}

function setupEventListeners() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            if (tabName) showTab(tabName);
        });
    });

    document.getElementById('total-clients-card')?.addEventListener('click', showTotalClientsDetails);
    document.getElementById('pending-tests-card')?.addEventListener('click', showPendingTestsDetails);
    document.getElementById('completed-today-card')?.addEventListener('click', showCompletedTodayDetails);

    document.getElementById('client-form')?.addEventListener('submit', handleAddClient);
    document.getElementById('lab-config-form')?.addEventListener('submit', handleUpdateLabConfig);

    document.getElementById('client-search')?.addEventListener('keyup', searchClients);
}

// --- DATA & UI ---

async function loadInitialData() {
    try {
        // 1. Fetch everything at once
        const [clientsRes, configRes, testResultsRes, visitsRes] = await Promise.all([
            apiFetch('/api/clients'),
            apiFetch('/api/lab/config'),
            apiFetch('/api/test-results'),
            apiFetch('/api/visits')
        ]);
        if (typeof fetchHRData === 'function') await fetchHRData();
        
        // 2. Safely process fallback data
        const safelyProcess = async (response, name, currentData) => {
            if (response.ok) {
                return await response.json();
            } else if (response.status === 503) {
                console.warn(`[Offline] Skipped ${name} refresh. Using cached data.`);
                return currentData; // Return the exact data we passed in
            } else {
                console.error(`Server error fetching ${name}.`);
                return currentData; 
            }
        };

        // 3. THE FIX: Pass the local variables directly, NOT window.xyz!
        // This prevents JS from accidentally grabbing HTML elements with matching IDs.
        clients = await safelyProcess(clientsRes, 'clients', clients || []);
        labConfig = await safelyProcess(configRes, 'lab config', labConfig || {});
        testResults = await safelyProcess(testResultsRes, 'test results', testResults || []);
        allVisits = await safelyProcess(visitsRes, 'visits', allVisits || []);
        
        // 4. Update the UI
        if (typeof updateUserInfo === 'function') updateUserInfo();
        if (typeof populateSettingsForm === 'function') populateSettingsForm();

        // 5. Fetch transactions
        if (typeof fetchTransactionsData === 'function') {
            await fetchTransactionsData();
        }

        // 6. Refresh whatever's currently on screen, in place (see refreshVisibleTables()).
        refreshVisibleTables();

    } catch (error) {
        console.error('Critical error in loadInitialData:', error);
        showAlert(t('ui_update_failed', 'UI update failed. Check console.'), 'error');
    }
}

// Re-renders whatever tab/drill-down is currently on screen, in place, from already-loaded
// data (clients/allVisits/allTransactions/testResults) — never goes through showTab(), since
// several of its per-tab cases reset transient UI state that has nothing to do with the tab
// itself having changed: resetDashboardView() collapses an open Dashboard drill-down back to
// the default KPI view, loadPendingSamples()/loadTestResults() wipe the search/date filters
// the technician had typed in, and 'add-client' would reset an in-progress new-client form.
// Called after any action whose effect could be visible on more than one tab (booking a
// test, marking samples collected, entering results, bulk actions, ...) so every already-open
// table reflects the change without the user needing to reload the page.
function refreshVisibleTables() {
    // KPI badges (#count-*, #tech-count-*) sit above whichever drill-down/table is showing
    // and read straight from the already-updated globals — cheap and safe to recompute
    // regardless of which tab is actually active.
    if (typeof updateDashboard === 'function') updateDashboard();

    if (currentDashboardTableType && typeof renderDashboardTable === 'function') {
        renderDashboardTable();
    }
    if (document.getElementById('tech-screen')?.classList.contains('active') && typeof renderTechTable === 'function') {
        renderTechTable();
    }
    if (document.getElementById('clients')?.classList.contains('active') && typeof searchClients === 'function') {
        searchClients();
    }
    if (document.getElementById('pending-samples')?.classList.contains('active') && typeof searchPendingSamples === 'function') {
        searchPendingSamples();
    }
    if (document.getElementById('test-results')?.classList.contains('active') && typeof searchTestResults === 'function') {
        searchTestResults();
    }
    if (document.getElementById('client-history')?.classList.contains('active') && typeof loadClientHistory === 'function') {
        loadClientHistory();
    }
    if (document.getElementById('transaction-history')?.classList.contains('active') && typeof filterTransactions === 'function') {
        filterTransactions();
    }
    if (document.getElementById('financial-overview')?.classList.contains('active') && typeof calculateFinancials === 'function') {
        calculateFinancials();
    }
    if (document.getElementById('statistics')?.classList.contains('active') && typeof loadStatistics === 'function') {
        loadStatistics();
    }
}

// Called via window.opener from the "Enter Results" popup (results_entry.js) right after a
// successful save — that page is a separate window with its own JS context, so without this
// the main app's status pills stayed stale until a manual reload. Only /api/visits could have
// changed from that popup, so this re-fetches just that before handing off to
// refreshVisibleTables() for the actual "redraw whatever's on screen" work.
function refreshAfterResultsEntry() {
    apiFetch('/api/visits')
        .then(response => response.ok ? response.json() : null)
        .then(data => {
            if (!data) return;
            allVisits = data;
            refreshVisibleTables();
        })
        .catch(error => console.error('Failed to refresh visits after results entry:', error));
}

// ==========================================
// NOTIFICATIONS SYSTEM
// ==========================================
let notifications = JSON.parse(localStorage.getItem('lab_notifications')) || [];

function addNotification(text, type = 'info') {
    notifications.unshift({ 
        text: text, 
        type: type, 
        date: new Date().toISOString(), 
        read: false 
    });
    
    // Keep only the last 30 notifications to save memory
    if (notifications.length > 30) notifications.pop();
    
    localStorage.setItem('lab_notifications', JSON.stringify(notifications));
    renderNotifications();
}

function renderNotifications() {
    const list = document.getElementById('notifications-list');
    const badge = document.getElementById('notif-badge');
    if (!list || !badge) return;
    
    // 1. Calculate how many are unread
    const unreadCount = notifications.filter(n => !n.read).length;
    
    // 2. Update the red counter badge
    if (unreadCount > 0) {
        badge.style.display = 'inline-block';
        badge.textContent = unreadCount > 99 ? '99+' : unreadCount; // Caps the number at 99+
    } else {
        badge.style.display = 'none';
    }

    // 3. Render the list inside the dropdown
    if (notifications.length === 0) {
        list.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--muted); font-size: 13px;">No new notifications</div>`;
        return;
    }

    list.innerHTML = notifications.map((n) => `
        <div style="padding: 12px 15px; border-bottom: 1px solid var(--border); background: ${n.read ? 'transparent' : 'rgba(92, 189, 185, 0.05)'};">
            <div style="font-size: 13px; margin-bottom: 4px; color: var(--text);">
                ${n.type === 'success' || n.type === 'ok' ? '📈' : '👤'} ${n.text}
            </div>
            <div style="font-size: 11px; color: var(--muted);">${new Date(n.date).toLocaleString()}</div>
        </div>
    `).join('');
}
function toggleNotifications(event) {
    if (event) event.stopPropagation(); // Prevent closing immediately
    const dropdown = document.getElementById('notifications-dropdown');
    
    if (dropdown.style.display === 'none') {
        dropdown.style.display = 'block';
        // Mark all as read when opened
        notifications.forEach(n => n.read = true);
        localStorage.setItem('lab_notifications', JSON.stringify(notifications));
        renderNotifications();
    } else {
        dropdown.style.display = 'none';
    }
}

function clearNotifications() {
    notifications = [];
    localStorage.removeItem('lab_notifications');
    renderNotifications();
}

// Ensure notifications render on page load
document.addEventListener('DOMContentLoaded', renderNotifications);

// Close dropdown if clicking outside
document.addEventListener('click', function(e) {
    const dropdown = document.getElementById('notifications-dropdown');
    if (dropdown && dropdown.style.display === 'block' && !e.target.closest('.action-dropdown')) {
        dropdown.style.display = 'none';
    }
});

function updateUserInfo() {
    const userInfoDiv = document.getElementById('user-info');
    if (currentUser && labConfig && userInfoDiv) {
        userInfoDiv.innerHTML = `<strong>${currentUser.username}</strong> (${currentUser.role})<br>`;
    }
}

async function initApp() {
    await fetchCurrentUser(); 
    
    setupUIForRole();
    
    document.querySelector('.sidebar').style.visibility = 'visible'; 
}

function setupUIForRole() {
    const permissions = currentUser?.permissions ? currentUser.permissions.split(',') : [];
    const allTabs = document.querySelectorAll('.nav-tab');
    let firstAllowedTab = null;
    allTabs.forEach(tab => {
        const tabName = tab.getAttribute('data-tab');

        // Logic: Admins see all, others see only what is permitted
        if (currentUser?.role === 'admin' || currentUser?.role === 'lab_master') {
            tab.style.display = 'block'; // Make visible
            if (!firstAllowedTab) firstAllowedTab = tabName;
        } else if (permissions.includes(tabName)) {
            tab.style.display = 'block'; // Make visible
            if (!firstAllowedTab) firstAllowedTab = tabName;
        } else {
            tab.style.display = 'none'; // Keep hidden
        }
    });
    const dashboardTab = document.querySelector('.nav-tab[data-tab="dashboard"]');
    
    // If the dashboard is hidden for this user, but there is another allowed tab, switch to it immediately
    if (dashboardTab && dashboardTab.style.display === 'none' && firstAllowedTab) {
        showTab(firstAllowedTab);
    }
    console.log("Current Permissions:", permissions)
}
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-mode');
    }
});

// 2. Updated Toggle: Saves to BOTH local storage and database
async function toggleTheme() {
    const isLight = document.body.classList.toggle('light-mode');
    const newTheme = isLight ? 'light' : 'dark';
    
    // Save to local storage for instant feedback on this device
    localStorage.setItem('theme', newTheme);
    
    // Sync to database so other devices get the update on refresh. Its own endpoint since
    // it's a personal preference any logged-in user can set, unlike the rest of
    // /api/lab/settings (admin-only lab branding/security policy).
    try {
        await apiFetch('/api/lab/settings/theme', {
            method: 'POST',
            body: JSON.stringify({ theme: newTheme })
        });
    } catch (error) {
        console.error('Failed to sync theme to database:', error);
    }
}
// if (localStorage.getItem('theme') === 'light') document.body.classList.add('light-mode');

function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));

    const activeContent = document.getElementById(tabName);
    const activeTab = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);

    if (activeContent) activeContent.classList.add('active');
    if (activeTab) activeTab.classList.add('active');

    logTabView(tabName);

    // Switch statement triggers the correct drawing function for the active tab!
    switch(tabName) {
        case 'dashboard': 
            resetDashboardView();
            updateDashboard();
            break;
        case 'add-client':
            if (!editingClientId) resetClientForm();
            break;
        case 'clients': searchClients(); break;
        case 'pending-samples': loadPendingSamples(); break;
        case 'test-results': loadTestResults(); break;
        case 'client-history': loadClientHistory(); break;
        case 'reports': loadReports(); break;
        case 'test-list': loadTestList(); break;
        case 'price-check': renderPriceCheckTests(); break;
        case 'transaction-history': filterTransactions(); fetchTransactionsSummary(); break;
        case 'financial-overview': calculateFinancials(); break;
        case 'warehouse': fetchWarehouseData(); break;
        case 'hr-management': fetchHRData(); break;
        case 'statistics': loadStatistics(); break;
        case 'activity-log': loadActivityLog(); break;
    }
}

// --- DASHBOARD UPDATES ---

let dashTestChartInstance = null;

function updateDashboard() {
    if (!clients || !allVisits) return;
    
    // 1. Calculate and update top KPI badges
    const clientsWithVisits = new Set(allVisits.map(v => v.patient_id));
    const unbookedClients = clients.filter(c => !clientsWithVisits.has(c.id));
    const total = allVisits.length + unbookedClients.length;
    const pending = allVisits.filter(v => v.status === 'pending').length;
    const finished = allVisits.filter(v => v.status === 'collected').length;
    
    const allDemandedTests = allVisits.flatMap(v => v.tests);
    const uniqueTests = new Set(allDemandedTests).size;

    document.getElementById('count-total').textContent = total;
    document.getElementById('count-pending').textContent = pending;
    document.getElementById('count-finished').textContent = finished;
    document.getElementById('count-tests').textContent = uniqueTests;
    const techPending = document.getElementById('tech-count-pending');
    const techFinished = document.getElementById('tech-count-finished');
    if (techPending) techPending.textContent = pending;
    if (techFinished) techFinished.textContent = finished;
    // 2. Populate Latest Registered Clients Table
    const latestClientsList = document.getElementById('latest-clients-list');
    if (latestClientsList) {
        // Sort clients by creation date (newest first) and slice the top 5
        const recentClients = [...clients].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
        
        if (recentClients.length === 0) {
            latestClientsList.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--muted); padding: 20px;">${t('empty_no_clients_registered', 'No clients registered yet.')}</td></tr>`;
        } else {
            latestClientsList.innerHTML = recentClients.map(c => `
                <tr>
                    <td><strong>2024${String(c.id).padStart(4, '0')}</strong></td>
                    <td>${c.first_name} ${c.last_name}</td>
                    <td style="text-align: right;">
                        <button class="btn" style="background: var(--teal); color: #04121d; padding: 6px 12px; font-size: 11px;" onclick="openBookTestModal(${c.id})">
                            ${t('btn_book_test_short', '📋 Book Test')}
                        </button>
                    </td>
                </tr>
            `).join('');
        }
    }

    // 3. Render Most Demanded Tests Bar Chart
    const testCtx = document.getElementById('dashboardTestDemandChart');
    if (testCtx) {
        // Count frequencies of all demanded tests
        const testCounts = {};
        allVisits.forEach(v => {
            if (v.tests && Array.isArray(v.tests)) {
                v.tests.forEach(t => testCounts[t] = (testCounts[t] || 0) + 1);
            }
        });
        
        // Sort them and grab the top 5 most popular
        const sortedTests = Object.entries(testCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

        // Destroy the old chart if it exists so it doesn't glitch when redrawing
        if (dashTestChartInstance) dashTestChartInstance.destroy();

        // Render the new chart using Chart.js
        dashTestChartInstance = new Chart(testCtx, {
            type: 'bar',
            data: {
                labels: sortedTests.map(t => t[0]), // Test names
                datasets: [{
                    label: 'Times Demanded',
                    data: sortedTests.map(t => t[1]), // Test counts
                    backgroundColor: 'rgba(92, 189, 185, 0.8)', // Transparent Teal
                    borderColor: '#5cbdb9',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { 
                        beginAtZero: true, 
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { precision: 0, color: '#8aa6b8' } // Ensures no decimal numbers on the Y axis
                    },
                    x: { 
                        grid: { display: false },
                        ticks: { color: '#8aa6b8' }
                    }
                }
            }
        });
    }
}
// Handles the clicks on the 4 dashboard cards
// --- UPGRADED DASHBOARD TABLE LOGIC ---

// Helper function to quickly load a patient into the edit form
async function quickEditPatient(clientId) {
    await viewClient(clientId); // Fetch data and populate currentClientDetails
    editPatient(); // Move to edit tab
    closePatientDetailsModal(); // Hide modal so user can edit
}
// Helper function to quickly load a patient into the Add/Edit form
async function quickEditPatient(clientId) {
    try {
        // 1. Fetch the data from the backend
        await viewClient(clientId); 
        
        // 2. Set the global editing ID so the form knows it's an update
        editingClientId = clientId;
        
        // 3. Switch to the Add Patient tab
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
        
        document.getElementById('add-client').classList.add('active');
        document.querySelector('.nav-tab[data-tab="add-client"]').classList.add('active');
        
        // 4. Populate the form with the fetched details
        if (currentClientDetails) {
            const form = document.getElementById('client-form');
            Object.keys(currentClientDetails).forEach(key => {
                const input = form.elements[key];
                if (input) {
                    if (input.type === 'date' && currentClientDetails[key]) {
                        input.value = currentClientDetails[key].split('T')[0];
                    } else {
                        input.value = currentClientDetails[key] || '';
                    }
                }
            });
            // Change button text
            const submitBtn = document.querySelector('#client-form button[type="submit"]');
            if (submitBtn) submitBtn.textContent = 'Save Changes';
        }
        
        // Hide the details modal if it's open
        const modal = document.getElementById('patient-details-modal');
        if (modal) modal.style.display = 'none';

    } catch (error) {
        showAlert(t('patient_edit_load_error', 'Error loading patient data for editing.'), 'danger');
    }
}
function showDashboardTable(type) {
    currentDashboardTableType = type;
    dashboardTablePage = 1;

    // 1. Hide the default summary statistics
    const defaultStats = document.getElementById('default-dashboard-stats');
    if (defaultStats) defaultStats.style.display = 'none';

    // 2. Show the table and its controls
    document.getElementById('dashboard-controls').style.display = 'flex';
    document.getElementById('dashboard-table-container').style.display = 'block';
    
    // Reset search inputs if needed
    document.getElementById('dash-search').value = "";
    
    // 3. Render the actual data into the table container
    renderDashboardTable();
    
    // Scroll down to the table smoothly
    document.getElementById('dashboard-controls').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetDashboardView() {
    currentDashboardTableType = null;
    
    // 1. Show the default summary statistics
    const defaultStats = document.getElementById('default-dashboard-stats');
    if (defaultStats) defaultStats.style.display = 'grid'; // .bento uses CSS grid

    // 2. Hide the table and its controls
    document.getElementById('dashboard-controls').style.display = 'none';
    document.getElementById('dashboard-table-container').style.display = 'none';
}

let dashboardTablePage = 1;

async function goToDashboardPage(page) {
    dashboardTablePage = page;
    renderDashboardTable();
}

// Bound to the dashboard search/filter inputs — any change to what's being filtered for
// goes back to page 1, since the current page number may no longer exist in the new result
// set. Pagination clicks go through goToDashboardPage() instead, which doesn't reset it.
function onDashboardFilterChange() {
    dashboardTablePage = 1;
    renderDashboardTable();
}

// The "Pending"/"Finished" drill-downs are plain status-filtered visit lists — paginated
// server-side now (GET /api/visits?status=...). "Total" (which hybrids in never-booked
// clients as placeholder rows) and "Tests" (a small ~20-row aggregate) are left as they
// were, still built from the already-loaded allVisits/clients — see docs/sumV2.md.
async function fetchDashboardVisitsPage(type, searchTerm, filterFrom, filterTo, filterStatus, filterPhysician) {
    const container = document.getElementById('dashboard-table-container');
    const title = type === 'pending' ? t('title_pending_appointments', 'List of Pending Appointments') : t('title_finished_appointments_collected', 'List of Finished (Collected) Appointments');
    const status = filterStatus || (type === 'pending' ? 'pending' : 'collected');

    const params = new URLSearchParams({ page: dashboardTablePage, per_page: 100, status });
    if (searchTerm) params.set('search', searchTerm);
    if (filterFrom) params.set('date_from', filterFrom);
    if (filterTo) params.set('date_to', filterTo);
    if (filterPhysician) params.set('physician', filterPhysician);

    let data = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };
    try {
        const response = await apiFetch(`/api/visits?${params.toString()}`);
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error('Failed to load dashboard table:', error);
    }

    container.innerHTML = buildAdminTableHTML(
        title, [t('th_hash','#'), t('th_date_created','Date Created'), t('th_trans_id','Trans ID'), t('th_patient','Patient'), t('th_phone','Phone'), t('th_physician','Physician'), t('th_tests','Tests'), t('th_status','Status'), t('th_action','Action')],
        data.items || [], type, true, 'dashboard-table-pagination',
        (data.page - 1) * (data.per_page || 100)
    );
    renderPaginationControls('dashboard-table-pagination', data, 'goToDashboardPage');
    applyTranslations(currentLang);
}

function renderDashboardTable() {
    const type = currentDashboardTableType;
    const container = document.getElementById('dashboard-table-container');

    const searchTerm = document.getElementById('dash-search').value.toLowerCase();

    // FIXED: Renamed variables to filterFrom and filterTo so they match the rest of the code!
    const filterFrom = document.getElementById('dash-filter-date-from')?.value || '';
    const filterTo = document.getElementById('dash-filter-date-to')?.value || '';
    // "Unfinished Reports Only" wins over the Status dropdown when checked — it's a
    // dedicated quick-access toggle for partially_delivered visits (the ones showing the
    // red "X/Y" counter badge: some but not all booked tests have results entered).
    const unfinishedOnly = document.getElementById('dash-filter-unfinished')?.checked || false;
    const filterStatus = unfinishedOnly ? 'partially_delivered' : document.getElementById('dash-filter-status').value;
    const filterPhysician = document.getElementById('dash-filter-physician')?.value.trim() || '';

    if (type === 'pending' || type === 'finished') {
        fetchDashboardVisitsPage(type, searchTerm, filterFrom, filterTo, filterStatus, filterPhysician);
        return;
    }

    let title = "";
    let html = "";

    if (type === 'total') {
        title = t('title_all_appointments', 'List of All Appointments');

        // Create hybrid list of new unbooked patients to inject into the "Total" table
        const clientsWithVisits = new Set(allVisits.map(v => v.patient_id));
        const unbookedClients = clients.filter(c => !clientsWithVisits.has(c.id)).map(c => ({
            is_unbooked: true,
            patient_id: c.id,
            date: c.created_at ? formatCairoDateTime(c.created_at) : 'N/A',
            visit_id: `2024${String(c.id).padStart(4, '0')}`,
            patient_name: `${c.first_name} ${c.last_name}`,
            phone: c.phone || 'N/A',
            physician_name: '',
            tests: ['None'], // Placeholder so the table doesn't break
            status: 'registered'
        }));

        let filteredData = [...allVisits, ...unbookedClients];

        // Filter by Date (Now filterFrom and filterTo exist!)
        if (filterFrom || filterTo) {
            filteredData = filteredData.filter(v => isDateInRange(v.date, filterFrom, filterTo));
        }

        // Filter by Status
        if (filterStatus) {
            filteredData = filteredData.filter(v => v.status === filterStatus);
        }

        // Filter by Physician
        if (filterPhysician) {
            filteredData = filteredData.filter(v => (v.physician_name || '').toLowerCase().includes(filterPhysician.toLowerCase()));
        }

        // Search
        if (searchTerm) {
            filteredData = filteredData.filter(v => {
                return v.visit_id.includes(searchTerm) ||
                       v.patient_name.toLowerCase().includes(searchTerm) ||
                       (v.phone && v.phone.includes(searchTerm));
            });
        }

        // Sort newest to oldest
        filteredData.sort((a, b) => new Date(b.date) - new Date(a.date));

        // "Total" mixes real visits with never-booked clients as placeholder rows, so it
        // can't reuse the same server-side ?page= pagination the other drill-downs use —
        // it's still built from the already-loaded allVisits/clients. But it can still be
        // *rendered* one page at a time instead of dumping potentially thousands of rows
        // into the DOM at once, with the same Prev/Next controls as everywhere else.
        const perPage = 100;
        const totalCount = filteredData.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
        dashboardTablePage = Math.min(Math.max(1, dashboardTablePage), totalPages);
        const startIndex = (dashboardTablePage - 1) * perPage;
        const pageData = filteredData.slice(startIndex, startIndex + perPage);

        html = buildAdminTableHTML(
            title, [t('th_hash','#'), t('th_date_created','Date Created'), t('th_trans_id','Trans ID'), t('th_patient','Patient'), t('th_phone','Phone'), t('th_physician','Physician'), t('th_tests','Tests'), t('th_status','Status'), t('th_action','Action')],
            pageData, type, true, 'dashboard-table-pagination', startIndex
        );
        container.innerHTML = html;
        renderPaginationControls('dashboard-table-pagination', {
            page: dashboardTablePage, per_page: perPage, total_pages: totalPages, total: totalCount,
        }, 'goToDashboardPage');
        applyTranslations(currentLang);
        return;
    }
    else if (type === 'tests') {
        title = t('title_ordered_tests', 'List of Ordered Tests');
        
        const testSummary = {};
        allVisits.forEach(v => {
            
            // UPDATED: Now uses filterFrom and filterTo consistently here as well
            if (filterFrom || filterTo) {
                if (!v.date) return; 
                const rowDate = v.date.split(' ')[0]; // Extract YYYY-MM-DD
                if (filterFrom && rowDate < filterFrom) return; 
                if (filterTo && rowDate > filterTo) return; 
            }
            
            v.tests.forEach(tName => {
                if (!testSummary[tName]) testSummary[tName] = { total: 0, pending: 0, collected: 0 };
                testSummary[tName].total++;
                if (v.status === 'pending') testSummary[tName].pending++;
                if (v.status === 'collected' || v.status === 'partially_delivered' || v.status === 'results_delivered_by_link') testSummary[tName].collected++;
            });
        });
        
        let testDataArray = Object.keys(testSummary).map((key, index) => ({
            id: index + 1,
            name: key,
            pending: testSummary[key].pending,
            collected: testSummary[key].collected,
            total: testSummary[key].total
        }));
        
        if (searchTerm) {
            testDataArray = testDataArray.filter(t => t.name.toLowerCase().includes(searchTerm));
        }

        html = buildAdminTableHTML(title, [t('th_hash','#'), t('th_test_name','Test Name'), t('th_pending_samples','Pending Samples'), t('th_collected_samples','Collected Samples'), t('th_total_demanded','Total Demanded')], testDataArray, type);
    }

    container.innerHTML = html;
    applyTranslations(currentLang);
}

// Notice the critical 'fileIndex = 0' parameter!
function printPDFReport(visitId, fileIndex = 0) {
    const visit = allVisits.find(v => v.visit_id === visitId);

    if (!visit || !visit.report_url) {
        showAlert(t('no_results_report_yet', 'Error: No results report generated yet!'), 'error');
        return;
    }

    // 1. Split the comma-separated string from the database
    const reportUrls = visit.report_url.split(',').filter(url => url.trim() !== '');

    // 2. Use the exact fileIndex sent from the dropdown button you clicked
    const safeIndex = (fileIndex >= 0 && fileIndex < reportUrls.length) ? fileIndex : 0;
    
    // Grab that specific file's URL
    let finalUrl = reportUrls[safeIndex].trim();

    // Ensure absolute routing
    if (!finalUrl.startsWith('/')) {
        finalUrl = '/' + finalUrl;
    }

    // 3. THE CACHE BUSTER: Force the browser to treat this as a brand-new file
    // By adding a unique timestamp, Firefox/Chrome cannot use the old cached PDF!
    const cacheBusterUrl = finalUrl + "?t=" + new Date().getTime();

    showAlert(t('sending_to_printer', 'Sending Document to printer...'), 'info');

    // 4. PRINTING ENGINE
    // If you are using Print.js:
    if (typeof printJS !== 'undefined') {
        printJS({
            printable: cacheBusterUrl,
            type: 'pdf',
            showModal: true 
        });
    } else {
        // If you are NOT using Print.js, fallback to the hidden iframe trick
        let printIframe = document.getElementById('hidden-pdf-printer');
        
        // Destroy the old iframe completely so memory is cleared
        if (printIframe) {
            printIframe.remove();
        }

        // Build a fresh one
        printIframe = document.createElement('iframe');
        printIframe.id = 'hidden-pdf-printer';
        printIframe.style.visibility = 'hidden';
        printIframe.style.position = 'absolute';
        printIframe.style.width = '0px';
        printIframe.style.height = '0px';
        printIframe.style.border = 'none';
        document.body.appendChild(printIframe);

        // Set the source to our fresh, cache-busted URL
        printIframe.src = cacheBusterUrl;

        printIframe.onload = function() {
            try {
                printIframe.contentWindow.focus();
                printIframe.contentWindow.print();
            } catch (error) {
                console.error("Browser blocked background printing:", error);
                window.open(cacheBusterUrl, '_blank');
            }
        };
    }
}

function buildAdminTableHTML(title, headers, data, type, clickable = false, paginationContainerId = null, startIndex = 0) {
    // Aggregate rows (type 'tests' — one row per test name, not per visit) have nothing
    // to individually delete; every other row is a real visit/order, selectable for bulk
    // delete via DELETE /api/visits/<id> (see handleBulkDeleteVisits()).
    const selectable = type !== 'tests';
    let thead = (selectable ? `<th style="width: 32px;"><input type="checkbox" onclick="toggleAllVisitCheckboxes(this)"></th>` : '')
        + headers.map(h => `<th>${h}</th>`).join('');
    let tbody = "";

    if (data.length === 0) {
        tbody = `<tr><td colspan="${headers.length + (selectable ? 1 : 0)}" style="text-align:center; padding: 20px; color: var(--muted);">${t('no_entries_match_filters', 'No entries match your filters.')}</td></tr>`;
    } else {
        data.forEach((row, index) => {
            console.log("Row Data:", row);
            if (type === 'tests') {
                tbody += `
                    <tr>
                        <td>${startIndex + index + 1}</td>
                        <td><strong>${row.name}</strong></td>
                        <td><span class="pill ghost">${t('pill_pending_count', '{count} Pending', {count: row.pending})}</span></td>
                        <td><span class="pill ok">${t('pill_collected_count', '{count} Collected', {count: row.collected})}</span></td>
                        <td><strong>${row.total}</strong></td>
                    </tr>
                `;
            } else {
                // Determine Badge Status
                let pillClass = 'ghost';
                let badgeText = t('status_pending_badge', 'Pending');
                let countBadge = ''; // small red "done/total" counter, only set for partially_delivered

                if (row.status === 'registered') {
                    pillClass = 'info';
                    badgeText = t('status_registered', 'Registered');
                } else if (row.status === 'pending') {
                    pillClass = 'danger'; // Red
                    badgeText = t('status_pending_badge', 'Pending');
                } else if (row.status === 'collected') {
                    pillClass = 'ok'; // Green
                    badgeText = t('status_waiting_results', 'Waiting for Results');
                } else if (row.status === 'partially_delivered') {
                    pillClass = 'info'; // Blue
                    badgeText = (row.completed_tests && row.completed_tests.length)
                        ? t('status_delivered_suffix', '{tests} Delivered', {tests: row.completed_tests.join(', ')})
                        : t('status_partially_delivered', 'Partially Delivered');
                    const totalCount = row.tests ? row.tests.length : 0;
                    const doneCount = row.completed_tests ? row.completed_tests.length : 0;
                    countBadge = `<span style="position: absolute; top: -8px; right: -10px; background: var(--danger); color: white; border-radius: 50%; padding: 1px 5px; font-size: 9px; font-weight: bold; min-width: 14px; text-align: center; line-height: 1.4; box-shadow: 0 1px 3px rgba(0,0,0,0.4);">${doneCount}/${totalCount}</span>`;
                } else if (row.status === 'results_delivered_by_link') {
                    pillClass = 'info'; // Blue
                    badgeText = t('status_delivered', 'Delivered');
                }

                let actionBtn = '';
                if (row.status === 'registered') {
                    // Restores the blue Book Test button for newly added patients
                    actionBtn = `<button class="btn" style="background: var(--teal); color: #04121d;" onclick="openBookTestModal(${row.patient_id})">${t('btn_order_now', 'Order Now')}</button>`;
                } else if (row.status === 'collected') {
                    actionBtn = `
                        <div class="action-dropdown" style="position: relative; display: inline-block;">
                            <button class="btn ghost">${t('action_menu_label', 'Action ▾')}</button>
                            <div class="action-dropdown-content" style="display: none; position: absolute; right: 0; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px; z-index: 100; min-width: 160px;">
                                <button onclick="openBookTestModal(${row.patient_id})">${t('btn_new_order', '📋 New Order')}</button>
                                <button onclick="window.open('/results-entry/${row.id}', 'EnterResults', 'width=1000,height=800,resizable=yes,scrollbars=yes')">${t('btn_enter_results', '🧪 Enter Results')}</button>
                                <button onclick="openUploadModal('${row.visit_id}', '${row.patient_id}', '${row.patient_name}')">${t('btn_upload_pdf_report', '📤 Upload PDF Report')}</button>
                                <button onclick="quickEditPatient(${row.patient_id})">${t('btn_edit_patient', '✏️ Edit Patient')}</button>
                            </div>
                        </div>
                    `;
                } else if (row.status === 'results_delivered_by_link') {
                    // UPDATED: Added the Upload PDF button to the delivered status dropdown
                    actionBtn = `
                        <div class="action-dropdown" style="position: relative; display: inline-block;">
                            <button class="btn ghost">${t('action_menu_label', 'Action ▾')}</button>
                            <div class="action-dropdown-content" style="display: none; position: absolute; right: 0; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px; z-index: 100; min-width: 160px;">
                                <button onclick="printPDFReport('${row.visit_id}')">${t('btn_print_report', '🖨️ Print Report')}</button>
                                <button onclick="openUploadModal('${row.visit_id}', '${row.patient_id}', '${row.patient_name}')">${t('btn_upload_additional_pdf', '📤 Upload Additional PDF')}</button>
                                <button onclick="openBookTestModal(${row.patient_id})">${t('btn_new_order', '📋 New Order')}</button>
                                <button onclick="quickEditPatient(${row.patient_id})">${t('btn_edit_patient', '✏️ Edit Patient')}</button>
                            </div>
                        </div>
                    `;
                } else if (row.status === 'partially_delivered') {
                    actionBtn = `
                        <div class="action-dropdown" style="position: relative; display: inline-block;">
                            <button class="btn ghost">${t('action_menu_label', 'Action ▾')}</button>
                            <div class="action-dropdown-content" style="display: none; position: absolute; right: 0; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px; z-index: 100; min-width: 160px;">
                                <button onclick="printPDFReport('${row.visit_id}')">${t('btn_print_report', '🖨️ Print Report')}</button>
                                <button onclick="window.open('/results-entry/${row.id}', 'EnterResults', 'width=1000,height=800,resizable=yes,scrollbars=yes')">${t('btn_enter_results', '🧪 Enter Results')}</button>
                                <button onclick="openUploadModal('${row.visit_id}', '${row.patient_id}', '${row.patient_name}')">${t('btn_upload_pdf_report', '📤 Upload PDF Report')}</button>
                                <button onclick="openBookTestModal(${row.patient_id})">${t('btn_new_order', '📋 New Order')}</button>
                                <button onclick="quickEditPatient(${row.patient_id})">${t('btn_edit_patient', '✏️ Edit Patient')}</button>
                            </div>
                        </div>
                    `;
                } else if (row.status === 'pending') {
                    actionBtn = `
        <button class="btn ghost" style="border-color: var(--warn); color: var(--warn);"
                onclick="markSampleCollected('${row.visit_id}')">
            ${t('btn_collect_sample', '🧪 Collect Sample')}
        </button>
    `;
} else if (row.status === 'collected') {
    // Stage 2: The row is collected, show "Upload"
    actionBtn = `
        <button class="btn" style="background: var(--teal); color: #04121d;"
                onclick="openUploadModal('${row.visit_id}', '${row.patient_id}', '${row.patient_name}')">
            ${t('btn_upload_report', '📤 Upload Report')}
        </button>
    `;
                }

                // Row itself is only clickable on the Dashboard's KPI tables (clickable=true),
                // and only for rows tied to a real visit (registered/unbooked rows have no
                // results to show yet). The row's onclick ignores clicks that land inside the
                // action cell (class "no-row-click") instead of stopping propagation there —
                // the Action ▾ dropdown is opened by a document-level click listener elsewhere
                // in this file, so the click still needs to bubble all the way up.
                const rowIsClickable = clickable && row.id && row.status !== 'registered';
                const rowAttrs = rowIsClickable
                    ? `onclick="if (!event.target.closest('.no-row-click')) openVisitResultsModal(${row.id})" style="cursor: pointer;" title="${t('title_view_results', 'View results')}"`
                    : '';

                tbody += `
                    <tr ${rowAttrs}>
                        <td class="no-row-click">${row.id ? `<input type="checkbox" class="visit-checkbox" data-id="${row.id}" onchange="updateBulkDeleteVisitsButton()">` : ''}</td>
                        <td>${startIndex + index + 1}</td>
                        <td style="color: var(--muted);">${formatCairoDateTime(row.date, false)}</td>
                        <td><strong>${row.visit_id}</strong></td>
                        <td>${row.patient_name}</td>
                        <td style="color: var(--muted);">${row.phone || 'N/A'}</td>
                        <td style="color: var(--muted);">${row.physician_name && row.physician_name !== 'Self' ? row.physician_name : '-'}</td>
                        <td>${row.tests.join(', ')}</td>
                        <td style="text-align: center;"><span style="position: relative; display: inline-block;"><span class="pill ${pillClass}">${badgeText}</span>${countBadge}</span></td>
                        <td class="no-row-click" style="text-align: right;">${actionBtn}</td>
                    </tr>
                `;
            }
        });
    }

    const safeFilename = typeof title === 'string' ? title.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'dashboard';

    return `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h3 style="margin: 0; color: var(--text);">${title}</h3>
            ${selectable ? `<button class="btn btn-danger bulk-delete-visits-btn" style="display: none; padding: 6px 12px; font-size: 12px; margin-left: auto; margin-right: 8px;" onclick="handleBulkDeleteVisits()">🗑️ <span data-i18n="actions.delete_selected">Delete Selected</span></button>` : ''}
            <button class="btn ghost" style="border-color: var(--ok); color: var(--ok); padding: 6px 12px; font-size: 12px; display: flex; align-items: center; gap: 6px;"
                onclick="exportTableToExcel(this, '${safeFilename}_report')">
                📥 <span data-i18n="actions.export_excel">Export to Excel</span>
            </button>
        </div>
        <div class="table-container">
            <table>
                <thead><tr>${thead}</tr></thead>
                <tbody>${tbody}</tbody>
            </table>
        </div>
        ${paginationContainerId ? `<div id="${paginationContainerId}"></div>` : ''}
    `;
}

// Shared by every buildAdminTableHTML() consumer (Dashboard drill-downs, Tech Screen,
// Pending Samples) — global .visit-checkbox lookups rather than scoping to one container,
// since only one of these tables is ever visible at a time (same convention already used
// for .client-checkbox/.test-checkbox/.warehouse-checkbox elsewhere in this file). Multiple
// "Delete Selected" buttons can exist in the DOM at once (one per rendered instance) even
// though only one is visible — updated by class, not id, to avoid duplicate-id collisions.
function toggleAllVisitCheckboxes(masterCheckbox) {
    document.querySelectorAll('.visit-checkbox').forEach(cb => { cb.checked = masterCheckbox.checked; });
    updateBulkDeleteVisitsButton();
}

function updateBulkDeleteVisitsButton() {
    const anyChecked = document.querySelectorAll('.visit-checkbox:checked').length > 0;
    document.querySelectorAll('.bulk-delete-visits-btn').forEach(btn => {
        btn.style.display = anyChecked ? 'inline-block' : 'none';
    });
}

async function handleBulkDeleteVisits() {
    const ids = Array.from(document.querySelectorAll('.visit-checkbox:checked')).map(cb => cb.dataset.id);
    if (ids.length === 0) return;
    if (!confirm(t('confirm_delete_visits', 'Delete {count} order(s)/visit(s)? This cannot be undone. Any payment already recorded for them is not affected.', {count: ids.length}))) return;

    let succeeded = 0;
    const failures = [];
    for (const id of ids) {
        try {
            const response = await apiFetch(`/api/visits/${id}`, { method: 'DELETE' });
            if (response.ok) {
                succeeded++;
            } else {
                const body = await response.json().catch(() => ({}));
                failures.push(`#${id}: ${body.error || response.status}`);
            }
        } catch (error) {
            failures.push(`#${id}: ${error.message}`);
        }
    }

    if (failures.length === 0) {
        showAlert(t('visits_deleted', 'Deleted {count} order(s)/visit(s).', {count: succeeded}), 'success');
    } else if (succeeded === 0) {
        showAlert(t('visits_delete_error', 'Error deleting orders/visits: {msg}', {msg: failures.join('; ')}), 'error');
    } else {
        showAlert(t('visits_delete_partial', 'Deleted {ok}; {failed} failed: {msg}', {ok: succeeded, failed: failures.length, msg: failures.join('; ')}), 'warn');
    }

    // Whichever screen is active re-renders its own table with fresh data — matches
    // each caller's own existing refresh-after-action pattern.
    await loadInitialData();
    if (currentDashboardTableType) renderDashboardTable();
    if (document.getElementById('tech-screen')?.classList.contains('active') && currentTechTableType) renderTechTable();
    if (document.getElementById('pending-samples')?.classList.contains('active')) fetchPendingSamplesPage();
}

// --- CLIENT MANAGEMENT ---

// --- PATIENT DIRECTORY LOGIC ---

let clientsPage = 1;

function searchClients() {
    clientsPage = 1; // any filter/search change goes back to page 1
    fetchClientsPage();
}

function goToClientsPage(page) {
    clientsPage = page;
    fetchClientsPage();
}

// Filtering and pagination happen server-side now (GET /api/clients?...) instead of
// slicing/re-rendering the entire clients array on every keystroke. The `clients` global
// stays fully loaded separately (loadInitialData()) for the booking modal's patient picker
// and other lookups that need the complete list — this only changes what this ONE table
// displays.
async function fetchClientsPage() {
    const searchTerm = document.getElementById('client-search').value;
    const filterFrom = document.getElementById('client-filter-date-from').value;
    const filterTo = document.getElementById('client-filter-date-to').value;
    const filterGender = document.getElementById('client-filter-gender').value;
    const filterStatus = document.getElementById('client-filter-status').value;

    const params = new URLSearchParams({ page: clientsPage, per_page: 100 });
    if (searchTerm) params.set('search', searchTerm);
    if (filterFrom) params.set('date_from', filterFrom);
    if (filterTo) params.set('date_to', filterTo);
    if (filterGender) params.set('gender', filterGender);
    if (filterStatus) params.set('status', filterStatus);

    let data = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };
    try {
        const response = await apiFetch(`/api/clients?${params.toString()}`);
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error('Failed to load clients:', error);
    }

    const emptyStateDiv = document.getElementById('search-empty-state');
    if (emptyStateDiv) {
        emptyStateDiv.style.display = (data.items || []).length === 0 ? 'block' : 'none';
    }

    displayClients(data.items || []);
    renderPaginationControls('clients-pagination', data, 'goToClientsPage');
}

function displayClients(clientsToDisplay) {
    const tableBody = document.getElementById('clients-table-body');
    if (!tableBody) return;

    if (clientsToDisplay.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--muted); padding: 30px;">${t('empty_no_patients_filtered', 'No patients found matching your filters.')}</td></tr>`;
        return;
    }

    tableBody.innerHTML = clientsToDisplay.map(c => {
        // Format Date and Code
        const dateStr = c.created_at ? formatCairoDateTime(c.created_at, false) : 'N/A';
        const codeStr = `2024${String(c.id).padStart(4, '0')}`;
        
        // --- FIXED STATUS LOGIC ---
        let pillClass = 'ghost';
        let statusText = t('status_registered', 'Registered');

        // 1. Check if they have tests assigned (this is what happens after a successful transaction)
        if (c.test_type && c.test_type.trim() !== '') {
            if (c.sample_status === 'pending') {
                pillClass = 'danger'; // Yellow
                statusText = t('status_pending_badge', 'Pending');
            } else if (c.sample_status === 'collected') {
                pillClass = 'ok';   // Green
                statusText = t('status_sample_collected', 'Sample Collected');
            }
        } else {
            // 2. Default state if no tests are assigned
            pillClass = 'info';
            statusText = t('status_registered', 'Registered');
        }

        return `
        <tr>
            <td><input type="checkbox" class="client-checkbox" data-id="${c.id}" onchange="updateBulkDeleteButton()"></td>
            <td><strong>${codeStr}</strong></td>
            <td style="color: var(--muted)">${dateStr}</td>
            <td>${c.first_name} ${c.last_name}</td>
            <td><span class="pill ghost">${c.gender}</span></td>
            <td style="color: var(--muted)">${c.phone || 'N/A'}</td>
            <td><span class="pill ${pillClass}">${statusText}</span></td>
            <td style="text-align: right;">
                <button class="btn ghost" style="padding: 6px 12px; font-size: 12px;" onclick="viewClient(${c.id})">Review Profile</button>
            </td>
        </tr>
    `}).join('');
}

function viewClient(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client) {
        showAlert(t('client_not_found', 'Client not found'), 'error');
        return;
    }
    
    currentClientDetails = client;
    editingClientId = client.id;
    showTab('add-client');
    
    // Populate form with client data
    document.getElementById('first-name').value = client.first_name;
    document.getElementById('last-name').value = client.last_name;
    document.getElementById('date-of-birth').value = client.date_of_birth;
    document.getElementById('gender').value = client.gender;
    document.getElementById('contact-person').value = client.contact_person;
    document.getElementById('phone').value = client.phone;
    document.getElementById('client-phone').value = client.client_phone || '';
    document.getElementById('blood-type').value = client.blood_type || '';
    document.getElementById('city').value = client.city || '';
    document.getElementById('area').value = client.area || '';
    document.getElementById('street').value = client.street || '';
    document.getElementById('apartment').value = client.apartment || '';
    document.getElementById('allergies').value = client.allergies || '';
    document.getElementById('clinical-indications').value = client.clinical_indications || '';
    
    const submitBtn = document.querySelector('#client-form button[type="submit"]');
    if (submitBtn) {
        submitBtn.textContent = '💾 Save Changes';
        submitBtn.className = 'btn btn-success';
    }
}

function resetClientForm() {
    document.getElementById('client-form').reset();
    editingClientId = null;
    currentClientDetails = null;
    
    const submitBtn = document.querySelector('#client-form button[type="submit"]');
    if (submitBtn) {
        submitBtn.textContent = 'Add Client';
        submitBtn.className = 'btn btn-primary';
    }
}

async function handleAddClient(e) {
    e.preventDefault();
    
    const formData = new FormData(document.getElementById('client-form'));
    const data = Object.fromEntries(formData);

    
    try {
        const endpoint = editingClientId ? `/api/clients/${editingClientId}` : '/api/clients';
        const method = editingClientId ? 'PUT' : 'POST';
        
        const response = await apiFetch(endpoint, {
            method: method,
            body: JSON.stringify(data),
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            showAlert(editingClientId ? t('client_updated', 'Client updated successfully!') : t('client_added', 'Client added successfully!'), 'success');
            if (!editingClientId) {
                addNotification(t('new_patient_added', 'New patient added: {name}', {name: `${data.first_name} ${data.last_name}`}), 'info');
            }
            resetClientForm();
            await loadInitialData();
            showTab('clients');
        } else {
            const error = await response.json();
            showAlert(error.error || t('client_save_failed', 'Failed to save client'), 'error');
        }
    } catch (error) {
        showAlert(t('client_save_error', 'Error saving client: {msg}', {msg: error.message}), 'error');
    }
}

// --- OTHER TABS (CONVERTED TO TABLES) ---

function loadPendingSamples() {
    // Clear filters when entering tab
    if(document.getElementById('pending-search')) document.getElementById('pending-search').value = "";
    if(document.getElementById('pending-filter-date-from')) document.getElementById('pending-filter-date-from').value = ""; // NEW
    if(document.getElementById('pending-filter-date-to')) document.getElementById('pending-filter-date-to').value = "";
    
    searchPendingSamples();
}

function loadTestResults() {
    // Clear the search and filters when entering the tab
    if(document.getElementById('results-search')) document.getElementById('results-search').value = "";
    if(document.getElementById('results-filter-date-from')) document.getElementById('results-filter-date-from').value = "";
    if(document.getElementById('results-filter-date-to')) document.getElementById('results-filter-date-to').value = "";
    if(document.getElementById('results-filter-gender')) document.getElementById('results-filter-gender').value = "";
    
    // Trigger the search builder
    searchTestResults();
}

function loadClientHistory() {
    const listDiv = document.getElementById('client-history-list');
    if (clients.length === 0) {
        listDiv.innerHTML = `<p style="color: var(--muted);">${t('empty_no_history', 'No history available.')}</p>`;
        return;
    }
    
    let rows = clients.map(c => `
        <tr>
            <td><strong>2024${String(c.id).padStart(4, '0')}</strong></td>
            <td>${c.first_name} ${c.last_name}</td>
            <td style="color: var(--muted)">${c.date_of_birth}</td>
            <td><span class="pill info">${c.status || 'Active'}</span></td>
            <td style="color: var(--muted)">${formatCairoDateTime(c.updated_at, false).split(' ')[0]}</td>
            <td style="text-align: right;"><button class="btn ghost" onclick="viewClient(${c.id})">View Record</button></td>
        </tr>
    `).join('');

    listDiv.innerHTML = `<div class="table-container"><table><thead><tr><th>Code</th><th>Patient</th><th>DOB</th><th>Status</th><th>Last Updated</th><th style="text-align:right;">Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function loadReports() {
    // Clear filters when entering the tab
    if(document.getElementById('report-search')) document.getElementById('report-search').value = "";
    if(document.getElementById('report-filter-date-from')) document.getElementById('report-filter-date-from').value = ""; // NEW
    if(document.getElementById('report-filter-date-to')) document.getElementById('report-filter-date-to').value = "";
    if(document.getElementById('report-filter-gender')) document.getElementById('report-filter-gender').value = "";
    
    searchReports();
}

async function downloadLabReport(clientId) {
    try {
        const response = await apiFetch(`/api/clients/${clientId}/lab-report`, {
            method: 'GET'
        });
        
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lab_report_${clientId}.pdf`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } else {
            showAlert(t('report_download_failed', 'Failed to download report'), 'error');
        }
    } catch (error) {
        showAlert(t('report_download_error', 'Error downloading report: {msg}', {msg: error.message}), 'error');
    }
}

// Dedicated render function for the Tech Screen
let currentTechTableType = null;
let techTablePage = 1;

function showTechTable(type) {
    currentTechTableType = type;
    techTablePage = 1; // switching table goes back to page 1
    renderTechTable();
}

function goToTechTablePage(page) {
    techTablePage = page;
    renderTechTable();
}

// Tech Screen tables are built from the already-loaded allVisits array (like the
// Dashboard's "Total" view), so pagination here is a client-side slice rather than a
// server-side ?page= fetch — 20 rows at a time with the same Prev/Next controls as
// everywhere else in the app.
function renderTechTable() {
    const type = currentTechTableType;
    const container = document.getElementById('tech-table-container');
    if (!type || !container) return;

    // 1. Set the title based on the button clicked
    let title = type === 'pending' ? 'Samples Waiting For Collection' : 'Collected (Waiting for Reports)';

    // 2. Filter the visits based on the requested status
    let filteredData = [];
    if (type === 'pending') {
        filteredData = allVisits.filter(v => v.status === 'pending');
    } else if (type === 'finished') {
        filteredData = allVisits.filter(v => v.status === 'collected');
    }

    // 3. Sort from newest to oldest
    filteredData.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 4. Slice to the current 20-row page
    const perPage = 20;
    const totalCount = filteredData.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    techTablePage = Math.min(Math.max(1, techTablePage), totalPages);
    const startIndex = (techTablePage - 1) * perPage;
    const pageData = filteredData.slice(startIndex, startIndex + perPage);

    // 5. Use your existing table builder to draw the UI inside the Tech Screen!
    container.innerHTML = buildAdminTableHTML(
        title,
        [t('th_hash','#'), t('th_date_created','Date Created'), t('th_trans_id','Trans ID'), t('th_patient','Patient'), t('th_phone','Phone'), t('th_physician','Physician'), t('th_tests','Tests'), t('th_status','Status'), t('th_action','Action')],
        pageData, type, false, 'tech-table-pagination', startIndex
    );
    renderPaginationControls('tech-table-pagination', {
        page: techTablePage, per_page: perPage, total_pages: totalPages, total: totalCount,
    }, 'goToTechTablePage');
    applyTranslations(currentLang);
}

async function markSampleCollected(visitId) {
    try {
        const response = await apiFetch(`/api/visits/${visitId}/collect`, {
            method: 'PUT'
        });
        
        if (!response.ok) throw new Error("Failed to update sample status.");

        // ========================================================
        // 🚨 UNCONDITIONAL OPTIMISTIC UI UPDATE 🚨
        // Always push to the UI instantly, regardless of connection!
        // ========================================================
        
        if (typeof allVisits !== 'undefined') {
            // 1. Find the exact visit in our local array
            const visitIndex = allVisits.findIndex(v => String(v.visit_id) === String(visitId));
            
            if (visitIndex !== -1) {
                // 2. Change its status to collected locally!
                allVisits[visitIndex].status = 'collected';
                
                // 3. Keep the Patient Directory in sync too
                if (typeof clients !== 'undefined') {
                    const patientId = allVisits[visitIndex].patient_id;
                    const patientIndex = clients.findIndex(c => c.id === patientId);
                    if (patientIndex !== -1) {
                        clients[patientIndex].sample_status = 'collected'
                    }
                }
            }
        }
        // ========================================================

        showAlert(t('sample_collected', 'Sample marked as collected!'), 'success');
        
        // 4. Redraw the data using our artificially updated arrays
        if (typeof loadInitialData === 'function') await loadInitialData(); 
        if (typeof showDashboardTable === 'function' && currentDashboardTableType) {
            showDashboardTable(currentDashboardTableType);
        }
        
    } catch (error) {
        console.error("Collection Error:", error);
        showAlert(t('sample_db_error', 'Database error while updating sample.'), 'error');
    }
}

function populateSettingsForm(settings) {
    if (!settings) return;
    
    // Safely loop through any settings data coming from your Python backend
    Object.keys(settings).forEach(key => {
        const inputElement = document.getElementById(key);
        
        // ONLY try to set the value if the element actually exists in the HTML
        if (inputElement) {
            inputElement.value = settings[key];
        }
    });
}

async function handleUpdateLabConfig(e) {
    e.preventDefault();
    
    const formData = new FormData(document.getElementById('lab-config-form'));
    const data = Object.fromEntries(formData);
    
    try {
        const response = await apiFetch('/api/lab/config', {
            method: 'PUT',
            body: JSON.stringify(data),
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            showAlert(t('lab_config_updated', 'Lab configuration updated successfully!'), 'success');
            await loadInitialData();
        } else {
            showAlert(t('lab_config_update_failed', 'Failed to update configuration'), 'error');
        }
    } catch (error) {
        showAlert(t('generic_error_prefix', 'Error: {msg}', {msg: error.message}), 'error');
    }
}

function updateBulkDeleteButton() {
    const checkboxes = document.querySelectorAll('.client-checkbox:checked');
    const btn = document.getElementById('bulk-delete-btn');
    if (btn) {
        btn.style.display = checkboxes.length > 0 ? 'block' : 'none';
    }
}

function toggleSelectAll(checkbox) {
    document.querySelectorAll('.client-checkbox').forEach(cb => {
        cb.checked = checkbox.checked;
    });
    updateBulkDeleteButton();
}

async function handleBulkDelete() {
    const checkboxes = document.querySelectorAll('.client-checkbox:checked');
    const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
    
    if (ids.length === 0) return;
    
    if (!confirm(t('confirm_delete_clients', 'Delete {count} client(s)? This cannot be undone.', {count: ids.length}))) return;
    
    // Each DELETE is checked individually — apiFetch() never throws for a non-2xx response
    // (only for an actual network failure), so blindly awaiting it without checking .ok
    // is exactly how this used to report "deleted successfully" while a client that still
    // had booked visits silently failed server-side (FK constraint) and stayed put.
    let succeeded = 0;
    const failures = [];
    for (const id of ids) {
        try {
            const response = await apiFetch(`/api/clients/${id}`, { method: 'DELETE' });
            if (response.ok) {
                succeeded++;
            } else {
                const body = await response.json().catch(() => ({}));
                failures.push(`#${id}: ${body.error || response.status}`);
            }
        } catch (error) {
            failures.push(`#${id}: ${error.message}`);
        }
    }

    if (failures.length === 0) {
        showAlert(t('clients_deleted', 'Clients deleted successfully!'), 'success');
    } else if (succeeded === 0) {
        showAlert(t('clients_delete_error', 'Error deleting clients: {msg}', {msg: failures.join('; ')}), 'error');
    } else {
        showAlert(t('clients_delete_partial', 'Deleted {ok} client(s); {failed} failed: {msg}', {ok: succeeded, failed: failures.length, msg: failures.join('; ')}), 'warn');
    }
    await loadInitialData();
    displayClients(clients);
}

async function logout(isPolicyTriggered = false) {
    if (isLoggingOut && !isPolicyTriggered) return;
    isLoggingOut = true;

    try {
        // Only send "offline" if it's a manual user logout
        if (!isPolicyTriggered && currentUser && currentUser.username) {
            await fetch('/api/auth/presence', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'offline', username: currentUser.username })
            });
        }
        
        // Destroys the backend session cookie
        await fetch('/api/auth/logout', { method: 'POST' });
        
    } catch (err) {
        console.error("Logout cleanup failed, proceeding to redirect.");
    }

    // Redirect to login
    window.location.replace('/login');
}

function showAlert(message, type) {
    const container = document.getElementById('alert-container');
    const alertDiv = document.createElement('div');
    alertDiv.style.cssText = `
        padding: 15px;
        margin-bottom: 10px;
        border-radius: 8px;
        background: ${type === 'success' ? '#d1fae5' : '#fee2e2'};
        border: 1px solid ${type === 'success' ? '#6ee7b7' : '#fca5a5'};
        color: ${type === 'success' ? '#065f46' : '#7f1d1d'};
        animation: slideIn 0.3s ease-out;
    `;
    alertDiv.textContent = message;
    
    container.appendChild(alertDiv);
    
    setTimeout(() => {
        alertDiv.remove();
    }, 5000);
}

function performDailyReset() {
    if (confirm(t('confirm_daily_reset', 'Are you sure you want to perform a daily reset? This will reset sample statuses.'))) {
        showAlert(t('daily_reset_done', 'Daily reset performed'), 'success');
        // Implementation would go here
    }
}

// Search functions
let pendingSamplesPage = 1;

function searchPendingSamples() {
    pendingSamplesPage = 1; // any filter/search change goes back to page 1
    fetchPendingSamplesPage();
}

function goToPendingSamplesPage(page) {
    pendingSamplesPage = page;
    fetchPendingSamplesPage();
}

// Filtering and pagination happen server-side now (GET /api/visits?status=pending&...)
// instead of slicing/re-rendering the entire allVisits array on every keystroke.
async function fetchPendingSamplesPage() {
    const searchTerm = document.getElementById('pending-search').value;
    const filterFrom = document.getElementById('pending-filter-date-from').value;
    const filterTo = document.getElementById('pending-filter-date-to').value;

    const params = new URLSearchParams({ page: pendingSamplesPage, per_page: 100, status: 'pending' });
    if (searchTerm) params.set('search', searchTerm);
    if (filterFrom) params.set('date_from', filterFrom);
    if (filterTo) params.set('date_to', filterTo);

    let data = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };
    try {
        const response = await apiFetch(`/api/visits?${params.toString()}`);
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error('Failed to load pending samples:', error);
    }

    const listDiv = document.getElementById('pending-samples-list');
    listDiv.innerHTML = buildAdminTableHTML(
        t('title_pending_appointments', 'List of Pending Appointments'),
        [t('th_hash','#'), t('th_date_created','Date Created'), t('th_code','Code'), t('th_patient','Patient'), t('th_phone','Phone'), t('th_physician','Physician'), t('th_test','Test'), t('th_status','Status'), t('th_action','Action')],
        data.items || [],
        'pending', // This tells the builder to use the "Collect Sample" buttons
        false,
        'pending-samples-pagination',
        (data.page - 1) * (data.per_page || 100)
    );
    renderPaginationControls('pending-samples-pagination', data, 'goToPendingSamplesPage');
    applyTranslations(currentLang);
}

// Track checkbox changes to show/hide the bulk button
function updateBulkFinishButton() {
    const checkboxes = document.querySelectorAll('.pending-checkbox:checked');
    document.getElementById('finish-samples-btn').style.display = checkboxes.length > 0 ? 'block' : 'none';
}

// Logic to mark multiple visits as finished
async function handleBulkFinish() {
    const checkboxes = document.querySelectorAll('.pending-checkbox:checked');
    const visitIds = Array.from(checkboxes).map(cb => cb.dataset.visitId);

    if (!confirm(t('confirm_mark_finished', 'Mark {count} sample(s) as finished?', {count: visitIds.length}))) return;

    try {
        for (const visitId of visitIds) {
            // Update the status on the backend
            await apiFetch(`/api/visits/${visitId}/collect`, { method: 'PUT' });
        }
        
        showAlert(t('samples_finished', 'Samples marked as finished!'), 'success');
        
        // Refresh the list to remove the finished items from the tab
        await loadInitialData();
        searchPendingSamples(); 
    } catch (error) {
        showAlert(t('samples_update_error', 'Error updating samples.'), 'error');
    }
}
// --- PDF GENERATOR WORKFLOW ---
async function downloadClientHistoryPDF(clientId) {
    try {
        showAlert(t('pdf_generating', 'Generating PDF report. Please wait...'), 'info');
        
        // This calls the specific client PDF route in your backend
        const response = await fetch(`/api/clients/${clientId}/report`, { 
            method: 'POST',
            headers: {
                'X-App-Mode': currentWorkspace
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to generate PDF from server.');
        }
        
        // Convert response to a blob and trigger browser download
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a'); 
        a.href = url; 
        
        // Name the file dynamically based on the client ID
        a.download = `patient_2024${String(clientId).padStart(4, '0')}_history.pdf`;
        
        document.body.appendChild(a); 
        a.click(); 
        window.URL.revokeObjectURL(url);
        
        showAlert(t('report_downloaded', 'Report downloaded successfully!'), 'success');
        
    } catch (error) { 
        console.error(error);
        showAlert(t('pdf_generate_error', 'Error generating PDF report.'), 'error'); 
    }
}

let testResultsPage = 1;

function searchTestResults() {
    testResultsPage = 1; // any filter/search change goes back to page 1
    fetchTestResultsPage();
}

function goToTestResultsPage(page) {
    testResultsPage = page;
    fetchTestResultsPage();
}

// Filtering and pagination happen server-side now (GET /api/visits?status=... &gender=...)
// instead of slicing/re-rendering the entire allVisits array on every keystroke.
async function fetchTestResultsPage() {
    const searchTerm = document.getElementById('results-search').value;
    const filterFrom = document.getElementById('results-filter-date-from').value;
    const filterTo = document.getElementById('results-filter-date-to').value;
    const filterGender = document.getElementById('results-filter-gender').value;

    const params = new URLSearchParams({
        page: testResultsPage, per_page: 100, status: 'results_delivered_by_link',
    });
    if (searchTerm) params.set('search', searchTerm);
    if (filterFrom) params.set('date_from', filterFrom);
    if (filterTo) params.set('date_to', filterTo);
    if (filterGender) params.set('gender', filterGender);

    let data = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };
    try {
        const response = await apiFetch(`/api/visits?${params.toString()}`);
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error('Failed to load test results:', error);
    }

    const listDiv = document.getElementById('test-results-list');
    const filtered = data.items || [];

    if (filtered.length === 0) {
        listDiv.innerHTML = '<div class="table-container"><table style="width:100%;"><tr><td style="text-align:center; padding: 30px; color: var(--muted);">No delivered results match your filters.</td></tr></table></div>';
        return;
    }

    const startIndex = (data.page - 1) * (data.per_page || 100);
    let rows = filtered.map((v, index) => {
        const patientCode = `2024${String(v.patient_id).padStart(4, '0')}`;

        return `
        <tr>
            <td>${startIndex + index + 1}</td>
            <td><strong>${patientCode}</strong></td>
            <td style="color: var(--muted);">${formatCairoDateTime(v.date, false)}</td>
            <td>${v.patient_name}</td>
            <td style="color: var(--muted);">${v.phone || 'N/A'}</td>
            <td>${v.tests.join(', ')}</td>
            <td style="text-align: right;">
                <button class="btn ghost" style="border-color: var(--ok); color: var(--ok);" onclick="printPDFReport('${v.visit_id}')">🖨️ Print PDF</button>
            </td>
        </tr>
        `;
    }).join('');

    listDiv.innerHTML = `
    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Patient ID</th>
                    <th>Date & Time</th>
                    <th>Patient Name</th>
                    <th>Phone Number</th>
                    <th>Tests Included</th>
                    <th style="text-align: right;">Action</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
    <div id="test-results-pagination"></div>`;

    renderPaginationControls('test-results-pagination', data, 'goToTestResultsPage');
}

function searchClientHistory() {
    const searchTerm = document.getElementById('history-search').value.toLowerCase();
    const filtered = clients.filter(c =>
        c.first_name.toLowerCase().includes(searchTerm) ||
        c.last_name.toLowerCase().includes(searchTerm) ||
        c.phone.includes(searchTerm)
    );
    
    const listDiv = document.getElementById('client-history-list');
    
    if (filtered.length === 0) {
        listDiv.innerHTML = '<p style="color: var(--muted); padding: 20px;">No history records match your filters.</p>';
        return;
    }

    // Generate the Card Layout instead of the Table
    listDiv.innerHTML = filtered.map(c => `
        <div class="history-record-card card" style="margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; padding: 20px; border: 1px solid var(--border);">
            <div>
                <strong style="font-size: 16px; color: var(--text);">${c.first_name} ${c.last_name}</strong> 
                <span style="color: var(--muted)">(Code: 2024${String(c.id).padStart(4, '0')})</span><br>
                <small style="color: var(--muted); display: inline-block; margin-top: 6px;">DOB: ${c.date_of_birth} | Phone: ${c.phone || 'N/A'}</small><br>
                <small style="color: var(--muted); display: inline-block; margin-top: 4px;">Status: ${c.status || 'Active'} | Last Updated: ${formatCairoDateTime(c.updated_at, false).split(' ')[0]}</small>
            </div>
            
            <div>
                <button type="button" class="btn" style="background: var(--teal); color: #04121d; position: relative; z-index: 10;" 
                    onclick="event.preventDefault(); event.stopPropagation(); downloadClientHistoryPDF(${c.id}); return false;">
                    📄 View Record
                </button>
            </div>
        </div>
    `).join('');
}

// --- PDF GENERATOR WORKFLOW ---
async function downloadClientHistoryPDF(clientId) {
    try {
        showAlert(t('pdf_generating', 'Generating PDF report. Please wait...'), 'info');
        
        const response = await fetch(`/api/clients/${clientId}/report`, { 
            method: 'GET',
            headers: { 'X-App-Mode': currentWorkspace }
        });
        
        if (!response.ok) throw new Error('Failed to generate PDF');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a'); 
        a.href = url; 
        a.download = `patient_2024${String(clientId).padStart(4, '0')}_history.pdf`;
        document.body.appendChild(a); 
        a.click(); 
        window.URL.revokeObjectURL(url);
        
        showAlert(t('report_downloaded', 'Report downloaded successfully!'), 'success');
    } catch (error) { 
        console.error(error);
        showAlert(t('pdf_generate_error', 'Error generating PDF report.'), 'error'); 
    }
}

function searchReports() {
    const searchTerm = document.getElementById('report-search').value.toLowerCase();
    const filterFrom = document.getElementById('report-filter-date-from').value; // NEW
    const filterTo = document.getElementById('report-filter-date-to').value;
    const filterGender = document.getElementById('report-filter-gender').value;

    let filtered = clients;

    // 1. Filter by Registration Date
    if (filterFrom || filterTo) {
        filtered = filtered.filter(c => isDateInRange(c.created_at, filterFrom, filterTo));
    }

    // 2. Filter by Gender
    if (filterGender) {
        filtered = filtered.filter(c => c.gender === filterGender);
    }

    // 3. Search by Code, ID, Name, or Phone
    if (searchTerm) {
        filtered = filtered.filter(c => {
            const codeStr = `2024${String(c.id).padStart(4, '0')}`;
            return c.id.toString().includes(searchTerm) || 
                   codeStr.includes(searchTerm) ||
                   `${c.first_name} ${c.last_name}`.toLowerCase().includes(searchTerm) || 
                   (c.phone && c.phone.includes(searchTerm));
        });
    }

    // 4. Sort newest first
    filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const listDiv = document.getElementById('reports-list');
    
    if (filtered.length === 0) {
        listDiv.innerHTML = '<div class="table-container"><table style="width:100%;"><tr><td style="text-align:center; padding: 30px; color: var(--muted);">No patients match your filters.</td></tr></table></div>';
        return;
    }

    // 5. Generate the Master Table
    let rows = filtered.map((c, index) => {
        const dateStr = c.created_at ? formatCairoDateTime(c.created_at, false) : 'N/A';
        const codeStr = `2024${String(c.id).padStart(4, '0')}`;
        const patientName = `${c.first_name} ${c.last_name}`.toUpperCase();
        
        // Find all visits for this specific patient
        const patientVisits = allVisits.filter(v => v.patient_id === c.id);
        
        // Calculate Latest Status
        let latestStatus = 'registered';
        if (patientVisits.length > 0) {
            // Sort visits by date (newest first) to grab the most recent status
            patientVisits.sort((a, b) => new Date(b.date) - new Date(a.date));
            latestStatus = patientVisits[0].status;
        }
        
        let pillClass = 'info';
        let badgeText = t('status_registered', 'Registered');

        if (latestStatus === 'pending') {
            pillClass = 'danger'; // Red
            badgeText = t('status_pending_badge', 'Pending');
        } else if (latestStatus === 'collected') {
            pillClass = 'warn'; // Yellow/Orange
            badgeText = t('status_processing', 'Processing');
        } else if (latestStatus === 'partially_delivered') {
            pillClass = 'info'; // Blue
            badgeText = t('status_partially_delivered', 'Partially Delivered');
        } else if (latestStatus === 'results_delivered_by_link') {
            pillClass = 'ok'; // Green
            badgeText = t('status_results_delivered', 'Results Delivered');
        }

        return `
        <tr>
            <td><strong>${codeStr}</strong></td>
            <td>${patientName}</td>
            <td style="color: var(--muted);">${dateStr}</td>
            <td style="color: var(--muted);">${c.phone || 'N/A'}</td>
            <td><span class="pill ghost">${c.gender}</span></td>
            <td><span class="pill ${pillClass}">${badgeText}</span></td>
            <td style="text-align: right;">
                <button class="btn ghost" style="border-color: var(--teal); color: var(--teal);" onclick="openPatientHistoryModal(${c.id})">
                    🔍 View Details
                </button>
            </td>
        </tr>
        `;
    }).join('');

    listDiv.innerHTML = `
    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th>Patient ID</th>
                    <th>Name</th>
                    <th>Date Registered</th>
                    <th>Phone</th>
                    <th>Gender</th>
                    <th>Latest Status</th>
                    <th style="text-align: right;">Action</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

// ==========================================
// PATIENT HISTORY MODAL LOGIC
// ==========================================

function openPatientHistoryModal(clientId) {
    // 1. Get Patient Details
    const patient = clients.find(c => c.id === clientId);
    if (!patient) return;

    document.getElementById('history-modal-title').textContent = `${patient.first_name} ${patient.last_name}`;
    document.getElementById('history-modal-subtitle').textContent = `Patient ID: 2024${String(patient.id).padStart(4, '0')} | Phone: ${patient.phone || 'N/A'} | Blood Type: ${patient.blood_type || 'N/A'}`;

    // 2. Get all visits for this patient
    let patientVisits = allVisits.filter(v => v.patient_id === clientId);
    
    // Sort visits by date (newest first)
    patientVisits.sort((a, b) => new Date(b.date) - new Date(a.date));

    const container = document.getElementById('history-modal-table-container');

    if (patientVisits.length === 0) {
        container.innerHTML = `<div style="text-align: center; padding: 30px; color: var(--muted); background: rgba(0,0,0,0.2); border-radius: 8px;">${t('empty_no_visits_recorded', 'No laboratory visits recorded for this patient yet.')}</div>`;
    } else {
        // 3. Generate the history table
        let rows = patientVisits.map(v => {
            let pillClass = 'danger';
            let badgeText = t('status_pending_badge', 'Pending');
            let countBadge = '';

            if (v.status === 'collected') {
                pillClass = 'warn';
                badgeText = t('status_processing', 'Processing');
            } else if (v.status === 'partially_delivered') {
                pillClass = 'info';
                badgeText = (v.completed_tests && v.completed_tests.length)
                    ? t('status_delivered_suffix', '{tests} Delivered', {tests: v.completed_tests.join(', ')})
                    : t('status_partially_delivered', 'Partially Delivered');
                const totalCount = v.tests ? v.tests.length : 0;
                const doneCount = v.completed_tests ? v.completed_tests.length : 0;
                countBadge = `<span style="position: absolute; top: -8px; right: -10px; background: var(--danger); color: white; border-radius: 50%; padding: 1px 5px; font-size: 9px; font-weight: bold; min-width: 14px; text-align: center; line-height: 1.4; box-shadow: 0 1px 3px rgba(0,0,0,0.4);">${doneCount}/${totalCount}</span>`;
            } else if (v.status === 'results_delivered_by_link') {
                pillClass = 'ok';
                badgeText = t('status_delivered', 'Delivered');
            }

            // --- THE NEW MULTI-FILE PRINT LOGIC ---
            let actionBtn = `<span style="color: var(--muted); font-size: 11px;">${t('status_awaiting_results', 'Awaiting Results')}</span>`;

            if ((v.status === 'results_delivered_by_link' || v.status === 'partially_delivered') && v.report_url) {
                // Split the comma-separated URLs
                const urls = v.report_url.split(',').filter(url => url.trim() !== '');

                if (urls.length === 1) {
                    // Single File
                    actionBtn = `<button class="btn ghost" style="color: var(--ok); border-color: var(--ok); padding: 4px 10px; font-size: 12px;" onclick="printPDFReport('${v.visit_id}', 0)">🖨️ Print PDF</button>`;
                } else if (urls.length > 1) {
                    // Multiple Files Dropdown
                    let dropdownItems = urls.map((url, idx) => {
                        
                        // 1. Get the raw filename from the URL
                        let fileName = url.split('/').pop();
                        fileName = decodeURIComponent(fileName);
                        
                        // 2. Slice off everything before the actual file name
                        let visitIdIndex = fileName.indexOf(v.visit_id);
                        if (visitIdIndex !== -1) {
                            // Find the exact underscore right after the visit ID
                            let slicePoint = fileName.indexOf('_', visitIdIndex);
                            if (slicePoint !== -1) {
                                fileName = fileName.substring(slicePoint + 1);
                            }
                        }

                        // 3. Failsafe: If the slice somehow results in a blank name, just show the full messy URL string so it's never empty
                        if (!fileName || fileName.trim() === '') {
                            fileName = url.split('/').pop(); 
                        }
                        
                        // Truncate super long names so the dropdown stays neat
                        let displayTitle = fileName;
                        if (displayTitle.length > 30) displayTitle = displayTitle.substring(0, 27) + '...';

                        return `<button onclick="printPDFReport('${v.visit_id}', ${idx})" title="${fileName}" style="width: 100%; text-align: left; padding: 8px 12px; background: transparent; border: none; color: var(--text); border-bottom: 1px solid var(--border); cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">🖨️ ${displayTitle}</button>`;
                    }).join('');

                    actionBtn = `
                        <div class="action-dropdown" style="position: relative; display: inline-block;">
                            <button class="btn ghost" style="color: var(--ok); border-color: var(--ok); padding: 4px 10px; font-size: 12px;">🖨️ Print PDFs ▾</button>
                            <div class="action-dropdown-content" style="display: none; position: absolute; right: 0; top: 100%; margin-top: 5px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; z-index: 100; min-width: 200px; box-shadow: var(--shadow); overflow: hidden;">
                                ${dropdownItems}
                            </div>
                        </div>
                    `;
                }
            }

            return `
            <tr>
                <td style="color: var(--muted);">${formatCairoDateTime(v.date, false)}</td>
                <td><strong>${v.visit_id}</strong></td>
                <td>${v.tests.join('<br>')}</td>
                <td><span style="position: relative; display: inline-block;"><span class="pill ${pillClass}">${badgeText}</span>${countBadge}</span></td>
                <td style="text-align: right;">${actionBtn}</td>
            </tr>
            `;
        }).join('');

        container.innerHTML = `
        <div class="table-container">
            <table style="width: 100%; font-size: 13px;">
                <thead>
                    <tr>
                        <th>Date & Time</th>
                        <th>Visit Code</th>
                        <th>Tests Performed</th>
                        <th>Status</th>
                        <th style="text-align: right;">Report</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    document.getElementById('patient-history-modal').style.display = 'block';
}

function closePatientHistoryModal() {
    document.getElementById('patient-history-modal').style.display = 'none';
}

// ==========================================
// VISIT RESULTS MODAL — click a record in the Dashboard's tables to see its booked
// tests as expandable cards, each with a Parameter/Result/Status table.
// ==========================================

function openVisitResultsModal(visitId) {
    const modal = document.getElementById('visit-results-modal');
    modal.style.display = 'block';
    document.getElementById('vr-modal-title').textContent = 'Loading...';
    document.getElementById('vr-modal-subtitle').textContent = '';
    document.getElementById('vr-charts-container').innerHTML = '';
    document.getElementById('vr-modal-body').innerHTML = '';
    destroyVrCharts();

    apiFetch(`/api/visits/${visitId}/results-view`)
        .then(response => response.json())
        .then(data => {
            renderVisitResultsModal(data);
            if (data.patient_id) loadVisitResultsHistoryCharts(data.patient_id);
        })
        .catch(error => {
            document.getElementById('vr-modal-title').textContent = 'Error loading results';
            console.error('Failed to load visit results:', error);
        });
}

function closeVisitResultsModal() {
    destroyVrCharts();
    document.getElementById('visit-results-modal').style.display = 'none';
}

function renderVisitResultsModal(data) {
    if (data.error) {
        document.getElementById('vr-modal-title').textContent = data.error;
        return;
    }

    document.getElementById('vr-modal-title').textContent = `${data.patient_name} — ${data.visit_code}`;
    document.getElementById('vr-modal-subtitle').textContent = data.date || '';

    const body = document.getElementById('vr-modal-body');
    if (!data.tests || !data.tests.length) {
        body.innerHTML = `<div style="text-align: center; padding: 30px; color: var(--muted); background: rgba(0,0,0,0.2); border-radius: 8px;">${t('empty_no_tests_booked_visit', 'No tests booked for this visit.')}</div>`;
        return;
    }

    body.innerHTML = data.tests.map(test => {
        const rows = test.parameters.length ? test.parameters.map(p => `
            <tr>
                <td>
                    ${p.name}
                    ${p.method ? `<div style="font-size: 11px; color: var(--muted);">${p.method}</div>` : ''}
                </td>
                <td>${p.result_value || '-'}</td>
                <td style="color: var(--muted);">${p.unit || '-'}</td>
                <td style="color: var(--muted);">${p.reference_range_text || '-'}</td>
                <td>${resultStatusPill(p.status)}</td>
            </tr>
        `).join('') : `<tr><td colspan="5" style="text-align: center; color: var(--muted);">${t('empty_no_parameters_defined', 'No parameters defined for this test.')}</td></tr>`;

        const isDelivered = test.status === 'delivered';
        return `
            <div class="card" style="margin-bottom: 12px; padding: 0; overflow: hidden;">
                <div onclick="const b=this.nextElementSibling; b.style.display = b.style.display === 'block' ? 'none' : 'block';"
                     style="padding: 14px 18px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: 600; color: var(--text);">
                    <span>🧪 ${test.test_name}</span>
                    <span style="display: flex; align-items: center; gap: 10px;">
                        <span class="pill ${isDelivered ? 'ok' : 'danger'}">${isDelivered ? t('status_delivered', 'Delivered') : t('status_pending_badge', 'Pending')}</span>
                        <button class="btn ghost" style="padding: 4px 10px; font-size: 11px;" onclick="event.stopPropagation(); printTestBarcode('${data.visit_code}', '${(data.patient_name || '').replace(/'/g, "\\'")}', '${(test.sample_type || '').replace(/'/g, "\\'")}')">🏷️ ${t('btn_print_barcode', 'Print Barcode')}</button>
                        <span style="color: var(--muted);">▾</span>
                    </span>
                </div>
                <div style="display: none;">
                    <table>
                        <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Ref. Range</th><th>Status</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }).join('');
}

function resultStatusPill(status) {
    const map = {
        high: ['danger', t('status_high', 'High')],
        low: ['warn', t('status_low', 'Low')],
        normal: ['ok', t('status_normal', 'Normal')],
        abnormal: ['danger', t('status_abnormal', 'Abnormal')],
        entered: ['info', t('status_entered', 'Entered')],
        pending: ['ghost', t('status_pending_pill', 'Pending')],
    };
    const [pillClass, text] = map[status] || ['ghost', status || 'Pending'];
    return `<span class="pill ${pillClass}">${text}</span>`;
}

// --- Patient test-history trend charts (shown above the test cards, before any card is expanded) ---

let vrChartInstances = [];

function destroyVrCharts() {
    vrChartInstances.forEach(c => c.destroy());
    vrChartInstances = [];
}

async function loadVisitResultsHistoryCharts(patientId) {
    try {
        const response = await apiFetch(`/api/clients/${patientId}/test-history`);
        const data = response.ok ? await response.json() : { tests: [] };
        renderVisitResultsHistoryCharts(data.tests || []);
    } catch (error) {
        console.error('Failed to load patient test history:', error);
        renderVisitResultsHistoryCharts([]);
    }
}

const VR_CHART_COLORS = ['#5cbdb9', '#e8c07a', '#ef6b6b', '#7ce0c2', '#f4b860', '#2d8a9e', '#a78bfa', '#f472b6'];

function renderVisitResultsHistoryCharts(tests) {
    const container = document.getElementById('vr-charts-container');
    destroyVrCharts();

    if (!tests.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <h3 style="color: var(--text); margin-bottom: 15px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">📈 Patient History Trends</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; margin-bottom: 24px;">
            ${tests.map((t, i) => `
                <div class="card" style="padding: 16px;">
                    <div style="font-weight: 600; color: var(--text); margin-bottom: 8px;">${t.test_name}</div>
                    <div style="height: 220px;"><canvas id="vr-chart-${i}"></canvas></div>
                </div>
            `).join('')}
        </div>
    `;

    tests.forEach((t, i) => {
        const canvas = document.getElementById(`vr-chart-${i}`);
        if (!canvas) return;
        vrChartInstances.push(new Chart(canvas, {
            type: 'line',
            data: {
                labels: t.labels.map(d => formatCairoDateTime(d, false)),
                datasets: t.series.map((s, idx) => ({
                    label: s.unit ? `${s.name} (${s.unit})` : s.name,
                    data: s.data,
                    borderColor: VR_CHART_COLORS[idx % VR_CHART_COLORS.length],
                    backgroundColor: VR_CHART_COLORS[idx % VR_CHART_COLORS.length],
                    spanGaps: true,
                    tension: 0.3,
                    pointRadius: 3,
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#8aa6b8', boxWidth: 10, font: { size: 10 } } },
                },
                scales: {
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8aa6b8' } },
                    x: { grid: { display: false }, ticks: { color: '#8aa6b8' } },
                },
            },
        }));
    });
}

// ==========================================
// STATISTICS TAB — flattened per-parameter results across every visit, filterable by
// date range / gender / High-Low status, for use in reporting/analytics.
// ==========================================

let statsPage = 1;
let statsPagination = { page: 1, per_page: 100, total_pages: 1, total: 0 };

async function loadStatistics() {
    statsPage = 1;
    await fetchStatisticsPage();
}

function searchStatistics() {
    statsPage = 1; // any filter change goes back to page 1
    fetchStatisticsPage();
}

function goToStatisticsPage(page) {
    statsPage = page;
    fetchStatisticsPage();
}

// Filtering (date/gender/status/search) and pagination both happen server-side now — see
// GET /api/statistics/test-results — instead of loading all 27k+ rows and filtering/
// re-rendering them in the DOM on every keystroke.
async function fetchStatisticsPage() {
    const searchTerm = document.getElementById('stats-search')?.value || '';
    const filterFrom = document.getElementById('stats-filter-date-from')?.value || '';
    const filterTo = document.getElementById('stats-filter-date-to')?.value || '';
    const filterGender = document.getElementById('stats-filter-gender')?.value || '';
    const filterStatus = document.getElementById('stats-filter-status')?.value || '';
    const filterPhysician = document.getElementById('stats-filter-physician')?.value.trim() || '';

    const params = new URLSearchParams({ page: statsPage, per_page: 100 });
    if (searchTerm) params.set('search', searchTerm);
    if (filterFrom) params.set('date_from', filterFrom);
    if (filterTo) params.set('date_to', filterTo);
    if (filterGender) params.set('gender', filterGender);
    if (filterStatus) params.set('status', filterStatus);
    if (filterPhysician) params.set('physician', filterPhysician);

    let data = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };
    try {
        const response = await apiFetch(`/api/statistics/test-results?${params.toString()}`);
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error('Failed to load statistics:', error);
    }

    statsPagination = data;
    renderStatisticsTable(data.items || []);
    renderPaginationControls('statistics-pagination', data, 'goToStatisticsPage');
}

function renderStatisticsTable(rows) {
    const listDiv = document.getElementById('statistics-list');
    if (!listDiv) return;

    if (!rows.length) {
        listDiv.innerHTML = '<div class="table-container"><table style="width:100%;"><tr><td style="text-align:center; padding: 30px; color: var(--muted);">No results match your filters.</td></tr></table></div>';
        return;
    }

    const startIndex = (statsPagination.page - 1) * (statsPagination.per_page || 100);
    const tableRows = rows.map((r, index) => `
        <tr>
            <td>${startIndex + index + 1}</td>
            <td style="color: var(--muted);">${formatCairoDateTime(r.date, false)}</td>
            <td>${r.patient_name || 'N/A'}</td>
            <td><span class="pill ghost">${r.gender || '-'}</span></td>
            <td style="color: var(--muted);">${r.physician_name && r.physician_name !== 'Self' ? r.physician_name : '-'}</td>
            <td>${r.test_name || ''}</td>
            <td>${r.parameter_name || ''}</td>
            <td>${r.result_value || ''} ${r.unit || ''}</td>
            <td style="color: var(--muted);">${r.reference_range || '-'}</td>
            <td>${resultStatusPill(r.status)}</td>
        </tr>
    `).join('');

    listDiv.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h3 style="margin: 0; color: var(--text);" data-i18n="stats.title">Test Results Statistics</h3>
            <button class="btn ghost" style="border-color: var(--ok); color: var(--ok); padding: 6px 12px; font-size: 12px; display: flex; align-items: center; gap: 6px;"
                onclick="exportTableToExcel(this, 'statistics_report')">
                📥 <span data-i18n="actions.export_excel">Export to Excel</span>
            </button>
        </div>
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>#</th><th>Date</th><th>Patient</th><th>Gender</th><th>Physician</th><th>Test</th>
                        <th>Parameter</th><th>Result</th><th>Ref. Range</th><th>Status</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
        <div id="statistics-pagination"></div>
    `;
}

function showTotalClientsDetails() {
    // Implementation for showing total clients details
}

function showPendingTestsDetails() {
    // Implementation for showing pending tests details
}

function showCompletedTodayDetails() {
    // Implementation for showing completed today details
}

// ==========================================
// TEST BOOKING & SAMPLE COLLECTION WORKFLOW
// ==========================================

let currentDashboardTableType = null; // Tracks which table is currently open
let currentBookingClientId = null;

// Track the active table whenever a dashboard button is clicked
const originalShowDashboardTable = showDashboardTable;
showDashboardTable = function(type) {
    currentDashboardTableType = type;
    originalShowDashboardTable(type);
};

window.currentUploadVisitId = null;
function openUploadModal(visitId, patientId, patientName) {
    // 1. Store the ID globally
    window.currentUploadVisitId = visitId; 
    window.currentUploadPatientId = patientId;
    window.currentUploadPatientName = patientName;

    console.log("Modal opened for:", visitId, patientId, patientName);
    console.log("Setting global upload ID to:", visitId);

    console.log("Saving to window:", { 
        visitId: window.currentUploadVisitId, 
        patientId: window.currentUploadPatientId, 
        patientName: window.currentUploadPatientName 
    });
    document.getElementById('upload-modal').style.display = 'block';
    
    const modal = document.getElementById('upload-modal');
    if (modal) {
        modal.style.display = 'block';
    } else {
        showAlert(t('upload_modal_missing', 'Upload modal not found!'), 'error');
    }
}

function toggleMessagingOptions() {
    const isEnabled = document.getElementById('setting-msg-enabled').checked;
    const methodContainer = document.getElementById('msg-method-container');
    const method = document.getElementById('setting-msg-method').value;
    const waButton = document.getElementById('topbar-wa-btn');
    const waConnectionSection = document.getElementById('wa-connection-section');
    
    if (isEnabled) {
        methodContainer.style.display = 'flex'; 
        
        const isWhatsApp = (method === 'whatsapp');
        if (waButton) waButton.style.display = isWhatsApp ? 'inline-block' : 'none';
        if (waConnectionSection) waConnectionSection.style.display = isWhatsApp ? 'block' : 'none';
        
    } else {
        methodContainer.style.display = 'none'; 
        if (waButton) waButton.style.display = 'none';
        if (waConnectionSection) waConnectionSection.style.display = 'none';
    }
}

async function handleFileUpload(event) {
    event.preventDefault();
    
    // 1. Get identifiers from global state
    const visitId = window.currentUploadVisitId; 
    const patientId = window.currentUploadPatientId;
    const patientName = window.currentUploadPatientName;

    if (!visitId || !patientId || !patientName) {
        console.error("Missing Data:", { visitId, patientId, patientName });
        showAlert(t('patient_info_missing', 'Error: Patient info missing.'), 'error');
        return;
    }
    
    const fileInput = document.getElementById('report-file-input');
    const files = fileInput.files;
    if (files.length === 0) {
        showAlert(t('select_files_first', 'Please select files first.'), 'error');
        return;
    }
    
    // 2. Prepare single FormData object
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('reports', files[i]);
    }
    formData.append('visit_id', visitId);
    formData.append('patient_id', patientId); 
    formData.append('patient_name', patientName); 
    
    try {
        // 3. Single POST request to the Python backend
        const response = await fetch('/api/upload-report', {
            method: 'POST',
            body: formData 
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || "Upload failed");
        }
        
        const data = await response.json();
        
        // 4. Update UI
        showAlert(t('report_uploaded', 'Report uploaded successfully!'), 'success');
        document.getElementById('upload-modal').style.display = 'none';
        await loadInitialData();
        showDashboardTable(currentDashboardTableType);

        // 5. Background WhatsApp Sending via Node.js
        if (data.success && data.report_urls.length > 0) {
            // Server-authoritative: same LabConfig.msg_enabled/msg_method the DB actually
            // holds, fetched fresh in upload_report() (main.py) — NOT this page's live
            // Settings checkbox, which only matches the DB if the last toggle was actually
            // saved (and reverted on a failed/permission-denied save, which it isn't). That
            // mismatch used to make this path send when "Enter Results" (which always asked
            // the DB) would correctly have skipped, or vice versa.
            const isEnabled = data.messaging?.enabled;
            const method = data.messaging?.method || 'whatsapp';

            if (!isEnabled) {
                showAlert(t('report_uploaded_messaging_disabled', 'Report uploaded. Auto-messaging is disabled.'), 'info');
                return;
            }
            const liveServer = `http://${window.location.hostname}:${window.APP_PORTS.backend}`;
            const nodeServer = `http://${window.location.hostname}:${window.APP_PORTS.node}`; // Your Node.js Bot Port
            const endpoint = (method === 'sms') ? '/api/sms/send' : '/api/whatsapp/send';

            const patientName = window.currentUploadPatientName || "عميلنا العزيز";
            let pdfLinksText = data.report_urls.map((url, index) => {
                // FIX: encodeURI converts spaces into '%20' so WhatsApp doesn't break the link
                let cleanUrl = encodeURI(url.trim());

                // Ensure absolute routing
                if (!cleanUrl.startsWith('/')) {
                    cleanUrl = '/' + cleanUrl;
                }

                return `📄 التقرير ${index + 1}: ${liveServer}${cleanUrl}`;
            }).join('\n');

            let message = `مرحباً ${patientName}،\n\nنتائج التحاليل الخاصة بك جاهزة الآن:\n\n${pdfLinksText}\n\nلعرض السجل الطبي الكامل: ${liveServer}/patient-history/${data.patient_id}`;
            const messagingPayload = {
                centerId: 'lab',
                phone: data.phone,
                message: message // <-- Now passing the valid string
            };
            if (method === 'whatsapp') {
                messagingPayload.pdfUrl = `${liveServer}${encodeURI(data.report_urls[0].trim().startsWith('/') ? data.report_urls[0].trim() : '/' + data.report_urls[0].trim())}`;
            }

            try {
                const waResponse = await fetch(`${nodeServer}${endpoint}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(messagingPayload)
                });
        
                if (!waResponse.ok) {
                    throw new Error(`Server returned ${waResponse.status}`);
                }
        
                showAlert(t('message_sent_via', 'Message sent successfully via {method}!', {method: method.toUpperCase()}), 'success');
                
            } catch (err) {
                console.error("Messaging Error:", err);
                showAlert(t('message_send_failed', 'Failed to send {method} message. Ensure Node server is running.', {method: method.toUpperCase()}), 'error');
            }
        }
        
    } catch (error) {
        console.error("Upload/WhatsApp Error:", error);
        showAlert(error.message || t('network_error_occurred', 'Network error occurred.'), 'error');
    }
}

// Variable to store the polling timer
let waPollInterval;

// Opens the modal and starts checking the status immediately
function openWhatsAppModal() {
    document.getElementById('wa-qr-modal').style.display = 'block';
    checkWhatsAppStatus();
}

// Closes the modal and stops the background checking to save memory
function closeWhatsAppModal() {
    document.getElementById('wa-qr-modal').style.display = 'none';
    if (waPollInterval) {
        clearInterval(waPollInterval);
        waPollInterval = null;
    }
}

// The core function to fetch the QR code or status from Node.js
async function checkWhatsAppStatus() {
    const statusMsg = document.getElementById('wa-modal-status-msg');
    const qrContainer = document.getElementById('wa-modal-qr-container');
    const qrImg = document.getElementById('wa-modal-qr-img');
    
    const nodeServer = `http://${window.location.hostname}:${window.APP_PORTS.node}`;

    try {
        const response = await fetch(`${nodeServer}/api/whatsapp/status?centerId=lab`);
        const data = await response.json();

        if (data.status === 'connected') {
            if (window.lastWaStatus !== 'connected') {
                addNotification(t('whatsapp_paired', 'WhatsApp: Device is paired and ready!'), 'success');
                window.lastWaStatus = 'connected';
            }
            // Success State
            statusMsg.textContent = "✅ Device is paired and ready!";
            statusMsg.style.color = "var(--ok)";
            qrContainer.style.display = 'none';
            
            // Stop polling since we are connected
            if (waPollInterval) clearInterval(waPollInterval);
            waPollInterval = null;
            
        } else if (data.status === 'qr') {
            window.lastWaStatus = 'qr';
            // QR Code State
            statusMsg.textContent = "⚠️ Device isn't paired, generating a qr code ...";
            statusMsg.style.color = "var(--warn)";
            
            // Render the raw QR string into an image using an external API
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(data.qrCode)}`;
            qrContainer.style.display = 'block';
            
            // Keep polling every 3 seconds to detect when the user scans it
            if (!waPollInterval) waPollInterval = setInterval(checkWhatsAppStatus, 3000);
            
        } else if (data.status === 'initializing') {
            // Loading State
            statusMsg.textContent = "⏳ Starting WhatsApp engine... please wait.";
            statusMsg.style.color = "var(--teal)";
            qrContainer.style.display = 'none';
            if (!waPollInterval) waPollInterval = setInterval(checkWhatsAppStatus, 3000);
            
        } else {
            // Offline / Error State
            if (window.lastWaStatus !== 'disconnected') {
                addNotification(t('whatsapp_prefix', 'WhatsApp: {msg}', {msg: data.message || t('connection_lost', 'Connection lost')}), 'warn');
                window.lastWaStatus = 'disconnected';
            }
            statusMsg.textContent = `Status: ${data.message || data.status}`;
            statusMsg.style.color = "var(--text)";
            qrContainer.style.display = 'none';
            if (!waPollInterval) waPollInterval = setInterval(checkWhatsAppStatus, 3000);
        }
    } catch (error) {
        statusMsg.textContent = "❌ Cannot reach Node.js server. Is it running?";
        statusMsg.style.color = "var(--danger)";
        qrContainer.style.display = 'none';
        addNotification(t('whatsapp_prefix', 'WhatsApp: {msg}', {msg: data.message || t('cannot_reach_node', '❌ Cannot reach Node.js server. Is it running?')}), 'warn');
        // Stop polling if the server is completely dead
        if (waPollInterval) clearInterval(waPollInterval);
        waPollInterval = null;
    }
}
// ==========================================
// TEST DIRECTORY & API LOGIC
// ==========================================

let availableTests = [];
let editingTestId = null;

// 1. Fetch tests from Python Database
async function fetchLabTests() {
    try {
        const response = await fetch('/api/tests', {
            method: 'GET',
            headers: { 'X-App-Mode': typeof currentWorkspace !== 'undefined' ? currentWorkspace : 'lab' }
        });
        
        if (!response.ok) throw new Error('Failed to fetch tests');
        
        availableTests = await response.json();
        loadTestList(); // Draw the table after data arrives
        
    } catch (error) {
        console.error("Database Error:", error);
        const container = document.getElementById('test-list-container');
        if (container) container.innerHTML = '<p style="color: var(--warn); padding: 20px;">Could not connect to database.</p>';
    }
}

// 2. Draw the Table
// 1. UPDATED TABLE GENERATOR (Now includes checkboxes)
function loadTestList() {
    const container = document.getElementById('test-list-container');
    if (!container) return; 
    
    if (availableTests.length === 0) {
        container.innerHTML = `<div class="table-container"><table style="width:100%;"><tr><td style="text-align:center; padding: 30px; color: var(--muted);">${t('empty_no_tests_available', 'No tests available. Click "Add New Test" to begin.')}</td></tr></table></div>`;
        return;
    }

    let rows = availableTests.map(t => `
        <tr>
            <td><input type="checkbox" class="test-checkbox" data-id="${t.id}" onchange="updateBulkDeleteTestButton()"></td>
            <td><strong>${t.id}</strong></td>
            <td>${t.name}</td>
            <td style="color: var(--muted);">${t.sample_type || 'Unspecified'}</td>
            <td style="color: var(--ok); font-weight: 600;">${parseFloat(t.price).toFixed(2)} EGP</td>
            <td style="text-align: right;">
                <button type="button" class="btn ghost" style="padding: 6px 12px; font-size: 12px; border: 1px solid var(--border);" onclick="openParametersModal(${t.id}, '${t.name.replace(/'/g, "\\'")}')" data-i18n="actions.parameters">Parameters</button>
                <button type="button" class="btn ghost" style="padding: 6px 12px; font-size: 12px; border: 1px solid var(--border);" onclick="openTestModal(${t.id})">Edit</button>
            </td>
        </tr>
    `).join('');

    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th style="width: 40px;"><input type="checkbox" id="select-all-tests" onclick="toggleSelectAllTests(this)"></th>
                        <th style="width: 80px;">ID</th>
                        <th>Test Name</th>
                        <th>Sample Type</th>
                        <th style="width: 150px;">Price</th>
                        <th style="text-align: right; width: 150px;">Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
    
    // Reset the bulk delete button state when redrawing the table
    updateBulkDeleteTestButton();
}

// 2. NEW LOGIC TO SHOW/HIDE THE DELETE BUTTON
function updateBulkDeleteTestButton() {
    const checkboxes = document.querySelectorAll('.test-checkbox:checked');
    const btn = document.getElementById('bulk-delete-tests-btn');
    if (btn) {
        btn.style.display = checkboxes.length > 0 ? 'block' : 'none';
    }
}

// 3. NEW LOGIC FOR THE "SELECT ALL" CHECKBOX IN THE HEADER
function toggleSelectAllTests(checkbox) {
    document.querySelectorAll('.test-checkbox').forEach(cb => {
        cb.checked = checkbox.checked;
    });
    updateBulkDeleteTestButton();
}

// 4. NEW LOGIC TO DELETE THE SELECTED TESTS
async function handleBulkDeleteTests() {
    const checkboxes = document.querySelectorAll('.test-checkbox:checked');
    const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
    
    if (ids.length === 0) return;
    
    if (!confirm(t('confirm_delete_tests', 'Are you sure you want to delete {count} test(s)? This cannot be undone.', {count: ids.length}))) return;
    
    // Checked individually — a test still referenced by a booked visit, transaction, or
    // panel is blocked server-side (409, see delete_test()) instead of silently failing,
    // and a bare success count would otherwise hide exactly why nothing got deleted.
    let successCount = 0;
    const failures = [];
    for (const id of ids) {
        try {
            const response = await fetch(`/api/tests/${id}`, {
                method: 'DELETE',
                headers: { 'X-App-Mode': typeof currentWorkspace !== 'undefined' ? currentWorkspace : 'lab' }
            });
            if (response.ok) {
                successCount++;
            } else {
                const body = await response.json().catch(() => ({}));
                failures.push(body.error || `#${id}: ${response.status}`);
            }
        } catch (error) {
            failures.push(`#${id}: ${error.message}`);
        }
    }

    if (failures.length === 0) {
        showAlert(t('tests_deleted', 'Successfully deleted {count} tests!', {count: successCount}), 'success');
    } else if (successCount === 0) {
        showAlert(t('tests_delete_error', 'Error deleting tests: {msg}', {msg: failures.join('; ')}), 'error');
    } else {
        showAlert(t('tests_delete_partial', 'Deleted {ok} test(s); {failed} failed: {msg}', {ok: successCount, failed: failures.length, msg: failures.join('; ')}), 'warn');
    }

    // Re-fetch the live data from DB to update the table instantly
    await fetchLabTests();
}

// 3. Popup Modal Logic
function openTestModal(testId = null) {
    editingTestId = testId;
    const modal = document.getElementById('test-modal');
    const title = document.getElementById('test-modal-title');
    
    if (testId) {
        title.textContent = 'Edit Test Price';
        const test = availableTests.find(t => t.id === testId);
        document.getElementById('test-name-input').value = test.name;
        document.getElementById('test-sample-input').value = test.sample_type || '';
        document.getElementById('test-price-input').value = test.price;
    } else {
        title.textContent = 'Add New Test';
        document.getElementById('test-form').reset();
    }
    
    modal.style.display = 'block';
}

function closeTestModal() {
    document.getElementById('test-modal').style.display = 'none';
    editingTestId = null;
}

// --- RESULT PARAMETER TEMPLATES (Test List > "Parameters") ---
let currentParameterTestId = null;
let currentParameterRows = []; // {id: null|number, name, unit, method, ref_low, ref_high, reference_range_text, abnormal_note}
let deletedParameterIds = [];

// Excel-like formula builder state: which row/field (relation_formula or
// absolute_count_formula — a parameter can have both) last had focus, and where its caret
// was — the 🔗 button next to another row's name inserts a [Name] reference there.
let activeFormulaTarget = null; // { rowIndex, field } | null
let formulaCaretPos = {}; // keyed by `${rowIndex}:${field}`

// The server stores/validates formulas with stable {id} tokens (e.g. "{55} / {56} * 2") so
// renaming a parameter never breaks a formula that references it. The modal shows/edits a
// friendlier "[Name]" form instead — these two converters translate between them.
function formulaToDisplay(formula) {
    if (!formula) return '';
    return formula.replace(/\{(\d+)\}/g, (match, idStr) => {
        const referenced = currentParameterRows.find((r) => r.id === parseInt(idStr, 10));
        return referenced ? `[${referenced.name}]` : match; // dangling ref (deleted param) — left as-is
    });
}

function formulaToStored(display) {
    if (!display) return '';
    let cleaned = display.trim();
    if (cleaned.startsWith('=')) cleaned = cleaned.slice(1).trim(); // "=" is just familiar Excel styling
    return cleaned.replace(/\[([^\]]+)\]/g, (match, name) => {
        const referenced = currentParameterRows.find((r) => r.name && r.name.trim() === name.trim());
        return referenced && referenced.id ? `{${referenced.id}}` : match; // unresolved — backend will reject
    });
}

async function openParametersModal(testId, testName) {
    currentParameterTestId = testId;
    deletedParameterIds = [];
    activeFormulaTarget = null;
    formulaCaretPos = {};
    document.getElementById('parameters-modal-subtitle').textContent = testName;

    try {
        const response = await apiFetch(`/api/lab-tests/${testId}/parameters`);
        currentParameterRows = response.ok ? await response.json() : [];
    } catch (error) {
        currentParameterRows = [];
        showAlert(t('parameters_load_error', 'Could not load parameters: {msg}', {msg: error.message}), 'error');
    }

    currentParameterRows.forEach((row) => {
        row.relation_formula = formulaToDisplay(row.relation_formula || '');
        row.absolute_count_formula = formulaToDisplay(row.absolute_count_formula || '');
    });

    renderParameterRows();
    document.getElementById('parameters-modal').style.display = 'block';
}

function closeParametersModal() {
    document.getElementById('parameters-modal').style.display = 'none';
    currentParameterTestId = null;
    currentParameterRows = [];
    deletedParameterIds = [];
}

function renderParameterRows() {
    const tbody = document.getElementById('parameters-modal-rows');
    const cell = (row, field, type = 'text') => `
        <input type="${type}" value="${(row[field] ?? '').toString().replace(/"/g, '&quot;')}"
               oninput="currentParameterRows[${currentParameterRows.indexOf(row)}].${field} = this.value"
               style="width: 100%; min-width: 70px;">
    `;
    const miniCell = (row, field, label) => `
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
            <span style="font-size:12px; color:var(--muted); width:28px;">${label}</span>
            ${cell(row, field, 'number')}
        </div>
    `;
    const nameCell = (row, idx) => `
        <div style="display:flex; align-items:center; gap:4px;">
            ${cell(row, 'name')}
            <button type="button" title="Insert this parameter into the active Formula field"
                    onclick="insertParamReference(${idx})"
                    style="flex-shrink:0; padding:3px 7px; font-size:12px; cursor:pointer; border-radius:4px; border:1px solid var(--border); background:var(--bg-2); color:var(--text);">🔗</button>
        </div>
    `;
    const formulaCell = (row, idx, field, placeholder) => `
        <input type="text" id="param-formula-${field}-${idx}" value="${(row[field] ?? '').toString().replace(/"/g, '&quot;')}"
               oninput="currentParameterRows[${idx}].${field} = this.value"
               onfocus="trackFormulaCaret(${idx}, '${field}')" onclick="trackFormulaCaret(${idx}, '${field}')" onkeyup="trackFormulaCaret(${idx}, '${field}')"
               placeholder="${placeholder}"
               style="width: 100%; min-width: 200px;">
    `;

    tbody.innerHTML = currentParameterRows.map((row) => {
        const idx = currentParameterRows.indexOf(row);
        const rangeCell = row.gender_specific
            ? miniCell(row, 'ref_low_male', 'M ↓') + miniCell(row, 'ref_high_male', 'M ↑')
              + miniCell(row, 'ref_low_female', 'F ↓') + miniCell(row, 'ref_high_female', 'F ↑')
            : `<div style="display:flex; gap:4px;">${cell(row, 'ref_low', 'number')}${cell(row, 'ref_high', 'number')}</div>`;
        const absoluteRangeCell = `<div style="display:flex; gap:4px;">${cell(row, 'absolute_ref_low', 'number')}${cell(row, 'absolute_ref_high', 'number')}</div>`;
        return `
        <tr>
            <td style="min-width: 160px;">${nameCell(row, idx)}</td>
            <td>${cell(row, 'unit')}</td>
            <td>${cell(row, 'method')}</td>
            <td style="text-align: center;">
                <input type="checkbox" ${row.gender_specific ? 'checked' : ''}
                       title="Different reference range for male/female"
                       onchange="currentParameterRows[${idx}].gender_specific = this.checked; renderParameterRows()">
            </td>
            <td style="min-width: 170px;">${rangeCell}</td>
            <td>${cell(row, 'reference_range_text')}</td>
            <td>${cell(row, 'abnormal_note')}</td>
            <td style="min-width: 220px;">${formulaCell(row, idx, 'relation_formula', "= click a parameter's 🔗, then an operator, e.g. [WBC] / [RBC] * 2")}</td>
            <td style="min-width: 220px;">${formulaCell(row, idx, 'absolute_count_formula', "= e.g. [Neutrophils] / 100 * [WBC]")}</td>
            <td>${cell(row, 'absolute_count_unit')}</td>
            <td style="min-width: 150px;">${absoluteRangeCell}</td>
            <td style="text-align: center;">
                <span style="cursor: pointer; color: var(--danger); font-size: 18px;" onclick="removeParameterRow(${idx})">&times;</span>
            </td>
        </tr>
        `;
    }).join('') || `<tr><td colspan="12" style="text-align: center; color: var(--muted); padding: 15px;">${t('empty_no_parameters_yet', 'No parameters yet — click "+ Add Parameter" below.')}</td></tr>`;
}

function addParameterRow() {
    currentParameterRows.push({
        id: null, name: '', unit: '', method: '',
        ref_low: '', ref_high: '', reference_range_text: '', abnormal_note: '',
        gender_specific: false, ref_low_male: '', ref_high_male: '', ref_low_female: '', ref_high_female: '',
        relation_formula: '',
        absolute_count_formula: '', absolute_count_unit: '', absolute_ref_low: '', absolute_ref_high: '',
    });
    renderParameterRows();
}

function removeParameterRow(index) {
    const row = currentParameterRows[index];
    if (row.id) deletedParameterIds.push(row.id);
    currentParameterRows.splice(index, 1);
    if (activeFormulaTarget && activeFormulaTarget.rowIndex === index) activeFormulaTarget = null;
    renderParameterRows();
}

// Remembers where the caret sits inside a Formula field as the technician clicks/types in it,
// so a later click on some other row's 🔗 button knows exactly where to splice the reference
// in. field is 'relation_formula' or 'absolute_count_formula' — a parameter can have both, so
// tracking just the row wouldn't say which of its two formula fields is actually focused.
function trackFormulaCaret(rowIndex, field) {
    activeFormulaTarget = { rowIndex, field };
    const input = document.getElementById(`param-formula-${field}-${rowIndex}`);
    if (input) formulaCaretPos[`${rowIndex}:${field}`] = input.selectionStart;
}

// Excel-like "click a cell to insert its reference" — inserts "[Name]" at the last-known
// caret position of whichever Formula field was last focused. namedIdx is the row whose 🔗
// was clicked (the parameter being referenced), not the formula being edited.
function insertParamReference(namedIdx) {
    if (!activeFormulaTarget) {
        showAlert(t('formula_click_field_first', "Click into a Formula field first, then click a parameter's 🔗 to insert it."), 'error');
        return;
    }
    const { rowIndex, field } = activeFormulaTarget;
    // Self-reference is meaningless for relation_formula (a value can't be derived from
    // itself) but is the common case for absolute_count_formula (e.g. Absolute Neutrophil
    // Count = Neutrophils% * WBC / 100 references Neutrophils' own value) — see
    // _validate_absolute_count_formula in reports.py.
    if (namedIdx === rowIndex && field === 'relation_formula') {
        showAlert(t('formula_self_reference', 'A parameter cannot reference itself.'), 'error');
        return;
    }
    const namedRow = currentParameterRows[namedIdx];
    if (!namedRow || !namedRow.name || !namedRow.name.trim()) {
        showAlert(t('name_parameter_first', 'Name that parameter before referencing it.'), 'error');
        return;
    }

    const targetRow = currentParameterRows[rowIndex];
    const current = targetRow[field] || '';
    const key = `${rowIndex}:${field}`;
    const pos = formulaCaretPos[key] != null ? formulaCaretPos[key] : current.length;
    const insertText = `[${namedRow.name.trim()}]`;
    targetRow[field] = current.slice(0, pos) + insertText + current.slice(pos);

    renderParameterRows();
    requestAnimationFrame(() => {
        const refreshedInput = document.getElementById(`param-formula-${field}-${rowIndex}`);
        if (!refreshedInput) return;
        refreshedInput.focus();
        const newPos = pos + insertText.length;
        refreshedInput.setSelectionRange(newPos, newPos);
        activeFormulaTarget = { rowIndex, field };
        formulaCaretPos[key] = newPos;
    });
}

async function saveParameterRows() {
    try {
        for (const id of deletedParameterIds) {
            await apiFetch(`/api/parameters/${id}`, { method: 'DELETE' });
        }

        // Pass 1: save every row's own fields (not its relation — a "Depends On" selection
        // may point at another row that doesn't have a real id yet either, so relations are
        // only resolvable once every row here has been created/updated at least once).
        for (const row of currentParameterRows) {
            if (!row.name || !row.name.trim()) continue; // skip blank rows silently

            const numOrNull = (v) => (v === '' || v == null ? null : parseFloat(v));
            const payload = {
                name: row.name,
                unit: row.unit || null,
                method: row.method || null,
                ref_low: numOrNull(row.ref_low),
                ref_high: numOrNull(row.ref_high),
                reference_range_text: row.reference_range_text || null,
                abnormal_note: row.abnormal_note || null,
                gender_specific: !!row.gender_specific,
                ref_low_male: numOrNull(row.ref_low_male),
                ref_high_male: numOrNull(row.ref_high_male),
                ref_low_female: numOrNull(row.ref_low_female),
                ref_high_female: numOrNull(row.ref_high_female),
                absolute_count_unit: row.absolute_count_unit || null,
                absolute_ref_low: numOrNull(row.absolute_ref_low),
                absolute_ref_high: numOrNull(row.absolute_ref_high),
            };

            if (row.id) {
                await apiFetch(`/api/parameters/${row.id}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                const response = await apiFetch(`/api/lab-tests/${currentParameterTestId}/parameters`, { method: 'POST', body: JSON.stringify(payload) });
                if (response.ok) row.id = (await response.json()).id;
            }
        }

        // Pass 2: now that every saved row has a real id, resolve each formula's "[Name]"
        // references (which may point at a row that only just got its id in pass 1 above)
        // into the stable "{id}" tokens the server stores and validates. Sent as two separate
        // requests (not combined into one payload) since the backend validates each field
        // independently and bails on the first error — combining them would let an invalid
        // relation_formula block an otherwise-valid absolute_count_formula from saving too.
        for (const row of currentParameterRows) {
            if (!row.id) continue; // blank row skipped above — nothing to attach a formula to

            const relationResponse = await apiFetch(`/api/parameters/${row.id}`, {
                method: 'PUT',
                body: JSON.stringify({ relation_formula: formulaToStored(row.relation_formula || '') || null }),
            });
            if (!relationResponse.ok) {
                const body = await relationResponse.json().catch(() => ({}));
                showAlert(t('formula_not_saved', 'Formula for "{name}" was not saved: {error}', {name: row.name, error: body.error || t('hr_unknown_error', 'unknown error')}), 'error');
            }

            const absoluteResponse = await apiFetch(`/api/parameters/${row.id}`, {
                method: 'PUT',
                body: JSON.stringify({ absolute_count_formula: formulaToStored(row.absolute_count_formula || '') || null }),
            });
            if (!absoluteResponse.ok) {
                const body = await absoluteResponse.json().catch(() => ({}));
                showAlert(t('absolute_formula_not_saved', 'Absolute Count formula for "{name}" was not saved: {error}', {name: row.name, error: body.error || t('hr_unknown_error', 'unknown error')}), 'error');
            }
        }

        showAlert(t('parameters_saved', 'Parameters saved!'), 'success');
        closeParametersModal();
    } catch (error) {
        showAlert(t('parameters_save_error', 'Error saving parameters: {msg}', {msg: error.message}), 'error');
    }
}

// 4. Save to Database
async function saveTestRecord(event) {
    event.preventDefault(); // Stop page from refreshing
    
    const payload = {
        name: document.getElementById('test-name-input').value,
        sample_type: document.getElementById('test-sample-input').value,
        price: document.getElementById('test-price-input').value
    };
    
    if (editingTestId) payload.id = editingTestId;
    
    try {
        // Send to Python Backend
        const response = await fetch('/api/tests', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-App-Mode': typeof currentWorkspace !== 'undefined' ? currentWorkspace : 'lab'
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) throw new Error('Server rejected save request');
        
        closeTestModal();
        await fetchLabTests(); // Re-fetch the live data from DB to update the table
        showAlert(t('test_saved_db', 'Test saved to database!'), 'success');
        
    } catch (error) {
        console.error("Save Error:", error);
        showAlert(t('test_save_db_failed', 'Failed to save to database.'), 'error');
    }
}

// Fetch tests when the page loads
document.addEventListener('DOMContentLoaded', fetchLabTests);

// --- TEST PANELS (Test List > "Manage Panels") ---
let availablePanels = [];
let editingPanelId = null;

async function fetchPanels() {
    try {
        const response = await apiFetch('/api/panels');
        availablePanels = response.ok ? await response.json() : [];
    } catch (error) {
        availablePanels = [];
    }
}
document.addEventListener('DOMContentLoaded', fetchPanels);

// --- PHYSICIAN AUTOCOMPLETE (booking / dashboard / statistics) ---
async function fetchPhysicians() {
    try {
        const response = await apiFetch('/api/physicians');
        const names = response.ok ? await response.json() : [];
        const datalist = document.getElementById('physician-datalist');
        if (datalist) datalist.innerHTML = names.map(n => `<option value="${n.replace(/"/g, '&quot;')}">`).join('');
    } catch (error) {
        console.error('Failed to load physicians:', error);
    }
}
document.addEventListener('DOMContentLoaded', fetchPhysicians);

function openPanelsModal() {
    startNewPanel();
    renderPanelsList();
    document.getElementById('panels-modal').style.display = 'block';
}

function closePanelsModal() {
    document.getElementById('panels-modal').style.display = 'none';
}

function renderPanelsList() {
    const container = document.getElementById('panels-list');
    if (!availablePanels.length) {
        container.innerHTML = `<p style="color: var(--muted); font-size: 13px;">${t('empty_no_panels', 'No panels yet — create one on the right.')}</p>`;
        return;
    }
    container.innerHTML = availablePanels.map(p => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05);">
            <span>${p.name} <span style="color: var(--muted); font-size: 11px;">(${p.tests.length} tests)</span></span>
            <div>
                <span style="cursor: pointer; margin-right: 10px;" onclick="editPanel(${p.id})" title="Edit">✏️</span>
                <span style="cursor: pointer; color: var(--danger);" onclick="deletePanel(${p.id})" title="Delete">🗑️</span>
            </div>
        </div>
    `).join('');
}

function startNewPanel() {
    editingPanelId = null;
    document.getElementById('panel-name-input').value = '';
    renderPanelTestCheckboxes([]);
}

function editPanel(panelId) {
    const panel = availablePanels.find(p => p.id === panelId);
    if (!panel) return;
    editingPanelId = panelId;
    document.getElementById('panel-name-input').value = panel.name;
    renderPanelTestCheckboxes(panel.lab_test_ids);
}

function renderPanelTestCheckboxes(selectedIds) {
    const container = document.getElementById('panel-test-checkboxes');
    container.innerHTML = availableTests.map(t => `
        <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" class="panel-test-checkbox" value="${t.id}" ${selectedIds.includes(t.id) ? 'checked' : ''}>
            ${t.name}
        </label>
    `).join('');
}

async function savePanel() {
    const name = document.getElementById('panel-name-input').value.trim();
    if (!name) return showAlert(t('panel_name_required', 'Panel name is required.'), 'warn');
    const lab_test_ids = Array.from(document.querySelectorAll('.panel-test-checkbox:checked')).map(cb => parseInt(cb.value, 10));
    if (lab_test_ids.length === 0) return showAlert(t('panel_select_one_test', 'Select at least one test for the panel.'), 'warn');

    try {
        const url = editingPanelId ? `/api/panels/${editingPanelId}` : '/api/panels';
        const method = editingPanelId ? 'PUT' : 'POST';
        const response = await apiFetch(url, { method, body: JSON.stringify({ name, lab_test_ids }) });
        if (!response.ok) throw new Error('Server rejected panel save');
        await fetchPanels();
        renderPanelsList();
        startNewPanel();
        showAlert(t('panel_saved', 'Panel saved!'), 'success');
    } catch (error) {
        showAlert(t('panel_save_error', 'Error saving panel: {msg}', {msg: error.message}), 'error');
    }
}

async function deletePanel(panelId) {
    if (!confirm(t('confirm_delete_panel', 'Delete this panel? This only removes the booking shortcut — no existing visits or tests are affected.'))) return;
    try {
        await apiFetch(`/api/panels/${panelId}`, { method: 'DELETE' });
        await fetchPanels();
        renderPanelsList();
        if (editingPanelId === panelId) startNewPanel();
    } catch (error) {
        showAlert(t('panel_delete_error', 'Error deleting panel: {msg}', {msg: error.message}), 'error');
    }
}

// 4. OVERRIDE: Dynamic "Book Test" Modal
// This overrides the old function to generate checkboxes from our live array!
function openBookTestModal(clientId) {
    currentBookingClientId = clientId;

    // Get the container in your modal where the checkboxes go
    const container = document.getElementById('dynamic-test-checkboxes');

    if (availableTests.length === 0) {
        container.innerHTML = `<p style="color: var(--danger);">${t('empty_no_tests_in_directory', 'No tests available in directory. Please add tests in the "Test List" tab first.')}</p>`;
    } else {
        // Dynamically create a checkbox for every test in your database
        container.innerHTML = availableTests.map(t => `
        <label style="display: flex; align-items: center; cursor: pointer; color: var(--text); padding: 8px; border-radius: 4px;">
            <input type="checkbox" class="test-checkbox" value="${t.name}" data-price="${t.price}" data-sample="${t.sample_type || 'Unspecified'}" style="margin-right: 10px; width: auto;">
            <span style="flex: 1;">${t.name} <span style="font-size:11px; color:var(--muted)">(${t.sample_type || 'Unspecified'})</span></span>
            <span style="color: var(--ok); font-size: 12px;">${parseFloat(t.price).toFixed(2)} EGP</span>
        </label>
    `).join('');
    }

    const panelContainer = document.getElementById('panel-quick-select');
    if (panelContainer) {
        panelContainer.innerHTML = (availablePanels || []).map(p => `
            <button type="button" class="btn ghost panel-chip" style="padding: 6px 12px; font-size: 12px;" onclick="applyPanelQuickSelect(${p.id})">🗂 ${p.name}</button>
        `).join('');
    }

    const physicianInput = document.getElementById('book-physician-name');
    if (physicianInput) physicianInput.value = '';

    document.getElementById('book-test-modal').style.display = 'block';
}

// Toggle-checks every test that belongs to a panel — check all if any are unchecked, else
// uncheck all. The technician can still adjust individual checkboxes afterward.
function applyPanelQuickSelect(panelId) {
    const panel = (availablePanels || []).find(p => p.id === panelId);
    if (!panel) return;
    const boxes = panel.tests
        .map(t => document.querySelector(`#dynamic-test-checkboxes .test-checkbox[value="${t.name}"]`))
        .filter(Boolean);
    const allChecked = boxes.length > 0 && boxes.every(b => b.checked);
    boxes.forEach(b => { b.checked = !allChecked; });
}

// Call loadTestList when the tab is clicked (Assuming you have a tab switcher in your script)
document.querySelector('.nav-tab[data-tab="test-list"]').addEventListener('click', () => {
    loadTestList();
});

// --- "Check Tests Total Price" — a standalone price quote, no patient/booking/payment
// involved at all (fully anonymous by design). Selections are kept in this object rather
// than read back from the checkboxes themselves, so ticking a test, then searching for
// something else (hiding it from the DOM), then clearing the search doesn't silently drop
// it from the total — the object is the single source of truth; the checkboxes just
// reflect it. Deliberately its own `.price-check-checkbox` class, distinct from the
// booking modal's `.test-checkbox` (used elsewhere for the Tests List's own bulk-delete
// selection too) so none of these three checkbox groups can ever cross-count each other.
let priceCheckSelectedTests = {}; // test name -> price

function renderPriceCheckTests() {
    const container = document.getElementById('price-check-test-list');
    if (!container) return;

    const searchTerm = (document.getElementById('price-check-search')?.value || '').toLowerCase();
    const filtered = (availableTests || []).filter(test =>
        test.name.toLowerCase().includes(searchTerm) ||
        (test.sample_type || '').toLowerCase().includes(searchTerm)
    );

    if (filtered.length === 0) {
        container.innerHTML = `<p style="color: var(--muted); text-align: center; padding: 20px;">${t('empty_no_tests_available', 'No tests available. Click "Add New Test" to begin.')}</p>`;
    } else {
        container.innerHTML = filtered.map(test => `
            <label style="display: flex; align-items: center; cursor: pointer; color: var(--text); padding: 8px; border-radius: 4px;">
                <input type="checkbox" class="price-check-checkbox" value="${test.name}"
                       ${Object.prototype.hasOwnProperty.call(priceCheckSelectedTests, test.name) ? 'checked' : ''}
                       onchange="togglePriceCheckTest('${test.name.replace(/'/g, "\\'")}', ${test.price}, this.checked)"
                       style="margin-right: 10px; width: auto;">
                <span style="flex: 1;">${test.name} <span style="font-size: 11px; color: var(--muted);">(${test.sample_type || 'Unspecified'})</span></span>
                <span style="color: var(--ok); font-size: 12px;">${parseFloat(test.price).toFixed(2)} EGP</span>
            </label>
        `).join('');
    }
    updatePriceCheckTotal();
    applyTranslations(currentLang);
}

function togglePriceCheckTest(testName, price, isChecked) {
    if (isChecked) {
        priceCheckSelectedTests[testName] = price;
    } else {
        delete priceCheckSelectedTests[testName];
    }
    updatePriceCheckTotal();
}

function updatePriceCheckTotal() {
    const names = Object.keys(priceCheckSelectedTests);
    const subtotal = names.reduce((sum, name) => sum + (parseFloat(priceCheckSelectedTests[name]) || 0), 0);
    const discountPercent = parseFloat(document.getElementById('price-check-discount')?.value) || 0;
    const total = subtotal - (subtotal * discountPercent / 100);

    const countEl = document.getElementById('price-check-count');
    const subtotalEl = document.getElementById('price-check-subtotal');
    const totalEl = document.getElementById('price-check-total');
    if (countEl) countEl.textContent = names.length;
    if (subtotalEl) subtotalEl.textContent = `${subtotal.toFixed(2)} EGP`;
    if (totalEl) totalEl.textContent = `${total.toFixed(2)} EGP`;
}

function clearPriceCheckSelection() {
    priceCheckSelectedTests = {};
    const searchInput = document.getElementById('price-check-search');
    if (searchInput) searchInput.value = '';
    const discountSelect = document.getElementById('price-check-discount');
    if (discountSelect) discountSelect.value = '0';
    renderPriceCheckTests();
}

function closeBookTestModal() {
    document.getElementById('book-test-modal').style.display = 'none';
    currentBookingClientId = null;
    document.getElementById('book-test-form').reset();
}

// 2. Submit the Booked Tests (Moves from Registered -> Pending)
// ==========================================
// BILLING, CHECKOUT & RECEIPT LOGIC
// ==========================================

let pendingTransaction = {}; // Stores the data temporarily while user selects discount

// 1. Intercept the "Submit Booking" button
function submitTestBooking(event) {
    event.preventDefault();

    // Find the patient details from the master list
    const patient = clients.find(c => c.id === currentBookingClientId);
    if (!patient) return showAlert(t('patient_data_lost', 'Patient data lost. Please try again.'), 'error');

    // Gather selected tests and prices
    const selectedBoxes = document.querySelectorAll('.test-checkbox:checked');
    if (selectedBoxes.length === 0) {
        showAlert(t('select_at_least_one_test', 'Please select at least one test.'), 'warn');
        return;
    }

    let testsList = [];
    let pricesList = [];
    let samplesList = [];
    let subtotal = 0;

    selectedBoxes.forEach(box => {
        testsList.push(box.value);
        samplesList.push(box.getAttribute('data-sample'));
        const price = parseFloat(box.getAttribute('data-price'));
        pricesList.push(price);
        subtotal += price;
    });

    // Generate Unique Trans ID (YYYYMMDDHHMMSS-PID)
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateString = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeString = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const transId = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}-${patient.id}`;

    // Store in our temporary global object
    pendingTransaction = {
        transaction_id: transId,
        patient_id: patient.id,
        patient_name: `${patient.first_name} ${patient.last_name}`,
        patient_phone: patient.phone || 'N/A',
        physician_name: document.getElementById('book-physician-name')?.value.trim() || 'Self',
        date: `${dateString} ${timeString}`,
        tests: testsList,
        sampleTypes: samplesList,
        prices: pricesList,
        total_price: subtotal,
        discount_percentage: 0,
        payment_method: 'Cash',
        final_payment: subtotal
    };

    // Close booking modal, open payment modal
    closeBookTestModal();
    populatePaymentModal();
}

// 2. Populate the Checkout Window
function populatePaymentModal() {
    document.getElementById('pay-patient-name').textContent = pendingTransaction.patient_name;
    document.getElementById('pay-patient-id').textContent = pendingTransaction.patient_id;
    document.getElementById('pay-trans-id').textContent = pendingTransaction.transaction_id;
    document.getElementById('pay-date').textContent = pendingTransaction.date;
    
    // Draw the list of tests chosen
    const testListDiv = document.getElementById('pay-test-list');
    testListDiv.innerHTML = pendingTransaction.tests.map((t, i) => `
        <div style="display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px;">
            <span>${t}</span>
            <span>${pendingTransaction.prices[i].toFixed(2)} EGP</span>
        </div>
    `).join('');

    document.getElementById('pay-subtotal').textContent = pendingTransaction.total_price.toFixed(2);
    
    // Reset inputs
    document.getElementById('pay-discount').value = "0";
    populatePaymentMethodOptions();
    document.getElementById('pay-method').value = "Cash";

    calculateFinalPayment();
    document.getElementById('payment-modal').style.display = 'block';
}

// 3. Do the Math when Discount changes
function calculateFinalPayment() {
    const discountPercent = parseInt(document.getElementById('pay-discount').value);
    const subtotal = pendingTransaction.total_price;

    const discountAmount = subtotal * (discountPercent / 100);
    const finalTotal = subtotal - discountAmount;

    pendingTransaction.discount_percentage = discountPercent;
    pendingTransaction.final_payment = finalTotal;

    document.getElementById('pay-final-total').textContent = finalTotal.toFixed(2);

    // Amount Paid defaults to fully paid whenever the total changes (e.g. discount edited);
    // updateRemainingFees() reconciles remaining_fees / the red-flag row from this.
    document.getElementById('pay-amount-paid').value = finalTotal.toFixed(2);
    updateRemainingFees();
}

// Remaining Fees = Total Due - Amount Paid (clamped to >= 0), recomputed live as the
// technician edits how much was actually tendered. Shown as a red flag row only when a
// balance remains — mirrors the treatment in the receipt and Transaction History.
function updateRemainingFees() {
    const amountPaid = parseFloat(document.getElementById('pay-amount-paid').value) || 0;
    const remaining = Math.max(0, pendingTransaction.final_payment - amountPaid);

    pendingTransaction.amount_paid = amountPaid;
    pendingTransaction.remaining_fees = remaining;

    document.getElementById('pay-remaining-fees').textContent = remaining.toFixed(2);
    document.getElementById('pay-remaining-row').style.display = remaining > 0 ? 'flex' : 'none';
}

// 4. Submit "Pay Now" to Python
async function processTransaction() {
    pendingTransaction.payment_method = document.getElementById('pay-method').value;

    try {
        const response = await apiFetch('/api/transactions', {
            method: 'POST',
            body: JSON.stringify(pendingTransaction)
        });

        if (!response.ok) throw new Error("Failed to save transaction.");

        closePaymentModal();
        const receiptModal = document.getElementById('receipt-modal');
        if (receiptModal) receiptModal.style.display = 'none';

        showAlert(t('payment_successful', 'Payment Successful!'), 'success');
        generateReceipt();
        
        const postPaymentModal = document.getElementById('post-payment-modal');
        if (postPaymentModal) postPaymentModal.style.display = 'block';

        // ========================================================
        // 🚨 UNCONDITIONAL OPTIMISTIC UI UPDATE 🚨
        // Always push to the UI instantly, regardless of internet connection!
        // ========================================================
            
        // 1. Update Dashboard Visits Array
        if (typeof allVisits !== 'undefined') {
            allVisits.unshift({
                id: Date.now(), // Fake temporary ID
                visit_id: pendingTransaction.transaction_id,
                patient_id: pendingTransaction.patient_id,
                patient_name: pendingTransaction.patient_name,
                date: pendingTransaction.date,
                tests: pendingTransaction.tests,
                status: 'pending',
                phone: pendingTransaction.patient_phone,
                physician_name: pendingTransaction.physician_name
            });
        }
        
        // 2. Update Financial & History Array
        if (typeof allTransactions !== 'undefined') {
            allTransactions.unshift({
                id: Date.now(),
                transaction_id: pendingTransaction.transaction_id,
                patient_id: pendingTransaction.patient_id,
                patient_name: pendingTransaction.patient_name,
                date: pendingTransaction.date,
                tests: pendingTransaction.tests,
                total_price: pendingTransaction.total_price,
                discount_percentage: pendingTransaction.discount_percentage,
                payment_method: pendingTransaction.payment_method,
                final_payment: pendingTransaction.final_payment,
                amount_paid: pendingTransaction.amount_paid,
                remaining_fees: pendingTransaction.remaining_fees || 0
            });
        }
        
        // 3. Update the specific Patient's Status in the Clients Directory
        if (typeof clients !== 'undefined') {
            const patientIndex = clients.findIndex(c => c.id === pendingTransaction.patient_id);
            if (patientIndex !== -1) {
                // Force the patient to look like they have a pending test
                clients[patientIndex].test_type = pendingTransaction.tests.join(', ');
                clients[patientIndex].sample_status = 'pending';
            }
        }
        // ========================================================

        // Now when this runs, it will redraw the tables using our updated arrays!
        await loadInitialData();
        fetchPhysicians(); // pick up a newly-typed physician name for future autocomplete

    } catch (error) {
        console.error("Transaction Error:", error);
        showAlert(t('payment_db_error', 'Database error while processing payment.'), 'error');
    }
}

// --- PRINTING & BARCODE ENGINE ---

// Helper: Generates a base64 Image of a Barcode using JsBarcode
function generateBarcodeImage(text) {
    const canvas = document.createElement('canvas');
    JsBarcode(canvas, text, { width: 1.5, height: 35, displayValue: true, fontSize: 14, margin: 0 });
    return canvas.toDataURL('image/png');
}

// One barcode value per (visit, sample type) — deterministic (not random) so printing it
// again later, e.g. via the "Print Barcode" button on a test's card in the visit-results
// modal, reproduces the exact same code that was on the tube's original sticker instead of
// a fresh unrelated one. Tests sharing a sample type share one tube/one code, matching
// groupTestsBySampleType() below. visitCode is stable (PatientVisit.visit_id, same string
// used as pendingTransaction.transaction_id at checkout — see confirmBooking()).
function sampleBarcodeValue(visitCode, sampleType) {
    const slug = (sampleType || 'SAMPLE').toString().toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6) || 'SAMPLE';
    return `${visitCode}-${slug}`;
}

// Helper: Groups tests that share the same Sample Type
function groupTestsBySampleType() {
    const groups = {};
    pendingTransaction.tests.forEach((testName, i) => {
        const sType = pendingTransaction.sampleTypes[i] || 'Unspecified';
        if (!groups[sType]) {
            groups[sType] = { barcode: sampleBarcodeValue(pendingTransaction.transaction_id, sType), tests: [] };
        }
        groups[sType].tests.push(testName);
    });
    return groups;
}

// Measures how wide `text` actually renders at `fontSizePx`, in mm — used to size a
// barcode sticker snugly around its own content instead of guessing a fixed label size.
function _measureTextWidthMm(text, fontSizePx, bold) {
    const span = document.createElement('span');
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.style.whiteSpace = 'nowrap';
    span.style.fontFamily = 'Arial, sans-serif';
    span.style.fontSize = `${fontSizePx}px`;
    if (bold) span.style.fontWeight = 'bold';
    span.textContent = text || '';
    document.body.appendChild(span);
    const widthPx = span.getBoundingClientRect().width;
    document.body.removeChild(span);
    return widthPx / 3.7795275591; // 96 CSS px/inch ÷ 25.4mm/inch
}

// Opens a print window sized to fit a small roll-fed barcode sticker (a real physical
// label, unlike a full A4/Letter sheet) — each sticker's page is sized around its own
// barcode/caption content rather than a fixed guess, per `stickers`: [{ caption,
// barcodeValue }]. Every sticker in one call shares the same page size (the widest one
// needed in the batch), so a whole multi-tube order still prints as one continuous job.
function printBarcodeStickers(stickers) {
    const BAR_HEIGHT_MM = 6.5;   // physical height of the barcode bars themselves
    const LINE_HEIGHT_MM = 3;    // the one caption line under the barcode
    const PAD_MM = 1;
    const MIN_WIDTH_MM = 18;
    const MAX_WIDTH_MM = 42;

    let widestMm = MIN_WIDTH_MM;
    const rendered = stickers.map(s => {
        const canvas = document.createElement('canvas');
        JsBarcode(canvas, s.barcodeValue, { format: 'CODE128', width: 1, height: 60, displayValue: false, margin: 0 });
        const barcodeWidthMm = BAR_HEIGHT_MM * (canvas.width / canvas.height);
        const captionWidthMm = s.caption ? _measureTextWidthMm(s.caption, 9, false) : 0;
        const neededMm = Math.max(barcodeWidthMm, captionWidthMm) + PAD_MM * 2;
        widestMm = Math.max(widestMm, Math.min(neededMm, MAX_WIDTH_MM));
        return { ...s, dataUrl: canvas.toDataURL('image/png') };
    });
    const width = Math.ceil(widestMm);
    const height = Math.ceil(BAR_HEIGHT_MM + LINE_HEIGHT_MM + PAD_MM * 2);

    let html = `<html><head><title>Print Barcode</title><style>
        @page { size: ${width}mm ${height}mm; margin: 0; }
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Arial, sans-serif; }
        .sticker {
            width: ${width}mm; height: ${height}mm; padding: ${PAD_MM}mm;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            page-break-after: always; overflow: hidden; text-align: center;
        }
        .sticker .caption { font-size: 2.6mm; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .sticker img { height: ${BAR_HEIGHT_MM}mm; max-width: 100%; }
    </style></head><body>`;
    rendered.forEach(s => {
        html += `<div class="sticker"><img src="${s.dataUrl}">${s.caption ? `<div class="caption">${s.caption}</div>` : ''}</div>`;
    });
    html += '<script>window.onload = function(){ setTimeout(()=>{window.print(); window.close();}, 200); }</script></body></html>';

    const printWindow = window.open('', '_blank', 'width=400,height=300');
    printWindow.document.write(html);
    printWindow.document.close();
}

// 1. Print Receipt
function printReceipt() {
    let printWindow = window.open('', '_blank', 'width=400,height=600');
    let content = document.querySelector('#receipt-modal .modal-content').innerHTML;
    content = content.replace(/<button.*?>.*?<\/button>/g, ''); // Remove buttons
    
    let html = `<html><head><title>Print Receipt</title><style>
        body { font-family: monospace; padding: 20px; color: #000; text-align: center; }
        table { width: 100%; font-size: 14px; margin-top: 15px; border-collapse: collapse; }
        th, td { border-bottom: 1px dashed #ccc; padding: 5px 0; text-align: left; }
        th:last-child, td:last-child { text-align: right; }
    </style></head><body>${content}
    <script>window.onload = function(){ setTimeout(()=>{window.print(); window.close();}, 200); }</script>
    </body></html>`;
    printWindow.document.write(html);
    printWindow.document.close();
}

// 2. Print Barcode Stickers — one small sticker per sample type/tube (see
// printBarcodeStickers()), not a full sheet of paper per barcode.
function printBarcodes() {
    const groups = groupTestsBySampleType();
    const stickers = Object.entries(groups).map(([sType, data]) => ({
        barcodeValue: data.barcode,
        caption: `${pendingTransaction.patient_name} · ${sType}`,
    }));
    printBarcodeStickers(stickers);
}

// Reprints the sticker for one already-booked test's sample/tube — same deterministic
// value sampleBarcodeValue() would have produced for it at checkout, so it matches
// whatever's physically on that tube already. Called from the "Print Barcode" button on
// each test's card in the visit-results modal (see renderVisitResultsModal()).
function printTestBarcode(visitCode, patientName, sampleType) {
    printBarcodeStickers([{
        barcodeValue: sampleBarcodeValue(visitCode, sampleType),
        caption: `${patientName} · ${sampleType}`,
    }]);
}

// 3. Print the Detailed Sampling Sheet (Matches your Image)
function printSamplingSheet() {
    const groups = groupTestsBySampleType();
    let printWindow = window.open('', '_blank', 'width=800,height=600');
    
    let rows = '';
    for (const [sType, data] of Object.entries(groups)) {
        const barcodeImg = generateBarcodeImage(data.barcode);
        data.tests.forEach((tName, index) => {
            rows += `
                <tr>
                    <td style="padding: 6px; border: 1px solid #000;">${tName}</td>
                    <td style="padding: 6px; border: 1px solid #000; text-align: center;">---</td>
                    <td style="padding: 6px; border: 1px solid #000; text-align: center;">
                        ${index === 0 ? `<img src="${barcodeImg}" style="height: 35px;"><br><small>${data.barcode}</small>` : ''}
                    </td>
                    <td style="padding: 6px; border: 1px solid #000;">${index === 0 ? sType : ''}</td>
                    <td style="padding: 6px; border: 1px solid #000; text-align: center;">Collected</td>
                </tr>
            `;
        });
    }

    let html = `
        <html><head><title>Sampling Details Sheet</title><style>
            body { font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; color: #000; }
            .header { display: flex; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 20px; font-size: 14px; }
            table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; }
            th { border: 1px solid #000; padding: 8px; background: #f8f8f8; text-align: left; }
        </style></head><body>
            <h2 style="text-align: center; text-decoration: underline; margin-bottom: 20px;">Sampling Details Sheet</h2>
            <div class="header">
                <div style="line-height: 1.5;">
                    <strong>Acc. No:</strong> ${pendingTransaction.transaction_id}<br>
                    <strong>Name:</strong> ${pendingTransaction.patient_name}<br>
                    <strong>Date:</strong> ${pendingTransaction.date}
                </div>
                <div style="line-height: 1.5;">
                    <strong>Patient Id:</strong> ${pendingTransaction.patient_id}<br>
                    <strong>Phone:</strong> ${pendingTransaction.patient_phone}<br>
                </div>
            </div>
            <table>
                <thead>
                    <tr><th>Test Name</th><th>---</th><th style="width: 150px; text-align:center;">Barcode</th><th>Sample</th><th>Status</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <script>window.onload = function(){ setTimeout(()=>{window.print(); window.close();}, 300); }</script>
        </body></html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
}

// 5. Draw the Receipt Modal
function generateReceipt() {
    document.getElementById('rec-name').textContent = pendingTransaction.patient_name;
    document.getElementById('rec-pid').textContent = pendingTransaction.patient_id;
    document.getElementById('rec-tid').textContent = pendingTransaction.transaction_id;
    document.getElementById('rec-date').textContent = pendingTransaction.date;
    
    document.getElementById('rec-table-body').innerHTML = pendingTransaction.tests.map((t, i) => `
        <tr>
            <td style="padding: 4px 0;">${t}</td>
            <td style="text-align: right; padding: 4px 0;">${pendingTransaction.prices[i].toFixed(2)} EGP</td>
        </tr>
    `).join('');

    document.getElementById('rec-subtotal').textContent = pendingTransaction.total_price.toFixed(2);
    document.getElementById('rec-discount').textContent = pendingTransaction.discount_percentage;
    document.getElementById('rec-method').textContent = pendingTransaction.payment_method;

    // TOTAL PAID reflects what was actually tendered now (amount_paid), not the discounted
    // total due — those only differ when a balance is left remaining.
    const amountPaid = pendingTransaction.amount_paid ?? pendingTransaction.final_payment;
    const remaining = pendingTransaction.remaining_fees || 0;
    document.getElementById('rec-total').textContent = amountPaid.toFixed(2);

    document.getElementById('rec-due-row').style.display = remaining > 0 ? 'block' : 'none';
    document.getElementById('rec-due').textContent = pendingTransaction.final_payment.toFixed(2);
    document.getElementById('rec-remaining-row').style.display = remaining > 0 ? 'block' : 'none';
    document.getElementById('rec-remaining').textContent = remaining.toFixed(2);

    document.getElementById('receipt-modal').style.display = 'block';
}

function closePaymentModal() {
    document.getElementById('payment-modal').style.display = 'none';
}

function closeReceiptModal() {
    document.getElementById('receipt-modal').style.display = 'none';
    pendingTransaction = {}; // Clear memory
}

// ==========================================
// SETTINGS PAGE LOGIC
// ==========================================

// Handles the real-time image preview when selecting a file
// ==========================================
// SETTINGS PAGE LOGIC & GLOBAL THEME
// ==========================================

function previewImage(inputElement, previewImageId, filenameInputId = null) {
    if (inputElement.files && inputElement.files[0]) {
        const file = inputElement.files[0];
        if (filenameInputId) document.getElementById(filenameInputId).value = file.name;

        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById(previewImageId).src = e.target.result;
        }
        reader.readAsDataURL(file);
    }
}

// 1. Save the chosen images to LocalStorage
// function saveSettings() {
//     const logoPreview = document.getElementById('settings-logo-preview').src;
//     const coverPreview = document.getElementById('settings-cover-preview').src;
//     const labName = document.getElementById('setting-lab-name').value;
//     const labSubtitle = document.getElementById('setting-lab-subtitle').value;
    
//     // Save to browser storage so it survives page refreshes
//     localStorage.setItem('lab_logo', logoPreview);
//     localStorage.setItem('lab_cover', coverPreview);
//     localStorage.setItem('lab_name', labName);
//     localStorage.setItem('lab_subtitle', labSubtitle);
    
//     // Apply changes immediately
//     applyGlobalSettings();
    
//     showAlert(t('interface_settings_updated', 'Interface settings updated successfully!'), 'success');
// }

async function saveSettings() {
    const payload = {
        lab_name: document.getElementById('setting-lab-name').value,
        lab_subtitle: document.getElementById('setting-lab-subtitle').value,
        msg_enabled: document.getElementById('setting-msg-enabled').checked,
        msg_method: document.getElementById('setting-msg-method').value,
        msg_phone: document.getElementById('setting-msg-phone').value,
        logo_path: document.getElementById('settings-logo-preview').src,
        cover_path: document.getElementById('settings-cover-preview').src,
        signature_path: document.getElementById('settings-signature-preview').src,
        signature_title: document.getElementById('setting-signature-title').value,
        show_report_background: document.getElementById('setting-show-report-background').checked,
        show_logo_on_report: document.getElementById('setting-show-logo-on-report').checked,
        lab_director: document.getElementById('setting-lab-director').value,
        doctor_qualification: document.getElementById('setting-doctor-qualification').value,
        doctor_reg_no: document.getElementById('setting-doctor-reg-no').value,
        tech_name: document.getElementById('setting-tech-name').value,
        tech_qualification: document.getElementById('setting-tech-qualification').value,
        tech_institute: document.getElementById('setting-tech-institute').value,
        lab_phone: document.getElementById('setting-lab-phone').value,
        lab_email: document.getElementById('setting-lab-email').value,
        lab_address: document.getElementById('setting-lab-address').value,
        social_facebook: document.getElementById('setting-social-facebook').value,
        social_instagram: document.getElementById('setting-social-instagram').value,
        social_twitter: document.getElementById('setting-social-twitter').value,
        report_footer_note: document.getElementById('setting-report-footer-note').value,
    };
    
    try {
        const response = await apiFetch('/api/lab/settings', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        
        if (response.ok) {
            showAlert(t('settings_saved_server', 'Settings saved to server!'), 'success');
            // Refresh local UI state after save
            applyGlobalSettings(); 
        } else {
            showAlert(t('settings_save_failed', 'Failed to save settings.'), 'error');
        }
    } catch (error) {
        console.error("Save error:", error);
        showAlert(t('server_connect_error', 'Error connecting to server.'), 'error');
    }
}


// 2. Apply the saved images to the Sidebar and Background
async function applyGlobalSettings() {
    try {
        const response = await apiFetch('/api/lab/settings');
        if (!response.ok) return;
        
        const settings = await response.json();
        const timestamp = new Date().getTime(); // Force browser to refresh images

        if (settings.force_logout_time) {
            systemPolicies.forceLogoutTime = settings.force_logout_time;
            document.getElementById('hr-force-logout-time').value = settings.force_logout_time;
            document.getElementById('display-logout-time').textContent = `Daily logout is set to: ${settings.force_logout_time} (admins/masters exempt)`;
        }

        if (settings.login_resume_time) {
            systemPolicies.loginResumeTime = settings.login_resume_time;
            document.getElementById('hr-login-resume-time').value = settings.login_resume_time;
            document.getElementById('display-resume-time').textContent = `Non-admin login resumes at: ${settings.login_resume_time}`;
        }

        if (settings.idle_logout_timeout !== undefined) {
            // Convert minutes to milliseconds for the background tracker
            const minutes = parseInt(settings.idle_logout_timeout);
            systemPolicies.idleLogoutMs = minutes > 0 ? minutes * 60 * 1000 : 0;
            const idleInput = document.getElementById('hr-idle-logout-timeout');
            if (idleInput) idleInput.value = settings.idle_logout_timeout;
        }
        // 1. Apply Logo
        if (settings.logo_path) {
            const sidebarLogo = document.getElementById('sidebar-logo');
            const settingsPreview = document.getElementById('settings-logo-preview');
        
            const isBase64 = settings.logo_path.startsWith('data:');
            const logoUrl = isBase64 ? settings.logo_path : `${settings.logo_path}?t=${timestamp}`;
        
            if (sidebarLogo) sidebarLogo.src = logoUrl;
            if (settingsPreview) settingsPreview.src = logoUrl;
        }
        // 1b. Apply Pathologist Signature (shown bottom-left of generated reports)
        if (settings.signature_path) {
            const signaturePreview = document.getElementById('settings-signature-preview');
            const isSigBase64 = settings.signature_path.startsWith('data:');
            const signatureUrl = isSigBase64 ? settings.signature_path : `${settings.signature_path}?t=${timestamp}`;
            if (signaturePreview) signaturePreview.src = signatureUrl;
        }
        if (settings.signature_title) {
            const signatureTitleInput = document.getElementById('setting-signature-title');
            if (signatureTitleInput) signatureTitleInput.value = settings.signature_title;
        }
        if (settings.theme) {
            localStorage.setItem('theme', settings.theme);
            
            if (settings.theme === 'light') {
                document.body.classList.add('light-mode');
            } else {
                document.body.classList.remove('light-mode');
            }
        }

        if (settings.msg_enabled !== undefined) {
            const msgCheckbox = document.getElementById('setting-msg-enabled');
            if (msgCheckbox) msgCheckbox.checked = settings.msg_enabled;
        }

        if (settings.msg_method) {
            const msgSelect = document.getElementById('setting-msg-method');
            if (msgSelect) msgSelect.value = settings.msg_method;
        }

        if (settings.msg_phone) {
            const msgPhone = document.getElementById('setting-msg-phone');
            if (msgPhone) msgPhone.value = settings.msg_phone;
        }

        // 2. Force the UI to update based on the loaded settings!
        if (typeof toggleMessagingOptions === 'function') {
            toggleMessagingOptions();
        }
        // 2. Apply Cover Background
        if (settings.cover_path) {
            // Similarly, handle base64 vs file path for the cover
            const isBase64 = settings.cover_path.startsWith('data:');
            const coverUrl = isBase64 ? settings.cover_path : `${settings.cover_path}?t=${timestamp}`;
        
            document.body.style.backgroundImage = `linear-gradient(to bottom, rgba(30, 41, 59, 0.65), rgba(15, 23, 42, 0.85)), url('${coverUrl}')`;
            document.body.style.backgroundSize = 'contain'; // shrink to fit the screen instead of cropping to fill it
            document.body.style.backgroundPosition = 'center';
            document.body.style.backgroundAttachment = 'fixed';
            document.body.style.backgroundRepeat = 'no-repeat';
            
            const coverPreview = document.getElementById('settings-cover-preview');
            if (coverPreview) coverPreview.src = coverUrl;
        }
        if (settings.show_report_background !== undefined) {
            const bgCheckbox = document.getElementById('setting-show-report-background');
            if (bgCheckbox) bgCheckbox.checked = !!settings.show_report_background;
        }
        if (settings.show_logo_on_report !== undefined) {
            const logoCheckbox = document.getElementById('setting-show-logo-on-report');
            if (logoCheckbox) logoCheckbox.checked = !!settings.show_logo_on_report;
        }

        // 3. Apply Report Branding fields (doctor/tech credentials, contact, social, footer)
        const reportBrandingFields = {
            lab_director: 'setting-lab-director',
            doctor_qualification: 'setting-doctor-qualification',
            doctor_reg_no: 'setting-doctor-reg-no',
            tech_name: 'setting-tech-name',
            tech_qualification: 'setting-tech-qualification',
            tech_institute: 'setting-tech-institute',
            lab_phone: 'setting-lab-phone',
            lab_email: 'setting-lab-email',
            lab_address: 'setting-lab-address',
            social_facebook: 'setting-social-facebook',
            social_instagram: 'setting-social-instagram',
            social_twitter: 'setting-social-twitter',
            report_footer_note: 'setting-report-footer-note',
        };
        Object.entries(reportBrandingFields).forEach(([key, elementId]) => {
            const el = document.getElementById(elementId);
            if (el && settings[key]) el.value = settings[key];
        });

        // 3. Apply Lab Name & Subtitle
        if (settings.lab_name) {
            const sidebarName = document.getElementById('sidebar-brand-name');
            if (sidebarName) sidebarName.textContent = settings.lab_name;
            const settingNameInput = document.getElementById('setting-lab-name');
            if (settingNameInput) settingNameInput.value = settings.lab_name;
        }
        
        if (settings.lab_subtitle) {
            const sidebarSub = document.getElementById('sidebar-brand-sub');
            if (sidebarSub) sidebarSub.textContent = settings.lab_subtitle;
            const settingSubInput = document.getElementById('setting-lab-subtitle');
            if (settingSubInput) settingSubInput.value = settings.lab_subtitle;
        }
    } catch (error) {
        console.error("Failed to load global settings:", error);
    }
}

// 3. Load these settings the exact second the page opens
document.addEventListener('DOMContentLoaded', () => {
    applyGlobalSettings();
});

function goToAddPatientTab() {
    // Look for the Lab version first ("add-client")
    const labTab = document.querySelector('.nav-tab[data-tab="add-client"]');
    // Look for the Clinic version second ("add-patient")
    const clinicTab = document.querySelector('.nav-tab[data-tab="add-patient"]');
    
    // Click whichever one actually exists on the page
    if (labTab) {
        labTab.click();
    } else if (clinicTab) {
        clinicTab.click();
    } else {
        console.error("Could not find the Add Patient tab in the sidebar.");
    }
}

// ==========================================
// TRANSACTIONS HISTORY & FINANCIAL DASHBOARD
// ==========================================

let allTransactions = [];

// 1. Fetch Transactions from Python Database
async function fetchTransactionsData() {
    try {
        // 1. USE APIFETCH FOR OFFLINE INTERCEPTION!
        const response = await apiFetch('/api/transactions');
        
        if (response.ok) {
            allTransactions = await response.json();
        } else if (response.status === 503) {
            console.warn("[Offline] Skipped transactions refresh. Using cached data.");
            // Do NOT wipe the array. Leave allTransactions exactly as it is!
        } else {
            console.error("Server error loading transactions.");
        }
        
        // Update both screens with whatever data we currently have
        if (typeof filterTransactions === 'function') filterTransactions();
        if (typeof calculateFinancials === 'function') calculateFinancials();
        populatePaymentMethodOptions();

    } catch (error) {
        console.error("Error loading transactions:", error);
    }
}

// Payment method field (checkout modal) is a free-text <input> with a <datalist> built
// from whatever payment_method values already exist in transaction history, plus a small
// default set so it's never empty before any transaction exists — typing a brand-new
// method is allowed, and using it on a transaction makes it a real suggestion next time.
const DEFAULT_PAYMENT_METHODS = ['Cash', 'Visa', 'InstaPay', 'Vodafone Cash'];

function populatePaymentMethodOptions() {
    const datalist = document.getElementById('pay-method-list');
    if (!datalist) return;
    const methods = [...new Set([
        ...DEFAULT_PAYMENT_METHODS,
        ...allTransactions.map(t => t.payment_method).filter(Boolean),
    ])].sort();
    datalist.innerHTML = methods.map(m => `<option value="${m}">`).join('');
}

// 2. Transaction History Table & Filtering
let transactionsHistoryPage = 1;

function filterTransactions() {
    transactionsHistoryPage = 1; // any filter change goes back to page 1
    fetchTransactionsHistoryPage();
}

function goToTransactionsHistoryPage(page) {
    transactionsHistoryPage = page;
    fetchTransactionsHistoryPage();
}

// Filtering and pagination happen server-side now (GET /api/transactions?...) instead of
// slicing/re-rendering the entire allTransactions array. That array stays fully loaded
// separately (fetchTransactionsData()) since calculateFinancials() needs the complete
// history for revenue totals — this only changes what this ONE table displays.
async function fetchTransactionsHistoryPage() {
    const container = document.getElementById('transactions-list-container');
    if (!container) return;

    const filterFrom = document.getElementById('trans-filter-date-from').value;
    const filterTo = document.getElementById('trans-filter-date-to').value;
    const unpaidOnly = document.getElementById('trans-filter-unpaid')?.checked || false;

    const params = new URLSearchParams({ page: transactionsHistoryPage, per_page: 100 });
    if (filterFrom) params.set('date_from', filterFrom);
    if (filterTo) params.set('date_to', filterTo);
    if (unpaidOnly) params.set('unpaid_only', 'true');

    let data = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0, total_remaining: 0 };
    try {
        const response = await apiFetch(`/api/transactions?${params.toString()}`);
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error('Failed to load transactions:', error);
    }

    const summary = document.getElementById('trans-remaining-summary');
    if (summary) {
        const totalRemaining = data.total_remaining || 0;
        if (totalRemaining > 0) {
            summary.style.display = 'block';
            summary.textContent = `🚩 Total Remaining to Collect: ${totalRemaining.toFixed(2)} EGP`;
        } else {
            summary.style.display = 'none';
        }
    }

    const filtered = data.items || [];
    lastFetchedTransactions = filtered; // for openCompletePaymentModal() to look up by id
    if (filtered.length === 0) {
        container.innerHTML = `<div class="glass-panel" style="padding: 30px; text-align: center; color: var(--muted);">${unpaidOnly ? t('empty_no_unpaid_transactions', 'No unpaid transactions found.') : t('empty_no_transactions_date', 'No transactions found for this date.')}</div>`;
        return;
    }

    let rows = filtered.map(t => {
        const remaining = t.remaining_fees || 0;
        const remainingCell = remaining > 0
            ? `<span class="pill danger">🚩 ${remaining.toFixed(2)} EGP owed</span>
               <button class="btn ghost" style="padding: 4px 10px; font-size: 11px; margin-left: 6px;" onclick="openCompletePaymentModal(${t.id})">💰 Complete Payment</button>`
            : `<span class="pill ok">Fully Paid</span>`;
        return `
        <tr>
            <td><input type="checkbox" class="transaction-checkbox" data-id="${t.id}" onchange="updateBulkDeleteTransactionsButton()"></td>
            <td style="color: var(--muted);">${formatCairoDateTime(t.date, false)}</td>
            <td><strong>${t.transaction_id}</strong></td>
            <td>${t.patient_name}</td>
            <td style="color: var(--muted); font-size: 12px;">${t.tests.join(', ')}</td>
            <td>${t.payment_method}</td>
            <td style="color: var(--warn);">${t.discount_percentage}%</td>
            <td style="color: var(--ok); font-weight: bold; text-align: right;">${(t.amount_paid ?? t.final_payment).toFixed(2)} EGP</td>
            <td style="text-align: right;">${remainingCell}</td>
        </tr>
    `;
    }).join('');

    container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h3 style="margin: 0; color: var(--text);"></h3>
            <div style="display: flex; gap: 8px;">
                <button id="bulk-delete-transactions-btn" class="btn btn-danger" style="display: none; padding: 6px 12px; font-size: 12px;" onclick="handleBulkDeleteTransactions()">🗑️ <span data-i18n="actions.delete_selected">Delete Selected</span></button>
                <button class="btn ghost" style="border-color: var(--ok); color: var(--ok); padding: 6px 12px; font-size: 12px;" onclick="exportTableToExcel(this, 'transaction_history', '#transactions-list-container')">📥 <span data-i18n="actions.export_excel">Export to Excel</span></button>
            </div>
        </div>
        <div class="table-container glass-panel">
            <table class="admin-table" style="width: 100%;">
                <thead>
                    <tr>
                        <th style="width: 32px;"><input type="checkbox" id="select-all-transactions" onclick="toggleAllTransactionCheckboxes(this)"></th>
                        <th>Date</th>
                        <th>Trans ID</th>
                        <th>Patient</th>
                        <th>Tests Included</th>
                        <th>Method</th>
                        <th>Discount</th>
                        <th style="text-align: right;">Paid</th>
                        <th style="text-align: right;">Remaining</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div id="transactions-history-pagination"></div>
    `;
    renderPaginationControls('transactions-history-pagination', data, 'goToTransactionsHistoryPage');
    applyTranslations(currentLang); // this table's markup (buttons above it) carries data-i18n and was just injected fresh
}

function toggleAllTransactionCheckboxes(checkbox) {
    document.querySelectorAll('.transaction-checkbox').forEach(cb => { cb.checked = checkbox.checked; });
    updateBulkDeleteTransactionsButton();
}

function updateBulkDeleteTransactionsButton() {
    const btn = document.getElementById('bulk-delete-transactions-btn');
    if (btn) btn.style.display = document.querySelectorAll('.transaction-checkbox:checked').length > 0 ? 'inline-block' : 'none';
}

async function handleBulkDeleteTransactions() {
    const ids = Array.from(document.querySelectorAll('.transaction-checkbox:checked')).map(cb => cb.dataset.id);
    if (ids.length === 0) return;
    if (!confirm(t('confirm_delete_transactions', 'Delete {count} transaction(s)? This cannot be undone and does not affect the underlying visit/order.', {count: ids.length}))) return;

    let succeeded = 0;
    const failures = [];
    for (const id of ids) {
        try {
            const response = await apiFetch(`/api/transactions/${id}`, { method: 'DELETE' });
            if (response.ok) {
                succeeded++;
            } else {
                const body = await response.json().catch(() => ({}));
                failures.push(`#${id}: ${body.error || response.status}`);
            }
        } catch (error) {
            failures.push(`#${id}: ${error.message}`);
        }
    }

    if (failures.length === 0) {
        showAlert(t('transactions_deleted', 'Deleted {count} transaction(s).', {count: succeeded}), 'success');
    } else if (succeeded === 0) {
        showAlert(t('transactions_delete_error', 'Error deleting transactions: {msg}', {msg: failures.join('; ')}), 'error');
    } else {
        showAlert(t('transactions_delete_partial', 'Deleted {ok} transaction(s); {failed} failed: {msg}', {ok: succeeded, failed: failures.length, msg: failures.join('; ')}), 'warn');
    }
    fetchTransactionsHistoryPage();
    fetchTransactionsSummary();
    fetchTransactionsData(); // keep Financial Overview's totals in sync too
}

// Today/this-week/this-month collected totals shown above the Transaction History table —
// computed server-side (see get_transactions_summary()) so it always reflects every
// matching transaction, not just whatever page happens to be loaded here.
async function fetchTransactionsSummary() {
    try {
        const response = await apiFetch('/api/transactions/summary');
        if (!response.ok) return;
        const data = await response.json();
        const setVal = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = `${(value || 0).toFixed(2)} EGP`;
        };
        setVal('trans-summary-today', data.today);
        setVal('trans-summary-week', data.this_week);
        setVal('trans-summary-month', data.this_month);
    } catch (error) {
        console.error('Failed to load transactions summary:', error);
    }
}

// --- COMPLETE PAYMENT (settle an outstanding balance from Transaction History) ---
let lastFetchedTransactions = [];
let completePaymentTransactionId = null;

function openCompletePaymentModal(transactionId) {
    const t = lastFetchedTransactions.find(row => row.id === transactionId);
    if (!t) return;
    completePaymentTransactionId = transactionId;

    const remaining = t.remaining_fees || 0;
    document.getElementById('cp-patient-name').textContent = t.patient_name;
    document.getElementById('cp-trans-id').textContent = t.transaction_id;
    document.getElementById('cp-remaining-fees').textContent = remaining.toFixed(2);
    document.getElementById('cp-amount-input').value = remaining.toFixed(2);

    document.getElementById('complete-payment-modal').style.display = 'block';
}

function closeCompletePaymentModal() {
    document.getElementById('complete-payment-modal').style.display = 'none';
    completePaymentTransactionId = null;
}

async function submitCompletePayment() {
    const amount = parseFloat(document.getElementById('cp-amount-input').value);
    if (!amount || amount <= 0) {
        showAlert(t('enter_valid_amount', 'Enter a valid amount.'), 'warn');
        return;
    }

    try {
        const response = await apiFetch(`/api/transactions/${completePaymentTransactionId}/payment`, {
            method: 'PUT',
            body: JSON.stringify({ amount }),
        });
        if (!response.ok) throw new Error('Server rejected payment update');

        closeCompletePaymentModal();
        showAlert(t('payment_recorded', 'Payment recorded!'), 'success');
        fetchTransactionsHistoryPage(); // re-fetch so the flag/columns update immediately
    } catch (error) {
        showAlert(t('payment_record_error', 'Error recording payment: {msg}', {msg: error.message}), 'error');
    }
}

// 3. Financial Dashboard Calculations
// 3. Financial Dashboard Calculations
// 3. Financial Dashboard Calculations
function calculateFinancials() {
    if (!document.getElementById('rev-daily')) return;

    const now = new Date();
    const todayStr = cairoDateStr(now);
    const monthStr = todayStr.substring(0, 7);
    const yearStr = todayStr.substring(0, 4);

    let dailyRev = 0, monthlyRev = 0, yearlyRev = 0;

    // A. Revenue Timeline Math (Last 7 Days)
    const revenueByDate = {};
    for (let i = 6; i >= 0; i--) {
        let d = new Date();
        d.setDate(d.getDate() - i);
        revenueByDate[cairoDateStr(d)] = 0;
    }

    allTransactions.forEach(t => {
        const payment = parseFloat(t.final_payment);
        const tDateStr = t.date.split(' ')[0]; 

        // Top KPI Math
        if (t.date.startsWith(todayStr)) dailyRev += payment;
        if (t.date.startsWith(monthStr)) monthlyRev += payment;
        if (t.date.startsWith(yearStr)) yearlyRev += payment;

        // Line Chart Math
        if (revenueByDate[tDateStr] !== undefined) {
            revenueByDate[tDateStr] += payment;
        }
    });

    // Update the UI text
    document.getElementById('rev-daily').textContent = dailyRev.toFixed(2);
    document.getElementById('rev-monthly').textContent = monthlyRev.toFixed(2);
    document.getElementById('rev-yearly').textContent = yearlyRev.toFixed(2);

    // B. Gender Distribution Math
    let males = 0, females = 0;
    clients.forEach(c => {
        // Safe check to handle uppercase/lowercase differences
        const gen = c.gender ? c.gender.toLowerCase() : '';
        if (gen === 'male') males++;
        else if (gen === 'female') females++;
    });

    // C. Test Demand Math (Using allTransactions instead of allVisits)
    const testCounts = {};
    allTransactions.forEach(t => {
        // Ensure tests exist and is recognized as an array
        if (t.tests && Array.isArray(t.tests)) {
            t.tests.forEach(test => {
                testCounts[test] = (testCounts[test] || 0) + 1;
            });
        }
    });
    
    // Sort and get Top 10 tests
    const sortedTests = Object.entries(testCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Draw the Charts!
    renderFinancialCharts(revenueByDate, { Male: males, Female: females }, sortedTests);
    let d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterdayStr = cairoDateStr(d);
    const yesterdayRev = revenueByDate[yesterdayStr] || 0;

    // If today is strictly better than yesterday, and we haven't notified yet today
    if (dailyRev > yesterdayRev && yesterdayRev > 0) {
        const lastNotifDate = localStorage.getItem('last_rev_notif_date');
        if (lastNotifDate !== todayStr) {
            addNotification(t('revenue_milestone', "Great job! Today's revenue ({today} EGP) surpassed yesterday's ({yesterday} EGP).", {today: dailyRev.toFixed(2), yesterday: yesterdayRev.toFixed(2)}), 'success');
            localStorage.setItem('last_rev_notif_date', todayStr);
        }
    }
}

// 4. Render Statistical Charts (Chart.js)
function renderFinancialCharts(revData, genderData, testData) {
    // Destroy old charts to prevent overlap
    if (revChartInstance) revChartInstance.destroy();
    if (genderChartInstance) genderChartInstance.destroy();
    if (testChartInstance) testChartInstance.destroy();

    // Global Chart Settings
    Chart.defaults.color = '#8aa6b8'; 
    Chart.defaults.font.family = "'DM Sans', sans-serif";

    // 1. Revenue Line Chart
    const revCtx = document.getElementById('revenueLineChart');
    if (revCtx) {
        revChartInstance = new Chart(revCtx, {
            type: 'line',
            data: {
                labels: Object.keys(revData),
                datasets: [{
                    label: 'Daily Revenue (EGP)',
                    data: Object.values(revData),
                    borderColor: '#5cbdb9', // Teal
                    backgroundColor: 'rgba(92, 189, 185, 0.2)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4, // Smooth curves
                    pointBackgroundColor: '#04121d',
                    pointBorderColor: '#5cbdb9'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    // 2. Gender Doughnut Chart
    const genCtx = document.getElementById('genderPieChart');
    if (genCtx) {
        genderChartInstance = new Chart(genCtx, {
            type: 'doughnut',
            data: {
                labels: ['Male', 'Female'],
                datasets: [{
                    data: [genderData.Male, genderData.Female],
                    backgroundColor: ['#3b82f6', '#ef6b6b'], // Blue & Red
                    borderWidth: 0,
                    hoverOffset: 10
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });
    }

    // 3. Top Tests Bar Chart
    const testCtx = document.getElementById('testDemandChart');
    if (testCtx) {
        testChartInstance = new Chart(testCtx, {
            type: 'bar',
            data: {
                labels: testData.map(t => t[0]), // Test Names
                datasets: [{
                    label: 'Times Demanded',
                    data: testData.map(t => t[1]), // Test Counts
                    backgroundColor: 'rgba(232, 192, 122, 0.8)', // Gold
                    borderColor: '#e8c07a',
                    borderWidth: 1,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

// ==========================================
// WAREHOUSE MANAGEMENT SYSTEM
// ==========================================

// Mirrors the exact admin/master check setupUIForRole() already uses to decide tab
// visibility — used here to gate warehouse actions that are admin-only server-side too
// (bill status changes, work-order approve/reject, batch disposal).
function isAdminUser() {
    return currentUser?.role === 'admin' || currentUser?.role === 'lab_master';
}

let warehouseExpiredFilterActive = false;

function toggleExpiredFilter() {
    warehouseExpiredFilterActive = !warehouseExpiredFilterActive;
    const btn = document.getElementById('warehouse-expired-filter-btn');
    if (btn) btn.style.background = warehouseExpiredFilterActive ? 'var(--danger)' : 'transparent';
    renderWarehouseTable();
}

async function fetchWarehouseData() {
    try {
        const response = await apiFetch('/api/warehouse');
        if (response.ok) {
            warehouseItems = await response.json();
            populateWarehouseCategoryOptions();
            renderWarehouseTable();
        }
    } catch (error) {
        console.error("Failed to load warehouse data", error);
    }

    const reviewBtn = document.getElementById('expired-batches-review-btn');
    if (reviewBtn) reviewBtn.style.display = isAdminUser() ? 'inline-block' : 'none';
}

// Category options used to be a hardcoded Chemical/Instruments/Housekeeping list that
// didn't match any category actually stored on warehouse_items — editing an item whose
// category wasn't one of those three silently showed a blank dropdown. Both the filter and
// the Add/Edit form now populate their options straight from whatever categories exist in
// the database, so they always stay in sync as items are added.
function populateWarehouseCategoryOptions() {
    const categories = [...new Set(warehouseItems.map(i => i.category).filter(Boolean))].sort();

    // Filter dropdown stays a strict <select> — filtering only makes sense against
    // categories that already exist.
    const filterSelect = document.getElementById('warehouse-filter-category');
    if (filterSelect) {
        const previousValue = filterSelect.value;
        filterSelect.innerHTML = '<option value="">All Categories</option>' +
            categories.map(c => `<option value="${c}">${c}</option>`).join('');
        if (categories.includes(previousValue)) filterSelect.value = previousValue;
    }

    // The Add/Edit form's category field is a free-text <input> with a <datalist> of
    // existing categories as suggestions — typing a brand-new category is allowed (and
    // saving that item makes it a real category, which then appears here too next load).
    const categoryDatalist = document.getElementById('warehouse-category-list');
    if (categoryDatalist) {
        categoryDatalist.innerHTML = categories.map(c => `<option value="${c}">`).join('');
    }
}

const WAREHOUSE_CATEGORY_COLORS = ['var(--danger)', 'var(--teal)', 'var(--warn)', 'var(--ok)', 'var(--gold)', 'var(--brand)'];

// Indexed by each category's position in the full sorted category list (not hashed) so
// distinct categories never collide on the same color as long as there are <=6 of them.
function categoryColor(category) {
    const categories = [...new Set(warehouseItems.map(i => i.category).filter(Boolean))].sort();
    const idx = categories.indexOf(category);
    return WAREHOUSE_CATEGORY_COLORS[idx >= 0 ? idx % WAREHOUSE_CATEGORY_COLORS.length : 0];
}

function renderWarehouseTable() {
    const container = document.getElementById('warehouse-list-container');
    if (!container) return;
    
    const searchTerm = document.getElementById('warehouse-search').value.toLowerCase();
    const filterCat = document.getElementById('warehouse-filter-category').value;
    
    let filtered = warehouseItems;

    if (filterCat) filtered = filtered.filter(i => i.category === filterCat);
    if (searchTerm) filtered = filtered.filter(i => i.name.toLowerCase().includes(searchTerm));
    if (warehouseExpiredFilterActive) filtered = filtered.filter(i => i.has_expired_batch);

    if (filtered.length === 0) {
        container.innerHTML = `<div class="table-container"><table style="width:100%;"><tr><td style="text-align:center; padding: 30px; color: var(--muted);">${t('empty_no_warehouse_items', 'No items found in warehouse.')}</td></tr></table></div>`;
        return;
    }

    let rows = filtered.map((item, index) => {
        let catColor = categoryColor(item.category || '');

        // Check if stock is critical
        let isCritical = item.quantity <= item.critical_level;
        let qtyColor = isCritical ? 'var(--danger)' : 'var(--text)'; 
        
        // Add the Order button if critical
        let orderBtn = isCritical
            ? `<button class="btn ghost" style="border-color: var(--danger); color: var(--danger); padding: 4px 8px; font-size: 11px; margin-right: 5px;" onclick="openNewBillModal(${item.id})">🚨 Order Stock</button>`
            : '';

        let expiredBadge = item.has_expired_batch
            ? `<span class="pill" style="color: var(--danger); border: 1px solid var(--danger); background: transparent; margin-left: 6px;" title="One or more batches of this item have expired">🚩 Expired batch</span>`
            : '';

        return `
        <tr>
            <td><input type="checkbox" class="warehouse-checkbox" data-id="${item.id}" onchange="updateBulkWarehouseBtn()"></td>
            <td>${index + 1}</td>
            <td><strong>${item.name}</strong>${expiredBadge}</td>
            <td><span class="pill" style="color: ${catColor}; border: 1px solid ${catColor}; background: transparent;">${item.category}</span></td>
            <td style="color: ${qtyColor}; font-weight: bold;">${item.quantity} <span style="font-size: 11px; color: var(--muted); font-weight: normal;">${item.unit}</span></td>
            <td style="color: var(--muted);">${formatCairoDateTime(item.updated_at, false)}</td>
            <td style="text-align: right;">
                ${orderBtn}
                <button type="button" class="btn ghost" style="padding: 4px 8px; font-size: 11px; margin-right: 5px;" onclick="openItemBatchesModal(${item.id})">🏷 Batches</button>
                <button type="button" class="btn ghost" style="padding: 4px 10px; font-size: 12px;" onclick="openWarehouseModal(${item.id})">Edit</button>
            </td>
        </tr>
    `}).join('');

    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th style="width: 40px;"><input type="checkbox" onclick="toggleAllWarehouseBoxes(this)"></th>
                        <th>#</th>
                        <th>Item Name</th>
                        <th>Category</th>
                        <th>Stock Level</th>
                        <th>Last Updated</th>
                        <th style="text-align: right;">Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
    updateBulkWarehouseBtn();
}

// --- Form & Modal Logic ---
function openWarehouseModal(itemId = null) {
    const title = document.getElementById('warehouse-modal-title');
    document.getElementById('warehouse-form').reset();
    document.getElementById('warehouse-id').value = '';
    
    if (itemId) {
        title.textContent = 'Edit Warehouse Item';
        const item = warehouseItems.find(i => i.id === itemId);
        if (item) {
            document.getElementById('warehouse-id').value = item.id;
            document.getElementById('warehouse-name').value = item.name;
            document.getElementById('warehouse-category').value = item.category;
            document.getElementById('warehouse-qty').value = item.quantity;
            document.getElementById('warehouse-critical').value = item.critical_level || 5; // NEW
            document.getElementById('warehouse-unit').value = item.unit;
        }
    } else {
        title.textContent = 'Add New Item';
    }
    
    document.getElementById('warehouse-modal').style.display = 'block';
}

function closeWarehouseModal() {
    document.getElementById('warehouse-modal').style.display = 'none';
}

async function saveWarehouseItem(event) {
    event.preventDefault();
    
    // Safely grab the critical level
    const criticalEl = document.getElementById('warehouse-critical');
    const criticalVal = criticalEl ? criticalEl.value : 5;

    const payload = {
        id: document.getElementById('warehouse-id').value,
        name: document.getElementById('warehouse-name').value,
        category: document.getElementById('warehouse-category').value,
        quantity: document.getElementById('warehouse-qty').value,
        critical_level: criticalVal, // 🚨 Ensure this is here
        unit: document.getElementById('warehouse-unit').value
    };

    try {
        const response = await apiFetch('/api/warehouse', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            showAlert(t('warehouse_item_saved', 'Warehouse item saved successfully!'), 'success');
            closeWarehouseModal();
            fetchWarehouseData();
        } else {
            showAlert(t('warehouse_item_save_failed_console', 'Failed to save item. Check console.'), 'error');
        }
    } catch (error) {
        showAlert(t('warehouse_item_save_failed', 'Failed to save item'), 'error');
    }
}

// --- Batches (expiry-dated stock) ---
function batchStatusPillClass(batch) {
    if (batch.is_expired) return 'danger';
    if (batch.status === 'disposed') return 'muted';
    if (batch.status === 'exhausted') return 'muted';
    return 'ok';
}

function batchStatusLabel(batch) {
    if (batch.is_expired) return t('status_expired_flag', '🚩 Expired');
    if (batch.status === 'disposed') return t('status_disposed', 'Disposed');
    if (batch.status === 'exhausted') return t('status_exhausted', 'Exhausted');
    return t('status_active', 'Active');
}

async function openItemBatchesModal(itemId) {
    const item = warehouseItems.find(i => i.id === itemId);
    document.getElementById('item-batches-title').textContent = `🏷 Batches — ${item ? item.name : ''}`;
    document.getElementById('item-batches-modal').style.display = 'block';
    const container = document.getElementById('item-batches-container');
    container.innerHTML = '<p style="text-align:center; padding:20px; color:var(--muted);">Loading…</p>';

    try {
        const response = await apiFetch(`/api/warehouse/batches?item_id=${itemId}`);
        if (!response.ok) throw new Error('Failed to load batches');
        const batches = await response.json();
        if (batches.length === 0) {
            container.innerHTML = `<p style="text-align:center; padding:20px; color:var(--muted);">${t('empty_no_batches', 'No batches received yet — receive a delivered bill to create one.')}</p>`;
            return;
        }
        const rows = batches.map(b => `
            <tr>
                <td style="color: ${b.is_expired ? 'var(--danger)' : 'var(--text)'}; font-weight: ${b.is_expired ? 'bold' : 'normal'};">${b.expiry_date}</td>
                <td>${b.quantity_received}</td>
                <td>${b.quantity_remaining} <span style="font-size: 11px; color: var(--muted);">${b.unit || ''}</span></td>
                <td><span class="pill" style="color: var(--${batchStatusPillClass(b)}); border: 1px solid var(--${batchStatusPillClass(b)}); background: transparent;">${batchStatusLabel(b)}</span></td>
                <td style="color: var(--muted); font-size: 11px;">${formatCairoDateTime(b.received_at, false)}</td>
                <td><button type="button" class="btn ghost" style="padding: 4px 8px; font-size: 11px;" onclick='printBatchBarcode(${JSON.stringify(b.barcode)}, ${JSON.stringify(b.item_name)}, ${JSON.stringify(b.expiry_date)})'>🖨️ Print</button></td>
            </tr>
        `).join('');
        container.innerHTML = `
            <div class="table-container">
                <table style="width:100%; font-size: 12px;">
                    <thead><tr><th>Expiry</th><th>Received</th><th>Remaining</th><th>Status</th><th>Received At</th><th></th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    } catch (error) {
        container.innerHTML = '<p style="text-align:center; padding:20px; color:var(--danger);">Failed to load batches.</p>';
    }
}

function printBatchBarcode(barcode, itemName, expiryDate) {
    const barcodeImg = generateBarcodeImage(barcode);
    const printWindow = window.open('', '_blank', 'width=500,height=400');
    const html = `
        <html><head><title>Batch Label — ${itemName}</title><style>
            body { font-family: Arial, sans-serif; padding: 20px; color: #000; text-align: center; }
            img { margin-top: 15px; }
        </style></head><body>
            <h3>${itemName}</h3>
            <p>Expiry: <strong>${expiryDate}</strong></p>
            <img src="${barcodeImg}">
            <script>window.onload=()=>{setTimeout(()=>{window.print();window.close();},200)}</script>
        </body></html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
}

// --- Receive into Warehouse (bill -> dated batch + barcode) ---
let currentReceiveBillId = null;
let lastReceivedBatch = null;

function openReceiveBatchModal(billId) {
    const bill = warehouseBills.find(b => b.id === billId);
    if (!bill) return;
    currentReceiveBillId = billId;
    lastReceivedBatch = null;

    document.getElementById('receive-batch-summary').textContent =
        `${bill.item_name} — ${bill.ordered_stock} ${bill.unit || ''} ordered`;
    document.getElementById('receive-quantity').value = bill.ordered_stock;
    document.getElementById('receive-expiry-date').value = '';
    document.getElementById('receive-batch-form').style.display = 'block';
    document.getElementById('receive-batch-result').style.display = 'none';
    document.getElementById('receive-batch-modal').style.display = 'block';
}

function closeReceiveBatchModal() {
    document.getElementById('receive-batch-modal').style.display = 'none';
    currentReceiveBillId = null;
    // Refresh whatever's behind this modal so "Receive" flips to "Received" / stock updates.
    fetchWarehouseData();
    if (document.getElementById('bills-history-modal').style.display === 'block') openBillsHistoryModal();
}

async function submitReceiveBatch() {
    const expiryDate = document.getElementById('receive-expiry-date').value;
    const quantity = parseInt(document.getElementById('receive-quantity').value) || 0;
    if (!expiryDate) {
        showAlert(t('expiry_date_required', 'Expiry date is required.'), 'error');
        return;
    }
    if (quantity <= 0) {
        showAlert(t('quantity_must_be_positive', 'Quantity received must be greater than zero.'), 'error');
        return;
    }

    try {
        const response = await apiFetch(`/api/warehouse/bills/${currentReceiveBillId}/receive`, {
            method: 'POST',
            body: JSON.stringify({ expiry_date: expiryDate, quantity_received: quantity }),
        });
        const body = await response.json();
        if (response.ok && body.success) {
            lastReceivedBatch = body;
            document.getElementById('receive-batch-form').style.display = 'none';
            document.getElementById('receive-batch-result').style.display = 'block';
            document.getElementById('receive-batch-barcode-img').src = generateBarcodeImage(body.barcode);
        } else {
            showAlert(body.error || t('batch_receive_failed', 'Failed to receive batch'), 'error');
        }
    } catch (error) {
        showAlert(t('batch_receive_error', 'Error receiving batch'), 'error');
    }
}

function printBatchBarcodeFromModal() {
    if (!lastReceivedBatch) return;
    printBatchBarcode(lastReceivedBatch.barcode, lastReceivedBatch.item_name, lastReceivedBatch.expiry_date);
}

// --- Expired batch disposal (admin-only) ---
async function openExpiredBatchesModal() {
    document.getElementById('expired-batches-modal').style.display = 'block';
    const container = document.getElementById('expired-batches-container');
    container.innerHTML = '<p style="text-align:center; padding:20px; color:var(--muted);">Loading…</p>';

    try {
        const response = await apiFetch('/api/warehouse/batches?expired_only=true');
        if (!response.ok) throw new Error('Failed to load expired batches');
        const batches = await response.json();
        if (batches.length === 0) {
            container.innerHTML = '<p style="text-align:center; padding:20px; color:var(--ok);">✅ No expired batches — nothing to review.</p>';
            return;
        }
        const rows = batches.map(b => `
            <tr>
                <td>${b.item_name}<div style="font-size: 11px; color: var(--muted);">${b.category || ''}</div></td>
                <td style="color: var(--danger); font-weight: bold;">${b.expiry_date}</td>
                <td>${b.quantity_remaining} <span style="font-size: 11px; color: var(--muted);">${b.unit || ''}</span></td>
                <td><button type="button" class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick='confirmDisposeBatch(${b.id}, ${JSON.stringify(b.item_name)}, ${b.quantity_remaining})'>🗑 Dispose</button></td>
            </tr>
        `).join('');
        container.innerHTML = `
            <div class="table-container">
                <table style="width:100%; font-size: 12px;">
                    <thead><tr><th>Item</th><th>Expiry</th><th>Remaining</th><th></th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    } catch (error) {
        container.innerHTML = '<p style="text-align:center; padding:20px; color:var(--danger);">Failed to load expired batches.</p>';
    }
}

async function confirmDisposeBatch(batchId, itemName, quantityRemaining) {
    const reason = prompt(`Dispose ${quantityRemaining} unit(s) of "${itemName}" — reason for disposal:`);
    if (reason === null) return; // cancelled
    if (!reason.trim()) {
        showAlert(t('disposal_reason_required', 'A disposal reason is required.'), 'error');
        return;
    }

    try {
        const response = await apiFetch(`/api/warehouse/batches/${batchId}/dispose`, {
            method: 'POST',
            body: JSON.stringify({ reason: reason.trim() }),
        });
        const body = await response.json();
        if (response.ok && body.success) {
            showAlert(t('batch_disposed', 'Disposed {count} unit(s).', {count: body.disposed_quantity}), 'success');
            openExpiredBatchesModal();
            fetchWarehouseData();
        } else {
            showAlert(body.error || t('batch_dispose_failed', 'Failed to dispose batch'), 'error');
        }
    } catch (error) {
        showAlert(t('batch_dispose_error', 'Error disposing batch'), 'error');
    }
}

// --- Checkboxes & Bulk Delete ---
function updateBulkWarehouseBtn() {
    const checked = document.querySelectorAll('.warehouse-checkbox:checked').length;
    document.getElementById('bulk-delete-warehouse-btn').style.display = checked > 0 ? 'block' : 'none';
    document.getElementById('new-work-order-btn').style.display = checked > 0 ? 'inline-block' : 'none';
}

function toggleAllWarehouseBoxes(masterBox) {
    document.querySelectorAll('.warehouse-checkbox').forEach(cb => cb.checked = masterBox.checked);
    updateBulkWarehouseBtn();
}

async function handleBulkDeleteWarehouse() {
    const checkboxes = document.querySelectorAll('.warehouse-checkbox:checked');
    const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
    if (ids.length === 0 || !confirm(t('confirm_delete_warehouse_items', 'Delete {count} item(s) from warehouse?', {count: ids.length}))) return;

    // Checked individually — an item with bills/batches/work orders on record is blocked
    // server-side (409, see delete_warehouse_item()), and blindly awaiting each request
    // without checking .ok used to report "deleted successfully" regardless either way.
    let succeeded = 0;
    const failures = [];
    for (const id of ids) {
        try {
            const response = await apiFetch(`/api/warehouse/${id}`, { method: 'DELETE' });
            if (response.ok) {
                succeeded++;
            } else {
                const body = await response.json().catch(() => ({}));
                failures.push(`#${id}: ${body.error || response.status}`);
            }
        } catch (error) {
            failures.push(`#${id}: ${error.message}`);
        }
    }

    if (failures.length === 0) {
        showAlert(t('items_deleted', 'Items deleted successfully!'), 'success');
    } else if (succeeded === 0) {
        showAlert(t('items_delete_error', 'Error deleting items: {msg}', {msg: failures.join('; ')}), 'error');
    } else {
        showAlert(t('items_delete_partial', 'Deleted {ok} item(s); {failed} failed: {msg}', {ok: succeeded, failed: failures.length, msg: failures.join('; ')}), 'warn');
    }
    fetchWarehouseData();
}

// --- Excel Import Engine for Warehouse ---
async function processWarehouseExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    showAlert(t('excel_reading_warehouse', 'Reading Warehouse Excel file...'), 'info');
    const reader = new FileReader();
    
    reader.onload = async function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array'});
            const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
            
            // 1. Create a map of existing items (using lowercase names for strict comparison)
            const existingItemsMap = new Map();
            warehouseItems.forEach(i => existingItemsMap.set(i.name.toLowerCase(), i));
            
            let successCount = 0;
            let skippedCount = 0;
            
            for (let row of json) {
                const cleanRow = {};
                for (let key in row) cleanRow[key.trim().toLowerCase()] = row[key];

                const name = cleanRow["item name"] || cleanRow["name"] || cleanRow["item"] || cleanRow["الاسم"] || cleanRow["الصنف"];
                if (!name) continue;

                // 2. Check for Duplication
                const normalizedName = String(name).trim().toLowerCase();
                
                if (existingItemsMap.has(normalizedName)) {
                    // Ask the user before proceeding
                    let addAnyway = confirm(
                        `⚠️ DUPLICATE FOUND!\n\n` +
                        `Item: "${name}"\n` +
                        `This item already exists in the warehouse.\n\n` +
                        `Do you want to add a duplicate anyway?\n` +
                        `[OK] = Add duplicate\n` +
                        `[Cancel] = Skip this item`
                    );
                    
                    if (!addAnyway) {
                        skippedCount++;
                        continue; // Skip to the next row
                    }
                }

                // Smart Category Matching
                let rawCat = String(cleanRow["category"] || cleanRow["القسم"] || cleanRow["النوع"] || "").toLowerCase();
                let category = "Housekeeping"; 
                if (rawCat.includes("chem") || rawCat.includes("كيماو")) category = "Chemical";
                if (rawCat.includes("inst") || rawCat.includes("أدا") || rawCat.includes("ادوات")) category = "Instruments";

                const payload = {
                    name: String(name).trim(),
                    category: category,
                    quantity: parseInt(cleanRow["quantity"] || cleanRow["qty"] || cleanRow["الكمية"]) || 0,
                    critical_level: parseInt(cleanRow["critical level"] || cleanRow["critical"] || 5),
                    unit: String(cleanRow["unit"] || cleanRow["الوحدة"] || "Pieces").trim()
                };

                const response = await apiFetch('/api/warehouse', {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
                
                if (response.ok) successCount++;
            }

            event.target.value = ''; 
            showAlert(t('warehouse_import_complete', 'Import complete: {added} added, {skipped} skipped.', {added: successCount, skipped: skippedCount}), 'success');
            fetchWarehouseData(); 

        } catch (error) {
            console.error("Excel Error:", error);
            showAlert(t('excel_parse_failed', 'Failed to parse Excel file.'), 'error');
        }
    };
    reader.readAsArrayBuffer(file);
}

// ==========================================
// WAREHOUSE BILLS ENGINE
// ==========================================

let warehouseBills = [];

function openNewBillModal(itemId) {
    const item = warehouseItems.find(i => i.id === itemId);
    if (!item) return;

    // Generate Order Data
    const now = new Date();
    const orderId = 'ORD-' + now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
    
    document.getElementById('new-bill-form').reset();
    document.getElementById('bill-item-id').value = item.id;
    document.getElementById('bill-order-id').value = orderId;
    document.getElementById('bill-date').value = now.toLocaleString();
    document.getElementById('bill-user').value = currentUser ? currentUser.username : 'Unknown User';
    document.getElementById('bill-category').value = item.category;
    document.getElementById('bill-item-name').textContent = item.name;
    document.getElementById('bill-present-stock').textContent = item.quantity;
    document.getElementById('bill-unit-label').textContent = item.unit;
    
    document.getElementById('new-bill-modal').style.display = 'block';
}

function calcBillTotal() {
    const qty = parseFloat(document.getElementById('bill-ordered-qty').value) || 0;
    const price = parseFloat(document.getElementById('bill-price').value) || 0;
    document.getElementById('bill-total').value = (qty * price).toFixed(2);
}

function printBillReceipt() {
    let printWindow = window.open('', '_blank', 'width=600,height=600');
    let html = `
        <html><head><title>Order Receipt</title><style>
            body { font-family: Arial, sans-serif; padding: 20px; color: #000; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ccc; padding: 10px; text-align: left; }
            th { background: #f4f4f4; }
        </style></head><body>
            <h2 style="text-align: center;">Warehouse Order Bill</h2>
            <p><strong>Order ID:</strong> ${document.getElementById('bill-order-id').value}</p>
            <p><strong>Date:</strong> ${document.getElementById('bill-date').value}</p>
            <p><strong>Ordered By:</strong> ${document.getElementById('bill-user').value}</p>
            <table>
                <tr><th>Item</th><td>${document.getElementById('bill-item-name').textContent} (${document.getElementById('bill-category').value})</td></tr>
                <tr><th>Present Stock</th><td>${document.getElementById('bill-present-stock').textContent} ${document.getElementById('bill-unit-label').textContent}</td></tr>
                <tr><th>Ordered Qty</th><td>${document.getElementById('bill-ordered-qty').value} ${document.getElementById('bill-unit-label').textContent}</td></tr>
                <tr><th>Price Per Unit</th><td>${document.getElementById('bill-price').value} EGP</td></tr>
                <tr><th>Total Price</th><td><strong>${document.getElementById('bill-total').value} EGP</strong></td></tr>
            </table>
            <script>window.onload=()=>{setTimeout(()=>{window.print();window.close();},200)}</script>
        </body></html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
}

async function saveWarehouseBill(event) {
    event.preventDefault();
    const payload = {
        order_id: document.getElementById('bill-order-id').value,
        item_id: document.getElementById('bill-item-id').value,
        item_name: document.getElementById('bill-item-name').textContent,
        present_stock: parseInt(document.getElementById('bill-present-stock').textContent),
        ordered_stock: parseInt(document.getElementById('bill-ordered-qty').value),
        unit: document.getElementById('bill-unit-label').textContent,
        price_per_unit: parseFloat(document.getElementById('bill-price').value),
        total_price: parseFloat(document.getElementById('bill-total').value),
        category: document.getElementById('bill-category').value,
        user: document.getElementById('bill-user').value,
        date_time: document.getElementById('bill-date').value
    };

    try {
        const response = await apiFetch('/api/warehouse/bills', {
            method: 'POST', body: JSON.stringify(payload)
        });
        if (response.ok) {
            showAlert(t('bill_saved', 'Bill saved successfully!'), 'success');
            document.getElementById('new-bill-modal').style.display = 'none';
        }
    } catch (error) {
        showAlert(t('bill_save_error', 'Error saving bill'), 'error');
    }
}

// --- New Bill (bulk-order every low-stock item in one go, creating grouped WarehouseBills) ---

function openBulkBillModal() {
    const criticalItems = warehouseItems.filter(i => i.quantity <= i.critical_level);
    const container = document.getElementById('bulk-bill-items-container');

    if (criticalItems.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--muted);">No items are currently low on stock.</div>';
    } else {
        const rows = criticalItems.map(item => {
            // Suggest restocking to 3x the critical level — a comfortable buffer above the
            // low-stock threshold. Fully editable, just a starting point.
            const suggestedQty = Math.max(1, item.critical_level * 3 - item.quantity);
            return `
            <tr data-item-id="${item.id}">
                <td><input type="checkbox" class="bb-item-checkbox" checked onchange="updateBulkBillSelectAllState()"></td>
                <td>${item.name}<div style="font-size: 11px; color: var(--muted);">${item.category}</div></td>
                <td style="color: var(--danger);">${item.quantity} <span style="color: var(--muted); font-size: 11px;">${item.unit}</span></td>
                <td><input type="number" class="bb-item-qty" min="1" value="${suggestedQty}" style="width: 90px;"></td>
                <td><input type="number" class="bb-item-price" min="0" step="0.01" placeholder="0.00" style="width: 100px;"></td>
            </tr>`;
        }).join('');

        container.innerHTML = `
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th style="width: 40px;"><input type="checkbox" id="bb-select-all" checked onclick="toggleAllBulkBillItems(this)"></th>
                            <th>Item</th>
                            <th>Current Stock</th>
                            <th>Order Qty</th>
                            <th>Price/Unit (EGP)</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }

    document.getElementById('bulk-bill-modal').style.display = 'block';
}

function toggleAllBulkBillItems(masterBox) {
    document.querySelectorAll('.bb-item-checkbox').forEach(cb => cb.checked = masterBox.checked);
}

function updateBulkBillSelectAllState() {
    const boxes = [...document.querySelectorAll('.bb-item-checkbox')];
    const selectAll = document.getElementById('bb-select-all');
    if (selectAll) selectAll.checked = boxes.length > 0 && boxes.every(cb => cb.checked);
}

function closeBulkBillModal() {
    document.getElementById('bulk-bill-modal').style.display = 'none';
}

async function submitBulkBill() {
    const rows = document.querySelectorAll('#bulk-bill-items-container tr[data-item-id]');
    const items = [];
    rows.forEach(row => {
        const checkbox = row.querySelector('.bb-item-checkbox');
        if (!checkbox || !checkbox.checked) return; // unchecked = excluded from this bill
        const qty = parseInt(row.querySelector('.bb-item-qty').value) || 0;
        const price = parseFloat(row.querySelector('.bb-item-price').value) || 0;
        if (qty > 0) {
            items.push({ item_id: parseInt(row.dataset.itemId), quantity: qty, price_per_unit: price });
        }
    });

    if (items.length === 0) {
        showAlert(t('select_item_with_quantity', 'Select at least one item with a quantity to order.'), 'error');
        return;
    }

    try {
        const response = await apiFetch('/api/warehouse/bulk-bills', {
            method: 'POST',
            body: JSON.stringify({
                items,
                user: currentUser ? currentUser.username : 'Unknown User',
                date_time: new Date().toLocaleString(),
            }),
        });
        const body = await response.json();
        if (response.ok && body.success) {
            showAlert(t('bill_created', 'Bill created with {count} item(s)!', {count: body.items_count}), 'success');
            closeBulkBillModal();
            fetchWarehouseData();
        } else {
            showAlert(body.error || t('bill_create_failed', 'Failed to create bill'), 'error');
        }
    } catch (error) {
        showAlert(t('bill_create_error', 'Error creating bill'), 'error');
    }
}

// --- Bills History ---
async function openBillsHistoryModal() {
    document.getElementById('bills-history-modal').style.display = 'block';
    
    try {
        const response = await apiFetch('/api/warehouse/bills');
        if (response.ok) {
            warehouseBills = await response.json();
            renderWarehouseBills();
        }
    } catch (error) {
        showAlert(t('bills_load_failed', 'Failed to load bills'), 'error');
    }
}

function billStatusPillClass(status) {
    return status === 'demanded' ? 'danger' : status === 'ordered' ? 'warn' : 'ok';
}

function billStatusOptionsHTML(currentStatus, onChangeAttr) {
    // Everyone with warehouse access can move a bill between Requested/Delivered — marking
    // stock as physically delivered is a routine receiving-desk action. "Confirmed" (ordered)
    // stays admin-only (server-enforced in update_bill_status()) — shown here as a disabled
    // option rather than hidden, so it's visible as a status this bill can reach without
    // looking like a broken/missing choice.
    const isAdmin = isAdminUser();
    return `
        <select onchange="${onChangeAttr}" style="padding: 4px; font-size: 11px; background: transparent; border: 1px solid var(--${billStatusPillClass(currentStatus)}); color: var(--${billStatusPillClass(currentStatus)}); border-radius: 4px;">
            <option value="demanded" ${currentStatus === 'demanded' ? 'selected' : ''}>${t('status_bill_requested', '🔴 Requested')}</option>
            <option value="ordered" ${currentStatus === 'ordered' ? 'selected' : ''} ${isAdmin ? '' : 'disabled'}>${t('status_bill_confirmed', '🟡 Confirmed')}${isAdmin ? '' : t('admin_only_suffix', ' (admin only)')}</option>
            <option value="delivered" ${currentStatus === 'delivered' ? 'selected' : ''}>${t('status_bill_delivered', '🟢 Delivered')}</option>
        </select>
    `;
}

// Bills created via the "New Bill" bulk flow share a work_order_id and collapse into one
// row here (click it to see every item in that order) instead of showing one row per item.
function renderWarehouseBills() {
    const container = document.getElementById('bills-history-container');
    if (warehouseBills.length === 0) {
        container.innerHTML = `<p style="text-align:center; padding:20px; color:var(--muted);">${t('empty_no_bills_history', 'No bills history available.')}</p>`;
        return;
    }

    const bulkBills = {};
    const standaloneBills = [];
    warehouseBills.forEach(b => {
        if (b.work_order_id) {
            (bulkBills[b.work_order_id] = bulkBills[b.work_order_id] || []).push(b);
        } else {
            standaloneBills.push(b);
        }
    });

    // A bulk bill's overall status is whichever of its items is least far along —
    // "Delivered" only once every item in it has actually been delivered.
    const groupStatus = (bills) => {
        if (bills.some(b => b.status === 'demanded')) return 'demanded';
        if (bills.some(b => b.status === 'ordered')) return 'ordered';
        return 'delivered';
    };

    const bulkBillRows = Object.entries(bulkBills).map(([bulkBillId, bills]) => {
        const status = groupStatus(bills);
        const totalPrice = bills.reduce((sum, b) => sum + (b.total_price || 0), 0);
        const deliveredCount = bills.filter(b => b.status === 'delivered').length;
        const receivedCount = bills.filter(b => b.received).length;
        const warehouseSummary = deliveredCount === 0
            ? '—'
            : `${receivedCount}/${deliveredCount} received`;
        return `
        <tr style="cursor: pointer;" onclick="openBulkBillDetail('${bulkBillId}')" title="View bill details">
            <td style="color: var(--muted); font-size: 11px;">${formatCairoDateTime(bills[0].date_time, false)}</td>
            <td><strong>${bulkBillId}</strong></td>
            <td>🧾 New Bill — ${bills.length} item${bills.length > 1 ? 's' : ''}</td>
            <td>—</td>
            <td>${totalPrice.toFixed(2)} EGP</td>
            <td style="color: var(--muted);">${bills[0].user}</td>
            <td onclick="event.stopPropagation()">
                ${billStatusOptionsHTML(status, `updateBulkBillGroupStatus('${bulkBillId}', this.value)`)}
            </td>
            <td style="color: var(--muted); font-size: 11px;">${warehouseSummary}</td>
        </tr>`;
    });

    const receiveCell = (b) => {
        if (b.status !== 'delivered') return '—';
        if (b.received) return '<span style="color: var(--ok); font-size: 11px;">✅ Received</span>';
        return `<button type="button" class="btn ghost" style="padding: 4px 8px; font-size: 11px;" onclick="openReceiveBatchModal(${b.id})">📥 Receive</button>`;
    };

    const standaloneRows = standaloneBills.map(b => `
        <tr>
            <td style="color: var(--muted); font-size: 11px;">${formatCairoDateTime(b.date_time, false)}</td>
            <td><strong>${b.order_id}</strong></td>
            <td>${b.item_name}</td>
            <td>${b.ordered_stock} <span style="font-size:10px; color:var(--muted)">${b.unit}</span></td>
            <td>${b.total_price} EGP</td>
            <td style="color: var(--muted);">${b.user}</td>
            <td>${billStatusOptionsHTML(b.status, `updateBillStatus(${b.id}, this.value)`)}</td>
            <td>${receiveCell(b)}</td>
        </tr>
    `);

    container.innerHTML = `
        <div class="table-container">
            <table style="width:100%; font-size: 12px;">
                <thead>
                    <tr><th>Date</th><th>Order ID</th><th>Item</th><th>Qty</th><th>Total</th><th>User</th><th>Status</th><th>Warehouse</th></tr>
                </thead>
                <tbody>${[...bulkBillRows, ...standaloneRows].join('')}</tbody>
            </table>
        </div>
    `;
}

async function updateBillStatus(billId, newStatus) {
    try {
        const response = await apiFetch(`/api/warehouse/bills/${billId}/status`, {
            method: 'PUT', body: JSON.stringify({ status: newStatus })
        });

        if (response.ok) {
            showAlert(t('bill_status_updated', 'Bill status updated!'), 'success');
            openBillsHistoryModal(); // refresh the list so the pill/status shown stays correct
        } else {
            const body = await response.json().catch(() => ({}));
            showAlert(body.error || t('bill_status_error_generic', 'Error updating status'), 'error');
        }
    } catch (error) {
        showAlert(t('bill_status_error_generic', 'Error updating status'), 'error');
    }
}

let currentBulkBillId = null;

function openBulkBillDetail(bulkBillId) {
    const bills = warehouseBills.filter(b => b.work_order_id === bulkBillId);
    if (bills.length === 0) return;
    currentBulkBillId = bulkBillId;

    document.getElementById('bb-detail-title').textContent = `🧾 New Bill ${bulkBillId}`;
    document.getElementById('bb-detail-subtitle').textContent = `${formatCairoDateTime(bills[0].date_time, false)} — Requested by ${bills[0].user}`;

    const status = bills.some(b => b.status === 'demanded') ? 'demanded'
        : bills.some(b => b.status === 'ordered') ? 'ordered' : 'delivered';
    const totalPrice = bills.reduce((sum, b) => sum + (b.total_price || 0), 0);

    const rows = bills.map(b => {
        let receiveCell = '—';
        if (b.status === 'delivered') {
            receiveCell = b.received
                ? '<span style="color: var(--ok); font-size: 11px;">✅ Received</span>'
                : `<button type="button" class="btn ghost" style="padding: 4px 8px; font-size: 11px;" onclick="openReceiveBatchModal(${b.id})">📥 Receive</button>`;
        }
        return `
        <tr>
            <td>${b.item_name}<div style="font-size: 11px; color: var(--muted);">${b.category}</div></td>
            <td>${b.ordered_stock} <span style="color: var(--muted); font-size: 11px;">${b.unit}</span></td>
            <td>${b.price_per_unit} EGP</td>
            <td>${b.total_price} EGP</td>
            <td>${receiveCell}</td>
        </tr>
    `;
    }).join('');

    document.getElementById('bb-detail-body').innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <span style="color: var(--text); font-weight: 600;">Status:</span>
            ${billStatusOptionsHTML(status, `updateBulkBillGroupStatus('${bulkBillId}', this.value)`)}
        </div>
        <div class="table-container">
            <table style="width: 100%;">
                <thead><tr><th>Item</th><th>Qty</th><th>Price/Unit</th><th>Subtotal</th><th>Warehouse</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div style="text-align: right; margin-top: 10px; color: var(--ok); font-weight: bold; font-size: 15px;">
            Total: ${totalPrice.toFixed(2)} EGP
        </div>
    `;

    document.getElementById('bulk-bill-detail-modal').style.display = 'block';
}

async function updateBulkBillGroupStatus(bulkBillId, newStatus) {
    try {
        const response = await apiFetch(`/api/warehouse/bulk-bills/${bulkBillId}/status`, {
            method: 'PUT', body: JSON.stringify({ status: newStatus })
        });

        if (response.ok) {
            showAlert(t('bill_status_updated', 'Bill status updated!'), 'success');
            await openBillsHistoryModal(); // refresh the list
            if (document.getElementById('bulk-bill-detail-modal').style.display === 'block') {
                openBulkBillDetail(bulkBillId); // refresh the open detail view too
            }
        } else {
            const body = await response.json().catch(() => ({}));
            showAlert(body.error || t('bill_status_error', 'Error updating bill status'), 'error');
        }
    } catch (error) {
        showAlert(t('bill_status_error', 'Error updating bill status'), 'error');
    }
}

function printBulkBill() {
    if (!currentBulkBillId) return;
    const bills = warehouseBills.filter(b => b.work_order_id === currentBulkBillId);
    if (bills.length === 0) return;

    const totalPrice = bills.reduce((sum, b) => sum + (b.total_price || 0), 0);
    const rows = bills.map(b => `
        <tr>
            <td>${b.item_name} (${b.category})</td>
            <td>${b.ordered_stock} ${b.unit}</td>
            <td>${b.price_per_unit} EGP</td>
            <td>${b.total_price} EGP</td>
        </tr>
    `).join('');

    const printWindow = window.open('', '_blank', 'width=700,height=700');
    const html = `
        <html><head><title>Bill ${currentBulkBillId}</title><style>
            body { font-family: Arial, sans-serif; padding: 20px; color: #000; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ccc; padding: 10px; text-align: left; }
            th { background: #f4f4f4; }
        </style></head><body>
            <h2 style="text-align: center;">Warehouse Bill</h2>
            <p><strong>Bill ID:</strong> ${currentBulkBillId}</p>
            <p><strong>Date:</strong> ${formatCairoDateTime(bills[0].date_time, false)}</p>
            <p><strong>Requested By:</strong> ${bills[0].user}</p>
            <table>
                <thead><tr><th>Item</th><th>Qty</th><th>Price/Unit</th><th>Subtotal</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p style="text-align: right; font-size: 16px; margin-top: 15px;"><strong>Total: ${totalPrice.toFixed(2)} EGP</strong></p>
            <script>window.onload=()=>{setTimeout(()=>{window.print();window.close();},200)}</script>
        </body></html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
}

// --- Work Order (issue/use up warehouse stock for hand-picked items) ---

let warehouseWorkOrders = [];

function openWorkOrderModal() {
    const checkboxes = document.querySelectorAll('.warehouse-checkbox:checked');
    const selectedIds = Array.from(checkboxes).map(cb => parseInt(cb.dataset.id));
    const selectedItems = warehouseItems.filter(i => selectedIds.includes(i.id));
    const container = document.getElementById('work-order-items-container');

    if (selectedItems.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--muted);">No items selected. Check some items in the warehouse table first.</div>';
    } else {
        // No max cap here anymore: a request no longer deducts stock at creation — it's just
        // a request that an admin must approve before any of it can actually be fulfilled
        // (one unit at a time, via barcode scan), so exceeding current stock is legitimate.
        const rows = selectedItems.map(item => `
            <tr data-item-id="${item.id}">
                <td>${item.name}<div style="font-size: 11px; color: var(--muted);">${item.category}</div></td>
                <td>${item.quantity} <span style="color: var(--muted); font-size: 11px;">${item.unit}</span></td>
                <td><input type="number" class="wo-item-qty" min="1" value="1" style="width: 90px;"></td>
            </tr>`).join('');

        container.innerHTML = `
            <div class="table-container">
                <table>
                    <thead>
                        <tr><th>Item</th><th>Current Stock</th><th>Quantity to Request</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }

    document.getElementById('work-order-modal').style.display = 'block';
}

function closeWorkOrderModal() {
    document.getElementById('work-order-modal').style.display = 'none';
}

async function submitWorkOrder() {
    const rows = document.querySelectorAll('#work-order-items-container tr[data-item-id]');
    const items = [];
    rows.forEach(row => {
        const qtyInput = row.querySelector('.wo-item-qty');
        const qty = parseInt(qtyInput.value) || 0;
        if (qty > 0) items.push({ item_id: parseInt(row.dataset.itemId), quantity: qty });
    });

    if (items.length === 0) {
        showAlert(t('enter_quantity_for_item', 'Enter a quantity for at least one item.'), 'error');
        return;
    }

    try {
        const response = await apiFetch('/api/warehouse/work-orders', {
            method: 'POST',
            body: JSON.stringify({
                items,
                user: currentUser ? currentUser.username : 'Unknown User',
                date_time: new Date().toLocaleString(),
            }),
        });
        const body = await response.json();
        if (response.ok && body.success) {
            showAlert(t('work_order_requested', 'Work order requested with {count} item(s) — awaiting admin approval.', {count: body.items_count}), 'success');
            closeWorkOrderModal();
            document.querySelectorAll('.warehouse-checkbox:checked').forEach(cb => cb.checked = false);
            updateBulkWarehouseBtn();
        } else {
            showAlert(body.error || t('work_order_create_failed', 'Failed to create work order'), 'error');
        }
    } catch (error) {
        showAlert(t('work_order_create_error', 'Error creating work order'), 'error');
    }
}

async function openWorkOrdersHistoryModal() {
    document.getElementById('work-orders-history-modal').style.display = 'block';

    try {
        const response = await apiFetch('/api/warehouse/work-orders');
        if (response.ok) {
            warehouseWorkOrders = await response.json();
            renderWarehouseWorkOrders();
        }
    } catch (error) {
        showAlert(t('work_orders_load_failed', 'Failed to load work orders'), 'error');
    }
}

// A work order's overall status is a derived aggregate over its per-item lines — same
// approach as groupStatus() for bills above, since there's no separate header/status row.
function workOrderGroupStatus(items) {
    if (items.some(i => i.status === 'requested')) return 'requested';
    if (items.every(i => i.status === 'rejected')) return 'rejected';
    if (items.some(i => i.status === 'approved')) return 'approved';
    return 'completed';
}

const WORK_ORDER_STATUS_PILL = { requested: 'danger', approved: 'warn', completed: 'ok', rejected: 'muted' };
function workOrderStatusLabelFor(status) {
    const labels = {
        requested: t('status_wo_requested', '🔴 Requested'),
        approved: t('status_wo_approved', '🟡 Approved'),
        completed: t('status_wo_completed', '🟢 Completed'),
        rejected: t('status_wo_rejected', '⚪ Rejected'),
    };
    return labels[status] || status;
}

function workOrderStatusPill(status) {
    const cls = WORK_ORDER_STATUS_PILL[status] || 'muted';
    return `<span class="pill" style="color: var(--${cls}); border: 1px solid var(--${cls}); background: transparent;">${workOrderStatusLabelFor(status)}</span>`;
}

// Each submission shares a work_order_id and collapses into one row here (click it to see
// every item taken in that work order) instead of showing one row per item.
function renderWarehouseWorkOrders() {
    const container = document.getElementById('work-orders-history-container');
    if (warehouseWorkOrders.length === 0) {
        container.innerHTML = `<p style="text-align:center; padding:20px; color:var(--muted);">${t('empty_no_work_orders', 'No work orders yet.')}</p>`;
        return;
    }

    const grouped = {};
    warehouseWorkOrders.forEach(r => {
        (grouped[r.work_order_id] = grouped[r.work_order_id] || []).push(r);
    });

    const rows = Object.entries(grouped).map(([workOrderId, items]) => {
        const itemsLabel = items.length === 1 ? items[0].item_name : `${items.length} items`;
        const status = workOrderGroupStatus(items);

        let actionBtns = '';
        if (status === 'requested' && isAdminUser()) {
            actionBtns = `
                <button type="button" class="btn ghost" style="border-color: var(--ok); color: var(--ok); padding: 4px 8px; font-size: 11px; margin-right: 5px;" onclick="event.stopPropagation(); approveWorkOrder('${workOrderId}')">✅ Approve</button>
                <button type="button" class="btn ghost" style="border-color: var(--danger); color: var(--danger); padding: 4px 8px; font-size: 11px;" onclick="event.stopPropagation(); rejectWorkOrder('${workOrderId}')">❌ Reject</button>
            `;
        } else if (status === 'approved') {
            actionBtns = `<button type="button" class="btn ghost" style="border-color: var(--teal); color: var(--teal); padding: 4px 8px; font-size: 11px;" onclick="event.stopPropagation(); openFulfillScanModal('${workOrderId}')">🔫 Fulfill via Scan</button>`;
        }

        return `
        <tr style="cursor: pointer;" onclick="openWorkOrderDetail('${workOrderId}')" title="View work order details">
            <td style="color: var(--muted); font-size: 11px;">${formatCairoDateTime(items[0].date_time, false)}</td>
            <td><strong>${workOrderId}</strong></td>
            <td>${itemsLabel}</td>
            <td style="color: var(--muted);">${items[0].user}</td>
            <td>${workOrderStatusPill(status)}</td>
            <td onclick="event.stopPropagation()">${actionBtns}</td>
        </tr>`;
    });

    container.innerHTML = `
        <div class="table-container">
            <table style="width:100%; font-size: 12px;">
                <thead><tr><th>Date</th><th>ID</th><th>Item/s</th><th>User</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>${rows.join('')}</tbody>
            </table>
        </div>
    `;
}

async function approveWorkOrder(workOrderId) {
    if (!confirm(t('confirm_approve_work_order', 'Approve work order {id}? The technician will then be able to fulfill it by scanning batch barcodes.', {id: workOrderId}))) return;
    try {
        const response = await apiFetch(`/api/warehouse/work-orders/${workOrderId}/approve`, { method: 'PUT' });
        const body = await response.json();
        if (response.ok && body.success) {
            showAlert(t('work_order_approved', 'Work order approved.'), 'success');
            openWorkOrdersHistoryModal();
        } else {
            showAlert(body.error || t('work_order_approve_failed', 'Failed to approve work order'), 'error');
        }
    } catch (error) {
        showAlert(t('work_order_approve_error', 'Error approving work order'), 'error');
    }
}

async function rejectWorkOrder(workOrderId) {
    if (!confirm(t('confirm_reject_work_order', 'Reject work order {id}? This cannot be undone.', {id: workOrderId}))) return;
    try {
        const response = await apiFetch(`/api/warehouse/work-orders/${workOrderId}/reject`, { method: 'PUT' });
        const body = await response.json();
        if (response.ok && body.success) {
            showAlert(t('work_order_rejected', 'Work order rejected.'), 'success');
            openWorkOrdersHistoryModal();
        } else {
            showAlert(body.error || t('work_order_reject_failed', 'Failed to reject work order'), 'error');
        }
    } catch (error) {
        showAlert(t('work_order_reject_error', 'Error rejecting work order'), 'error');
    }
}

let currentWorkOrderId = null;

function openWorkOrderDetail(workOrderId) {
    const items = warehouseWorkOrders.filter(r => r.work_order_id === workOrderId);
    if (items.length === 0) return;
    currentWorkOrderId = workOrderId;

    document.getElementById('wo-detail-title').textContent = `📦 Work Order ${workOrderId}`;
    document.getElementById('wo-detail-subtitle').textContent = `${formatCairoDateTime(items[0].date_time, false)} — Issued by ${items[0].user}`;

    const rows = items.map(i => `
        <tr>
            <td>${i.item_name}<div style="font-size: 11px; color: var(--muted);">${i.category}</div></td>
            <td>${i.quantity} <span style="color: var(--muted); font-size: 11px;">${i.unit}</span></td>
            <td>${i.quantity_fulfilled || 0} / ${i.quantity}</td>
            <td>${workOrderStatusPill(i.status)}</td>
        </tr>
    `).join('');

    document.getElementById('wo-detail-body').innerHTML = `
        <div class="table-container">
            <table style="width: 100%;">
                <thead><tr><th>Item</th><th>Quantity</th><th>Fulfilled</th><th>Status</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;

    document.getElementById('work-order-detail-modal').style.display = 'block';
}

// --- Fulfill via Scan (approved work order -> barcode-driven stock deduction) ---
let currentScanWorkOrderId = null;
let pendingFefoOverrideBarcode = null;

function fulfillScanFocusInput() {
    const input = document.getElementById('scan-input');
    if (input && document.getElementById('fulfill-scan-modal').style.display === 'block') input.focus();
}

async function openFulfillScanModal(workOrderId) {
    currentScanWorkOrderId = workOrderId;
    pendingFefoOverrideBarcode = null;
    document.getElementById('fulfill-scan-title').textContent = `🔫 Fulfill via Scan — ${workOrderId}`;
    document.getElementById('scan-feedback').innerHTML = '';
    document.getElementById('scan-input').value = '';
    document.getElementById('fulfill-scan-modal').style.display = 'block';
    renderFulfillScanProgress();

    const input = document.getElementById('scan-input');
    input.onblur = () => setTimeout(fulfillScanFocusInput, 50);
    input.focus();
}

function renderFulfillScanProgress() {
    const items = warehouseWorkOrders.filter(r => r.work_order_id === currentScanWorkOrderId);
    const rows = items.map(i => `
        <tr>
            <td>${i.item_name}</td>
            <td>${i.quantity_fulfilled || 0} / ${i.quantity} ${i.unit || ''}</td>
            <td>${workOrderStatusPill(i.status)}</td>
        </tr>
    `).join('');
    document.getElementById('fulfill-scan-progress').innerHTML = `
        <div class="table-container">
            <table style="width:100%; font-size: 12px;">
                <thead><tr><th>Item</th><th>Progress</th><th>Status</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function submitBatchScan(overrideBarcode, confirmOverride) {
    const input = document.getElementById('scan-input');
    const barcode = overrideBarcode || input.value.trim();
    input.value = ''; // clear immediately so the physical scanner can fire again right away

    if (!barcode) return;

    const feedback = document.getElementById('scan-feedback');
    try {
        const response = await apiFetch(`/api/warehouse/work-orders/${currentScanWorkOrderId}/scan`, {
            method: 'POST',
            body: JSON.stringify({ barcode, confirm_fefo_override: !!confirmOverride }),
        });
        const body = await response.json();

        if (response.ok && body.success) {
            feedback.innerHTML = `<div style="padding: 10px; margin-top: 10px; border-radius: 6px; background: rgba(16,185,129,0.15); color: var(--ok);">
                ✅ Scanned ${body.item_name} — ${body.line_fulfilled}/${body.line_requested} fulfilled${body.line_complete ? ' — line complete!' : ''}
            </div>`;
            // Refresh the underlying work-orders list so progress/status reflect the scan.
            const woResponse = await apiFetch('/api/warehouse/work-orders');
            if (woResponse.ok) warehouseWorkOrders = await woResponse.json();
            renderFulfillScanProgress();
            fetchWarehouseData();
        } else if (response.status === 409 && body.fefo_warning) {
            feedback.innerHTML = `<div style="padding: 10px; margin-top: 10px; border-radius: 6px; background: rgba(245,158,11,0.15); color: var(--warn);">
                ⚠️ ${body.message}
                <div style="margin-top: 8px;">
                    <button type="button" class="btn ghost" style="border-color: var(--warn); color: var(--warn); padding: 4px 10px; font-size: 12px;" onclick="submitBatchScan(${JSON.stringify(barcode)}, true)">Scan Anyway</button>
                </div>
            </div>`;
        } else {
            feedback.innerHTML = `<div style="padding: 10px; margin-top: 10px; border-radius: 6px; background: rgba(239,68,68,0.15); color: var(--danger);">❌ ${body.error || 'Scan failed'}</div>`;
        }
    } catch (error) {
        feedback.innerHTML = `<div style="padding: 10px; margin-top: 10px; border-radius: 6px; background: rgba(239,68,68,0.15); color: var(--danger);">❌ Error submitting scan</div>`;
    }

    input.focus();
}

function closeFulfillScanModal() {
    const input = document.getElementById('scan-input');
    if (input) input.onblur = null;
    document.getElementById('fulfill-scan-modal').style.display = 'none';
    currentScanWorkOrderId = null;
    openWorkOrdersHistoryModal();
}

function printWorkOrder() {
    if (!currentWorkOrderId) return;
    const items = warehouseWorkOrders.filter(r => r.work_order_id === currentWorkOrderId);
    if (items.length === 0) return;

    const rows = items.map(i => `
        <tr><td>${i.item_name} (${i.category})</td><td>${i.quantity} ${i.unit}</td></tr>
    `).join('');

    const printWindow = window.open('', '_blank', 'width=700,height=700');
    const html = `
        <html><head><title>Work Order ${currentWorkOrderId}</title><style>
            body { font-family: Arial, sans-serif; padding: 20px; color: #000; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ccc; padding: 10px; text-align: left; }
            th { background: #f4f4f4; }
        </style></head><body>
            <h2 style="text-align: center;">Warehouse Work Order</h2>
            <p><strong>Work Order ID:</strong> ${currentWorkOrderId}</p>
            <p><strong>Date:</strong> ${formatCairoDateTime(items[0].date_time, false)}</p>
            <p><strong>Issued By:</strong> ${items[0].user}</p>
            <table>
                <thead><tr><th>Item</th><th>Quantity</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <script>window.onload=()=>{setTimeout(()=>{window.print();window.close();},200)}</script>
        </body></html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
}

// ==========================================
// SECURITY, RBAC & USER MANAGEMENT
// ==========================================

let currentActiveRole = 'lab_master';

// 1. Fetch and Display Users in Settings
async function fetchUsers() {
    try {
        // UPDATED ENDPOINT: Added /auth
        const response = await fetch('/api/auth/users');
        const users = await response.json();
        
        const tbody = document.getElementById('settings-users-list');
        if (!tbody) return;

        tbody.innerHTML = users.map(u => `
            <tr>
                <td><strong>${u.username}</strong></td>
                <td>${u.role}</td>
                <td style="text-align: right;">
                    <button class="btn ghost" onclick="openAccessModal(${u.id}, '${u.permissions || ''}')">Manage Access</button>
                    ${u.role !== 'lab_master' ? `<button class="btn ghost" style="color: #ef4444;" onclick="deleteUser(${u.id})">Delete</button>` : ''}
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error("Failed to load users", error);
    }
}

// 2. Create New User
async function createNewUser() {
    const user = document.getElementById('new-username').value;
    const pass = document.getElementById('new-password').value;
    const role = document.getElementById('new-role').value;

    if (!user || !pass) return showAlert(t('fill_all_fields', 'Please fill in all fields'), 'warn');

    try {
        // UPDATED ENDPOINT: Added /auth
        const response = await fetch('/api/auth/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass, role: role })
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            return showAlert(result.error || t('user_create_failed', 'Failed to create user'), 'error');
        }
        
        document.getElementById('new-username').value = '';
        document.getElementById('new-password').value = '';
        fetchUsers();
        showAlert(t('user_created', 'User created successfully!'), 'success');
        addNotification(t('admin_created_user', 'Admin created a new system user: {user} ({role})', {user: user, role: role}), 'info');
    } catch (error) {
        showAlert(t('server_connect_failed', 'Failed to connect to server.'), 'error');
    }
}

// 3. Delete User
async function deleteUser(id) {
    if (!confirm(t('confirm_delete_user', 'Are you sure you want to delete this user?'))) return;
    try {
        // UPDATED ENDPOINT: Added /auth
        const response = await fetch(`/api/auth/users/${id}`, { method: 'DELETE' });
        
        if (!response.ok) throw new Error("Failed to delete");
        
        fetchUsers();
        showAlert(t('user_deleted', 'User deleted.'), 'success');
    } catch (error) {
        showAlert(t('user_delete_error', 'Error deleting user.'), 'error');
    }
}

// 4. THE SECURITY BOUNCER (Role Enforcement)
function switchRole(role, isInitialLoad = false) {
    currentActiveRole = role;
    
    // Select all the sensitive tabs in the sidebar
    const settingsTab = document.querySelector('.nav-tab[data-tab="settings"]');
    const financialTab = document.querySelector('.nav-tab[data-tab="financial-overview"]');
    const historyTab = document.querySelector('.nav-tab[data-tab="transaction-history"]');
    
    // Reset everything to visible first
    if(settingsTab) settingsTab.style.display = 'flex';
    if(financialTab) financialTab.style.display = 'flex';
    if(historyTab) historyTab.style.display = 'flex';

    // Apply strict rules based on the user's role
    if (role === 'lab_master') {
        // Lab Master sees EVERYTHING. No restrictions.
        console.log("Logged in as Lab Master");
        
    } 
    else if (role === 'Admin') {
        // Admin owns the lab, but doesn't handle software configuration.
        // Hide: Settings
        if(settingsTab) settingsTab.style.display = 'none';
        
        // If they were on the settings tab, kick them out to the dashboard
        if (document.getElementById('settings').classList.contains('active-tab')) {
            document.querySelector('.nav-tab[data-tab="dashboard"]').click();
        }
    } 
    else if (role === 'User') {
        // Secretary only handles daily patient flow.
        // Hide: Settings, Financials, Transaction History
        if(settingsTab) settingsTab.style.display = 'none';
        if(financialTab) financialTab.style.display = 'none';
        if(historyTab) historyTab.style.display = 'none';
        
        // Kick them out if they are on a forbidden tab
        const activeTab = document.querySelector('.tab-content.active-tab');
        if (activeTab && (activeTab.id === 'settings' || activeTab.id === 'financial-overview' || activeTab.id === 'transaction-history')) {
            document.querySelector('.nav-tab[data-tab="dashboard"]').click();
        }
    
    }
    if (!isInitialLoad) {
        showAlert(t('role_switched', 'Role switched to {role}. Interface updated.', {role: role}), 'success');
    }
    
}


// Load users when app starts
// 5. Check Real Login & Enforce Security Automatically
async function initializeUserSecurity() {
    try {
        // Ask the Python backend who is currently logged in
        const response = await fetch('/api/auth/current_user');
        if (!response.ok) return; 

        const userData = await response.json();
        let realRole = userData.role;

        // Check if this is your JSON Master Account
        if (userData.id && String(userData.id).startsWith('master_')) {
            realRole = 'lab_master';
            
            // UNHIDE the Role Simulator dropdown because YOU are logged in
            const simulator = document.getElementById('role-simulator-container');
            if (simulator) simulator.style.display = 'flex';
            
            // Load the settings users (Only Master needs this)
            fetchUsers();
        } else {
            // Keep the simulator completely hidden for Admins and Secretaries
            const simulator = document.getElementById('role-simulator-container');
            if (simulator) simulator.style.display = 'none';
        }

        // IMMEDIATELY apply the UI restrictions based on their real role
        // We pass 'true' so it doesn't show the green popup on page load
        switchRole(realRole, true);

    } catch (error) {
        console.error("Failed to verify user session", error);
    }
}

// Add this to your main setup (or bottom of script_lab.js)
document.addEventListener('click', function(e) {
    // Close all dropdowns if clicking outside
    if (!e.target.matches('.btn.ghost')) {
        document.querySelectorAll('.action-dropdown-content').forEach(d => d.style.display = 'none');
    }
    
    // Open the one that was clicked
    if (e.target.matches('.btn.ghost') && e.target.nextElementSibling?.classList.contains('action-dropdown-content')) {
        const content = e.target.nextElementSibling;
        content.style.display = content.style.display === 'block' ? 'none' : 'block';
    }
});

// ==========================================
// EXCEL EXPORT ENGINE — real .xlsx workbooks via the SheetJS library already loaded for
// Excel *import* (index_lab.html's xlsx.full.min.js), not a .csv file wearing an "Excel"
// label. Every "📥 Export to Excel" button across the app calls this.
// ==========================================
function exportTableToExcel(btnElement, filename, containerSelector) {
    // Most callers render the export button inside a header row that's immediately
    // followed by a sibling ".table-container" holding the actual table — target that
    // specific table instead of "the first table anywhere in this tab/modal". The Dashboard
    // tab in particular has a second, unrelated 5-row "Latest Registered Clients" table
    // earlier in the DOM; searching the whole tab-content grabbed that one instead of the
    // KPI drill-down table the button actually belongs to. A caller whose button sits one
    // level deeper (e.g. grouped with other action buttons in their own wrapper div, so
    // "next sibling of the button's parent" isn't the table container) passes an explicit
    // containerSelector instead of relying on this relative-DOM guess.
    const table = containerSelector
        ? document.querySelector(containerSelector)?.querySelector('table')
        : btnElement.parentElement?.nextElementSibling?.querySelector('table');

    if (!table) {
        showAlert(t('no_table_to_export', 'Error: No table found to export.'), 'error');
        return;
    }

    const rows = table.querySelectorAll('tr');

    // Identify the "Action"/checkbox columns so we don't export buttons or checkbox cells.
    let actionColIndex = -1;
    let checkboxColIndex = -1;
    const headers = table.querySelectorAll('th');
    headers.forEach((th, index) => {
        if (th.innerText.includes('Action') || th.innerText.includes('إجراء')) {
            actionColIndex = index;
        }
        if (th.querySelector('input[type="checkbox"]')) {
            checkboxColIndex = index;
        }
    });

    const sheetData = [];
    for (let i = 0; i < rows.length; i++) {
        const row = [];
        const cols = rows[i].querySelectorAll('td, th');

        for (let j = 0; j < cols.length; j++) {
            if (j === actionColIndex || j === checkboxColIndex) continue;
            if (cols[j].querySelector('input[type="checkbox"]')) continue;
            row.push(cols[j].innerText.replace(/(\r\n|\n|\r)/gm, ' ').trim());
        }
        sheetData.push(row);
    }

    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    XLSX.writeFile(workbook, (filename || 'export') + '.xlsx');
}
// ==========================================
// EXCEL IMPORT ENGINE (PATIENTS / CLIENTS)
// ==========================================
async function processPatientExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    showAlert(t('excel_reading_patients', 'Reading Patient Excel file... Please wait.'), 'info');

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array'});
            const firstSheetName = workbook.SheetNames[0];
            const json = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName]);
            
            if (json.length === 0) {
                showAlert(t('excel_sheet_empty', 'The Excel sheet is empty.'), 'warn');
                return;
            }

            // 1. Create a map of existing patients to check for duplicates
            // We combine First+Last Name and Phone to make a unique key
            const existingPatientsMap = new Set();
            clients.forEach(c => {
                const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase();
                const phone = (c.phone || '').trim();
                existingPatientsMap.add(`${fullName}-${phone}`);
            });

            let toImport = [];

            // 2. Loop and map the Excel rows
            for (let row of json) {
                // Clean headers
                const cleanRow = {};
                for (let key in row) {
                    cleanRow[key.trim().toLowerCase()] = row[key];
                }

                // A. Handle Names (If they only provide one "Name" column, split it into First/Last)
                let rawName = cleanRow["name"] || cleanRow["patient name"] || cleanRow["اسم المريض"] || cleanRow["الاسم"] || cleanRow["اسم الحالة"] || cleanRow["المريض"] || cleanRow["الاسم بالكامل"] || cleanRow["اسم"] || "";
                let fName = cleanRow["first name"] || cleanRow["الاسم الاول"] || "";
                let lName = cleanRow["last name"] || cleanRow["اسم العائلة"] || cleanRow["اللقب"] || "";

                if (!fName && rawName) {
                    const parts = rawName.toString().trim().split(" ");
                    fName = parts[0];
                    lName = parts.slice(1).join(" ") || "Unknown"; 
                }

                if (!fName) continue; // Skip completely blank rows

                // B. Handle Phone (Bulletproof Arabic Matching)
                let phoneRaw = cleanRow["phone"] || cleanRow["mobile"] || cleanRow["رقم الهاتف"] || cleanRow["الموبايل"] || cleanRow["تليفون"] || cleanRow["رقم الجوال"] || cleanRow["رقم الموبايل"] || cleanRow["التليفون"] || cleanRow["موبايل"] || "";
                
                // Clean the phone number (remove anything that isn't a number)
                let phone = phoneRaw.toString().replace(/[^0-9]/g, '');
                
                // 🚨 NEW: If the phone is blank or too short, send a dummy number that passes validation
                if (!phone || phone.length < 8) {
                    phone = "00000000000"; 
                } else if (!phone.startsWith("0")) {
                    phone = "0" + phone;
                }

                // C. Handle Gender
                let genderRaw = cleanRow["gender"] || cleanRow["sex"] || cleanRow["النوع"] || cleanRow["الجنس"] || cleanRow["ذكر/انثى"] || "Male";
                genderRaw = genderRaw.toString().toLowerCase().trim();
                let gender = (genderRaw.includes("f") || genderRaw.includes("انثى") || genderRaw.includes("أنثى") || genderRaw.includes("أنثي") || genderRaw === "أنثي") ? "Female" : "Male";

                // D. Handle DOB / Age
                let dob = cleanRow["dob"] || cleanRow["date of birth"] || cleanRow["تاريخ الميلاد"] || cleanRow["الميلاد"] || "1990-01-01";
                let age = cleanRow["age"] || cleanRow["السن"] || cleanRow["العمر"] || "";

                if (age && dob === "1990-01-01") {
                    const currentYear = new Date().getFullYear();
                    const calculatedYear = currentYear - parseInt(age);
                    dob = `${calculatedYear}-01-01`;
                }

                // 🚨 NEW: Absolute Failsafe Payload. Every field is guaranteed to be valid.
                const payload = {
                    first_name: fName.trim() || "Unknown",
                    last_name: lName.trim() || "Unknown",
                    phone: phone, // Will be 00000000000 if it was missing in Excel
                    gender: gender || "Male",
                    date_of_birth: dob || "1990-01-01",
                    contact_person: "Self"
                };

                // 3. Duplicate Check
                const checkKey = `${payload.first_name.toLowerCase()} ${payload.last_name.toLowerCase()}-${payload.phone}`;

                if (existingPatientsMap.has(checkKey)) {
                    let addAnyway = confirm(
                        `⚠️ DUPLICATE FOUND!\n\n` +
                        `Patient: "${payload.first_name} ${payload.last_name}"\n` +
                        `Phone: ${payload.phone || "N/A"}\n\n` +
                        `This patient already exists. Add anyway?\n` +
                        `[OK] = Add Duplicate\n` +
                        `[Cancel] = Skip`
                    );
                    
                    if (addAnyway) toImport.push(payload);
                } else {
                    toImport.push(payload);
                }
            }

            if (toImport.length === 0) {
                showAlert(t('no_new_patients', 'No new patients to import.'), 'info');
                event.target.value = ''; // Reset input
                return;
            }

            showAlert(t('importing_patients', 'Importing {count} patients...', {count: toImport.length}), 'info');
            let successCount = 0;

            // 4. Send to Database (With Error Logging!)
            for (let payload of toImport) {
                const response = await fetch('/api/clients', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-App-Mode': typeof currentWorkspace !== 'undefined' ? currentWorkspace : 'lab'
                    },
                    body: JSON.stringify(payload)
                });
                
                if (response.ok) {
                    successCount++;
                } else {
                    // If Python rejects it, print the exact error so we can read it!
                    const errorText = await response.text();
                    console.error(`Backend rejected patient ${payload.first_name}:`, errorText);
                }
            }

            // 5. Clean up and Refresh UI
            event.target.value = ''; 
            showAlert(t('patients_imported', 'Successfully imported {count} patients!', {count: successCount}), 'success');
            
            // Instantly redraw the tables and KPIs
            await loadInitialData(); 
            showTab('clients');

        } catch (error) {
            console.error("Excel Parsing Error:", error);
            showAlert(t('excel_parse_failed_format', "Failed to parse the Excel file. Make sure it's a valid .xlsx or .csv"), 'error');
        }
    };
    
    // Start reading the file
    reader.readAsArrayBuffer(file);
}

// ==========================================
// EXCEL IMPORT ENGINE (TEST DIRECTORY)
// ==========================================

// Helper Function: Makes test matching "Fuzzy"
// It strips out punctuation, extra spaces, and common filler words (English & Arabic)
function getStandardizedTestName(name) {
    if (!name) return "";
    
    // Convert to lowercase and remove weird punctuation (keep letters, numbers, and Arabic characters)
    let n = name.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF\s]/g, '').trim();
    
    // Strip common filler words that cause false mismatches
    n = n.replace(/\b(analysis|examination|routine|test|profile|assay)\b/g, ' ');
    n = n.replace(/\b(تحليل|فحص|روتين|عينة)\b/g, ' ');
    
    // Remove extra spaces and return
    return n.replace(/\s+/g, ' ').trim();
}

// Tests have a nested "Parameters" table (Settings > Test List > "Parameters") that never
// appears in the Test Directory's own visible table — a plain generic table-scrape
// (exportTableToExcel()) has no way to see it, so this exports Tests and Parameters as two
// linked sheets in one workbook instead: "Parameters" carries a "Test Name" column back to
// its parent test, which processExcelImport() below reads to recreate each test's
// parameters on import. Formula fields (relation_formula/absolute_count_formula) are
// deliberately left out — they reference sibling parameters by internal numeric {id}, which
// wouldn't mean anything after re-import creates fresh rows with new ids.
async function exportTestsWithParameters() {
    if (!availableTests || availableTests.length === 0) {
        showAlert(t('no_table_to_export', 'Error: No table found to export.'), 'error');
        return;
    }

    const testsSheet = availableTests.map(test => ({
        'Test Name': test.name,
        'Sample Type': test.sample_type || '',
        'Price': test.price,
    }));

    const parameterRows = [];
    for (const test of availableTests) {
        try {
            const response = await apiFetch(`/api/lab-tests/${test.id}/parameters`);
            if (!response.ok) continue;
            const params = await response.json();
            params.forEach(p => {
                parameterRows.push({
                    'Test Name': test.name,
                    'Parameter Name': p.name,
                    'Unit': p.unit || '',
                    'Method': p.method || '',
                    'Ref Low': p.ref_low ?? '',
                    'Ref High': p.ref_high ?? '',
                    'Reference Range (display)': p.reference_range_text || '',
                    'Abnormal Interpretation': p.abnormal_note || '',
                    'Gender Specific': p.gender_specific ? 'Yes' : 'No',
                    'Ref Low (Male)': p.ref_low_male ?? '',
                    'Ref High (Male)': p.ref_high_male ?? '',
                    'Ref Low (Female)': p.ref_low_female ?? '',
                    'Ref High (Female)': p.ref_high_female ?? '',
                });
            });
        } catch (error) {
            console.error(`Failed to load parameters for test "${test.name}":`, error);
        }
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(testsSheet), 'Tests');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(parameterRows), 'Parameters');
    XLSX.writeFile(workbook, 'test_directory.xlsx');
}

async function processExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    showAlert(t('excel_reading_generic', 'Reading Excel file... Please wait.'), 'info');

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, {type: 'array'});

            // A workbook from exportTestsWithParameters() names its two sheets explicitly;
            // fall back to "whichever sheet is first" for a plain single-sheet file someone
            // built by hand (unnamed, or named something else entirely) — same leniency the
            // column-name matching below already has.
            const testsSheetName = workbook.SheetNames.includes('Tests') ? 'Tests' : workbook.SheetNames[0];
            const worksheet = workbook.Sheets[testsSheetName];
            const json = XLSX.utils.sheet_to_json(worksheet);

            if (json.length === 0) {
                showAlert(t('excel_sheet_empty', 'The Excel sheet is empty.'), 'warn');
                return;
            }

            // Parameters sheet is optional — a plain Tests-only import (no nested data)
            // still works exactly as before. Rows are grouped by their own normalized test
            // name (same normalization as the duplicate-detection below) so "CBC " and "cbc"
            // on the Parameters sheet both attach to a Tests-sheet row named "CBC".
            const parametersByTestName = new Map();
            if (workbook.SheetNames.includes('Parameters')) {
                const paramRows = XLSX.utils.sheet_to_json(workbook.Sheets['Parameters']);
                paramRows.forEach(row => {
                    const cleanRow = {};
                    for (let key in row) cleanRow[key.trim().toLowerCase()] = row[key];
                    const forTest = getStandardizedTestName(cleanRow['test name'] || '');
                    const paramName = (cleanRow['parameter name'] || '').toString().trim();
                    if (!forTest || !paramName) return;
                    const parsed = {
                        name: paramName,
                        unit: (cleanRow['unit'] || '').toString().trim() || null,
                        method: (cleanRow['method'] || '').toString().trim() || null,
                        ref_low: cleanRow['ref low'] !== undefined && cleanRow['ref low'] !== '' ? parseFloat(cleanRow['ref low']) : null,
                        ref_high: cleanRow['ref high'] !== undefined && cleanRow['ref high'] !== '' ? parseFloat(cleanRow['ref high']) : null,
                        reference_range_text: (cleanRow['reference range (display)'] || '').toString().trim() || null,
                        abnormal_note: (cleanRow['abnormal interpretation'] || '').toString().trim() || null,
                        gender_specific: ['yes', 'true', '1'].includes((cleanRow['gender specific'] || '').toString().trim().toLowerCase()),
                        ref_low_male: cleanRow['ref low (male)'] !== undefined && cleanRow['ref low (male)'] !== '' ? parseFloat(cleanRow['ref low (male)']) : null,
                        ref_high_male: cleanRow['ref high (male)'] !== undefined && cleanRow['ref high (male)'] !== '' ? parseFloat(cleanRow['ref high (male)']) : null,
                        ref_low_female: cleanRow['ref low (female)'] !== undefined && cleanRow['ref low (female)'] !== '' ? parseFloat(cleanRow['ref low (female)']) : null,
                        ref_high_female: cleanRow['ref high (female)'] !== undefined && cleanRow['ref high (female)'] !== '' ? parseFloat(cleanRow['ref high (female)']) : null,
                    };
                    if (!parametersByTestName.has(forTest)) parametersByTestName.set(forTest, []);
                    parametersByTestName.get(forTest).push(parsed);
                });
            }

            // 1. Create a "Fuzzy" map of existing tests
            // Map structure: { "normalized_name": "Original Database Name" }
            const existingTestsMap = new Map();
            availableTests.forEach(t => {
                const normName = getStandardizedTestName(t.name);
                if (normName) existingTestsMap.set(normName, t.name);
            });
            
            let toImport = [];

            // 2. Loop through every row in the Excel sheet
            for (let row of json) {
                
                const cleanRow = {};
                for (let key in row) {
                    cleanRow[key.trim().toLowerCase()] = row[key];
                }

                let testName = cleanRow["test name"] || cleanRow["name"] || cleanRow["test"] || cleanRow["اسم التحليل"] || cleanRow["التحليل"] || cleanRow["الاسم"] || cleanRow["test_name"] || "";
                let sampleType = cleanRow["sample type"] || cleanRow["sample"] || cleanRow["نوع العينة"] || cleanRow["العينة"] || cleanRow["sample_type"] || "";
                let price = cleanRow["price"] || cleanRow["cost"] || cleanRow["السعر"] || cleanRow["التكلفة"] || 0;

                if (typeof price === 'string') {
                    price = price.replace(/[^0-9.]/g, ''); 
                }

                if (!testName || testName.trim() === "") continue;

                // Normalize the incoming Excel test name
                let normalizedExcelName = getStandardizedTestName(testName.trim());

                const payload = {
                    name: testName.trim(),
                    sample_type: sampleType,
                    price: parseFloat(price) || 0,
                    _normalizedName: normalizedExcelName, // looked up against parametersByTestName below, stripped before POSTing
                };

                // 3. Check for Fuzzy Duplicates
                if (existingTestsMap.has(normalizedExcelName)) {
                    
                    // Grab the actual name stored in the database to show the user
                    let dbName = existingTestsMap.get(normalizedExcelName);
                    
                    // INDIVIDUAL CONFIRMATION POPUP
                    let addAnyway = confirm(
                        `⚠️ DUPLICATE FOUND!\n\n` +
                        `Excel Test: "${payload.name}"\n` +
                        `Database Match: "${dbName}"\n\n` +
                        `Do you want to ADD this test anyway?\n` +
                        `[OK] = Add Anyway\n` +
                        `[Cancel] = Skip this test`
                    );
                    
                    if (addAnyway) {
                        toImport.push(payload);
                    }
                } else {
                    // Not a duplicate, add to import list normally
                    toImport.push(payload);
                }
            }

            // 4. Safety check: Did they skip everything?
            if (toImport.length === 0) {
                showAlert(t('no_new_tests', 'No new tests to import.'), 'info');
                event.target.value = ''; // Reset input
                return;
            }

            showAlert(t('importing_tests', 'Importing {count} tests...', {count: toImport.length}), 'info');
            let successCount = 0;
            let paramSuccessCount = 0;

            // 5. Send the final approved list to the database
            for (let payload of toImport) {
                const normalizedName = payload._normalizedName;
                delete payload._normalizedName; // helper only -- not a real LabTest field
                const response = await fetch('/api/tests', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-App-Mode': typeof currentWorkspace !== 'undefined' ? currentWorkspace : 'lab'
                    },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) continue;
                successCount++;

                // Attach this test's parameters, if the workbook's Parameters sheet had any
                // rows for it — same nested-data round-trip exportTestsWithParameters() sets
                // up on the way out.
                const created = await response.json().catch(() => null);
                const params = created?.id ? parametersByTestName.get(normalizedName) : null;
                if (params) {
                    for (const param of params) {
                        const paramResponse = await apiFetch(`/api/lab-tests/${created.id}/parameters`, {
                            method: 'POST',
                            body: JSON.stringify(param),
                        });
                        if (paramResponse.ok) paramSuccessCount++;
                    }
                }
            }

            // 6. Clean up and Refresh
            event.target.value = '';
            showAlert(paramSuccessCount > 0
                ? t('tests_imported_with_params', 'Successfully imported {count} tests and {paramCount} parameter(s)!', {count: successCount, paramCount: paramSuccessCount})
                : t('tests_imported', 'Successfully imported {count} tests!', {count: successCount}), 'success');
            await fetchLabTests();
            
        } catch (error) {
            console.error("Excel Parsing Error:", error);
            showAlert(t('excel_parse_failed_format', "Failed to parse the Excel file. Make sure it's a valid .xlsx or .csv"), 'error');
        }
    };
    
    // Start reading the file
    reader.readAsArrayBuffer(file);
}

function openAccessModal(userId, permissions) {
    document.getElementById('access-user-id').value = userId;
    const list = document.getElementById('permissions-list');
    const allowed = permissions ? permissions.split(',') : [];
    
    // Clear current list
    list.innerHTML = '';
    
    // Find all sidebar tabs and generate checkboxes dynamically
    document.querySelectorAll('.nav-tab').forEach(tab => {
        const tabName = tab.getAttribute('data-tab');
        const tabText = tab.querySelector('span:last-child').innerText; // Gets the label text
        
        if (!tabName) return; // Skip if no data-tab attribute

        const label = document.createElement('label');
        label.style.display = 'block';
        label.innerHTML = `
            <input type="checkbox" value="${tabName}" ${allowed.includes(tabName) ? 'checked' : ''}> 
            ${tabText}
        `;
        list.appendChild(label);
    });
    
    document.getElementById('access-modal').style.display = 'block';
}

async function savePermissions() {
    const userId = document.getElementById('access-user-id').value;
    const selected = Array.from(document.querySelectorAll('#permissions-list input:checked')).map(cb => cb.value).join(',');
    
    const response = await fetch(`/api/auth/users/${userId}/permissions`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ permissions: selected })
    });
    
    if (response.ok) {
        showAlert(t('permissions_updated', 'Permissions updated!'), 'success');
        document.getElementById('access-modal').style.display = 'none';
    }
}
window.onerror = function(message, source, lineno, colno, error) {
    const errorText = `System Error: ${message} (at ${source}:${lineno})`;
    
    // Add to notification list
    addNotification(errorText, 'danger');
    
    // Still show the alert on screen
    showAlert(errorText, 'danger');
    
    return false; // Let the browser handle the error normally too
};

// ==========================================
// REAL-TIME PRESENCE & IDLE TRACKER
// ==========================================

let heartbeatTimer;
let lastActivityTime = Date.now();
const IDLE_TIMEOUT_MS = 1 * 60 * 1000; // 1 minute of no activity
const HEARTBEAT_MS = 30 * 1000;     // 5 minute heartbeat
let currentPresenceState = 'offline';

async function sendPresenceUpdate(status, force = false) {
    if (currentPresenceState === status && !force) return;
    if (!currentUser || !currentUser.username) return; 
    
    currentPresenceState = status;
    
    try {
        await apiFetch('/api/auth/presence', {
            method: 'POST',
            credentials: 'include',
            body: JSON.stringify({ 
                status: status,
                username: currentUser.username
            })
        });
    } catch (error) {
        console.warn("Failed to update presence status in background.");
    }
}

// 1. Just updates the timestamp when the user moves
function updateActivity() {
    lastActivityTime = Date.now();
    
    // Instantly snap back to online if they were idle
    if (currentPresenceState !== 'online') {
        sendPresenceUpdate('online');
    }
}

// 2. The single continuous loop that manages the server connection
function checkPresence() {
    const timeSinceLastActivity = Date.now() - lastActivityTime;
    const isIdle = systemPolicies.idleLogoutMs > 0 && timeSinceLastActivity >= systemPolicies.idleLogoutMs;

    if (timeSinceLastActivity >= IDLE_TIMEOUT_MS) {
        // User is inactive: Send 'idle' ping to keep the session alive on the server
        sendPresenceUpdate('idle', true);
    } else {
        // User is active: Send 'online' ping
        sendPresenceUpdate('online', true);
    }
}

function initializePresenceTracker() {
    const activityEvents = ['mousemove', 'keydown', 'mousedown', 'scroll', 'touchstart'];
    activityEvents.forEach(evt => {
        document.addEventListener(evt, updateActivity, { passive: true });
    });

    // Mobile browsers suspend a backgrounded tab's timers (screen lock, app switch) — so
    // the checkPresence() heartbeat below never runs while that's the case, and 'idle' never
    // gets sent; the status sits stuck on 'online' until the server's own offline timeout
    // fires directly and logs them out, skipping 'idle' entirely. visibilitychange fires
    // synchronously even when other timers are suspended, so use it to report the state
    // change immediately instead of waiting on the polling loop.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            sendPresenceUpdate('idle', true);
        } else {
            updateActivity();
        }
    });

    // Initial ping
    updateActivity();

    // Start the endless heartbeat
    heartbeatTimer = setInterval(checkPresence, HEARTBEAT_MS);
}

window.addEventListener('beforeunload', () => {
    if (currentUser && currentUser.username) {
        const payload = JSON.stringify({ status: 'offline', username: currentUser.username });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/auth/presence', blob);
    }
});

setInterval(() => {
    if (!currentUser || isLoggingOut) return;

    // RULE 1: IDLE AUTO-LOGOUT
    if (systemPolicies.idleLogoutMs > 0) {
        const timeSinceLastActivity = Date.now() - lastActivityTime;
        if (timeSinceLastActivity >= systemPolicies.idleLogoutMs) {
            isLoggingOut = true;
            alert(t('session_expired_idle', 'Session expired due to inactivity.'));
            logout();
        }
    }

    // RULE 2: FORCED DAILY LOGOUT (Robust Version) — admins/masters are exempt; this is a
    // policy for regular staff accounts only. The server enforces the same exemption
    // independently (before_request_interceptor in main.py), so this is a UX nicety
    // (immediate redirect in an open tab) rather than the only thing standing in the way.
    const isAdminOrMaster = String(currentUser.id).startsWith('master_')
        || (currentUser.role || '').toLowerCase() === 'admin';
    if (systemPolicies.forceLogoutTime && !isAdminOrMaster) {
        const now = new Date();
        const currentTimeStr = now.toTimeString().substring(0, 5); // Returns "HH:MM"

        // Compare string matches
        if (currentTimeStr === systemPolicies.forceLogoutTime) {
            console.log("Idle threshold reached, logging out...");
            isLoggingOut = true;
            alert(t('maintenance_logout', 'Maintenance time reached ({time}). Logging out.', {time: systemPolicies.forceLogoutTime}));
            logout();
        }
    }
}, 30000);

setInterval(() => {
    const hrTab = document.getElementById('hr-management');
    if (hrTab && hrTab.classList.contains('active')) {
        fetchHRData(); 
    }
}, 10000);

document.addEventListener('DOMContentLoaded', async () => {
    await initializeUserSecurity();
    
    initializePresenceTracker();

    $('#hr-force-logout-time').clockpicker({
    placement: 'bottom', // Keeps it below the input
    align: 'left',       // Aligns to the left of the input
    autoclose: true,
    twelvehour: true,
    donetext: 'Done',
    container: 'body'
});

    $('#hr-login-resume-time').clockpicker({
    placement: 'bottom',
    align: 'left',
    autoclose: true,
    twelvehour: true,
    donetext: 'Done',
    container: 'body'
});

    console.log("Application initialization complete.");
});
// Start the tracker when the app loads
//document.addEventListener('DOMContentLoaded', initializePresenceTracker);
// Start security checks the exact millisecond the app opens
//document.addEventListener('DOMContentLoaded', initializeUserSecurity);

// ==========================================
// ACTIVITY LOG (admin-only audit trail)
// ==========================================

let activityLogPage = 1;
let activityUsernameOptionsLoaded = false;
let onlineUsersInterval = null;

function searchActivityLog() {
    activityLogPage = 1; // any filter/search change goes back to page 1
    fetchActivityLogPage();
}

function goToActivityLogPage(page) {
    activityLogPage = page;
    fetchActivityLogPage();
}

// Populated from /api/users (already admin-only) rather than building a separate endpoint
// just for a filter dropdown.
async function populateActivityUsernameFilter() {
    if (activityUsernameOptionsLoaded) return;
    const select = document.getElementById('activity-filter-username');
    if (!select) return;
    try {
        const response = await apiFetch('/api/users');
        if (!response.ok) return;
        const users = await response.json();
        select.innerHTML = '<option value="">All Users</option>' +
            users.map(u => `<option value="${u.username}">${u.username}</option>`).join('');
        activityUsernameOptionsLoaded = true;
    } catch (error) {
        console.error('Failed to load users for activity filter', error);
    }
}

// Holds the raw entries behind whatever's currently rendered, indexed the same way as the
// row checkboxes (data-index) — lets exportActivityLogSelected() build a CSV straight from
// the real field values instead of re-scraping table cell text.
let currentActivityLogItems = [];

async function fetchActivityLogPage() {
    await populateActivityUsernameFilter();

    const searchTerm = document.getElementById('activity-search').value;
    const filterFrom = document.getElementById('activity-filter-date-from').value;
    const filterTo = document.getElementById('activity-filter-date-to').value;
    const filterUsername = document.getElementById('activity-filter-username').value;
    const filterEvent = document.getElementById('activity-filter-event').value;

    const params = new URLSearchParams({ page: activityLogPage, per_page: 100 });
    if (searchTerm) params.set('search', searchTerm);
    if (filterFrom) params.set('date_from', filterFrom);
    if (filterTo) params.set('date_to', filterTo);
    if (filterUsername) params.set('username', filterUsername);
    if (filterEvent) params.set('event_type', filterEvent);

    const listDiv = document.getElementById('activity-log-list');
    let data = { items: [], page: 1, per_page: 100, total_pages: 1, total: 0 };
    try {
        const response = await apiFetch(`/api/activity?${params.toString()}`);
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error('Failed to load activity log', error);
    }

    currentActivityLogItems = data.items;

    const startIndex = (data.page - 1) * (data.per_page || 100);
    const rows = data.items.map((entry, index) => `
        <tr>
            <td><input type="checkbox" class="activity-row-checkbox" data-index="${index}" onchange="updateActivitySelectAllState()"></td>
            <td>${startIndex + index + 1}</td>
            <td style="color: var(--muted); font-size: 11px; white-space: nowrap;">${formatCairoDateTime(entry.timestamp) || ''}</td>
            <td>${entry.username || '—'}</td>
            <td><span class="pill ${activityEventPillClass(entry.event_type)}">${activityEventLabel(entry.event_type)}</span></td>
            <td>${entry.resource || ''}${entry.resource_id ? ' #' + entry.resource_id : ''}</td>
            <td>${entry.description || ''}</td>
            <td style="color: var(--muted); font-size: 11px;">${entry.ip_address || ''}</td>
        </tr>
    `).join('');

    listDiv.innerHTML = `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th style="width: 40px;"><input type="checkbox" id="activity-select-all" onclick="toggleAllActivityRows(this)"></th>
                        <th>#</th><th>Timestamp</th><th>User</th><th>Event</th><th>Resource</th><th>Description</th><th>IP</th>
                    </tr>
                </thead>
                <tbody>${rows || `<tr><td colspan="8" style="text-align:center; padding: 20px; color: var(--muted);">${t('empty_no_activity', 'No activity recorded yet.')}</td></tr>`}</tbody>
            </table>
        </div>
        <div id="activity-log-pagination"></div>
    `;
    renderPaginationControls('activity-log-pagination', {
        page: data.page, per_page: data.per_page, total_pages: data.total_pages, total: data.total,
    }, 'goToActivityLogPage');
}

function toggleAllActivityRows(masterBox) {
    document.querySelectorAll('.activity-row-checkbox').forEach(cb => cb.checked = masterBox.checked);
}

function updateActivitySelectAllState() {
    const boxes = [...document.querySelectorAll('.activity-row-checkbox')];
    const selectAll = document.getElementById('activity-select-all');
    if (selectAll) selectAll.checked = boxes.length > 0 && boxes.every(cb => cb.checked);
}

// Exports only the checked rows; if none are checked, falls back to exporting every row on
// the current page (i.e. the same "export what I'm looking at" behavior as before checkboxes
// existed) — this only ever operates on the loaded page, not the full filtered result set,
// same limitation exportTableToExcel already has everywhere else in the app.
function exportActivityLogSelected() {
    const checked = [...document.querySelectorAll('.activity-row-checkbox:checked')]
        .map(cb => currentActivityLogItems[parseInt(cb.dataset.index)]);
    const items = checked.length > 0 ? checked : currentActivityLogItems;

    if (items.length === 0) {
        showAlert(t('no_activity_to_export', 'No activity rows to export.'), 'error');
        return;
    }

    const headers = ['Timestamp', 'User', 'Event', 'Resource', 'Resource ID', 'Description', 'Status', 'IP'];
    const sheetData = [headers, ...items.map(entry => [
        entry.timestamp || '', entry.username || '', activityEventLabel(entry.event_type),
        entry.resource || '', entry.resource_id || '', entry.description || '',
        entry.status || '', entry.ip_address || '',
    ])];

    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    XLSX.writeFile(workbook, 'activity_log.xlsx');
}

function activityEventPillClass(eventType) {
    if (eventType === 'login' || eventType === 'create') return 'ok';
    if (eventType === 'login_failed' || eventType === 'delete') return 'danger';
    if (eventType === 'update') return 'warn';
    if (eventType === 'view') return 'info';
    return 'ghost'; // logout, unknown
}

function activityEventLabel(eventType) {
    const labels = {
        login: 'Login', login_failed: 'Failed Login', logout: 'Logout',
        view: 'View', create: 'Create', update: 'Update', delete: 'Delete',
    };
    return labels[eventType] || eventType || 'Unknown';
}

async function fetchOnlineUsers() {
    const container = document.getElementById('online-users-list');
    if (!container) return;
    try {
        const response = await apiFetch('/api/activity/online');
        if (!response.ok) return;
        const users = await response.json();
        if (users.length === 0) {
            container.innerHTML = '<span style="color: var(--muted); font-size: 13px;">No one online right now.</span>';
            return;
        }
        container.innerHTML = users.map(u => `
            <span class="pill ok" style="display: inline-flex; align-items: center; gap: 6px;">
                🟢 ${u.username} <span style="color: var(--muted); font-size: 10px;">${u.last_seen_seconds_ago}s ago</span>
            </span>
        `).join('');
    } catch (error) {
        console.error('Failed to load online users', error);
    }
}

function startOnlineUsersPolling() {
    fetchOnlineUsers();
    if (onlineUsersInterval) clearInterval(onlineUsersInterval);
    onlineUsersInterval = setInterval(fetchOnlineUsers, 30000);
}

function loadActivityLog() {
    activityLogPage = 1;
    fetchActivityLogPage();
    startOnlineUsersPolling();
}

// Fired once per tab switch (see showTab()) rather than on every background polling GET —
// that would be noise, not a meaningful "what did they look at". Fire-and-forget: a failed
// view-log call shouldn't block or error out normal navigation.
function logTabView(tabName) {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    apiFetch('/api/activity/view', {
        method: 'POST',
        body: JSON.stringify({ tab: tabName }),
    }).catch(() => {});
}
