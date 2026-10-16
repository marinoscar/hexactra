import { BrowserAction } from '@hexactra/sdk';
export interface ApiError {
    error: string;
    message?: string;
}
export interface HealthResponse {
    status: 'ok';
    version: string;
}
export interface CreateGoalRequest {
    sessionId: string;
    actions: BrowserAction[];
}
export interface CreateGoalResponse {
    goalId: string;
}
//# sourceMappingURL=openapi.d.ts.map