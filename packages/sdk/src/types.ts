//! Type definitions for Hexactra

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

export enum RunStatus {
  Queued = 'queued',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
  TimedOut = 'timed_out',
}

export enum SessionStatus {
  Initializing = 'initializing',
  Running = 'running',
  Paused = 'paused',
  Ended = 'ended',
}

export enum OperationStatus {
  Queued = 'queued',
  InProgress = 'in_progress',
  Completed = 'completed',
  Failed = 'failed',
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

// ==================== HITL Types ====================

export enum InteractionKind {
  SecretText = 'secret_text',
  OtpCode = 'otp_code',
  OobConfirmation = 'oob_confirmation',
  PasskeyOrSecurityKey = 'passkey_or_security_key',
  ActionApproval = 'action_approval',
  HumanTakeover = 'human_takeover',
  Information = 'information',
}

export enum InteractionStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
  Expired = 'expired',
  Cancelled = 'cancelled',
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
