//! Hexactra Chrome extension - Side panel logic

import { loadProviders, addProvider, setCurrentProvider, testProviderConnection, removeProvider } from './provider';

// DOM state
let currentTabId: number | null = null;
let currentUrl: string | null = null;
let providerState: any = {};

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

// Provider configuration handlers

/**
 * Populate provider dropdown with saved providers
 */
async function populateProviderDropdown() {
  const select = document.getElementById('provider-select') as HTMLSelectElement;
  if (!select) return;

  // Clear existing options except the disabled one
  while (select.options.length > 1) {
    select.remove(1);
  }

  for (const [id, provider] of Object.entries(providerState.providers)) {
    const option = document.createElement('option');
    option.value = id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = provider as any;
    option.textContent = p.name;
    select.appendChild(option);
  }
}

/**
 * Handle provider selection change
 */
async function handleProviderChange(event: Event) {
  const select = event.target as HTMLSelectElement;
  const id = select.value;

  if (id) {
    await setCurrentProvider(providerState, id);
    const statusDiv = document.getElementById('status');
    if (statusDiv) statusDiv.textContent = `Selected: ${providerState.providers[id]?.name}`;
  }
}

/**
 * Handle test connection button click
 */
async function handleTestConnection() {
  const urlInput = document.getElementById('provider-url') as HTMLInputElement;
  const modelInput = document.getElementById('provider-model') as HTMLInputElement;
  const keyInput = document.getElementById('provider-key') as HTMLInputElement;

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
  if (statusDiv) statusDiv.textContent = 'Testing connection...';

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
  const nameInput = document.getElementById('provider-name') as HTMLInputElement;
  const urlInput = document.getElementById('provider-url') as HTMLInputElement;
  const modelInput = document.getElementById('provider-model') as HTMLInputElement;
  const keyInput = document.getElementById('provider-key') as HTMLInputElement;

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
  } catch (error) {
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
  const select = document.getElementById('provider-select') as HTMLSelectElement;
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
  } catch (error) {
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
      statusDiv.textContent = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      statusDiv.className = 'status error';
    }
  }
}

// Initialize when side panel loads
init();
