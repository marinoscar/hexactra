import { OpenAIClient } from './openai';
/**
 * Browser action types
 */
export type BrowserActionType = 'observe' | 'click' | 'type' | 'navigate' | 'screenshot' | 'wait' | 'scroll';
/**
 * Browser action payload
 */
export interface BrowserAction {
    type: BrowserActionType;
    selector?: string;
    text?: string;
    url?: string;
    duration?: number;
    x?: number;
    y?: number;
}
/**
 * Observation result from browser
 */
export interface BrowserObservation {
    url: string;
    title: string;
    elements: Array<{
        tagName: string;
        id?: string;
        className?: string;
        role?: string;
        text?: string;
        visible: boolean;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
}
/**
 * Goal state
 */
export interface GoalState {
    goal: string;
    observations: BrowserObservation[];
    actions: BrowserAction[];
    modelProposals: Array<{
        reasoning: string;
        action?: BrowserAction;
        nextStep: 'continue' | 'finish' | 'replan';
    }>;
    status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
    stepCount: number;
    maxSteps: number;
    createdAt: string;
    lastUpdated: string;
}
/**
 * AI planning loop configuration
 */
export interface PlanningLoopConfig {
    /** Maximum number of steps to execute */
    maxSteps: number;
    /** Timeout for each step in milliseconds */
    stepTimeout: number;
    /** Retry count for failed actions */
    maxRetries: number;
    /** Minimum confidence threshold for accepting model proposals */
    minConfidence: number;
}
/**
 * Result of a planning loop iteration
 */
export interface LoopResult {
    success: boolean;
    nextAction?: BrowserAction;
    shouldContinue: boolean;
    observation?: BrowserObservation;
    error?: string;
}
/**
 * AI Planning and Browser Action Loop
 *
 * Implements the core loop:
 * 1. Observe current state
 * 2. Send to model for proposal
 * 3. Parse and validate schema
 * 4. Authorize action
 * 5. Execute via BrowserDriver
 * 6. Observe result
 * 7. Verify and continue/finish
 */
export declare class PlanningLoop {
    private client;
    private config;
    private state;
    constructor(client: OpenAIClient, config: PlanningLoopConfig, initialGoal: string);
    /**
     * Get current goal state
     */
    getState(): GoalState;
    /**
     * Observe the current browser state
     */
    observe(): Promise<BrowserObservation>;
    /**
     * Build the system prompt for the AI loop
     */
    private buildSystemPrompt;
    /**
     * Build tools for the model to use
     */
    private buildTools;
    /**
     * Get model proposal for next action
     */
    getModelProposal(): Promise<{
        reasoning: string;
        action?: BrowserAction;
        confidence: number;
    }>;
    /**
     * Validate the proposed action
     */
    private validateAction;
    /**
     * Execute a browser action
     */
    executeAction(action: BrowserAction): Promise<{
        success: boolean;
        result?: unknown;
        error?: string;
    }>;
    /**
     * Verify the action result against expectations
     */
    private verifyResult;
    /**
     * Run one iteration of the planning loop
     */
    runIteration(): Promise<LoopResult>;
    /**
     * Run the complete planning loop until completion or failure
     */
    runLoop(): Promise<GoalState>;
    /**
     * Pause the current loop
     */
    pause(): void;
    /**
     * Resume a paused loop
     */
    resume(): Promise<GoalState>;
    /**
     * Cancel the current loop
     */
    cancel(): void;
}
/**
 * Factory function to create a planning loop
 */
export declare function createPlanningLoop(client: OpenAIClient, config: PlanningLoopConfig, goal: string): PlanningLoop;
//# sourceMappingURL=planning.d.ts.map