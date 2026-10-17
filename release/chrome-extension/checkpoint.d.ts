/**
 * Task states
 */
export type TaskState = 'idle' | 'running' | 'paused' | 'stopped' | 'failed' | 'completed' | 'pending_approval' | 'approved' | 'rejected' | 'expired' | 'secret_input_received';
/**
 * Checkpoint data structure
 */
export interface Checkpoint {
    taskId: string;
    goal: string;
    state: TaskState;
    timestamp: number;
    lastActionIndex: number;
    history: TaskStep[];
}
/**
 * Task step in history
 */
export interface TaskStep {
    id: string;
    type: 'observe' | 'click' | 'type' | 'navigate' | 'screenshot' | 'wait';
    timestamp: number;
    selector?: string;
    value?: string;
    url?: string;
    success: boolean;
    error?: string;
}
/**
 * Task metadata
 */
export interface TaskMetadata {
    taskId: string;
    goal: string;
    state: TaskState;
    createdAt: number;
    lastUpdatedAt: number;
    stepsCount: number;
    type?: string;
    message?: string;
    details?: Record<string, unknown>;
    expiresAt?: number;
}
/**
 * Load checkpoints from storage
 */
export declare function loadCheckpoints(): Promise<Record<string, Checkpoint>>;
/**
 * Save checkpoints to storage
 */
export declare function saveCheckpoints(checkpoints: Record<string, Checkpoint>): Promise<void>;
/**
 * Load current task from storage
 */
export declare function loadCurrentTask(): Promise<TaskMetadata | null>;
/**
 * Save current task to storage
 */
export declare function saveCurrentTask(metadata: TaskMetadata): Promise<void>;
/**
 * Load task history from storage
 */
export declare function loadTaskHistory(): Promise<TaskMetadata[]>;
/**
 * Save task history to storage
 */
export declare function saveTaskHistory(history: TaskMetadata[]): Promise<void>;
/**
 * Create a new checkpoint
 */
export declare function createCheckpoint(taskId: string, goal: string, state?: TaskState, lastActionIndex?: number): Promise<Checkpoint>;
/**
 * Update an existing checkpoint
 */
export declare function updateCheckpoint(taskId: string, updates: Partial<Checkpoint>): Promise<void>;
/**
 * Add a step to task history
 */
export declare function addTaskStep(taskId: string, step: TaskStep): Promise<void>;
/**
 * Get task metadata
 */
export declare function getTaskMetadata(taskId: string): Promise<TaskMetadata | null>;
/**
 * Clear all checkpoints
 */
export declare function clearCheckpoints(): Promise<void>;
/**
 * Clear task history
 */
export declare function clearTaskHistory(taskId: string): Promise<void>;
/**
 * Get all task metadata
 */
export declare function getAllTaskMetadata(): Promise<TaskMetadata[]>;
/**
 * Recover task from checkpoint
 */
export declare function recoverTask(taskId: string): Promise<Checkpoint | null>;
/**
 * Mark task as completed
 */
export declare function markTaskCompleted(taskId: string): Promise<void>;
/**
 * Mark task as failed with error
 */
export declare function markTaskFailed(taskId: string, error: string): Promise<void>;
/**
 * Check if task can be resumed
 */
export declare function canResumeTask(taskId: string): Promise<boolean>;
/**
 * Check if task can be restarted
 */
export declare function canRestartTask(taskId: string): Promise<boolean>;
/**
 * Get task status summary
 */
export declare function getTaskStatus(taskId: string): Promise<{
    taskId: string;
    goal: string;
    state: TaskState;
    stepsCompleted: number;
    canResume: boolean;
    canRestart: boolean;
}>;
//# sourceMappingURL=checkpoint.d.ts.map