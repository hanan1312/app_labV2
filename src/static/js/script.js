// --- GLOBAL STATE ---
let patients = [];
let currentUser = null;
let clinicConfig = null;
let financialData = {};
let revenueChart = null;
let serviceChart = null;
let serviceTypes = [];
let selectedPatientForReservation = null;
let selectedPatientForTransaction = null;
let currentPatientDetails = null;

// "YYYY-MM-DD" for a given instant (default: right now) as it reads in Africa/Cairo local
// time — used for "today"/"this month" boundary comparisons so they agree with the
// server-stamped Cairo-local created_at/date values (see src/utils/timezone.py) regardless
// of the viewing browser's own OS timezone. Matches cairoDateStr() in script_lab.js.
function cairoDateStr(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(date);
}

// --- WORKSPACE LOGIC ---
let currentWorkspace = localStorage.getItem('app_workspace') || 'clinic';

function initializeWorkspaceDropdown() {
    const selector = document.getElementById('workspace-selector');
    if (selector) selector.value = currentWorkspace;
}

async function changeWorkspace() {
    const selector = document.getElementById('workspace-selector');
    currentWorkspace = selector.value;
    localStorage.setItem('app_workspace', currentWorkspace);
    try {
        const response = await apiFetch('/api/auth/update_workspace', {
            method: 'POST', body: JSON.stringify({ workspace: currentWorkspace })
        });
        if (response.ok) window.location.reload();
        else showAlert('Failed to update workspace on server.', 'danger');
    } catch (error) {
        showAlert('An error occurred while switching workspaces.', 'danger');
    }
}

async function apiFetch(endpoint, options = {}) {
    if (!options.headers) options.headers = {};
    options.headers['X-App-Mode'] = currentWorkspace;
    if (options.body && !options.headers['Content-Type'] && !(options.body instanceof FormData)) {
        options.headers['Content-Type'] = 'application/json';
    }
    return await fetch(endpoint, options);
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', main);

async function main() {
    try {
        const response = await apiFetch('/api/auth/current_user', { method: 'GET', credentials: 'include' });
        if (!response.ok) {
            window.location.href = '/login';
            return; 
        }
        currentUser = await response.json();
        await initializeApp();
    } catch (error) {}
}

async function initializeApp() {
    setupEventListeners();
    await loadFeatures();
    initializeWorkspaceDropdown();
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
            if (selector && features.workspace_switcher === true) selector.style.display = 'block'; 
        }
    } catch (error) {}
}

function setupEventListeners() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            if (tabName) showTab(tabName);
        });
    });

    const methodSelect = document.getElementById('payment-method');
    methodSelect?.addEventListener('change', function() {
        const cardSection = document.getElementById('card-details-section');
        const insuranceSection = document.getElementById('insurance-details-section');
        cardSection.style.display = 'none';
        insuranceSection.style.display = 'none';
        if (this.value === 'card') cardSection.style.display = 'block';
        else if (this.value === 'insurance') insuranceSection.style.display = 'block';
    });

    document.getElementById('patient-form')?.addEventListener('submit', handleAddPatient);
    document.getElementById('clinic-config-form')?.addEventListener('submit', handleUpdateConfig);
    document.getElementById('reservation-form')?.addEventListener('submit', handleCreateReservation);
    document.getElementById('transaction-form')?.addEventListener('submit', handleAddTransaction);
    document.getElementById('patient-search')?.addEventListener('keyup', searchPatients);
}

async function loadInitialData() {
    try {
        const [patientsRes, configRes, serviceTypesRes] = await Promise.all([
            apiFetch('/api/patients'), apiFetch('/api/clinic/config'), apiFetch('/api/financial/service-types')
        ]);
        patients = await patientsRes.json();
        clinicConfig = await configRes.json();
        serviceTypes = await serviceTypesRes.json();
        
        updateDashboard();
        updateUserInfo();
        populateSettingsForm();
        populateServiceTypes();
        
        const activeTab = document.querySelector('.nav-tab.active')?.dataset?.tab;
        if (activeTab) showTab(activeTab);
    } catch (error) {
        showAlert('Could not load application data.', 'danger');
    }
}

function populateServiceTypes() {
    const serviceTypeSelect = document.getElementById('service-type');
    if (!serviceTypeSelect) return;
    serviceTypeSelect.innerHTML = '<option value="">Select Service Type</option>';
    if (serviceTypes && serviceTypes.length > 0) {
        serviceTypes.forEach(service => {
            const option = document.createElement('option');
            option.value = service.id; 
            option.textContent = `${service.name} - $${service.default_price}`;
            serviceTypeSelect.appendChild(option);
        });
    }
}

function updateUserInfo() {
    const userInfoDiv = document.getElementById('user-info');
    if (currentUser && clinicConfig && userInfoDiv) {
        userInfoDiv.innerHTML = `
            <div class="avatar">${currentUser.username.substring(0, 2).toUpperCase()}</div>
            <div style="text-align: left;">
                <div class="user-name">${currentUser.username} <span class="pill info" style="font-size: 9px; padding: 2px 6px;">${currentUser.role}</span></div>
                <div class="user-role">${clinicConfig.doctor_name || 'Doctor'} · ${clinicConfig.clinic_phone || 'Phone'}</div>
            </div>
        `;
    }
}

function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
    const activeContent = document.getElementById(tabName);
    const activeTab = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);
    if (activeContent) activeContent.classList.add('active');
    if (activeTab) activeTab.classList.add('active');
    
    switch(tabName) {
        case 'add-patient': if (!editingPatientId) resetPatientForm(); break;
        case 'patients': displayPatients(patients); break;
        case 'awaiting-hall': loadAwaitingPatients(); break;
        case 'finished-reservations': loadFinishedPatients(); break;
        case 'patient-history': loadPatientHistory(); break;
        case 'hall-status-manager': loadHallStatusPatients(); break;
        case 'financial': initializeFinancialDashboard(); break;
    }
}

function updateDashboard() {
    if (!patients) return;
    const totalPatients = patients.length;
    // created_at/visit_datetime are already Cairo-local text from the server — compared as
    // strings against a Cairo-local "now" reference, rather than round-tripped through Date
    // object getters (which read the browser's own timezone, not necessarily Cairo's).
    const nowCairoMonth = cairoDateStr().substring(0, 7); // "YYYY-MM"
    const newPatientsThisMonth = patients.filter(p => p.created_at && p.created_at.substring(0, 7) === nowCairoMonth).length;
    const todayCairoStr = cairoDateStr(); // "YYYY-MM-DD"
    const todayPatientsCount = patients.filter(p => p.visit_datetime && p.visit_datetime >= todayCairoStr).length;
    const totalAge = patients.reduce((sum, p) => sum + calculateAge(p.date_of_birth), 0);
    const averageAge = totalPatients > 0 ? Math.round(totalAge / totalPatients) : 0;

    const totalPatientsEl = document.getElementById('total-patients');
    const newPatientsEl = document.getElementById('new-patients');
    const avgAgeEl = document.getElementById('avg-age');
    const todayPatientsEl = document.getElementById('today-patients');

    if(totalPatientsEl) totalPatientsEl.textContent = totalPatients;
    if(newPatientsEl) newPatientsEl.textContent = newPatientsThisMonth;
    if(avgAgeEl) avgAgeEl.textContent = averageAge;
    if(todayPatientsEl) todayPatientsEl.textContent = todayPatientsCount;
}

function displayPatients(patientsToDisplay) {
    const tableBody = document.getElementById('patients-table-body');
    if (!tableBody) return;
    if (patientsToDisplay.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--muted); padding: 20px;">No patients found.</td></tr>';
        return;
    }
    tableBody.innerHTML = patientsToDisplay.map(p => `
        <tr>
            <td><input type="checkbox" class="patient-checkbox" data-id="${p.id}" onchange="updateBulkDeleteButton()"></td>
            <td><strong>#${p.id}</strong></td>
            <td>${p.first_name} ${p.last_name}</td>
            <td><span class="pill ghost">${p.gender}</span></td>
            <td style="color: var(--muted)">${p.phone}</td>
            <td>
                <button class="btn ghost" style="padding: 6px 12px; font-size: 12px;" onclick="viewPatient(${p.id})">Review</button>
            </td>
        </tr>
    `).join('');
}

function searchPatients() {
    const searchTerm = document.getElementById('patient-search').value.toLowerCase();
    const filtered = patients.filter(p => 
        p.id.toString().includes(searchTerm) || p.first_name.toLowerCase().includes(searchTerm) || p.last_name.toLowerCase().includes(searchTerm) || p.phone.includes(searchTerm)
    );
    displayPatients(filtered);
}

let editingPatientId = null;

function editPatient() {
    if (!currentPatientDetails) return;
    editingPatientId = currentPatientDetails.id;
    showTab('add-patient');
    const submitBtn = document.querySelector('#patient-form button[type="submit"]');
    if (submitBtn) { submitBtn.textContent = 'Save Changes'; }
    const form = document.getElementById('patient-form');
    Object.keys(currentPatientDetails).forEach(key => {
        const value = currentPatientDetails[key];
        const input = form.elements[key];
        if (input) {
            if (input.type === 'date' && value) input.value = value.split('T')[0];
            else input.value = value || '';
        }
    });
    closePatientDetailsModal();
    showAlert(`Editing ${currentPatientDetails.first_name}`, 'info');
}

async function handleAddPatient(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const patientData = Object.fromEntries(formData.entries());
    const url = editingPatientId ? `/api/patients/${editingPatientId}` : '/api/patients';
    const method = editingPatientId ? 'PUT' : 'POST';

    try {
        const response = await fetch(url, {
            method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patientData)
        });
        if (!response.ok) throw new Error((await response.json()).error);
        showAlert(editingPatientId ? 'Patient updated!' : 'Patient added!', 'success');
        resetPatientForm();
        await loadInitialData();
        showTab('patients');
    } catch (error) {
        showAlert(`Error: ${error.message}`, 'danger');
    }
}

function resetPatientForm() {
    editingPatientId = null;
    document.getElementById('patient-form').reset();
    const submitBtn = document.querySelector('#patient-form button[type="submit"]');
    if(submitBtn) submitBtn.textContent = 'Save Patient';
}

function toggleSelectAll(masterCheckbox) {
    document.querySelectorAll('.patient-checkbox').forEach(cb => cb.checked = masterCheckbox.checked);
    updateBulkDeleteButton();
}

function updateBulkDeleteButton() {
    const count = document.querySelectorAll('.patient-checkbox:checked').length;
    document.getElementById('bulk-delete-btn').style.display = count > 0 ? 'block' : 'none';
}

async function handleBulkDelete() {
    const selectedIds = Array.from(document.querySelectorAll('.patient-checkbox:checked')).map(cb => cb.dataset.id);
    if (!confirm(`Delete ${selectedIds.length} patient(s)?`)) return;
    try {
        await Promise.all(selectedIds.map(id => apiFetch(`/api/patients/${id}`, { method: 'DELETE' })));
        showAlert('Patients deleted.', 'success');
        await loadInitialData();
        displayPatients(patients);
        updateBulkDeleteButton();
    } catch (error) {
        showAlert('Error deleting patients.', 'danger');
    }
}

function populateSettingsForm() {
    if (currentUser?.role === 'admin' && clinicConfig) {
        if (document.getElementById('doctor-name-config')) document.getElementById('doctor-name-config').value = clinicConfig.doctor_name || '';
        if (document.getElementById('clinic-name-config')) document.getElementById('clinic-name-config').value = clinicConfig.clinic_name || '';
        if (document.getElementById('clinic-phone-config')) document.getElementById('clinic-phone-config').value = clinicConfig.clinic_phone || '';
    }
}

async function handleUpdateConfig(event) {
    event.preventDefault();
    const configData = Object.fromEntries(new FormData(event.target).entries());
    try {
        const response = await apiFetch('/api/clinic/config', { method: 'PUT', body: JSON.stringify(configData) });
        if (!response.ok) throw new Error((await response.json()).error);
        clinicConfig = (await response.json()).config;
        updateUserInfo();
        showAlert('Settings updated!', 'success');
    } catch (error) {
        showAlert(error.message, 'danger');
    }
}

async function logout() {
    await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/login';
}

function calculateAge(dateOfBirth) {
    if (!dateOfBirth) return 0;
    const ageDate = new Date(Date.now() - new Date(dateOfBirth).getTime());
    return Math.abs(ageDate.getUTCFullYear() - 1970);
}

function showAlert(message, type = 'info') {
    const container = document.getElementById('alert-container');
    if (!container) return;
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert-item ${type}`;
    alertDiv.innerHTML = `<div><div class="who">System Message</div><div class="what">${message}</div></div>`;
    container.prepend(alertDiv);
    setTimeout(() => { alertDiv.style.opacity = '0'; setTimeout(() => alertDiv.remove(), 500); }, 4000);
}

function searchPatientsForReservation() {
    const term = document.getElementById('reservation-patient-search').value.toLowerCase();
    const resultsDiv = document.getElementById('reservation-patient-results');
    if (term.length < 1) { resultsDiv.innerHTML = ''; return; }
    const filtered = patients.filter(p => p.first_name.toLowerCase().includes(term) || p.last_name.toLowerCase().includes(term) || p.phone.includes(term) || p.id.toString() === term);
    
    if (filtered.length === 0) {
        resultsDiv.innerHTML = `<div class="card" style="text-align: center;"><p style="color: var(--muted); margin-bottom: 10px;">No patient found</p><button class="btn ghost" onclick="showTab('add-patient')">Add New Patient</button></div>`;
        return;
    }
    resultsDiv.innerHTML = filtered.map(p => `
        <div class="card" onclick="selectPatientForReservation(${p.id})" style="cursor: pointer; padding: 12px; margin-bottom: 8px;">
            <strong>ID: ${p.id} - ${p.first_name} ${p.last_name}</strong><br>
            <span style="color: var(--muted); font-size: 12px;">Phone: ${p.phone}</span>
        </div>
    `).join('');
}

function selectPatientForReservation(patientId) {
    selectedPatientForReservation = patients.find(p => p.id === patientId);
    if (selectedPatientForReservation) {
        document.getElementById('reservation-patient-id').value = patientId;
        document.getElementById('reservation-patient-search').value = `${selectedPatientForReservation.first_name} ${selectedPatientForReservation.last_name}`;
        document.getElementById('reservation-patient-results').innerHTML = '';
        document.getElementById('reservation-form').style.display = 'block';
        document.getElementById('visit-date').value = cairoDateStr();
    }
}

async function handleCreateReservation(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const visitDateTime = new Date(`${formData.get('visit_date')}T${formData.get('visit_time')}`).toISOString();
    
    try {
        const response = await apiFetch(`/api/patients/${selectedPatientForReservation.id}/reservation`, {
            method: 'POST',
            body: JSON.stringify({ visit_datetime: visitDateTime, visit_type: formData.get('visit_type'), hall_status: formData.get('hall_status') })
        });
        if (!response.ok) throw new Error((await response.json()).error);
        showAlert('Reservation created!', 'success');
        event.target.reset();
        cancelReservation();
        await loadInitialData();
        showTab('dashboard');
    } catch (error) {
        showAlert(error.message, 'danger');
    }
}

function cancelReservation() {
    document.getElementById('reservation-form').style.display = 'none';
    document.getElementById('reservation-patient-search').value = '';
    document.getElementById('reservation-patient-results').innerHTML = '';
    selectedPatientForReservation = null;
}

function showAddTransactionModal() {
    const modal = document.getElementById('transaction-modal');
    if (modal) {
        modal.style.display = 'block';
        if (document.getElementById('service-type')) populateServiceTypes(); 
        const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        document.getElementById('transaction-date').value = now.toISOString().slice(0, 16);
    }
}

function closeTransactionModal() {
    const modal = document.getElementById('transaction-modal');
    if (modal) { modal.style.display = 'none'; document.getElementById('transaction-form').reset(); document.getElementById('transaction-patient-results').innerHTML = ''; selectedPatientForTransaction = null; }
}

function searchPatientsForTransaction() {
    const term = document.getElementById('transaction-patient-search').value.toLowerCase();
    const resultsDiv = document.getElementById('transaction-patient-results');
    if (term.length < 2) { resultsDiv.innerHTML = ''; return; }
    const filtered = patients.filter(p => p.first_name.toLowerCase().includes(term) || p.last_name.toLowerCase().includes(term) || p.id.toString().includes(term));
    resultsDiv.innerHTML = filtered.map(p => `
        <div class="card" onclick="selectPatientForTransaction(${p.id})" style="cursor: pointer; padding: 10px; margin-bottom: 5px;">
            <strong>${p.first_name} ${p.last_name}</strong>
        </div>
    `).join('');
}

function selectPatientForTransaction(patientId) {
    selectedPatientForTransaction = patients.find(p => p.id === patientId);
    if (selectedPatientForTransaction) {
        document.getElementById('transaction-patient-id').value = patientId;
        document.getElementById('transaction-patient-search').value = `${selectedPatientForTransaction.first_name} ${selectedPatientForTransaction.last_name}`;
        document.getElementById('transaction-patient-results').innerHTML = '';
    }
}

async function handleAddTransaction(event) {
    event.preventDefault();
    const transactionData = Object.fromEntries(new FormData(event.target).entries());
    if (isNaN(transactionData.service_type_id)) {
        const found = serviceTypes.find(s => s.name.toLowerCase() === transactionData.service_type_id.toLowerCase());
        if (found) transactionData.service_type_id = found.id;
    }
    try {
        const response = await apiFetch('/api/financial/transactions', { method: 'POST', body: JSON.stringify(transactionData) });
        if (!response.ok) throw new Error((await response.json()).error);
        showAlert('Transaction added!', 'success');
        closeTransactionModal();
        await loadInitialData(); 
    } catch (error) {
        showAlert(error.message, 'danger');
    }
}

async function viewPatient(patientId) {
    try {
        const response = await apiFetch(`/api/patients/${patientId}`);
        if (!response.ok) throw new Error('Failed to fetch patient');
        currentPatientDetails = await response.json();
        showPatientDetailsModal();
    } catch (error) {
        showAlert(error.message, 'danger');
    }
}

function showPatientDetailsModal() {
    const modal = document.getElementById('patient-details-modal');
    const titleEl = document.getElementById('patient-details-title');
    const contentEl = document.getElementById('patient-details-content');
    if (modal && currentPatientDetails) {
        titleEl.textContent = `[ID: ${currentPatientDetails.id}] ${currentPatientDetails.first_name} ${currentPatientDetails.last_name}`;
        contentEl.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div>
                    <h4 style="color: var(--teal); margin-bottom: 8px;">Personal Info</h4>
                    <p style="color: var(--muted); margin-bottom: 4px;"><strong>Age:</strong> ${calculateAge(currentPatientDetails.date_of_birth)}</p>
                    <p style="color: var(--muted); margin-bottom: 4px;"><strong>Gender:</strong> ${currentPatientDetails.gender}</p>
                    <p style="color: var(--muted); margin-bottom: 4px;"><strong>Phone:</strong> ${currentPatientDetails.phone}</p>
                </div>
                <div>
                    <h4 style="color: var(--teal); margin-bottom: 8px;">Visit Info</h4>
                    <p style="color: var(--muted); margin-bottom: 4px;"><strong>Status:</strong> ${currentPatientDetails.status || 'N/A'}</p>
                    <p style="color: var(--muted); margin-bottom: 4px;"><strong>Type:</strong> ${currentPatientDetails.visit_type || 'N/A'}</p>
                    <p style="color: var(--muted); margin-bottom: 4px;"><strong>Date:</strong> ${currentPatientDetails.visit_datetime ? new Date(currentPatientDetails.visit_datetime).toLocaleString() : 'N/A'}</p>
                </div>
            </div>
        `;
        modal.style.display = 'block';
    }
}

function closePatientDetailsModal() {
    const modal = document.getElementById('patient-details-modal');
    if (modal) { modal.style.display = 'none'; currentPatientDetails = null; }
}

async function loadAwaitingPatients() {
    const awaitingList = document.getElementById('awaiting-patients-list');
    if (!awaitingList) return;
    const awaitingPatients = patients.filter(p => p.hall_status === 'In' && p.status !== 'finished');
    if (awaitingPatients.length === 0) { awaitingList.innerHTML = '<p style="color: var(--muted); grid-column: span 12;">No patients currently awaiting.</p>'; return; }
    
    awaitingList.innerHTML = awaitingPatients.map(p => `
        <div class="card col-6">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                <div>
                    <h3 style="font-size: 16px; margin-bottom: 4px;">${p.first_name} ${p.last_name}</h3>
                    <div style="color: var(--muted); font-size: 12px;">Age: ${calculateAge(p.date_of_birth)} · Visit: ${p.visit_datetime ? new Date(p.visit_datetime).toLocaleTimeString() : 'N/A'}</div>
                </div>
                <span class="pill info">${p.visit_type || 'General'}</span>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn" style="flex: 1;" onclick="markPatientFinished(${p.id})">Mark Finished</button>
                <button class="btn ghost" onclick="viewPatient(${p.id})">Details</button>
            </div>
        </div>
    `).join('');
}

async function markPatientFinished(patientId) {
    try {
        const response = await apiFetch(`/api/patients/${patientId}`, { method: 'PUT', body: JSON.stringify({ status: 'finished', hall_status: 'Out' }) });
        if (!response.ok) throw new Error('Failed to update patient');
        showAlert('Patient marked as finished!', 'success');
        await loadInitialData(); loadAwaitingPatients();
    } catch (error) { showAlert(error.message, 'danger'); }
}

let currentDefaultPrice = 0;
function openPaymentForPatient(patientId) {
    const patient = patients.find(p => p.id === patientId);
    if (!patient || !patient.visit_type) return;
    showAddTransactionModal(); selectPatientForTransaction(patientId);
    
    const displayLabel = document.getElementById('service-type-display');
    const hiddenInput = document.getElementById('service-type-hidden');
    const match = serviceTypes.find(s => s.name.trim().toLowerCase() === patient.visit_type.trim().toLowerCase());

    if (match) {
        currentDefaultPrice = match.default_price;
        displayLabel.textContent = `${match.name} - $${match.default_price}`;
        hiddenInput.value = match.id;
        const amountInput = document.getElementById('amount');
        if (amountInput) amountInput.value = match.default_price;
        document.getElementById('comment-section').style.display = 'none';
        document.getElementById('price_comment').required = false;
    } else {
        displayLabel.textContent = patient.visit_type; hiddenInput.value = patient.visit_type; 
    }
}

function checkAmountDifference() {
    const inputAmount = parseFloat(document.getElementById('amount').value) || 0;
    const commentSection = document.getElementById('comment-section');
    const commentInput = document.getElementById('price_comment');
    if (inputAmount < currentDefaultPrice) { commentSection.style.display = 'block'; commentInput.required = true; } 
    else { commentSection.style.display = 'none'; commentInput.required = false; }
}

async function loadFinishedPatients() {
    const finishedList = document.getElementById('finished-patients-list');
    if (!finishedList) return;
    const finishedPatients = patients.filter(p => p.status === 'finished');
    if (finishedPatients.length === 0) { finishedList.innerHTML = '<p style="color: var(--muted); grid-column: span 12;">No finished reservations found.</p>'; return; }
    
    finishedList.innerHTML = finishedPatients.map(p => `
        <div class="card col-6">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                <div>
                    <h3 style="font-size: 16px; margin-bottom: 4px;">${p.first_name} ${p.last_name}</h3>
                    <div style="color: var(--muted); font-size: 12px;">Age: ${calculateAge(p.date_of_birth)} · ${p.visit_type || 'N/A'}</div>
                </div>
                <span class="pill ok">Finished</span>
            </div>
            <div style="display: flex; gap: 8px;">
                ${p.has_paid ? `<button class="btn ghost" disabled style="flex: 1; opacity: 0.5;">Paid</button>` : `<button class="btn" style="flex: 1; background: var(--ok);" onclick="openPaymentForPatient(${p.id})">Pay Now</button>`}
                <button class="btn ghost" onclick="generatePatientPDF(${p.id})">PDF</button>
                <button class="btn ghost" onclick="viewPatient(${p.id})">Details</button>
            </div>
        </div>
    `).join('');
}

async function loadPatientHistory() {
    const historyList = document.getElementById('patient-history-list');
    if (!historyList) return;
    const patientsWithHistory = patients.filter(p => p.visit_datetime);
    if (patientsWithHistory.length === 0) { historyList.innerHTML = '<p style="color: var(--muted); grid-column: span 12;">No patient history found.</p>'; return; }
    
    patientsWithHistory.sort((a, b) => new Date(b.visit_datetime) - new Date(a.visit_datetime));
    historyList.innerHTML = patientsWithHistory.map(p => `
        <div class="card col-4">
            <h3 style="font-size: 16px; margin-bottom: 4px;">${p.first_name} ${p.last_name}</h3>
            <div style="color: var(--muted); font-size: 12px; margin-bottom: 12px;">Date: ${new Date(p.visit_datetime).toLocaleDateString()}</div>
            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); padding-top: 12px;">
                <span class="pill ghost">${p.visit_type || 'N/A'}</span>
                <span class="pill ${p.status === 'finished' ? 'ok' : 'warn'}">${p.status}</span>
            </div>
        </div>
    `).join('');
}

async function loadHallStatusPatients() {
    const hallStatusList = document.getElementById('hall-status-list');
    if (!hallStatusList) return;
    const todayCairoStr = cairoDateStr(); // "YYYY-MM-DD" — visit_datetime is already Cairo-local text
    const todayPatients = patients.filter(p => p.visit_datetime && p.visit_datetime >= todayCairoStr && p.status !== 'finished');
    
    if (todayPatients.length === 0) { hallStatusList.innerHTML = '<p style="color: var(--muted); padding: 20px;">No patients scheduled for today.</p>'; return; }
    
    let html = `
        <div style="margin-bottom: 16px;"><button class="btn" onclick="submitSelectedPatientsToHall()">Submit Selected "In"</button></div>
        <div class="table-container"><table>
            <thead><tr><th><input type="checkbox" onclick="toggleSelectAllHall(this)"></th><th>ID</th><th>Patient Name</th><th>Visit Type</th><th>Status</th><th style="text-align: right;">Actions</th></tr></thead>
            <tbody>
    `;

    html += todayPatients.map(p => {
        const isOut = p.hall_status?.toLowerCase() !== 'in';
        return `<tr>
            <td><input type="checkbox" class="hall-status-checkbox" data-patient-id="${p.id}"></td>
            <td><strong>#${p.id}</strong></td>
            <td>${p.first_name} ${p.last_name}</td>
            <td style="color: var(--muted)">${p.visit_type || 'N/A'}</td>
            <td><span class="pill ${isOut ? 'ghost' : 'warn'}">${p.hall_status || 'Out'}</span></td>
            <td style="text-align: right;">
                <button class="btn ghost" style="padding: 6px 12px;" onclick="viewPatient(${p.id})">Details</button>
                <button class="btn" style="padding: 6px 12px; margin-left: 6px; ${!isOut ? 'background: var(--surface); color: var(--text); border: 1px solid var(--border);' : ''}" onclick="toggleHallStatus(${p.id}, '${isOut ? 'In' : 'Out'}')">${isOut ? 'Move In' : 'Move Out'}</button>
            </td>
        </tr>`;
    }).join('');
    html += `</tbody></table></div>`;
    hallStatusList.innerHTML = html;
}

async function toggleHallStatus(patientId, newStatus) {
    try {
        await apiFetch(`/api/patients/${patientId}`, { method: 'PUT', body: JSON.stringify({ hall_status: newStatus }) });
        showAlert(`Patient moved ${newStatus.toLowerCase()}!`, 'success');
        await loadInitialData(); loadHallStatusPatients();
    } catch (error) {}
}

async function submitSelectedPatientsToHall() {
    const checkboxes = document.querySelectorAll('.hall-status-checkbox:checked');
    if (checkboxes.length === 0) { showAlert('Please select patients.', 'warn'); return; }
    const ids = Array.from(checkboxes).map(cb => parseInt(cb.dataset.patientId));
    Promise.all(ids.map(id => apiFetch(`/api/patients/${id}`, { method: 'PUT', body: JSON.stringify({ hall_status: 'In' }) })))
    .then(() => { showAlert('Submitted to hall!', 'success'); loadInitialData().then(() => loadHallStatusPatients()); });
}

async function generatePatientPDF(patientId) {
    const id = patientId || (currentPatientDetails ? currentPatientDetails.id : null);
    try {
        const response = await fetch(`/api/patients/${id}/report`, { method: 'POST' });
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `patient_${id}_report.pdf`;
        document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url);
    } catch (error) { showAlert('Error generating PDF', 'danger'); }
}

async function performDailyReset() {
    if (!confirm('Perform daily reset?')) return;
    try {
        await Promise.all(patients.map(p => apiFetch(`/api/patients/${p.id}`, { method: 'PUT', body: JSON.stringify({ hall_status: 'Out' }) })));
        showAlert('Daily reset completed!', 'success'); await loadInitialData(); updateDashboard();
    } catch (error) {}
}

// Master Control Logic
let activeMasterWorkspace = null;

function setupUIForRole() {
    const isMaster = String(currentUser?.id).startsWith('master_');
    if (isMaster) {
        document.querySelector('.standard-settings-view').style.display = 'none';
        document.getElementById('master-settings-view').style.display = 'block';
        document.getElementById('settings-tab').style.display = 'block'; 
    } else if (currentUser?.role === 'admin') {
        document.getElementById('settings-tab').style.display = 'block';
        document.getElementById('financial-tab').style.display = 'block';
    }
    if (!isMaster && clinicConfig && clinicConfig.active_features) {
        document.querySelectorAll('.nav-tab').forEach(tab => {
            const fName = tab.dataset.tab;
            if (fName === 'settings') return; 
            if (fName === 'financial' && currentUser.role !== 'admin') return;
            if (fName && !clinicConfig.active_features.includes(fName)) tab.style.display = 'none';
        });
    }
}

function openMasterModal(workspace) {
    activeMasterWorkspace = workspace;
    document.getElementById('master-modal-title').textContent = `Managing: ${workspace.toUpperCase()}`;
    document.getElementById('master-management-modal').style.display = 'block';
    showMasterView('add-client');
}

function closeMasterModal() { document.getElementById('master-management-modal').style.display = 'none'; }
function showMasterView(viewId) {
    document.getElementById('master-view-add-client').style.display = 'none';
    document.getElementById('master-view-configure-features').style.display = 'none';
    document.getElementById(`master-view-${viewId}`).style.display = 'block';
}

function closeStatsModal() { document.getElementById('stats-modal').style.display = 'none'; }