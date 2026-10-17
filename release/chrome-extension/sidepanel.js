//! Hexactra Chrome extension - Side panel logic
import { loadProviders, addProvider, setCurrentProvider, testProviderConnection, removeProvider } from './provider';
import { isRequestValid, getRequestRemainingSeconds } from './hitl.js';
// DOM state
let currentTabId = null;
let currentUrl = null;
let providerState = {};
let currentTaskId = null;
let taskStatus = 'idle';
/**
 * Initialize the side panel
 */
export async function init() {
    console.log('Side panel initialized');
    // Set up event listeners
    document.addEventListener('DOMContentLoaded', () => {
        setupUI();
    });
    // Listen for messages from background
    chrome.runtime.onMessage.addListener(handleMessage);
}
/**
 * Set up UI elements
 */
async function setupUI() {
    // Load provider state
    providerState = await loadProviders();
    const initializeBtn = document.getElementById('initialize-btn');
    const observeBtn = document.getElementById('observe-btn');
    const screenshotBtn = document.getElementById('screenshot-btn');
    if (initializeBtn) {
        initializeBtn.addEventListener('click', handleInitialize);
    }
    if (observeBtn) {
        observeBtn.addEventListener('click', handleObserve);
    }
    if (screenshotBtn) {
        screenshotBtn.addEventListener('click', handleScreenshot);
    }
    // Provider configuration
    const providerSelect = document.getElementById('provider-select');
    const testConnectionBtn = document.getElementById('test-connection-btn');
    if (providerSelect) {
        providerSelect.addEventListener('change', handleProviderChange);
        populateProviderDropdown();
    }
    if (testConnectionBtn) {
        testConnectionBtn.addEventListener('click', handleTestConnection);
    }
    // Provider management buttons
    const addProviderBtn = document.getElementById('add-provider-btn');
    const removeProviderBtn = document.getElementById('remove-provider-btn');
    if (addProviderBtn) {
        addProviderBtn.addEventListener('click', handleAddProvider);
    }
    if (removeProviderBtn) {
        removeProviderBtn.addEventListener('click', handleRemoveProvider);
    }
    // Task control buttons
    const startTaskBtn = document.getElementById('start-task-btn');
    const pauseTaskBtn = document.getElementById('pause-task-btn');
    const resumeTaskBtn = document.getElementById('resume-task-btn');
    const stopTaskBtn = document.getElementById('stop-task-btn');
    if (startTaskBtn) {
        startTaskBtn.addEventListener('click', handleStartTask);
    }
    if (pauseTaskBtn) {
        pauseTaskBtn.addEventListener('click', handlePauseTask);
    }
    if (resumeTaskBtn) {
        resumeTaskBtn.addEventListener('click', handleResumeTask);
    }
    if (stopTaskBtn) {
        stopTaskBtn.addEventListener('click', handleStopTask);
    }
    // HITL controls
    setupHitlUI();
}
/**
 * Handle messages from background
 */
function handleMessage(message) {
    switch (message.type) {
        case 'RESPONSE':
            handleResponse(message);
            break;
        case 'TASK_RECOVERED':
            handleTaskRecovered(message);
            break;
        case 'TASK_UPDATE':
            handleTaskUpdate(message);
            break;
    }
}
/**
 * Handle task recovered message from background
 */
function handleTaskRecovered(message) {
    const statusDiv = document.getElementById('task-status');
    if (statusDiv) {
        statusDiv.textContent = `Recovered task: ${message.goal.substring(0, 50)}... (${message.state})`;
        statusDiv.className = 'status';
    }
    currentTaskId = message.taskId;
    taskStatus = message.state;
    updateTaskControls();
}
/**
 * Handle task update message from background
 */
function handleTaskUpdate(message) {
    const statusDiv = document.getElementById('task-status');
    if (statusDiv) {
        statusDiv.textContent = `Task ${message.status}: ${currentTaskId}`;
        statusDiv.className = 'status';
    }
    taskStatus = message.status;
    updateTaskControls();
}
/**
 * Handle response from background
 */
async function handleResponse(message) {
    const requestId = message.requestId;
    if (!requestId)
        return;
    // Update UI based on response
    const statusDiv = document.getElementById('status');
    if (message.success) {
        if (statusDiv)
            statusDiv.textContent = 'Success';
        if (message.data) {
            updateObservationDisplay(message.data);
        }
    }
    else {
        if (statusDiv)
            statusDiv.textContent = `Error: ${message.error}`;
    }
}
/**
 * Update observation display
 */
function updateObservationDisplay(data) {
    const elementsList = document.getElementById('elements-list');
    if (!elementsList || !data.elements)
        return;
    elementsList.innerHTML = '';
    data.elements.forEach((element, index) => {
        if (index >= 50)
            return; // Limit display
        const item = document.createElement('div');
        item.className = 'element-item';
        item.textContent = `${element.tagName}#${element.id || 'no-id'} (${element.visible ? 'visible' : 'hidden'})`;
        elementsList.appendChild(item);
    });
}
/**
 * Handle initialize button click
 */
async function handleInitialize() {
    const statusDiv = document.getElementById('status');
    if (statusDiv)
        statusDiv.textContent = 'Initializing...';
    try {
        // Get the active tab
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) {
            if (statusDiv)
                statusDiv.textContent = 'No active tab found';
            return;
        }
        currentTabId = tabs[0].id || null;
        currentUrl = tabs[0].url || null;
        // Send initialization message to background
        chrome.runtime.sendMessage({
            type: 'INITIALIZE',
            requestId: Date.now().toString(),
        }, (response) => {
            if (statusDiv) {
                if (response?.success) {
                    statusDiv.textContent = `Initialized: ${currentUrl}`;
                }
                else {
                    statusDiv.textContent = `Initialization failed: ${response?.error || 'Unknown error'}`;
                }
            }
        });
    }
    catch (error) {
        if (statusDiv)
            statusDiv.textContent = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}
/**
 * Handle observe button click
 */
async function handleObserve() {
    if (!currentTabId) {
        const statusDiv = document.getElementById('status');
        if (statusDiv)
            statusDiv.textContent = 'Initialize first';
        return;
    }
    const statusDiv = document.getElementById('status');
    if (statusDiv)
        statusDiv.textContent = 'Observing...';
    chrome.runtime.sendMessage({
        type: 'OBSERVE',
        requestId: Date.now().toString(),
    }, (response) => {
        if (statusDiv) {
            if (response?.success) {
                statusDiv.textContent = `Observed ${response.data?.elements?.length || 0} elements`;
            }
            else {
                statusDiv.textContent = `Observation failed: ${response?.error || 'Unknown error'}`;
            }
        }
    });
}
/**
 * Handle screenshot button click
 */
async function handleScreenshot() {
    if (!currentTabId) {
        const statusDiv = document.getElementById('status');
        if (statusDiv)
            statusDiv.textContent = 'Initialize first';
        return;
    }
    const statusDiv = document.getElementById('status');
    if (statusDiv)
        statusDiv.textContent = 'Taking screenshot...';
    chrome.runtime.sendMessage({
        type: 'TAKE_SCREENSHOT',
        requestId: Date.now().toString(),
        format: 'jpeg',
        quality: 80,
    }, (response) => {
        if (statusDiv) {
            if (response?.success) {
                statusDiv.textContent = `Screenshot captured (${response.dataUrl?.substring(0, 50)}...)`;
                // Display screenshot
                const screenshotDiv = document.getElementById('screenshot');
                if (screenshotDiv) {
                    const img = document.createElement('img');
                    img.src = response.dataUrl;
                    img.style.maxWidth = '100%';
                    screenshotDiv.appendChild(img);
                }
            }
            else {
                statusDiv.textContent = `Screenshot failed: ${response?.error || 'Unknown error'}`;
            }
        }
    });
}
// Provider configuration handlers
/**
 * Populate provider dropdown with saved providers
 */
async function populateProviderDropdown() {
    const select = document.getElementById('provider-select');
    if (!select)
        return;
    // Clear existing options except the disabled one
    while (select.options.length > 1) {
        select.remove(1);
    }
    for (const [id, provider] of Object.entries(providerState.providers)) {
        const option = document.createElement('option');
        option.value = id;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = provider;
        option.textContent = p.name;
        select.appendChild(option);
    }
}
/**
 * Handle provider selection change
 */
async function handleProviderChange(event) {
    const select = event.target;
    const id = select.value;
    if (id) {
        await setCurrentProvider(providerState, id);
        const statusDiv = document.getElementById('status');
        if (statusDiv)
            statusDiv.textContent = `Selected: ${providerState.providers[id]?.name}`;
    }
}
/**
 * Handle test connection button click
 */
async function handleTestConnection() {
    const urlInput = document.getElementById('provider-url');
    const modelInput = document.getElementById('provider-model');
    const keyInput = document.getElementById('provider-key');
    if (!urlInput?.value || !modelInput?.value) {
        alert('Please provide URL and model ID');
        return;
    }
    const config = {
        baseUrl: urlInput.value,
        modelId: modelInput.value,
        apiKey: keyInput?.value,
    };
    const statusDiv = document.getElementById('status');
    if (statusDiv)
        statusDiv.textContent = 'Testing connection...';
    const result = await testProviderConnection(config);
    if (statusDiv) {
        statusDiv.textContent = result.message || (result.success ? 'Success' : 'Failed');
        statusDiv.className = result.success ? 'status' : 'status error';
    }
}
/**
 * Handle add provider button click
 */
async function handleAddProvider() {
    const nameInput = document.getElementById('provider-name');
    const urlInput = document.getElementById('provider-url');
    const modelInput = document.getElementById('provider-model');
    const keyInput = document.getElementById('provider-key');
    if (!nameInput?.value || !urlInput?.value || !modelInput?.value) {
        alert('Please fill in all required fields');
        return;
    }
    try {
        const provider = await addProvider(providerState, {
            name: nameInput.value,
            baseUrl: urlInput.value,
            modelId: modelInput.value,
            apiKey: keyInput?.value,
        });
        providerState.providers[provider.id] = provider;
        populateProviderDropdown();
        // Clear inputs
        nameInput.value = '';
        urlInput.value = '';
        modelInput.value = '';
        keyInput.value = '';
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = `Provider added: ${provider.name}`;
            statusDiv.className = 'status';
        }
    }
    catch (error) {
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            statusDiv.className = 'status error';
        }
    }
}
/**
 * Handle remove provider button click
 */
async function handleRemoveProvider() {
    const select = document.getElementById('provider-select');
    const id = select.value;
    if (!id) {
        alert('Please select a provider to remove');
        return;
    }
    try {
        await removeProvider(providerState, id);
        delete providerState.providers[id];
        populateProviderDropdown();
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = `Provider removed: ${id}`;
            statusDiv.className = 'status';
        }
    }
    catch (error) {
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            statusDiv.className = 'status error';
        }
    }
}
/**
 * Handle start task button click
 */
async function handleStartTask() {
    const goalInput = document.getElementById('task-goal');
    const goal = goalInput?.value?.trim();
    if (!goal) {
        const statusDiv = document.getElementById('status');
        if (statusDiv)
            statusDiv.textContent = 'Please enter a task goal';
        return;
    }
    const statusDiv = document.getElementById('status');
    if (statusDiv)
        statusDiv.textContent = 'Starting task...';
    chrome.runtime.sendMessage({
        type: 'START_TASK',
        requestId: Date.now().toString(),
        goal,
    }, (response) => {
        if (response?.success) {
            currentTaskId = response.taskId;
            taskStatus = 'running';
            updateTaskControls();
            if (statusDiv) {
                statusDiv.textContent = `Task started: ${goal.substring(0, 50)}...`;
                statusDiv.className = 'status';
            }
        }
        else {
            if (statusDiv) {
                statusDiv.textContent = `Failed to start task: ${response?.error || 'Unknown error'}`;
                statusDiv.className = 'status error';
            }
        }
    });
}
/**
 * Handle pause task button click
 */
async function handlePauseTask() {
    if (!currentTaskId) {
        const statusDiv = document.getElementById('status');
        if (statusDiv)
            statusDiv.textContent = 'No active task to pause';
        return;
    }
    const statusDiv = document.getElementById('status');
    if (statusDiv)
        statusDiv.textContent = 'Pausing task...';
    chrome.runtime.sendMessage({
        type: 'PAUSE_TASK',
        requestId: Date.now().toString(),
        taskId: currentTaskId,
    }, (response) => {
        if (response?.success) {
            taskStatus = 'paused';
            updateTaskControls();
            if (statusDiv) {
                statusDiv.textContent = `Task paused: ${currentTaskId}`;
                statusDiv.className = 'status';
            }
        }
        else {
            if (statusDiv) {
                statusDiv.textContent = `Failed to pause task: ${response?.error || 'Unknown error'}`;
                statusDiv.className = 'status error';
            }
        }
    });
}
/**
 * Handle resume task button click
 */
async function handleResumeTask() {
    if (!currentTaskId) {
        const statusDiv = document.getElementById('status');
        if (statusDiv)
            statusDiv.textContent = 'No task to resume';
        return;
    }
    const statusDiv = document.getElementById('status');
    if (statusDiv)
        statusDiv.textContent = 'Resuming task...';
    chrome.runtime.sendMessage({
        type: 'RESUME_TASK',
        requestId: Date.now().toString(),
        taskId: currentTaskId,
    }, (response) => {
        if (response?.success) {
            taskStatus = 'running';
            updateTaskControls();
            if (statusDiv) {
                statusDiv.textContent = `Task resumed: ${currentTaskId}`;
                statusDiv.className = 'status';
            }
        }
        else {
            if (statusDiv) {
                statusDiv.textContent = `Failed to resume task: ${response?.error || 'Unknown error'}`;
                statusDiv.className = 'status error';
            }
        }
    });
}
/**
 * Handle stop task button click
 */
async function handleStopTask() {
    if (!currentTaskId) {
        const statusDiv = document.getElementById('status');
        if (statusDiv)
            statusDiv.textContent = 'No active task to stop';
        return;
    }
    const statusDiv = document.getElementById('status');
    if (statusDiv)
        statusDiv.textContent = 'Stopping task...';
    chrome.runtime.sendMessage({
        type: 'STOP_TASK',
        requestId: Date.now().toString(),
        taskId: currentTaskId,
    }, (response) => {
        if (response?.success) {
            currentTaskId = null;
            taskStatus = 'stopped';
            updateTaskControls();
            if (statusDiv) {
                statusDiv.textContent = `Task stopped: ${currentTaskId}`;
                statusDiv.className = 'status';
            }
        }
        else {
            if (statusDiv) {
                statusDiv.textContent = `Failed to stop task: ${response?.error || 'Unknown error'}`;
                statusDiv.className = 'status error';
            }
        }
    });
}
/**
 * Update task control button states
 */
function updateTaskControls() {
    const startBtn = document.getElementById('start-task-btn');
    const pauseBtn = document.getElementById('pause-task-btn');
    const resumeBtn = document.getElementById('resume-task-btn');
    const stopBtn = document.getElementById('stop-task-btn');
    if (!startBtn || !pauseBtn || !resumeBtn || !stopBtn)
        return;
    // Disable all buttons first
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    stopBtn.disabled = true;
    // Enable based on current state
    if (taskStatus === 'idle' || taskStatus === 'stopped') {
        startBtn.disabled = false;
    }
    else if (taskStatus === 'running') {
        pauseBtn.disabled = false;
        stopBtn.disabled = false;
    }
    else if (taskStatus === 'paused') {
        resumeBtn.disabled = false;
        stopBtn.disabled = false;
    }
}
/**
 * Set up HITL UI elements
 */
function setupHitlUI() {
    const hitlContainer = document.getElementById('hitl-container');
    if (!hitlContainer)
        return;
    // Check for pending requests on load
    checkForPendingHITLRequests();
}
/**
 * Check for pending HITL requests
 */
async function checkForPendingHITLRequests() {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'HITL_GET_STATE',
        });
        if (response?.success && response.pendingRequest) {
            displayHITLRequest(response.pendingRequest);
        }
    }
    catch (error) {
        console.error('Failed to check for pending HITL requests:', error);
    }
}
/**
 * Display a pending HITL request in the UI
 */
function displayHITLRequest(request) {
    const hitlContainer = document.getElementById('hitl-container');
    if (!hitlContainer)
        return;
    // Clear existing content
    hitlContainer.innerHTML = '';
    // Calculate remaining time
    const remainingSeconds = getRequestRemainingSeconds(request);
    const remainingMinutes = Math.floor(remainingSeconds / 60);
    const remainingSecs = remainingSeconds % 60;
    // Create request display
    const requestDiv = document.createElement('div');
    requestDiv.className = 'hitl-request';
    requestDiv.innerHTML = `
    <h3>HITL Request</h3>
    <p class="request-type">Type: ${request.type}</p>
    <p class="request-message">${request.message}</p>
    <p class="request-timer">Expires in: ${remainingMinutes}:${remainingSecs.toString().padStart(2, '0')}</p>
  `;
    // Create secret input if needed
    const secretInputDiv = document.createElement('div');
    secretInputDiv.className = 'hitl-secret-input';
    secretInputDiv.innerHTML = `
    <label for="secret-input">Enter secret:</label>
    <input type="password" id="secret-input" placeholder="Password or OTP">
    <button id="submit-secret-btn">Submit</button>
  `;
    // Create action buttons
    const actionButtonsDiv = document.createElement('div');
    actionButtonsDiv.className = 'hitl-action-buttons';
    actionButtonsDiv.innerHTML = `
    <button id="approve-btn" class="btn approve">Approve</button>
    <button id="reject-btn" class="btn reject">Reject</button>
    <button id="expire-btn" class="btn expire">Expire</button>
  `;
    // Append elements
    hitlContainer.appendChild(requestDiv);
    // Only show secret input for secret_text and otp_code types
    if (request.type === 'secret_text' || request.type === 'otp_code') {
        hitlContainer.appendChild(secretInputDiv);
    }
    hitlContainer.appendChild(actionButtonsDiv);
    // Add event listeners
    const submitSecretBtn = document.getElementById('submit-secret-btn');
    if (submitSecretBtn) {
        submitSecretBtn.addEventListener('click', () => handleSubmitSecret(request));
    }
    const approveBtn = document.getElementById('approve-btn');
    if (approveBtn) {
        approveBtn.addEventListener('click', () => handleApproveRequest(request));
    }
    const rejectBtn = document.getElementById('reject-btn');
    if (rejectBtn) {
        rejectBtn.addEventListener('click', () => handleRejectRequest(request));
    }
    const expireBtn = document.getElementById('expire-btn');
    if (expireBtn) {
        expireBtn.addEventListener('click', () => handleExpireRequest(request));
    }
    // Start timer update
    startHITLTimer(request);
}
/**
 * Handle secret submission for a HITL request
 */
async function handleSubmitSecret(request) {
    const secretInput = document.getElementById('secret-input');
    const secret = secretInput?.value?.trim();
    if (!secret) {
        alert('Please enter a secret');
        return;
    }
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'HITL_INPUT_SECRET',
            requestId: request.id,
            secret,
        });
        if (response?.success) {
            alert('Secret submitted successfully!');
            // Clear the container
            const hitlContainer = document.getElementById('hitl-container');
            if (hitlContainer) {
                hitlContainer.innerHTML = '';
            }
        }
        else {
            alert(`Failed: ${response?.error || 'Unknown error'}`);
        }
    }
    catch (error) {
        alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
/**
 * Handle approve request
 */
async function handleApproveRequest(request) {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'HITL_APPROVE',
            requestId: request.id,
        });
        if (response?.success) {
            alert('Request approved!');
            const hitlContainer = document.getElementById('hitl-container');
            if (hitlContainer) {
                hitlContainer.innerHTML = '';
            }
        }
        else {
            alert(`Failed: ${response?.error || 'Unknown error'}`);
        }
    }
    catch (error) {
        alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
/**
 * Handle reject request
 */
async function handleRejectRequest(request) {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'HITL_REJECT',
            requestId: request.id,
        });
        if (response?.success) {
            alert('Request rejected');
            const hitlContainer = document.getElementById('hitl-container');
            if (hitlContainer) {
                hitlContainer.innerHTML = '';
            }
        }
        else {
            alert(`Failed: ${response?.error || 'Unknown error'}`);
        }
    }
    catch (error) {
        alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
/**
 * Handle expire request
 */
async function handleExpireRequest(request) {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'HITL_EXPIRE',
            requestId: request.id,
        });
        if (response?.success) {
            alert('Request expired');
            const hitlContainer = document.getElementById('hitl-container');
            if (hitlContainer) {
                hitlContainer.innerHTML = '';
            }
        }
        else {
            alert(`Failed: ${response?.error || 'Unknown error'}`);
        }
    }
    catch (error) {
        alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
/**
 * Start updating the HITL timer display
 */
function startHITLTimer(request) {
    const interval = setInterval(() => {
        if (!isRequestValid(request)) {
            clearInterval(interval);
            return;
        }
        const remainingSeconds = getRequestRemainingSeconds(request);
        const timerElements = document.querySelectorAll('.request-timer');
        timerElements.forEach(element => {
            const remainingMinutes = Math.floor(remainingSeconds / 60);
            const remainingSecs = remainingSeconds % 60;
            element.textContent = `Expires in: ${remainingMinutes}:${remainingSecs.toString().padStart(2, '0')}`;
        });
        if (remainingSeconds <= 0) {
            clearInterval(interval);
        }
    }, 1000);
}
// Initialize when side panel loads
init();
//# sourceMappingURL=sidepanel.js.map