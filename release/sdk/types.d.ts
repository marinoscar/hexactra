/**
 * Error codes for Hexactra SDK errors
 */
export declare enum ErrorCode {
    InvalidInput = "INVALID_INPUT",
    Unauthorized = "UNAUTHORIZED",
    Forbidden = "FORBIDDEN",
    NotFound = "NOT_FOUND",
    Conflict = "CONFLICT",
    RateLimit = "RATE_LIMIT",
    InternalError = "INTERNAL_ERROR",
    NetworkError = "NETWORK_ERROR",
    TimeoutError = "TIMEOUT_ERROR"
}
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
export declare enum InteractionKind {
    SecretText = "secret_text",
    OtpCode = "otp_code",
    OobConfirmation = "oob_confirmation",
    PasskeyOrSecurityKey = "passkey_or_security_key",
    ActionApproval = "action_approval",
    HumanTakeover = "human_takeover",
    Information = "information"
}
export declare enum InteractionStatus {
    Pending = "pending",
    Approved = "approved",
    Rejected = "rejected",
    Expired = "expired",
    Cancelled = "cancelled"
}
export interface InteractionRequest {
    id: string;
    sessionId: string;
    reason: string;
    details: Record<string, unknown>;
    createdAt: string;
    kind: InteractionKind;
    status: InteractionStatus;
    expiresAt: string;
    ownerId?: string;
    originSessionId: string;
}
export interface CreateInteractionRequestRequest {
    sessionId: string;
    reason: string;
    details: Record<string, unknown>;
    kind?: InteractionKind;
    ttlMinutes?: number;
}
export interface CreateInteractionRequestResponse {
    request: InteractionRequestResponse;
}
export interface InteractionRequestResponse {
    id: string;
    sessionId: string;
    reason: string;
    details: Record<string, unknown>;
    createdAt: string;
    kind: InteractionKind;
    status: InteractionStatus;
    expiresAt: string;
    originSessionId?: string;
}
export interface ClaimInteractionRequestRequest {
    ownerId: string;
}
export interface ClaimInteractionRequestResponse {
    claimed: boolean;
}
export interface RespondInteractionRequestRequest {
    ownerId: string;
    status: InteractionStatus;
    secret?: string;
}
export interface RespondInteractionRequestResponse {
    responded: boolean;
}
export interface RequestOobConfirmationRequest {
    sessionId: string;
    reason: string;
    details: Record<string, unknown>;
    ttlMinutes?: number;
}
export interface RequestOobConfirmationResponse {
    request: InteractionRequestResponse;
    oobChannel: OobChannelInfo;
}
export interface OobChannelInfo {
    channelId: string;
    verificationUri: string;
    verificationCode: string;
    expiresAt: string;
}
export interface VerifyOobRequest {
    channelId: string;
    verificationCode: string;
}
export interface VerifyOobResponse {
    verified: boolean;
}
export interface RequestPasskeyRequest {
    sessionId: string;
    reason: string;
    details: Record<string, unknown>;
    ttlMinutes?: number;
}
export interface RequestPasskeyResponse {
    request: InteractionRequestResponse;
    passkeyChallenge: PasskeyChallenge;
}
export interface PasskeyChallenge {
    challengeId: string;
    rpEntityName: string;
    userId: string;
    timeoutSeconds: number;
    attestationTypes: string[];
}
export interface VerifyPasskeyRequest {
    challengeId: string;
    credentialId: string;
    authenticatorData: string;
    clientDataJson: string;
    signature: string;
}
export interface VerifyPasskeyResponse {
    verified: boolean;
    credentialId: string;
}
//# sourceMappingURL=types.d.ts.map