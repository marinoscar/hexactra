//! Client for Hexactra control plane API

import { Goal, Session, Operation, BrowserAction, ActionResult, CreateGoalRequest } from './types';

export interface HttpClient {
  get<T>(url: string): Promise<T>;
  post<T, R>(url: string, body: T): Promise<R>;
}

export class ControlPlaneClient {
  constructor(private baseUrl: string, private httpClient: HttpClient) {}

  async createGoal(sessionId: string, actions: BrowserAction[]): Promise<Goal> {
    const request: CreateGoalRequest = { sessionId, actions };
    return this.httpClient.post<CreateGoalRequest, Goal>(
      `${this.baseUrl}/goals`,
      request
    );
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.httpClient.get<Session>(`${this.baseUrl}/sessions/${sessionId}`);
  }

  async getOperation(operationId: string): Promise<Operation> {
    return this.httpClient.get<Operation>(`${this.baseUrl}/operations/${operationId}`);
  }

  async executeAction(sessionId: string, action: BrowserAction): Promise<ActionResult> {
    return this.httpClient.post<BrowserAction, ActionResult>(
      `${this.baseUrl}/sessions/${sessionId}/actions`,
      action
    );
  }
}
