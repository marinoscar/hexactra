export interface Goal {
    id: string;
    sessionId: string;
    actions: BrowserAction[];
    createdAt: string;
    status: RunStatus;
}
export interface Session {
    id: string;
    profileId: string;
    status: SessionStatus;
    createdAt: string;
    updatedAt: string;
}
export interface Profile {
    id: string;
    name: string;
    chromeProfilePath?: string;
    createdAt: string;
    updatedAt: string;
}
export interface Operation {
    id: string;
    goalId: string;
    status: OperationStatus;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
}
export declare enum RunStatus {
    Queued = "queued",
    Running = "running",
    Completed = "completed",
    Failed = "failed",
    Cancelled = "cancelled",
    TimedOut = "timed_out"
}
export declare enum SessionStatus {
    Initializing = "initializing",
    Running = "running",
    Paused = "paused",
    Ended = "ended"
}
export declare enum OperationStatus {
    Queued = "queued",
    InProgress = "in_progress",
    Completed = "completed",
    Failed = "failed"
}
export interface BrowserAction {
    type: string;
    payload?: Record<string, unknown>;
}
export interface CreateGoalRequest {
    sessionId: string;
    actions: BrowserAction[];
}
export interface CreateGoalResponse {
    goalId: string;
}
export interface ActionResult {
    success: boolean;
    error?: string;
    data?: unknown;
}
//# sourceMappingURL=types.d.ts.map