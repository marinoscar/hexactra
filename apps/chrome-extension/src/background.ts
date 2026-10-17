//! Hexactra Chrome extension - Background service worker

// Extension state
let initialized = false;

// Import checkpoint module
import { 
  loadCurrentTask, 
  saveCurrentTask, 
  createCheckpoint,
  updateCheckpoint,
} from './checkpoint.js';

// Import HITL module
import { initHitl } from './hitl.js';

/**
 * Initialize the extension background worker
 */
export async function init() {
  if (initialized) {
    console.log('Hexactra extension already initialized');
    return;
  }

  initialized = true;

  console.log('Hexactra extension initialized');

  // Initialize HITL controls
  initHitl();

  // Listen for messages from side panel
  chrome.runtime.onMessage.addListener(handleMessage);

  // Handle service worker lifecycle events
  handleLifecycleEvents();

  // Open the side panel when installed/updated
  chrome.action.onClicked.addListener(() => {
    chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  });

  // Check for recovered task on startup
  checkForRecoveredTask();
}

/**
 * Message types
 */
type MessageType = 
  | 'INITIALIZE'
  | 'OBSERVE'
  | 'CLICK'
  | 'TYPE'
  | 'NAVIGATE'
  | 'TAKE_SCREENSHOT'
  | 'GET_CAPABILITIES'
  | 'TAB_LIST'
  | 'TAB_SWITCH'
  | 'TAB_OPEN'
  | 'TAB_CLOSE'
  | 'FOCUS'
  | 'CLEAR'
  | 'SELECT'
  | 'TOGGLE'
  | 'KEYPRESS'
  | 'SCROLL'
  | 'WAIT'
  | 'SUBMIT'
  | 'START_TASK'
  | 'PAUSE_TASK'
  | 'RESUME_TASK'
  | 'STOP_TASK'
  // HITL message types
  | 'HITL_CREATE_REQUEST'
  | 'HITL_APPROVE'
  | 'HITL_REJECT'
  | 'HITL_EXPIRE'
  | 'HITL_INPUT_SECRET'
  | 'HITL_GET_STATE';

/**
 * Handle messages from side panel or content scripts
 */
function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender
): void | Promise<void> {
  if (!sender.id || sender.id !== chrome.runtime.id) {
    return;
  }

  const msg = message as any;
  switch (msg.type as MessageType) {
    case 'INITIALIZE':
      return handleInitialize(sender);
    case 'OBSERVE':
      return handleObserve(sender);
    case 'CLICK':
      return handleClick(sender, msg);
    case 'TYPE':
      return handleType(sender, msg);
    case 'NAVIGATE':
      return handleNavigate(sender, msg);
    case 'TAKE_SCREENSHOT':
      return handleScreenshot(sender, msg);
    case 'GET_CAPABILITIES':
      return handleGetCapabilities(sender);
    case 'TAB_LIST':
      return handleTabList(sender);
    case 'TAB_SWITCH':
      return handleTabSwitch(sender, msg);
    case 'TAB_OPEN':
      return handleTabOpen(sender, msg);
    case 'TAB_CLOSE':
      return handleTabClose(sender, msg);
    case 'FOCUS':
      return handleFocus(sender, msg);
    case 'CLEAR':
      return handleClear(sender, msg);
    case 'SELECT':
      return handleSelect(sender, msg);
    case 'TOGGLE':
      return handleToggle(sender, msg);
    case 'KEYPRESS':
      return handleKeypress(sender, msg);
    case 'SCROLL':
      return handleScroll(sender, msg);
    case 'WAIT':
      return handleWait(sender, msg);
    case 'SUBMIT':
      return handleSubmit(sender, msg);
    case 'START_TASK':
      return handleStartTask(sender, msg);
    case 'PAUSE_TASK':
      return handlePauseTask(sender, msg);
    case 'RESUME_TASK':
      return handleResumeTask(sender, msg);
    case 'STOP_TASK':
      return handleStopTask(sender, msg);
    // HITL handlers
    case 'HITL_CREATE_REQUEST':
      return handleHitlCreateRequest(sender, msg);
    case 'HITL_APPROVE':
      return handleHitlApprove(sender, msg);
    case 'HITL_REJECT':
      return handleHitlReject(sender, msg);
    case 'HITL_EXPIRE':
      return handleHitlExpire(sender, msg);
    case 'HITL_INPUT_SECRET':
      return handleHitlInputSecret(sender, msg);
    case 'HITL_GET_STATE':
      return handleHitlGetState(sender);
    default:
      console.warn('Unknown message type:', msg.type);
      sendResponse(sender, { success: false, error: `Unknown action: ${msg.type}` });
  }
}

/**
 * Handle initialization request
 */
async function handleInitialize(sender: chrome.runtime.MessageSender) {
  if (!sender.tab?.id) {
    sendResponse(sender, { success: false, error: 'No tab ID' });
    return;
  }

  try {
    // Get active tab information
    const tab = await chrome.tabs.get(sender.tab.id);
    
    sendResponse(sender, {
      success: true,
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
    });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to get tab' 
    });
  }
}

/**
 * Handle observation request
 */
async function handleObserve(sender: chrome.runtime.MessageSender) {
  if (!sender.tab?.id) {
    sendResponse(sender, { success: false, error: 'No tab ID' });
    return;
  }

  try {
    // Inject content script to observe DOM
    const result = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: () => {
        // Get accessible DOM elements
        function getElementInfo(element: Element): any {
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;

          return {
            tagName: element.tagName.toLowerCase(),
            id: element.id || undefined,
            className: element.className || undefined,
            role: element.getAttribute('role') || element.getAttribute('type') || undefined,
            text: element.textContent?.trim().substring(0, 100) || undefined,
            accessibleName: element.getAttribute('aria-label') || element.getAttribute('title') || undefined,
            visible: rect.width > 0 && rect.height > 0,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }

        function getDocumentInfo(): any {
          const body = document.body;
          if (!body) return null;

          return {
            url: window.location.href,
            title: document.title,
            elements: Array.from(document.querySelectorAll('*'))
              .map(getElementInfo)
              .filter(Boolean)
              .slice(0, 500), // Limit to prevent oversized messages
          };
        }

        return getDocumentInfo();
      },
    });

    if (result && result.length > 0) {
      sendResponse(sender, { success: true, data: result[0].result });
    } else {
      sendResponse(sender, { success: false, error: 'No observation data' });
    }
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Observation failed' 
    });
  }
}

/**
 * Handle click action
 */
async function handleClick(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || !msg.selector) {
    sendResponse(sender, { success: false, error: 'Missing tab ID or selector' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }
        
        // Check if element is interactable
        if (element instanceof HTMLElement) {
          element.click();
        } else {
          throw new Error('Element is not clickable');
        }
      },
      args: [msg.selector],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Click failed' 
    });
  }
}

/**
 * Handle type action
 */
async function handleType(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || !msg.selector || typeof msg.text !== 'string') {
    sendResponse(sender, { success: false, error: 'Missing required parameters' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (selector: string, text: string) => {
        const element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }

        // Only allow input/textarea elements
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = text;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          throw new Error('Element is not an input field');
        }
      },
      args: [msg.selector, msg.text],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Type failed' 
    });
  }
}

/**
 * Handle navigation action
 */
async function handleNavigate(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || typeof msg.url !== 'string') {
    sendResponse(sender, { success: false, error: 'Missing tab ID or URL' });
    return;
  }

  try {
    await chrome.tabs.update(sender.tab.id, { url: msg.url });
    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Navigation failed' 
    });
  }
}

/**
 * Handle screenshot action
 */
async function handleScreenshot(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id) {
    sendResponse(sender, { success: false, error: 'Missing tab ID' });
    return;
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.id, {
      format: msg.format === 'png' ? 'png' : 'jpeg',
      quality: msg.quality || 80,
    });

    sendResponse(sender, { success: true, dataUrl });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Screenshot failed' 
    });
  }
}

/**
 * Handle tab list action
 */
async function handleTabList(sender: chrome.runtime.MessageSender) {
  try {
    const tabs = await chrome.tabs.query({});
    
    sendResponse(sender, {
      success: true,
      tabs: tabs.map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        windowId: tab.windowId,
      })),
    });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to list tabs' 
    });
  }
}

/**
 * Handle tab switch action
 */
async function handleTabSwitch(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!msg.tabId) {
    sendResponse(sender, { success: false, error: 'Missing tab ID' });
    return;
  }

  try {
    await chrome.tabs.update(msg.tabId, { active: true });
    
    // Get updated tab info
    const tab = await chrome.tabs.get(msg.tabId);
    sendResponse(sender, { 
      success: true,
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
    });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to switch tab' 
    });
  }
}

/**
 * Handle tab open action
 */
async function handleTabOpen(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  try {
    const createProperties: chrome.tabs.CreateProperties = {
      url: msg.url || 'about:newtab',
      active: msg.active ?? true,
      windowId: msg.windowId,
    };

    const tab = await chrome.tabs.create(createProperties);
    
    sendResponse(sender, {
      success: true,
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
    });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to open tab' 
    });
  }
}

/**
 * Handle tab close action
 */
async function handleTabClose(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!msg.tabId) {
    sendResponse(sender, { success: false, error: 'Missing tab ID' });
    return;
  }

  try {
    await chrome.tabs.remove(msg.tabId);
    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to close tab' 
    });
  }
}

/**
 * Handle get capabilities action
 */
async function handleGetCapabilities(sender: chrome.runtime.MessageSender) {
  try {
    const capabilities = await getCapabilities();
    sendResponse(sender, { 
      success: true,
      capabilities,
    });
  } catch (error) {
    // Return minimal capabilities even on error
    sendResponse(sender, { 
      success: true,
      capabilities: {
        screenshot: { supported: true, formats: ['png', 'jpeg'], defaultFormat: 'jpeg' },
        debugger: { available: false, supported: false, error: error instanceof Error ? error.message : 'Capability detection failed' },
        tabCapture: { supported: true, maxTabs: 10 },
        scripting: { supported: true, canInjectScripts: true, canExecuteScripts: true },
      },
    });
  }
}

/**
 * Handle focus action
 */
async function handleFocus(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || !msg.selector) {
    sendResponse(sender, { success: false, error: 'Missing tab ID or selector' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }
        
        if (element instanceof HTMLElement) {
          element.focus();
        } else {
          throw new Error('Element cannot receive focus');
        }
      },
      args: [msg.selector],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Focus failed' 
    });
  }
}

/**
 * Handle clear action
 */
async function handleClear(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || !msg.selector) {
    sendResponse(sender, { success: false, error: 'Missing tab ID or selector' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (selector: string) => {
        const element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = '';
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          throw new Error('Element is not a clearable input field');
        }
      },
      args: [msg.selector],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Clear failed' 
    });
  }
}

/**
 * Handle select action
 */
async function handleSelect(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || !msg.selector || typeof msg.value !== 'string') {
    sendResponse(sender, { success: false, error: 'Missing required parameters' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (selector: string, value: string) => {
        const element = document.querySelector(selector) as HTMLSelectElement;
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }

        if (element instanceof HTMLSelectElement) {
          element.value = value;
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          throw new Error('Element is not a select element');
        }
      },
      args: [msg.selector, msg.value],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Select failed' 
    });
  }
}

/**
 * Handle toggle action
 */
async function handleToggle(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || !msg.selector) {
    sendResponse(sender, { success: false, error: 'Missing tab ID or selector' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (selector: string) => {
        const element = document.querySelector(selector) as HTMLInputElement;
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }

        if (element instanceof HTMLInputElement && 
            (element.type === 'checkbox' || element.type === 'radio')) {
          element.checked = !element.checked;
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          throw new Error('Element is not a toggleable input (checkbox/radio)');
        }
      },
      args: [msg.selector],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Toggle failed' 
    });
  }
}

/**
 * Handle keypress action
 */
async function handleKeypress(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || !msg.key || typeof msg.key !== 'string') {
    sendResponse(sender, { success: false, error: 'Missing tab ID or key' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (key: string) => {
        // Create and dispatch keyboard event
        const event = new KeyboardEvent('keydown', {
          key: key,
          code: key,
          bubbles: true,
        });
        document.dispatchEvent(event);
      },
      args: [msg.key],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Keypress failed' 
    });
  }
}

/**
 * Handle scroll action
 */
async function handleScroll(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || typeof msg.x !== 'number' || typeof msg.y !== 'number') {
    sendResponse(sender, { success: false, error: 'Missing tab ID or scroll coordinates' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (x: number, y: number) => {
        window.scrollTo(x, y);
      },
      args: [msg.x, msg.y],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Scroll failed' 
    });
  }
}

/**
 * Handle wait action
 */
async function handleWait(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (typeof msg.duration !== 'number') {
    sendResponse(sender, { success: false, error: 'Missing duration' });
    return;
  }

  // Wait for the specified duration
  await new Promise(resolve => setTimeout(resolve, msg.duration));

  sendResponse(sender, { 
    success: true,
    waitedFor: msg.duration,
  });
}

/**
 * Handle submit action
 */
async function handleSubmit(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  if (!sender.tab?.id || !msg.selector) {
    sendResponse(sender, { success: false, error: 'Missing tab ID or selector' });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }

        const form = element instanceof HTMLElement ? element.closest('form') : null;
        if (!form) {
          throw new Error('Element is not inside a form');
        }

        form.submit();
      },
      args: [msg.selector],
    });

    sendResponse(sender, { success: true });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Submit failed' 
    });
  }
}

/**
 * Send response to message sender
 */
function sendResponse(
  sender: chrome.runtime.MessageSender,
  response: any
) {
  if (sender.tab?.id && sender.frameId !== undefined) {
    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'RESPONSE',
      requestId: (response as any).requestId,
      ...response,
    }).catch(() => {});
  } else {
    chrome.runtime.sendMessage({
      type: 'RESPONSE',
      requestId: (response as any).requestId,
      ...response,
    }).catch(() => {});
  }
}

/**
 * Get browser/debugger capability information
 */
async function getCapabilities(): Promise<CapabilityInfo> {
  const capabilities: CapabilityInfo = {
    screenshot: {
      supported: true,
      formats: ['png', 'jpeg'],
      defaultFormat: 'jpeg',
    },
    debugger: {
      available: false,
      supported: false,
      error: 'Chrome debugger not available',
    },
    tabCapture: {
      supported: true,
      maxTabs: 10, // Chrome extension limit
    },
    scripting: {
      supported: true,
      canInjectScripts: true,
      canExecuteScripts: true,
    },
  };

  // Check if chrome.debugger API is available
  try {
    if (chrome.debugger) {
      capabilities.debugger.available = true;
      capabilities.debugger.supported = true;
      capabilities.debugger.error = undefined;
      
      // Try to get version info
      try {
        const targets = await chrome.debugger.getTargets();
        capabilities.debugger.targetsCount = targets.length;
      } catch (debugError) {
        // Debug API exists but may not be connected yet
        capabilities.debugger.targetsCount = 0;
      }
    }
  } catch (error) {
    // chrome.debugger not available
    capabilities.debugger.error = 'Chrome debugger API not available';
  }

  return capabilities;
}

// ==================== HITL Handlers ====================

/**
 * Create a new HITL request
 */
async function handleHitlCreateRequest(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  const { type, message, details, ttlMinutes = 15 } = msg;

  if (!type || !message) {
    sendResponse(sender, { success: false, error: 'Missing type or message' });
    return;
  }

  const requestId = Date.now().toString();
  const expiresAt = Date.now() + ttlMinutes * 60 * 1000;

  // Save HITL request state
  try {
    await saveCurrentTask({
      taskId: requestId,
      goal: message,
      type: type as string,
      details,
      expiresAt,
      state: 'pending_approval' as any,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      stepsCount: 0,
    });
  } catch (error) {
    console.error('Failed to save HITL request:', error);
  }

  sendResponse(sender, {
    success: true,
    requestId,
    message: 'HITL request created',
  });

  // Notify side panel
  chrome.runtime.sendMessage({
    type: 'HITL_NOTIFICATION',
    notificationType: 'HITL_REQUEST_CREATED',
    requestId,
    hitlType: type as string,
    message,
    expiresAt,
  }).catch(() => {});
}

/**
 * Approve a HITL request
 */
async function handleHitlApprove(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  const { requestId } = msg;

  if (!requestId) {
    sendResponse(sender, { success: false, error: 'Request ID required' });
    return;
  }

  try {
    await updateCheckpoint(requestId, { state: 'approved' as any });
    await chrome.storage.local.remove('currentTask');

    sendResponse(sender, {
      success: true,
      message: 'Request approved',
    });

    chrome.runtime.sendMessage({
      type: 'HITL_NOTIFICATION',
      notificationType: 'HITL_REQUEST_APPROVED',
      requestId,
    }).catch(() => {});
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Approval failed' 
    });
  }
}

/**
 * Reject a HITL request
 */
async function handleHitlReject(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  const { requestId } = msg;

  if (!requestId) {
    sendResponse(sender, { success: false, error: 'Request ID required' });
    return;
  }

  try {
    await updateCheckpoint(requestId, { state: 'rejected' as any });
    await chrome.storage.local.remove('currentTask');

    sendResponse(sender, {
      success: true,
      message: 'Request rejected',
    });

    chrome.runtime.sendMessage({
      type: 'HITL_NOTIFICATION',
      notificationType: 'HITL_REQUEST_REJECTED',
      requestId,
    }).catch(() => {});
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Rejection failed' 
    });
  }
}

/**
 * Expire a HITL request
 */
async function handleHitlExpire(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  const { requestId } = msg;

  if (!requestId) {
    sendResponse(sender, { success: false, error: 'Request ID required' });
    return;
  }

  try {
    await updateCheckpoint(requestId, { state: 'expired' as any });
    await chrome.storage.local.remove('currentTask');

    sendResponse(sender, {
      success: true,
      message: 'Request expired',
    });

    chrome.runtime.sendMessage({
      type: 'HITL_NOTIFICATION',
      notificationType: 'HITL_REQUEST_EXPIRED',
      requestId,
    }).catch(() => {});
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Expiration failed' 
    });
  }
}

/**
 * Input secret for a HITL request
 */
async function handleHitlInputSecret(
  sender: chrome.runtime.MessageSender,
  msg: any
) {
  const { requestId, secret } = msg;

  if (!requestId || !secret) {
    sendResponse(sender, { success: false, error: 'Missing request ID or secret' });
    return;
  }

  try {
    // In production, this would securely handle the secret
    console.log(`Secret received for request: ${requestId}`);

    await updateCheckpoint(requestId, { state: 'secret_input_received' as any });
    
    sendResponse(sender, {
      success: true,
      message: 'Secret received',
    });

    chrome.runtime.sendMessage({
      type: 'HITL_NOTIFICATION',
      notificationType: 'HITL_SECRET_INPUT_RECEIVED',
      requestId,
    }).catch(() => {});
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Secret input failed' 
    });
  }
}

/**
 * Get current HITL state
 */
async function handleHitlGetState(
  sender: chrome.runtime.MessageSender
) {
  try {
    const currentTask = await loadCurrentTask();
    
    sendResponse(sender, {
      success: true,
      pendingRequest: currentTask?.state === 'pending_approval' ? currentTask : null,
    });
  } catch (error) {
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to get HITL state' 
    });
  }
}

// Auto-initialize when the extension loads
chrome.runtime.onInstalled.addListener(() => {
  console.log('Hexactra extension installed');
});

/**
 * Handle service worker lifecycle events (suspend, resume, restart)
 */
function handleLifecycleEvents() {
  // Handle service worker being suspended by Chrome
  chrome.runtime.onSuspend.addListener(() => {
    console.log('Service worker suspended - saving state');
    saveWorkerState();
  });

  // Handle extension startup (after suspend/resume cycle)
  chrome.runtime.onStartup.addListener(() => {
    console.log('Extension started - checking for recovered task');
    checkForRecoveredTask();
  });
}

/**
 * Save worker state to storage
 */
async function saveWorkerState() {
  try {
    const currentTask = await loadCurrentTask();
    if (currentTask) {
      // Task was running when suspended - mark as paused
      console.log(`Saving task state: ${currentTask.taskId}`);
      // State is persisted in checkpoints, just log for debugging
    }
  } catch (error) {
    console.error('Failed to save worker state:', error);
  }
}

/**
 * Check for recovered task on extension startup
 */
async function checkForRecoveredTask() {
  try {
    const currentTask = await loadCurrentTask();
    
    if (currentTask) {
      // Task was active when service worker was suspended
      console.log(`Recovered task: ${currentTask.taskId} in state ${currentTask.state}`);
      
      // Notify side panel about recovered task
      chrome.runtime.sendMessage({
        type: 'TASK_RECOVERED',
        taskId: currentTask.taskId,
        goal: currentTask.goal,
        state: currentTask.state,
        stepsCompleted: currentTask.stepsCount,
      });
    }
  } catch (error) {
    console.error('Failed to check for recovered task:', error);
  }
}

/**
 * Handle start task request
 */
async function handleStartTask(sender: chrome.runtime.MessageSender, msg: any) {
  if (!sender.tab?.id) {
    sendResponse(sender, { success: false, error: 'No tab ID' });
    return;
  }

  const goal = msg.goal;
  if (!goal) {
    sendResponse(sender, { success: false, error: 'Goal is required' });
    return;
  }

  const taskId = Date.now().toString();
  
  // Create checkpoint for the new task
  try {
    await createCheckpoint(taskId, goal, 'running');
    
    // Save current task metadata
    await saveCurrentTask({
      taskId,
      goal,
      state: 'running',
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      stepsCount: 0,
    });

    console.log(`Starting task: ${taskId}, goal: ${goal}`);

    // Send confirmation
    sendResponse(sender, { 
      success: true, 
      taskId,
      message: `Task started: ${goal.substring(0, 50)}...`
    });

    // Notify side panel
    chrome.runtime.sendMessage({
      type: 'TASK_UPDATE',
      status: 'running',
      goal,
    });
  } catch (error) {
    console.error('Failed to start task:', error);
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to start task'
    });
  }
}

/**
 * Handle pause task request
 */
async function handlePauseTask(sender: chrome.runtime.MessageSender, msg: any) {
  const taskId = msg.taskId;
  if (!taskId) {
    sendResponse(sender, { success: false, error: 'Task ID is required' });
    return;
  }

  try {
    await updateCheckpoint(taskId, { state: 'paused' });
    
    // Update current task metadata
    const currentTask = await loadCurrentTask();
    if (currentTask && currentTask.taskId === taskId) {
      await saveCurrentTask({
        ...currentTask,
        state: 'paused',
        lastUpdatedAt: Date.now(),
      });
    }

    console.log(`Pausing task: ${taskId}`);

    sendResponse(sender, { 
      success: true, 
      taskId,
      message: 'Task paused'
    });

    chrome.runtime.sendMessage({
      type: 'TASK_UPDATE',
      status: 'paused',
    });
  } catch (error) {
    console.error('Failed to pause task:', error);
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to pause task'
    });
  }
}

/**
 * Handle resume task request
 */
async function handleResumeTask(sender: chrome.runtime.MessageSender, msg: any) {
  const taskId = msg.taskId;
  if (!taskId) {
    sendResponse(sender, { success: false, error: 'Task ID is required' });
    return;
  }

  try {
    await updateCheckpoint(taskId, { state: 'running' });
    
    // Update current task metadata
    const currentTask = await loadCurrentTask();
    if (currentTask && currentTask.taskId === taskId) {
      await saveCurrentTask({
        ...currentTask,
        state: 'running',
        lastUpdatedAt: Date.now(),
      });
    }

    console.log(`Resuming task: ${taskId}`);

    sendResponse(sender, { 
      success: true, 
      taskId,
      message: 'Task resumed'
    });

    chrome.runtime.sendMessage({
      type: 'TASK_UPDATE',
      status: 'running',
    });
  } catch (error) {
    console.error('Failed to resume task:', error);
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to resume task'
    });
  }
}

/**
 * Handle stop task request
 */
async function handleStopTask(sender: chrome.runtime.MessageSender, msg: any) {
  const taskId = msg.taskId;
  if (!taskId) {
    sendResponse(sender, { success: false, error: 'Task ID is required' });
    return;
  }

  try {
    await updateCheckpoint(taskId, { state: 'stopped' });
    
    // Clear current task metadata
    await chrome.storage.local.remove('currentTask');
    
    console.log(`Stopping task: ${taskId}`);

    sendResponse(sender, { 
      success: true, 
      taskId,
      message: 'Task stopped'
    });

    chrome.runtime.sendMessage({
      type: 'TASK_UPDATE',
      status: 'stopped',
    });
  } catch (error) {
    console.error('Failed to stop task:', error);
    sendResponse(sender, { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to stop task'
    });
  }
}

/**
 * Type definitions
 */
interface CapabilityInfo {
  screenshot: ScreenshotCapability;
  debugger: DebuggerCapability;
  tabCapture: TabCaptureCapability;
  scripting: ScriptingCapability;
}

interface ScreenshotCapability {
  supported: boolean;
  formats: string[];
  defaultFormat: string;
}

interface DebuggerCapability {
  available: boolean;
  supported: boolean;
  error?: string;
  targetsCount?: number;
}

interface TabCaptureCapability {
  supported: boolean;
  maxTabs: number;
}

interface ScriptingCapability {
  supported: boolean;
  canInjectScripts: boolean;
  canExecuteScripts: boolean;
}
