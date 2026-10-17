/**
 * HITL request types
 */
export type HitlRequestType = 'secret_text' | 'otp_code' | 'oob_confirmation' | 'action_approval';
/**
 * HITL request structure
 */
export interface HitlRequest {
    id: string;
    type: HitlRequestType;
    message: string;
    details?: Record<string, unknown>;
    expiresAt: number;
    originTabId?: number;
    originFrameId?: number;
}
/**
 * Initialize HITL controls
 */
export declare function initHitl(): Promise<void>;
/**
 * Check if a request is still valid (not expired)
 */
export declare function isRequestValid(request: HitlRequest): boolean;
/**
 * Get remaining time for a request in seconds
 */
export declare function getRequestRemainingSeconds(request: HitlRequest): number;
//# sourceMappingURL=hitl.d.ts.map