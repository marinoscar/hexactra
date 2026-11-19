import { Session, Operation, BrowserAction, ActionResult } from './types';
export interface HttpClient {
    get<T>(url: string): Promise<T>;
    post<T, R>(url: string, body: T): Promise<R>;
}
export declare class ControlPlaneClient {
    private baseUrl;
    private httpClient;
    constructor(baseUrl: string, httpClient: HttpClient);
    getSession(sessionId: string): Promise<Session>;
    getOperation(operationId: string): Promise<Operation>;
    executeAction(sessionId: string, action: BrowserAction): Promise<ActionResult>;
}
//# sourceMappingURL=client.d.ts.map