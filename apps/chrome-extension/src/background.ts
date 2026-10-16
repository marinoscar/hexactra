//! Hexactra Chrome extension - Background service worker

// Extension state
let initialized = false;

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

  // Listen for messages from side panel
  chrome.runtime.onMessage.addListener(handleMessage);

  // Open the side panel when installed/updated
  chrome.action.onClicked.addListener(() => {
    chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  });
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
  | 'SUBMIT';

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

// Auto-initialize when the extension loads
chrome.runtime.onInstalled.addListener(() => {
  console.log('Hexactra extension installed');
});
