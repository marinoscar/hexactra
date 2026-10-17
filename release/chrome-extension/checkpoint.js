//! Checkpoint persistence and MV3 lifecycle management for Hexactra Chrome extension
//!
//! This module handles:
//! - Persisting non-secret run/checkpoint state
//! - Service-worker suspend/restart handling
//! - Page unload and tab closure
//! - Network loss and retry ambiguity
/**
 * Storage keys for checkpoint data
 */
const STORAGE_KEYS = {
    CHECKPOINTS: 'checkpoints',
    CURRENT_TASK: 'currentTask',
    TASK_HISTORY: 'taskHistory',
};
/**
 * Load checkpoints from storage
 */
export async function loadCheckpoints() {
    try {
        const data = await chrome.storage.local.get([STORAGE_KEYS.CHECKPOINTS]);
        return data[STORAGE_KEYS.CHECKPOINTS] || {};
    }
    catch (error) {
        console.error('Failed to load checkpoints:', error);
        return {};
    }
}
/**
 * Save checkpoints to storage
 */
export async function saveCheckpoints(checkpoints) {
    try {
        await chrome.storage.local.set({
            [STORAGE_KEYS.CHECKPOINTS]: checkpoints,
        });
    }
    catch (error) {
        console.error('Failed to save checkpoints:', error);
    }
}
/**
 * Load current task from storage
 */
export async function loadCurrentTask() {
    try {
        const data = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_TASK]);
        return data[STORAGE_KEYS.CURRENT_TASK] || null;
    }
    catch (error) {
        console.error('Failed to load current task:', error);
        return null;
    }
}
/**
 * Save current task to storage
 */
export async function saveCurrentTask(metadata) {
    try {
        await chrome.storage.local.set({
            [STORAGE_KEYS.CURRENT_TASK]: metadata,
        });
    }
    catch (error) {
        console.error('Failed to save current task:', error);
    }
}
/**
 * Load task history from storage
 */
export async function loadTaskHistory() {
    try {
        const data = await chrome.storage.local.get([STORAGE_KEYS.TASK_HISTORY]);
        return data[STORAGE_KEYS.TASK_HISTORY] || [];
    }
    catch (error) {
        console.error('Failed to load task history:', error);
        return [];
    }
}
/**
 * Save task history to storage
 */
export async function saveTaskHistory(history) {
    try {
        await chrome.storage.local.set({
            [STORAGE_KEYS.TASK_HISTORY]: history,
        });
    }
    catch (error) {
        console.error('Failed to save task history:', error);
    }
}
/**
 * Create a new checkpoint
 */
export async function createCheckpoint(taskId, goal, state = 'idle', lastActionIndex = 0) {
    const checkpoint = {
        taskId,
        goal,
        state,
        timestamp: Date.now(),
        lastActionIndex,
        history: [],
    };
    const checkpoints = await loadCheckpoints();
    checkpoints[taskId] = checkpoint;
    await saveCheckpoints(checkpoints);
    return checkpoint;
}
/**
 * Update an existing checkpoint
 */
export async function updateCheckpoint(taskId, updates) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        throw new Error(`Checkpoint not found: ${taskId}`);
    }
    checkpoints[taskId] = {
        ...checkpoints[taskId],
        ...updates,
        timestamp: Date.now(),
    };
    await saveCheckpoints(checkpoints);
}
/**
 * Add a step to task history
 */
export async function addTaskStep(taskId, step) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        throw new Error(`Checkpoint not found: ${taskId}`);
    }
    checkpoints[taskId].history.push(step);
    checkpoints[taskId].lastActionIndex = checkpoints[taskId].history.length - 1;
    checkpoints[taskId].timestamp = Date.now();
    await saveCheckpoints(checkpoints);
}
/**
 * Get task metadata
 */
export async function getTaskMetadata(taskId) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        return null;
    }
    const checkpoint = checkpoints[taskId];
    return {
        taskId: checkpoint.taskId,
        goal: checkpoint.goal,
        state: checkpoint.state,
        createdAt: checkpoint.timestamp,
        lastUpdatedAt: checkpoint.timestamp,
        stepsCount: checkpoint.history.length,
    };
}
/**
 * Clear all checkpoints
 */
export async function clearCheckpoints() {
    try {
        await chrome.storage.local.remove(STORAGE_KEYS.CHECKPOINTS);
        await chrome.storage.local.remove(STORAGE_KEYS.CURRENT_TASK);
    }
    catch (error) {
        console.error('Failed to clear checkpoints:', error);
    }
}
/**
 * Clear task history
 */
export async function clearTaskHistory(taskId) {
    const checkpoints = await loadCheckpoints();
    if (checkpoints[taskId]) {
        checkpoints[taskId].history = [];
        checkpoints[taskId].lastActionIndex = 0;
        await saveCheckpoints(checkpoints);
    }
}
/**
 * Get all task metadata
 */
export async function getAllTaskMetadata() {
    const checkpoints = await loadCheckpoints();
    const metadataList = [];
    for (const taskId in checkpoints) {
        const metadata = await getTaskMetadata(taskId);
        if (metadata) {
            metadataList.push(metadata);
        }
    }
    return metadataList;
}
/**
 * Recover task from checkpoint
 */
export async function recoverTask(taskId) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        return null;
    }
    const checkpoint = checkpoints[taskId];
    // Reset failed tasks to idle for user to review
    if (checkpoint.state === 'failed') {
        checkpoint.state = 'idle';
        await saveCheckpoints(checkpoints);
    }
    return checkpoint;
}
/**
 * Mark task as completed
 */
export async function markTaskCompleted(taskId) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        throw new Error(`Checkpoint not found: ${taskId}`);
    }
    checkpoints[taskId].state = 'completed';
    checkpoints[taskId].timestamp = Date.now();
    await saveCheckpoints(checkpoints);
}
/**
 * Mark task as failed with error
 */
export async function markTaskFailed(taskId, error) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        throw new Error(`Checkpoint not found: ${taskId}`);
    }
    checkpoints[taskId].state = 'failed';
    checkpoints[taskId].timestamp = Date.now();
    // Add failure step to history
    checkpoints[taskId].history.push({
        id: `failure-${Date.now()}`,
        type: 'wait',
        timestamp: Date.now(),
        success: false,
        error,
    });
    await saveCheckpoints(checkpoints);
}
/**
 * Check if task can be resumed
 */
export async function canResumeTask(taskId) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        return false;
    }
    const checkpoint = checkpoints[taskId];
    // Can resume from paused or failed state
    return checkpoint.state === 'paused' || checkpoint.state === 'failed';
}
/**
 * Check if task can be restarted
 */
export async function canRestartTask(taskId) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        return false;
    }
    const checkpoint = checkpoints[taskId];
    // Can restart from any state except running
    return checkpoint.state !== 'running';
}
/**
 * Get task status summary
 */
export async function getTaskStatus(taskId) {
    const checkpoints = await loadCheckpoints();
    if (!checkpoints[taskId]) {
        return {
            taskId,
            goal: '',
            state: 'idle',
            stepsCompleted: 0,
            canResume: false,
            canRestart: false,
        };
    }
    const checkpoint = checkpoints[taskId];
    return {
        taskId: checkpoint.taskId,
        goal: checkpoint.goal,
        state: checkpoint.state,
        stepsCompleted: checkpoint.history.length,
        canResume: await canResumeTask(taskId),
        canRestart: await canRestartTask(taskId),
    };
}
//# sourceMappingURL=checkpoint.js.map