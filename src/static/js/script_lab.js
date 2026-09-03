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
let allVisits = [];
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

// isDateInRange() (Dashboard's old 'total' drill-down date filter) migrated to React — see
// frontend-lab/src/islands/DashboardTab/DashboardTab.tsx's own copy of the same helper.

// renderPaginationControls() (Prev/Next + numbered page buttons) migrated to React — see
// frontend-lab/src/lib/PaginationControls.tsx, an exact port used by every paginated React
// island. Test Results and then Transaction History were its last two vanilla callers.

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
// Employee list/CRUD/bulk-actions, Attendance Policy + Holidays, the all-employees Attendance
// Report, and the per-employee attendance drill-down modal (sessions/permissions/vacations,
// trend chart, calendar heatmap) are all migrated to React now — see
// frontend-lab/src/islands/HREmployeesTab. The `employees` global and fetchHRData() were kept
// alive through earlier phases purely for the drill-down modal's own employee lookup; now
// that it's React too (taking `employees` as a prop from HREmployeesTab's own fetch), neither
// has any remaining purpose and both were removed, along with getInitials/avatarColorForName/
// renderAvatarHtml (ported as the React Avatar component, frontend-lab/src/lib/Avatar.tsx) —
// deleteEmployee() (single-record delete) stays unported: dead code, never called from
// anywhere; bulk delete (in HREmployeesTab) is and remains the only reachable delete path.

// ==========================================
// ATTENDANCE — managed entirely by admin/HR per employee (not all employees have a system
// login, so this is never self-service; see src/models/attendance.py).
// ==========================================

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

// attendancePresetRange() above is the one piece of the vanilla attendance UI left in this
// file — everything that used to call it (Attendance Policy, the all-employees Attendance
// Report, and the whole per-employee drill-down modal: sessions/permissions/vacations CRUD,
// trend chart, calendar heatmap) is React now, in frontend-lab/src/islands/HREmployeesTab —
// but this one pure date-math function is still called directly as window.attendancePresetRange()
// from that same React code (see globals.d.ts), so unlike setAttendanceRangePreset()/
// attendanceRangeQuery() (its DOM-reading/writing wrappers, both fully removable and removed
// once their only callers — openEmployeeAttendanceModal()/loadEmployeeAttendanceModalData() —
// were gone), this one has to stay.

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

            // Used to also call fetchHRData() here to refresh the employee list — that
            // function is gone now that the list itself is React (HREmployeesTab), which
            // polls its own /api/hr/employees every 10s while this tab is active, so newly
            // imported rows still show up shortly without a direct bridge back into React.

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

    document.getElementById('lab-config-form')?.addEventListener('submit', handleUpdateLabConfig);
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
        // fetchHRData() used to be pre-fetched here too — removed along with the function
        // itself now that HREmployeesTab (React) does its own fetch on mount.

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
// its remaining per-tab case resets transient UI state that has nothing to do with the tab
// itself having changed: 'add-client' would reset an in-progress new-client form.
// Called after any action whose effect could be visible on more than one tab (booking a
// test, marking samples collected, entering results, bulk actions, ...) so every already-open
// table reflects the change without the user needing to reload the page.
function refreshVisibleTables() {
    // Dashboard tab migrated to React (frontend-lab/src/islands/DashboardTab) — it owns its
    // own state now, so tell it to refresh via a custom event instead of calling into it
    // directly (mirrors the Statistics tab's own lab:refresh-statistics event just below).
    window.dispatchEvent(new CustomEvent('lab:refresh-dashboard'));

    // Tech Screen migrated to React (frontend-lab/src/islands/TechScreenTab) — it now computes
    // its own KPI counts from its own fetched data (updateTechScreenBadges() is gone), same
    // lab:refresh-* CustomEvent bridge.
    window.dispatchEvent(new CustomEvent('lab:refresh-tech-screen'));
    // Clients list migrated to React (frontend-lab/src/islands/ClientsTab) — it owns its
    // own state now, same lab:refresh-* CustomEvent bridge as Statistics/Dashboard above.
    window.dispatchEvent(new CustomEvent('lab:refresh-clients'));
    // Pending Samples migrated to React (frontend-lab/src/islands/PendingSamplesTab) — same
    // lab:refresh-* CustomEvent bridge.
    window.dispatchEvent(new CustomEvent('lab:refresh-pending-samples'));
    // Test Results / Approvals migrated to React (frontend-lab/src/islands/TestResultsTab) —
    // same lab:refresh-* CustomEvent bridge (fires after approveVisitsAndNotify() too, via its
    // own loadInitialData() call).
    window.dispatchEvent(new CustomEvent('lab:refresh-test-results'));
    if (document.getElementById('client-history')?.classList.contains('active') && typeof loadClientHistory === 'function') {
        loadClientHistory();
    }
    // Transaction History migrated to React (frontend-lab/src/islands/TransactionHistoryTab) —
    // same lab:refresh-* CustomEvent bridge as Dashboard/Tech Screen/Clients/Pending
    // Samples/Test Results above.
    window.dispatchEvent(new CustomEvent('lab:refresh-transaction-history'));
    // Financial Overview migrated to React (frontend-lab/src/islands/FinancialOverviewTab) —
    // same lab:refresh-* CustomEvent bridge.
    window.dispatchEvent(new CustomEvent('lab:refresh-financial-overview'));
    // Statistics tab migrated to React (frontend-lab/src/islands/StatisticsTab) — it owns
    // its own state now, so tell it to refresh via a custom event instead of calling into it
    // directly (mirrors the tab-click listener it attaches to its own nav-tab button).
    if (document.getElementById('statistics')?.classList.contains('active')) {
        window.dispatchEvent(new CustomEvent('lab:refresh-statistics'));
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

// Set by setupUIForRole() below, read by the Visit Results modal (renderVisitResultsModal)
// to decide whether to show its "Approve & Send" action — kept as a global rather than
// recomputed locally there so both places can never disagree about who's allowed to approve.
let userCanApproveResults = false;

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
        } else if (tabName === 'security') {
            // Every user-management/permissions route it leads to is @admin_required on the
            // backend (not gated by a 'security' UserPermission key — that key doesn't
            // exist), so there's no permission a non-admin could be granted that would make
            // this tab do anything but 403. Hide it for non-admins unconditionally instead
            // of going through the generic permissions.includes() path below.
            tab.style.display = 'none';
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

    // Test Results > Check — gated by its own permission, independent of the "test-results"
    // tab permission itself, so a tab-visible user doesn't automatically get to approve.
    userCanApproveResults = currentUser?.role === 'admin' || currentUser?.role === 'lab_master' || permissions.includes('approve_results');
    const checkApprovalsBtn = document.getElementById('check-approvals-btn');
    if (checkApprovalsBtn) checkApprovalsBtn.style.display = userCanApproveResults ? 'inline-block' : 'none';
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
        // 'dashboard' migrated to React (frontend-lab/src/islands/DashboardTab) — it
        // re-fetches and resets its own drill-down view on this same nav-tab click (see its
        // useEffect), no per-tab-click trigger needed here.
        // 'clients' and 'add-client' migrated to React (frontend-lab/src/islands/ClientsTab,
        // frontend-lab/src/islands/AddClientTab) — each has its own self-attached nav-tab
        // click listener (AddClientTab's also replicates the old `if (!editingClientId)
        // resetClientForm()` guard), no per-tab-click trigger needed here.
        // 'pending-samples' migrated to React (frontend-lab/src/islands/PendingSamplesTab) —
        // it clears its own filters and re-fetches on this same nav-tab click (see its
        // useEffect), no per-tab-click trigger needed here.
        // 'test-results' migrated to React (frontend-lab/src/islands/TestResultsTab) — it
        // clears its own filters and re-fetches on this same nav-tab click, no per-tab-click
        // trigger needed here.
        case 'client-history': loadClientHistory(); break;
        // 'reports' migrated to React (frontend-lab/src/islands/ReportsTab) — it re-fetches
        // and clears its own filters on this same nav-tab click (see its useEffect), no
        // per-tab-click trigger needed here.
        // 'test-list' migrated to React (frontend-lab/src/islands/TestListTab) and
        // 'price-check' migrated to React (frontend-lab/src/islands/PriceCheckTab) — both
        // mount once and manage their own data/state, no per-tab-click trigger needed.
        // 'transaction-history' migrated to React (frontend-lab/src/islands/TransactionHistoryTab)
        // — it doesn't clear its own date/unpaid-only filters on this same nav-tab click
        // (matching the vanilla filterTransactions(), which never did either — only the
        // "Clear Filter" button did), just resets to page 1 and re-fetches (see its useEffect).
        // 'financial-overview' migrated to React (frontend-lab/src/islands/FinancialOverviewTab)
        // — it has its own self-attached nav-tab click listener, no per-tab-click trigger
        // needed here.
        case 'warehouse': fetchWarehouseData(); break;
        // 'hr-management' migrated to React (frontend-lab/src/islands/HREmployeesTab) — it
        // fetches on mount and polls independently, no per-tab-click trigger needed.
        // 'statistics' migrated to React (frontend-lab/src/islands/StatisticsTab) — it
        // listens for clicks on this same nav-tab button itself (see its useEffect).
        // 'activity-log' migrated to React (frontend-lab/src/islands/ActivityLogTab) —
        // same self-attached nav-tab click listener pattern.
    }
}

// --- DASHBOARD UPDATES ---
// Dashboard's own KPI badges/latest-clients table/demand chart migrated to React — see
// frontend-lab/src/islands/DashboardTab. Tech Screen's #tech-count-pending/-finished badges
// (formerly updateTechScreenBadges(), a side effect of the vanilla updateDashboard() before
// that) are now computed by frontend-lab/src/islands/TechScreenTab from its own fetched data.
// --- UPGRADED DASHBOARD TABLE LOGIC ---

// Clients list + Add/Edit Patient form migrated to React — see
// frontend-lab/src/islands/ClientsTab and frontend-lab/src/islands/AddClientTab. This used to
// reach directly into #client-form's DOM; now it just dispatches the same 'lab:edit-client'
// CustomEvent AddClientTab listens for (ClientsTab's own "Add New Patient" button dispatches
// { clientId: null } directly for the same reason) and lets showTab() handle visibility —
// still called unchanged from Tech Screen/Pending Samples row actions and from
// DashboardTab's window.quickEditPatient bridge.
function quickEditPatient(clientId) {
    window.dispatchEvent(new CustomEvent('lab:edit-client', { detail: { clientId } }));
    showTab('add-client');
}
// showDashboardTable()/resetDashboardView()/goToDashboardPage()/onDashboardFilterChange()/
// fetchDashboardVisitsPage()/renderDashboardTable() (and the dashboardTablePage/
// currentDashboardTableType state they shared) migrated to React — see
// frontend-lab/src/islands/DashboardTab.

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

// buildAdminTableHTML()/toggleAllVisitCheckboxes()/updateBulkDeleteVisitsButton()/
// handleBulkDeleteVisits() — the shared visit-table renderer + its bulk-select/delete
// machinery, formerly used by Dashboard, Tech Screen, and Pending Samples — are gone now that
// all three are React (see frontend-lab/src/islands/DashboardTab/VisitsTable.tsx, which each
// of their own islands uses).

// --- CLIENT MANAGEMENT ---
// Patient Directory (list) + Add/Edit Patient form migrated to React — see
// frontend-lab/src/islands/ClientsTab and frontend-lab/src/islands/AddClientTab.
// quickEditPatient() above is the one piece still shared with this file (Tech Screen/Pending
// Samples row actions); everything else that used to live here (searchClients/
// fetchClientsPage/displayClients/viewClient/resetClientForm/handleAddClient, and the
// clientsPage/editingClientId/currentClientDetails state they shared) is gone.

// --- OTHER TABS (CONVERTED TO TABLES) ---

// loadPendingSamples() migrated to React (frontend-lab/src/islands/PendingSamplesTab) — its
// own nav-tab click listener clears filters itself.

// loadTestResults() migrated to React (frontend-lab/src/islands/TestResultsTab) — its own
// nav-tab click listener clears filters itself.

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

// "Master Patient Directory & Reports" (reports tab) migrated to React —
// frontend-lab/src/islands/ReportsTab, mounted by react/lab-islands.js.

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

// Tech Screen (showTechTable()/goToTechTablePage()/renderTechTable(), and the
// currentTechTableType/techTablePage state they shared) migrated to React — see
// frontend-lab/src/islands/TechScreenTab. markSampleCollected() (the "Collect Sample" button
// buildAdminTableHTML() used to render) is gone too — Dashboard/Pending Samples/Tech Screen
// each now call PUT /api/visits/<id>/collect directly and refresh their own state.

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

// updateBulkDeleteButton()/toggleSelectAll()/handleBulkDelete() (Clients list bulk-delete —
// not shared with any other tab) migrated to React — see
// frontend-lab/src/islands/ClientsTab/ClientsTab.tsx.

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
// searchPendingSamples()/fetchPendingSamplesPage()/goToPendingSamplesPage()/
// updateBulkFinishButton()/handleBulkFinish() (and the pendingSamplesPage state they shared)
// migrated to React — see frontend-lab/src/islands/PendingSamplesTab. Note for whoever
// migrates Tech Screen next: updateBulkFinishButton()/handleBulkFinish() here read a
// `.pending-checkbox` class that buildAdminTableHTML() never actually rendered (it always
// used `.visit-checkbox`), so "Finish Selected" never worked in the vanilla app either —
// PendingSamplesTab's extraBulkAction on VisitsTable is a from-scratch (but intent-faithful)
// fix, not a port of working code.
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

// searchTestResults()/goToTestResultsPage()/fetchTestResultsPage() (and the testResultsPage
// state they shared) migrated to React — see frontend-lab/src/islands/TestResultsTab.

// --- Test Results > Check: approve results held back by LabConfig.require_results_approval
// (see save_results()/upload_report() in the backend) before their WhatsApp/SMS message
// sends. Gated by the 'approve_results' permission — see setupUIForRole(). ---

// openPendingApprovalModal()/renderPendingApprovalList()/closePendingApprovalModal()/
// toggleAllApprovalRows()/approveSelectedResults() migrated to React — see
// frontend-lab/src/islands/TestResultsTab's own approval modal, which calls
// window.approveVisitsAndNotify() below directly instead of reimplementing it.

// Shared core for both bulk approval (Test Results > Check) and single-visit approval (the
// Visit Results modal's "Approve & Send" button) — POSTs to /api/visits/approve, sends the
// results-ready message for every returned visit that has a phone on file, and surfaces one
// aggregate summary toast rather than one per visit. Returns true on success so callers know
// whether to close their own modal; always refreshes the visible data either way it can.
async function approveVisitsAndNotify(body) {
    let data;
    try {
        const response = await apiFetch('/api/visits/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        data = await response.json();
        if (!response.ok || !data.success) {
            showAlert(data.error || t('network_error_occurred', 'Network error occurred.'), 'error');
            return false;
        }
    } catch (error) {
        console.error('Approve failed:', error);
        showAlert(t('network_error_occurred', 'Network error occurred.'), 'error');
        return false;
    }

    let sent = 0, skipped = 0, failed = 0;
    for (const result of data.results) {
        if (!result.phone) {
            skipped++;
            continue;
        }
        const outcome = await sendResultsReadyMessage({
            phone: result.phone,
            patientName: result.patient_name,
            patientId: result.patient_id,
            reportUrls: result.report_urls,
            method: result.method,
        });
        if (outcome.ok) sent++; else failed++;
    }

    showAlert(
        t('approve_summary', '{approved} approved — {sent} sent, {skipped} skipped (no phone), {failed} failed.',
          { approved: data.approved_count, sent, skipped, failed }),
        failed > 0 ? 'warn' : 'success'
    );

    // loadInitialData()'s own refreshVisibleTables() call covers Test Results (React) via its
    // lab:refresh-test-results event listener, no separate redraw call needed here.
    await loadInitialData();
    return true;
}

// Called from the Visit Results modal's "Approve & Send" button (see renderVisitResultsModal)
// when that visit's status is 'awaiting_approval' — lets a permitted user review (and, via
// "Edit Results", correct) the actual entered values before approving a single visit, as an
// alternative to the bulk Check-approvals flow.
async function approveVisitFromModal(visitId) {
    const ok = await approveVisitsAndNotify({ visit_ids: [visitId] });
    if (ok) closeVisitResultsModal();
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
            } else if (v.status === 'awaiting_approval') {
                pillClass = 'warn';
                badgeText = t('status_awaiting_approval', 'Waiting for Approval');
            } else if (v.status === 'results_delivered_by_link') {
                pillClass = 'ok';
                badgeText = t('status_delivered', 'Delivered');
            }

            // --- THE NEW MULTI-FILE PRINT LOGIC ---
            let actionBtn = `<span style="color: var(--muted); font-size: 11px;">${t('status_awaiting_results', 'Awaiting Results')}</span>`;

            if ((v.status === 'results_delivered_by_link' || v.status === 'partially_delivered' || v.status === 'awaiting_approval') && v.report_url) {
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
    document.getElementById('vr-approval-bar').style.display = 'none';
    document.getElementById('vr-approval-bar').innerHTML = '';
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

    // Lets a permitted user review the entered values right here and either fix them first
    // (Edit Results, reusing the same results-entry popup the "Enter Results" action opens
    // elsewhere) or approve directly — an alternative, single-visit path to the bulk Check-
    // approvals flow. Only shown for a visit actually awaiting approval, and only to someone
    // with the approve_results permission (userCanApproveResults, set in setupUIForRole()).
    const approvalBar = document.getElementById('vr-approval-bar');
    if (data.status === 'awaiting_approval' && userCanApproveResults) {
        approvalBar.style.display = 'block';
        approvalBar.innerHTML = `
            <div class="card" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-color: var(--warn);">
                <span class="pill warn">${t('status_awaiting_approval', 'Waiting for Approval')}</span>
                <div style="display: flex; gap: 10px;">
                    <button class="btn ghost" onclick="window.open('/results-entry/${data.visit_id}', 'EnterResults', 'width=1000,height=800,resizable=yes,scrollbars=yes')">${t('btn_enter_results', '🧪 Enter Results')}</button>
                    <button class="btn" style="background: var(--teal); color: #04121d;" onclick="approveVisitFromModal(${data.visit_id})">✅ ${t('results.approve_selected', 'Approve & Send')}</button>
                </div>
            </div>
        `;
    } else {
        approvalBar.style.display = 'none';
        approvalBar.innerHTML = '';
    }

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

// "Test Results Statistics" (statistics tab) migrated to React —
// frontend-lab/src/islands/StatisticsTab, mounted by react/lab-islands.js.

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

let currentBookingClientId = null;

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

// Settings' own #setting-msg-enabled/#setting-msg-method inputs are gone now (migrated to
// React, see frontend-lab/src/islands/SettingsTab) — this only drives the topbar WhatsApp
// connect button now, so it takes the enabled/method values as args (from the LabConfig
// applyGlobalSettings() already fetched) instead of reading removed DOM elements.
function toggleMessagingOptions(isEnabled, method) {
    const waButton = document.getElementById('topbar-wa-btn');
    const waConnectionSection = document.getElementById('wa-connection-section');

    if (isEnabled) {
        const isWhatsApp = (method === 'whatsapp');
        if (waButton) waButton.style.display = isWhatsApp ? 'inline-block' : 'none';
        if (waConnectionSection) waConnectionSection.style.display = isWhatsApp ? 'block' : 'none';
    } else {
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
        
        // 4. Update UI — loadInitialData()'s own refreshVisibleTables() call covers every
        // currently-visible table, Dashboard (React) included (via its lab:refresh-dashboard
        // event listener), so no separate redraw call is needed here.
        showAlert(t('report_uploaded', 'Report uploaded successfully!'), 'success');
        document.getElementById('upload-modal').style.display = 'none';
        await loadInitialData();

        // 5. Background WhatsApp Sending via Node.js
        if (data.success && data.report_urls.length > 0) {
            // Server-authoritative: same LabConfig.msg_enabled/msg_method/require_results_
            // approval the DB actually holds, fetched fresh in upload_report() (main.py) —
            // NOT this page's live Settings checkbox, which only matches the DB if the last
            // toggle was actually saved (and reverted on a failed/permission-denied save,
            // which it isn't). That mismatch used to make this path send when "Enter Results"
            // (which always asked the DB) would correctly have skipped, or vice versa.
            const method = data.messaging?.method || 'whatsapp';

            if (data.messaging?.approval_pending) {
                showAlert(t('report_uploaded_pending_approval', 'Report uploaded. Results are pending approval before sending — use Test Results > Check to approve.'), 'info');
                return;
            }
            if (!data.messaging?.enabled) {
                showAlert(t('report_uploaded_messaging_disabled', 'Report uploaded. Auto-messaging is disabled.'), 'info');
                return;
            }

            const result = await sendResultsReadyMessage({
                phone: data.phone,
                patientName: window.currentUploadPatientName,
                patientId: data.patient_id,
                reportUrls: data.report_urls,
                method,
            });
            if (result.ok) {
                showAlert(t('message_sent_via', 'Message sent successfully via {method}!', {method: method.toUpperCase()}), 'success');
            } else {
                showAlert(t('message_send_failed', 'Failed to send {method} message. Ensure Node server is running.', {method: method.toUpperCase()}), 'error');
            }
        }

    } catch (error) {
        console.error("Upload/WhatsApp Error:", error);
        showAlert(error.message || t('network_error_occurred', 'Network error occurred.'), 'error');
    }
}

// Builds the Arabic "results ready" message and sends it via the Node WhatsApp/SMS bot.
// Shared by handleFileUpload() above and approveVisitsAndNotify() below, so the two flows
// (auto-send, and approve-then-send) can't drift into two different message templates again.
// Returns {ok, error, method} rather than showing its own toast — a single send (upload flow)
// and a batch of sends (approval flow) each want to surface the outcome differently.
async function sendResultsReadyMessage({ phone, patientName, patientId, reportUrls, method }) {
    method = method || 'whatsapp';
    if (!phone) {
        return { ok: false, error: 'no_phone', method };
    }

    const liveServer = `http://${window.location.hostname}:${window.APP_PORTS.backend}`;
    const nodeServer = `http://${window.location.hostname}:${window.APP_PORTS.node}`; // Your Node.js Bot Port
    const endpoint = (method === 'sms') ? '/api/sms/send' : '/api/whatsapp/send';

    const safeName = patientName || "عميلنا العزيز";
    const urls = reportUrls || [];
    let pdfLinksText = urls.map((url, index) => {
        // FIX: encodeURI converts spaces into '%20' so WhatsApp doesn't break the link
        let cleanUrl = encodeURI(url.trim());
        if (!cleanUrl.startsWith('/')) {
            cleanUrl = '/' + cleanUrl;
        }
        return `📄 التقرير ${index + 1}: ${liveServer}${cleanUrl}`;
    }).join('\n');

    let message = `مرحباً ${safeName}،\n\nنتائج التحاليل الخاصة بك جاهزة الآن:\n\n${pdfLinksText}\n\nلعرض السجل الطبي الكامل: ${liveServer}/patient-history/${patientId}`;
    const messagingPayload = {
        centerId: 'lab',
        phone,
        message,
    };
    if (method === 'whatsapp' && urls[0]) {
        const first = urls[0].trim();
        messagingPayload.pdfUrl = `${liveServer}${encodeURI(first.startsWith('/') ? first : '/' + first)}`;
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
        return { ok: true, method };
    } catch (err) {
        console.error("Messaging Error:", err);
        return { ok: false, error: err.message, method };
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

// "Test List" (test-list tab: table, search, add/edit/delete CRUD) migrated to React —
// frontend-lab/src/islands/TestListTab, mounted by react/lab-islands.js. fetchLabTests()
// below is kept (trimmed of its old table-rendering call) purely to keep populating
// `availableTests`, which the still-vanilla Book Test modal, Test Panels, Parameters modal,
// and Excel import/export engine all read directly.
let availableTests = [];

// 1. Fetch tests from Python Database
async function fetchLabTests() {
    try {
        const response = await fetch('/api/tests', {
            method: 'GET',
            headers: { 'X-App-Mode': typeof currentWorkspace !== 'undefined' ? currentWorkspace : 'lab' }
        });

        if (!response.ok) throw new Error('Failed to fetch tests');

        availableTests = await response.json();

    } catch (error) {
        console.error("Database Error:", error);
    }
}

// Test add/edit/save (incl. the duplicate-name guard) migrated to React — see
// frontend-lab/src/islands/TestListTab. fetchLabTests() above still needs to run on load for
// the still-vanilla consumers of `availableTests` listed at its definition.
document.addEventListener('DOMContentLoaded', fetchLabTests);

// Result Parameter Templates (Test List > "Parameters", the formula builder) migrated to
// React — see frontend-lab/src/islands/TestListTab/ParametersModal. Fully self-contained
// (currentParameterRows etc. were never read outside this block), so unlike Test
// Panels/availablePanels there's no vanilla global left to keep populating here.

// --- TEST PANELS (Test List > "Manage Panels") --- CRUD UI migrated to React, see
// frontend-lab/src/islands/TestListTab. fetchPanels() below is kept as-is (it never rendered
// anything itself) purely to keep populating `availablePanels`, which the still-vanilla Book
// Test modal's applyPanelQuickSelect() (below) reads directly.
let availablePanels = [];

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

// 4. OVERRIDE: Dynamic "Book Test" Modal
// This overrides the old function to generate checkboxes from our live array!
// Selections for the "Book Tests" modal are tracked here (name -> {price, sample_type}):
// renderBookTestCheckboxes() re-renders the (filtered) checkbox list on every search keystroke,
// and a checked-but-filtered-out box
// would otherwise lose its checked state the moment it leaves the DOM. This object is the
// source of truth; submitTestBooking() reads from it, not from the checkboxes.
let bookTestSelectedTests = {};

function openBookTestModal(clientId) {
    currentBookingClientId = clientId;
    bookTestSelectedTests = {};

    const searchInput = document.getElementById('book-test-search');
    if (searchInput) searchInput.value = '';

    renderBookTestCheckboxes();

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

function renderBookTestCheckboxes() {
    const container = document.getElementById('dynamic-test-checkboxes');
    if (!container) return;

    if (availableTests.length === 0) {
        container.innerHTML = `<p style="color: var(--danger);">${t('empty_no_tests_in_directory', 'No tests available in directory. Please add tests in the "Test List" tab first.')}</p>`;
        return;
    }

    const searchTerm = (document.getElementById('book-test-search')?.value || '').toLowerCase();
    const filtered = availableTests.filter(test =>
        test.name.toLowerCase().includes(searchTerm) ||
        (test.sample_type || '').toLowerCase().includes(searchTerm)
    );

    container.innerHTML = filtered.length === 0
        ? `<p style="color: var(--muted);">${t('empty_no_tests_available', 'No tests available. Click "Add New Test" to begin.')}</p>`
        : filtered.map(test => `
        <label style="display: flex; align-items: center; cursor: pointer; color: var(--text); padding: 8px; border-radius: 4px;">
            <input type="checkbox" class="test-checkbox" value="${test.name}"
                   ${Object.prototype.hasOwnProperty.call(bookTestSelectedTests, test.name) ? 'checked' : ''}
                   onchange="toggleBookTestSelection('${test.name.replace(/'/g, "\\'")}', ${test.price}, '${(test.sample_type || 'Unspecified').replace(/'/g, "\\'")}', this.checked)"
                   style="margin-right: 10px; width: auto;">
            <span style="flex: 1;">${test.name} <span style="font-size:11px; color:var(--muted)">(${test.sample_type || 'Unspecified'})</span></span>
            <span style="color: var(--ok); font-size: 12px;">${parseFloat(test.price).toFixed(2)} EGP</span>
        </label>
    `).join('');
}

function toggleBookTestSelection(testName, price, sampleType, isChecked) {
    if (isChecked) {
        bookTestSelectedTests[testName] = { price, sample_type: sampleType };
    } else {
        delete bookTestSelectedTests[testName];
    }
}

// Toggle-checks every test that belongs to a panel — check all if any are unchecked, else
// uncheck all. The technician can still adjust individual checkboxes afterward. Writes into
// bookTestSelectedTests (not just DOM checked state) so a quick-selected panel survives a
// subsequent search re-render.
function applyPanelQuickSelect(panelId) {
    const panel = (availablePanels || []).find(p => p.id === panelId);
    if (!panel) return;
    const allSelected = panel.tests.every(t => Object.prototype.hasOwnProperty.call(bookTestSelectedTests, t.name));
    panel.tests.forEach(t => {
        if (allSelected) {
            delete bookTestSelectedTests[t.name];
        } else {
            bookTestSelectedTests[t.name] = { price: t.price, sample_type: t.sample_type || 'Unspecified' };
        }
    });
    renderBookTestCheckboxes();
}

// "Check Tests Total Price" (price-check tab) migrated to React —
// frontend-lab/src/islands/PriceCheckTab, mounted by react/lab-islands.js.

function closeBookTestModal() {
    document.getElementById('book-test-modal').style.display = 'none';
    currentBookingClientId = null;
    bookTestSelectedTests = {};
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

    // Gather selected tests and prices from the persisted selection object (not the DOM —
    // see bookTestSelectedTests above for why: a search filter can hide a checked box).
    const selectedEntries = Object.entries(bookTestSelectedTests);
    if (selectedEntries.length === 0) {
        showAlert(t('select_at_least_one_test', 'Please select at least one test.'), 'warn');
        return;
    }

    let testsList = [];
    let pricesList = [];
    let samplesList = [];
    let subtotal = 0;

    selectedEntries.forEach(([name, info]) => {
        testsList.push(name);
        samplesList.push(info.sample_type);
        pricesList.push(info.price);
        subtotal += info.price;
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

// "System Settings" (settings tab: branding, messaging, report credentials, image uploads)
// migrated to React — frontend-lab/src/islands/SettingsTab, mounted by react/lab-islands.js.
// previewImage()/saveSettings() (the settings form's own file-preview and save-payload
// logic) went with it; applyGlobalSettings() below stays vanilla — it's the page-wide
// (sidebar logo/name, background, theme) half, not the settings-form half.

// Apply the saved images to the Sidebar and Background
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
        // Apply Logo (sidebar only now — the Settings tab's own preview is migrated to
        // React, see frontend-lab/src/islands/SettingsTab, and fetches this same endpoint
        // itself rather than reading DOM state this function used to also populate).
        if (settings.logo_path) {
            const sidebarLogo = document.getElementById('sidebar-logo');
            const isBase64 = settings.logo_path.startsWith('data:');
            const logoUrl = isBase64 ? settings.logo_path : `${settings.logo_path}?t=${timestamp}`;
            if (sidebarLogo) sidebarLogo.src = logoUrl;
        }
        if (settings.theme) {
            localStorage.setItem('theme', settings.theme);

            if (settings.theme === 'light') {
                document.body.classList.add('light-mode');
            } else {
                document.body.classList.remove('light-mode');
            }
        }

        // Drives the topbar WhatsApp connect button's visibility — see toggleMessagingOptions()'s
        // own comment for why it takes these as args instead of reading (now React-owned) DOM.
        toggleMessagingOptions(!!settings.msg_enabled, settings.msg_method);

        // Apply Cover Background (page-wide; the Settings tab's own preview is React-owned now)
        if (settings.cover_path) {
            // Similarly, handle base64 vs file path for the cover
            const isBase64 = settings.cover_path.startsWith('data:');
            const coverUrl = isBase64 ? settings.cover_path : `${settings.cover_path}?t=${timestamp}`;

            document.body.style.backgroundImage = `linear-gradient(to bottom, rgba(30, 41, 59, 0.65), rgba(15, 23, 42, 0.85)), url('${coverUrl}')`;
            document.body.style.backgroundSize = 'contain'; // shrink to fit the screen instead of cropping to fill it
            document.body.style.backgroundPosition = 'center';
            document.body.style.backgroundAttachment = 'fixed';
            document.body.style.backgroundRepeat = 'no-repeat';
        }

        // Apply Lab Name & Subtitle (sidebar only — see the Logo comment above)
        if (settings.lab_name) {
            const sidebarName = document.getElementById('sidebar-brand-name');
            if (sidebarName) sidebarName.textContent = settings.lab_name;
        }

        if (settings.lab_subtitle) {
            const sidebarSub = document.getElementById('sidebar-brand-sub');
            if (sidebarSub) sidebarSub.textContent = settings.lab_subtitle;
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
        
        // Transaction History and Financial Overview both migrated to React and fetch their
        // own copies of /api/transactions now — this function stays alive purely to keep
        // `allTransactions` fresh for the checkout modal's payment-method <datalist> below, and
        // to tell Financial Overview to refetch (a transaction may have just changed here,
        // e.g. via window.fetchTransactionsData() called from TransactionHistoryTab's own
        // writes) — same lab:refresh-* CustomEvent bridge refreshVisibleTables() uses.
        window.dispatchEvent(new CustomEvent('lab:refresh-financial-overview'));
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

// Transaction History table (filter/pagination/bulk-delete) and the Complete Payment
// modal migrated to React — see
// frontend-lab/src/islands/TransactionHistoryTab/{TransactionHistoryTab,CompletePaymentModal}.tsx.

// Financial Overview (calculateFinancials()/renderFinancialCharts(), and the
// revChartInstance/genderChartInstance/testChartInstance globals they used) migrated to
// React — see frontend-lab/src/islands/FinancialOverviewTab/FinancialOverviewTab.tsx.

// ==========================================
// WAREHOUSE MANAGEMENT SYSTEM
// ==========================================

// Mirrors the exact admin/master check setupUIForRole() already uses to decide tab
// visibility — used here to gate warehouse actions that are admin-only server-side too
// (bill status changes, work-order approve/reject, batch disposal).
function isAdminUser() {
    return currentUser?.role === 'admin' || currentUser?.role === 'lab_master';
}

// Item list rendering (incl. the "Expired Only" filter/category filter+color), CRUD, the
// "Review Expired" button, and Batches (receive/FEFO view/dispose) all moved to React — see
// frontend-lab/src/islands/WarehouseTab. This now only keeps the `warehouseItems` global
// fresh for the still-vanilla Work-Orders modal and Excel import that read it directly, and
// tells the React tab to refresh via the same lab:refresh-* CustomEvent bridge used everywhere
// else — every mutating warehouse flow (item save/delete, Excel import, scan) already calls
// this function, so nothing else needed to change to pick up the new event.
async function fetchWarehouseData() {
    try {
        const response = await apiFetch('/api/warehouse');
        if (response.ok) {
            warehouseItems = await response.json();
            window.dispatchEvent(new CustomEvent('lab:refresh-warehouse'));
        }
    } catch (error) {
        console.error("Failed to load warehouse data", error);
    }
}

// populateWarehouseCategoryOptions()/categoryColor()/renderWarehouseTable() (item list +
// category filter/color) and openWarehouseModal()/closeWarehouseModal()/saveWarehouseItem()
// (Add/Edit Item) migrated to React — see frontend-lab/src/islands/WarehouseTab.

// Batches — FEFO view (openItemBatchesModal), receive-into-batch (openReceiveBatchModal),
// and expired-batch disposal (openExpiredBatchesModal/confirmDisposeBatch) migrated to React
// — see frontend-lab/src/islands/WarehouseTab/{ItemBatchesModal,ReceiveBatchModal,
// ExpiredBatchesModal}.tsx. generateBarcodeImage() (barcode-engine section above) stays here
// since printSamplingSheet() still uses it for an unrelated feature.

// updateBulkWarehouseBtn()/toggleAllWarehouseBoxes()/handleBulkDeleteWarehouse() (item
// checkboxes + bulk delete) migrated to React — see
// frontend-lab/src/islands/WarehouseTab/WarehouseTab.tsx.

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

// Single-item order (New Bill), bulk order (bulk-bill-*), Bills History (incl. per-bill and
// per-bulk-group status changes), and Receive-into-batch all migrated to React — see
// frontend-lab/src/islands/WarehouseTab. Nothing vanilla reads bill data anymore, so the old
// `warehouseBills` global that openReceiveBatchModal() used to populate is gone too.

// printBulkBill() migrated to React (BulkBillDetailModal's own print()) — see
// frontend-lab/src/islands/WarehouseTab.

// Work Orders (create/request, admin approve/reject) and Fulfill-via-Scan
// (barcode-driven per-batch fulfillment with server-side FEFO 409/override) migrated to
// React — see frontend-lab/src/islands/WarehouseTab/{WorkOrderModal,WorkOrdersHistoryModal,
// WorkOrderDetailModal,FulfillScanModal}.tsx. This was the last vanilla piece of Warehouse
// (see docs/app_react_migration.md) — the `.warehouse-checkbox`/`data-id` DOM convention
// openWorkOrderModal() used to read is gone too, since WarehouseTab.tsx now passes its own
// selection state straight into WorkOrderModal as a prop.

// ==========================================
// SECURITY, RBAC & USER MANAGEMENT
// ==========================================
// User CRUD + permissions (fetchUsers/createNewUser/deleteUser/openAccessModal/
// savePermissions) migrated to React — see frontend-lab/src/islands/SecurityRBACTab.
// switchRole()/initializeUserSecurity() below are a separate, unrelated mechanism (the
// master-only "View As" role simulator + the real-role tab-visibility fallback) and stay
// vanilla.

let currentActiveRole = 'lab_master';

// THE SECURITY BOUNCER (Role Enforcement)
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

// Test Directory's own two-sheet (Tests + Parameters) Excel import/export engine migrated to
// React — see frontend-lab/src/islands/TestListTab/excelImportExport.ts. Fully self-contained
// (getStandardizedTestName/exportTestsWithParameters/processExcelImport were never called or
// read outside this block), so — like the Parameters modal — there's no vanilla global left
// to keep populating here; the React version reads TestListTab's own `tests` state directly
// instead of the vanilla `availableTests` global this used to read.

// openAccessModal()/savePermissions()/EXTRA_PERMISSIONS migrated to React — see
// frontend-lab/src/islands/SecurityRBACTab/SecurityRBACTab.tsx.
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

// The #hr-management 10s poll that used to live here (calling the now-removed fetchHRData())
// is gone — HREmployeesTab (frontend-lab/src/islands/HREmployeesTab) has had its own
// equivalent poll since the employee list itself became React, so this was already fully
// redundant even before fetchHRData() was removed.

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

// "Activity Log" (activity-log tab, incl. online-users polling) migrated to React —
// frontend-lab/src/islands/ActivityLogTab, mounted by react/lab-islands.js.

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
