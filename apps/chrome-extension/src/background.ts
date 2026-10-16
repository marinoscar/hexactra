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
 * Handle messages from side panel or content scripts
 */
function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender
): void | Promise<void> {
  if (!sender.id || sender.id !== chrome.runtime.id) {
    return;
  }

  switch (message && typeof message === 'object' ? (message as any).type : undefined) {
    case 'INITIALIZE':
      return handleInitialize(sender);
    case 'OBSERVE':
      return handleObserve(sender);
    case 'CLICK':
      return handleClick(sender, message);
    case 'TYPE':
      return handleType(sender, message);
    case 'NAVIGATE':
      return handleNavigate(sender, message);
    case 'TAKE_SCREENSHOT':
      return handleScreenshot(sender, message);
    default:
      console.warn('Unknown message type:', (message as any)?.type);
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
  message: unknown
) {
  const msg = message as any;
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
  message: unknown
) {
  const msg = message as any;
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
  message: unknown
) {
  const msg = message as any;
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
  message: unknown
) {
  const msg = message as any;
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
