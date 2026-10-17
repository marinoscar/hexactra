//! Hexactra Chrome extension - HITL (Human-in-the-Loop) controls
//!
//! This module provides in-browser controls for human-in-the-loop operations:
//! - Pending credential/OTP/approval display
//! - Secret input from privileged context only
//! - Pause AI while human directly interacts with Chrome
import { loadCurrentTask, saveCurrentTask } from './checkpoint.js';
// HITL state
let hitlState = {
    pendingRequest: null,
    isPaused: false,
    humanActive: false,
};
/**
 * Send response to message sender (helper for background handler)
 */
function sendResponse(sender, response) {
    if (sender.tab?.id && sender.frameId !== undefined) {
        chrome.tabs.sendMessage(sender.tab.id, {
            type: 'RESPONSE',
            requestId: response.requestId,
            ...response,
        }).catch(() => { });
    }
    else {
        chrome.runtime.sendMessage({
            type: 'RESPONSE',
            requestId: response.requestId,
            ...response,
        }).catch(() => { });
    }
}
/**
 * Initialize HITL controls
 */
export async function initHitl() {
    console.log('HITL controls initialized');
    // Listen for messages from content scripts or side panel
    chrome.runtime.onMessage.addListener(handleHitlMessage);
    // Check for recovered pending requests on startup
    checkForPendingRequest();
}
/**
 * Handle HITL-specific messages
 */
function handleHitlMessage(message, sender) {
    if (!sender.id || sender.id !== chrome.runtime.id) {
        return;
    }
    const msg = message;
    switch (msg.type) {
        case 'HITL_CREATE_REQUEST':
            return handleCreateRequest(sender, msg);
        case 'HITL_APPROVE':
            return handleApprove(sender, msg);
        case 'HITL_REJECT':
            return handleReject(sender, msg);
        case 'HITL_EXPIRE':
            return handleExpire(sender, msg);
        case 'HITL_INPUT_SECRET':
            return handleInputSecret(sender, msg);
        case 'HITL_GET_STATE':
            return handleGetState(sender);
        default:
            console.warn('Unknown HITL message type:', msg.type);
    }
}
/**
 * Create a new HITL request
 */
async function handleCreateRequest(sender, msg) {
    const { type, message, details, ttlMinutes = 15 } = msg;
    if (!type || !message) {
        sendResponse(sender, { success: false, error: 'Missing type or message' });
        return;
    }
    const requestId = Date.now().toString();
    const expiresAt = Date.now() + ttlMinutes * 60 * 1000;
    hitlState.pendingRequest = {
        id: requestId,
        type: type,
        message,
        details,
        expiresAt,
        originTabId: sender.tab?.id,
        originFrameId: sender.frameId,
    };
    // Save to checkpoint for recovery
    try {
        await saveCurrentTask({
            taskId: requestId,
            goal: message,
            type: type,
            details,
            expiresAt,
            state: 'pending_approval',
            createdAt: Date.now(),
            lastUpdatedAt: Date.now(),
            stepsCount: 0,
        });
    }
    catch (error) {
        console.error('Failed to save HITL request:', error);
    }
    // Notify side panel
    notifySidePanel({
        type: 'HITL_REQUEST_CREATED',
        requestId,
        hitlType: type,
        message,
        expiresAt,
    });
    sendResponse(sender, {
        success: true,
        requestId,
    });
}
/**
 * Approve a pending HITL request
 */
async function handleApprove(sender, msg) {
    const { requestId } = msg;
    if (!requestId || !hitlState.pendingRequest || hitlState.pendingRequest.id !== requestId) {
        sendResponse(sender, { success: false, error: 'Invalid or expired request' });
        return;
    }
    // Check if secret is provided for secret_text/otp_code
    if (hitlState.pendingRequest.type === 'secret_text' ||
        hitlState.pendingRequest.type === 'otp_code') {
        if (!msg.secret) {
            sendResponse(sender, { success: false, error: 'Secret required for this request type' });
            return;
        }
    }
    // Process approval
    console.log(`Approving HITL request: ${requestId}`);
    hitlState.pendingRequest = null;
    sendResponse(sender, {
        success: true,
        message: 'Request approved',
    });
    notifySidePanel({
        type: 'HITL_REQUEST_APPROVED',
        requestId,
    });
}
/**
 * Reject a pending HITL request
 */
async function handleReject(sender, msg) {
    const { requestId } = msg;
    if (!requestId || !hitlState.pendingRequest || hitlState.pendingRequest.id !== requestId) {
        sendResponse(sender, { success: false, error: 'Invalid or expired request' });
        return;
    }
    console.log(`Rejecting HITL request: ${requestId}`);
    hitlState.pendingRequest = null;
    sendResponse(sender, {
        success: true,
        message: 'Request rejected',
    });
    notifySidePanel({
        type: 'HITL_REQUEST_REJECTED',
        requestId,
    });
}
/**
 * Expire a pending HITL request
 */
async function handleExpire(sender, msg) {
    const { requestId } = msg;
    if (!requestId || !hitlState.pendingRequest || hitlState.pendingRequest.id !== requestId) {
        sendResponse(sender, { success: false, error: 'Invalid or expired request' });
        return;
    }
    // Check if already expired
    if (Date.now() > hitlState.pendingRequest.expiresAt) {
        sendResponse(sender, { success: false, error: 'Request already expired' });
        return;
    }
    console.log(`Expiring HITL request: ${requestId}`);
    hitlState.pendingRequest = null;
    sendResponse(sender, {
        success: true,
        message: 'Request expired',
    });
    notifySidePanel({
        type: 'HITL_REQUEST_EXPIRED',
        requestId,
    });
}
/**
 * Input secret for a HITL request
 */
async function handleInputSecret(sender, msg) {
    const { requestId, secret } = msg;
    if (!requestId || !secret) {
        sendResponse(sender, { success: false, error: 'Missing request ID or secret' });
        return;
    }
    // Verify the request is valid and not expired
    if (!hitlState.pendingRequest || hitlState.pendingRequest.id !== requestId) {
        sendResponse(sender, { success: false, error: 'Invalid request' });
        return;
    }
    if (Date.now() > hitlState.pendingRequest.expiresAt) {
        sendResponse(sender, { success: false, error: 'Request expired' });
        return;
    }
    // Verify secret type matches request type
    const validTypes = ['secret_text', 'otp_code'];
    if (!validTypes.includes(hitlState.pendingRequest.type)) {
        sendResponse(sender, { success: false, error: 'Secret input not required for this request type' });
        return;
    }
    console.log(`Secret received for request: ${requestId}`);
    // In production, this would securely handle the secret
    // For now, we just acknowledge receipt
    sendResponse(sender, {
        success: true,
        message: 'Secret received',
    });
    // Auto-approve after secret input
    hitlState.pendingRequest = null;
    notifySidePanel({
        type: 'HITL_SECRET_INPUT_RECEIVED',
        requestId,
    });
}
/**
 * Get current HITL state
 */
async function handleGetState(sender) {
    const state = {
        pendingRequest: hitlState.pendingRequest,
        isPaused: hitlState.isPaused,
        humanActive: hitlState.humanActive,
    };
    sendResponse(sender, { success: true, ...state });
}
/**
 * Check for pending requests on startup
 */
async function checkForPendingRequest() {
    try {
        const currentTask = await loadCurrentTask();
        if (currentTask && currentTask.state === 'pending_approval') {
            console.log(`Recovered pending HITL request: ${currentTask.taskId}`);
            hitlState.pendingRequest = {
                id: currentTask.taskId,
                type: currentTask.type || 'action_approval',
                message: currentTask.message || 'Human approval required',
                details: currentTask.details,
                expiresAt: currentTask.expiresAt || Date.now() + 15 * 60 * 1000,
            };
        }
    }
    catch (error) {
        console.error('Failed to check for pending HITL request:', error);
    }
}
/**
 * Notify side panel about HITL events
 */
function notifySidePanel(message) {
    chrome.runtime.sendMessage({
        type: 'HITL_NOTIFICATION',
        ...message,
    }).catch(() => { });
}
/**
 * Check if a request is still valid (not expired)
 */
export function isRequestValid(request) {
    return Date.now() < request.expiresAt;
}
/**
 * Get remaining time for a request in seconds
 */
export function getRequestRemainingSeconds(request) {
    const remaining = Math.ceil((request.expiresAt - Date.now()) / 1000);
    return Math.max(0, remaining);
}
//# sourceMappingURL=hitl.js.map