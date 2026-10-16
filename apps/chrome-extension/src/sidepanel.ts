//! Hexactra Chrome extension - Side panel logic

// DOM state
let currentTabId: number | null = null;
let currentUrl: string | null = null;

// Configuration state (reserved for future provider configuration)

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
function setupUI() {
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
}

/**
 * Handle messages from background
 */
function handleMessage(message: any) {
  switch (message.type) {
    case 'RESPONSE':
      handleResponse(message);
      break;
  }
}

/**
 * Handle response from background
 */
async function handleResponse(message: any) {
  const requestId = message.requestId;
  if (!requestId) return;

  // Update UI based on response
  const statusDiv = document.getElementById('status');
  if (message.success) {
    if (statusDiv) statusDiv.textContent = 'Success';
    if (message.data) {
      updateObservationDisplay(message.data);
    }
  } else {
    if (statusDiv) statusDiv.textContent = `Error: ${message.error}`;
  }
}

/**
 * Update observation display
 */
function updateObservationDisplay(data: any) {
  const elementsList = document.getElementById('elements-list');
  if (!elementsList || !data.elements) return;

  elementsList.innerHTML = '';

  data.elements.forEach((element: any, index: number) => {
    if (index >= 50) return; // Limit display

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
  if (statusDiv) statusDiv.textContent = 'Initializing...';

  try {
    // Get the active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tabs.length === 0) {
      if (statusDiv) statusDiv.textContent = 'No active tab found';
      return;
    }

    currentTabId = tabs[0].id || null;
    currentUrl = tabs[0].url || null;

    // Send initialization message to background
    chrome.runtime.sendMessage({
      type: 'INITIALIZE',
      requestId: Date.now().toString(),
    }, (response: any) => {
      if (statusDiv) {
        if (response?.success) {
          statusDiv.textContent = `Initialized: ${currentUrl}`;
        } else {
          statusDiv.textContent = `Initialization failed: ${response?.error || 'Unknown error'}`;
        }
      }
    });
  } catch (error) {
    if (statusDiv) statusDiv.textContent = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

/**
 * Handle observe button click
 */
async function handleObserve() {
  if (!currentTabId) {
    const statusDiv = document.getElementById('status');
    if (statusDiv) statusDiv.textContent = 'Initialize first';
    return;
  }

  const statusDiv = document.getElementById('status');
  if (statusDiv) statusDiv.textContent = 'Observing...';

  chrome.runtime.sendMessage({
    type: 'OBSERVE',
    requestId: Date.now().toString(),
  }, (response: any) => {
    if (statusDiv) {
      if (response?.success) {
        statusDiv.textContent = `Observed ${response.data?.elements?.length || 0} elements`;
      } else {
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
    if (statusDiv) statusDiv.textContent = 'Initialize first';
    return;
  }

  const statusDiv = document.getElementById('status');
  if (statusDiv) statusDiv.textContent = 'Taking screenshot...';

  chrome.runtime.sendMessage({
    type: 'TAKE_SCREENSHOT',
    requestId: Date.now().toString(),
    format: 'jpeg',
    quality: 80,
  }, (response: any) => {
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
      } else {
        statusDiv.textContent = `Screenshot failed: ${response?.error || 'Unknown error'}`;
      }
    }
  });
}

// Initialize when side panel loads
init();
