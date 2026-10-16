//! AI planning and browser action loop for Hexactra
//!
//! This module implements the core AI loop: goal → observe → model propose → parse schema →
//! authorize → execute BrowserDriver → observe/verify → continue/finish.

import { OpenAIClient, ToolDefinition, ChatMessage } from './openai';

/**
 * Browser action types
 */
export type BrowserActionType =
  | 'observe'
  | 'click'
  | 'type'
  | 'navigate'
  | 'screenshot'
  | 'wait'
  | 'scroll';

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
export class PlanningLoop {
  private client: OpenAIClient;
  private config: PlanningLoopConfig;
  private state: GoalState;

  constructor(client: OpenAIClient, config: PlanningLoopConfig, initialGoal: string) {
    this.client = client;
    this.config = config;
    this.state = {
      goal: initialGoal,
      observations: [],
      actions: [],
      modelProposals: [],
      status: 'pending',
      stepCount: 0,
      maxSteps: config.maxSteps,
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Get current goal state
   */
  getState(): GoalState {
    return this.state;
  }

  /**
   * Observe the current browser state
   */
  async observe(): Promise<BrowserObservation> {
    // In a real implementation, this would call the Chrome extension API
    // For now, return a placeholder
    return {
      url: '',
      title: '',
      elements: [],
    };
  }

  /**
   * Build the system prompt for the AI loop
   */
  private buildSystemPrompt(): string {
    return `You are an AI browser automation assistant. Your task is to help users complete goals by interacting with web pages.

Follow this process for each step:
1. Analyze the current page state
2. Determine what action to take next
3. Provide reasoning for your decision

Available actions:
- observe: Get current page state (automatic, do not propose)
- click: Click on an element using CSS selector
- type: Enter text into an input field
- navigate: Go to a new URL
- wait: Wait for a specified duration
- scroll: Scroll the page

Constraints:
- Always use CSS selectors for element targeting
- Do not execute arbitrary JavaScript
- If uncertain, ask for clarification or take a safer action
- Stop when the goal is achieved or max steps reached
- Never execute actions that could cause irreversible changes without confirmation`;
  }

  /**
   * Build tools for the model to use
   */
  private buildTools(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'propose_action',
          description: 'Propose the next action to take based on current observation',
          parameters: {
            type: 'object',
            properties: {
              reasoning: {
                type: 'string',
                description: 'Explanation of why this action is needed',
              },
              action: {
                type: 'string',
                enum: ['observe', 'click', 'type', 'navigate', 'wait', 'scroll'],
                description: 'The action to take',
              },
              selector: {
                type: 'string',
                description: 'CSS selector for click/type actions (optional)',
              },
              text: {
                type: 'string',
                description: 'Text to type (for type action)',
              },
              url: {
                type: 'string',
                description: 'URL to navigate to (for navigate action)',
              },
              duration: {
                type: 'number',
                description: 'Duration to wait in milliseconds (for wait action)',
              },
            },
            required: ['reasoning', 'action'],
          },
        },
      },
    ];
  }

  /**
   * Get model proposal for next action
   */
  async getModelProposal(): Promise<{
    reasoning: string;
    action?: BrowserAction;
    confidence: number;
  }> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      ...this.state.observations.map((obs, index) => ({
        role: 'user' as const,
        content: `Observation ${index + 1}:\nURL: ${obs.url}\nTitle: ${obs.title}\nElements: ${JSON.stringify(obs.elements.slice(0, 50))}`,
      })),
      ...this.state.actions.map((action, index) => ({
        role: 'assistant' as const,
        content: `Action ${index + 1}: ${action.type}${action.selector ? ` (selector: ${action.selector})` : ''}`,
      })),
    ];

    const response = await this.client.createChatCompletion(messages, this.buildTools());

    const toolCalls = OpenAIClient.extractToolCalls(response);
    if (toolCalls.length === 0) {
      throw new Error('No action proposal from model');
    }

    // Parse the tool call arguments
    try {
      const args = JSON.parse(toolCalls[0].function.arguments);
      return {
        reasoning: args.reasoning || '',
        action: {
          type: args.action as BrowserActionType,
          selector: args.selector,
          text: args.text,
          url: args.url,
          duration: args.duration,
        },
        confidence: 0.9, // Assume high confidence for now
      };
    } catch (error) {
      throw new Error(`Failed to parse model response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate the proposed action
   */
  private validateAction(action: BrowserAction): { valid: boolean; error?: string } {
    if (!action.type) {
      return { valid: false, error: 'Action type is required' };
    }

    // Validate action-specific requirements
    switch (action.type) {
      case 'click':
        if (!action.selector) {
          return { valid: false, error: 'Selector required for click action' };
        }
        break;
      case 'type':
        if (!action.selector) {
          return { valid: false, error: 'Selector required for type action' };
        }
        if (!action.text) {
          return { valid: false, error: 'Text required for type action' };
        }
        break;
      case 'navigate':
        if (!action.url) {
          return { valid: false, error: 'URL required for navigate action' };
        }
        break;
      case 'wait':
        if (action.duration === undefined || action.duration <= 0) {
          return { valid: false, error: 'Valid duration required for wait action' };
        }
        break;
    }

    return { valid: true };
  }

  /**
   * Execute a browser action
   */
  async executeAction(action: BrowserAction): Promise<{ success: boolean; result?: unknown; error?: string }> {
    // In a real implementation, this would call the Chrome extension API
    // For now, return success as a placeholder
    try {
      // Simulate action execution
      await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay

      if (action.type === 'click' && !action.selector) {
        return { success: false, error: 'Selector required for click' };
      }
      if (action.type === 'type' && (!action.selector || !action.text)) {
        return { success: false, error: 'Selector and text required for type action' };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Verify the action result against expectations
   */
  private verifyResult(_action: BrowserAction, result: unknown): boolean {
    // Simple verification - in production this would check for expected outcomes
    return result !== null && result !== undefined;
  }

  /**
   * Run one iteration of the planning loop
   */
  async runIteration(): Promise<LoopResult> {
    this.state.status = 'running';
    this.state.lastUpdated = new Date().toISOString();

    // Step 1: Observe current state
    const observation = await this.observe();
    this.state.observations.push(observation);

    // Step 2: Get model proposal
    let proposal;
    try {
      proposal = await this.getModelProposal();
    } catch (error) {
      this.state.status = 'failed';
      return {
        success: false,
        error: `Model proposal failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        shouldContinue: false,
      };
    }

    // Step 3: Validate schema
    if (!proposal.action) {
      this.state.status = 'completed';
      return { success: true, shouldContinue: false, observation };
    }

    const validation = this.validateAction(proposal.action);
    if (!validation.valid) {
      this.state.status = 'failed';
      return {
        success: false,
        error: `Action validation failed: ${validation.error}`,
        shouldContinue: false,
      };
    }

    // Step 4: Execute action
    const executionResult = await this.executeAction(proposal.action);
    if (!executionResult.success) {
      // Retry logic
      for (let i = 0; i < this.config.maxRetries; i++) {
        const retryResult = await this.executeAction(proposal.action);
        if (retryResult.success) {
          break;
        }
        if (i === this.config.maxRetries - 1) {
          this.state.status = 'failed';
          return {
            success: false,
            error: `Action execution failed after ${this.config.maxRetries} retries: ${executionResult.error}`,
            shouldContinue: false,
          };
        }
      }
    }

    // Step 5: Verify result
    if (!this.verifyResult(proposal.action, executionResult.result)) {
      this.state.status = 'failed';
      return {
        success: false,
        error: 'Action verification failed',
        shouldContinue: false,
      };
    }

    // Step 6: Update state
    this.state.actions.push(proposal.action);
    this.state.modelProposals.push({
      reasoning: proposal.reasoning,
      action: proposal.action,
      nextStep: 'continue',
    });
    this.state.stepCount++;

    // Step 7: Check if we should continue
    const shouldContinue = this.state.stepCount < this.config.maxSteps;

    if (!shouldContinue) {
      this.state.status = 'completed';
    }

    return {
      success: true,
      nextAction: proposal.action,
      shouldContinue,
      observation,
    };
  }

  /**
   * Run the complete planning loop until completion or failure
   */
  async runLoop(): Promise<GoalState> {
    while (this.state.status === 'running' && this.state.stepCount < this.config.maxSteps) {
      const result = await this.runIteration();
      if (!result.success || !result.shouldContinue) {
        break;
      }
    }

    return this.state;
  }

  /**
   * Pause the current loop
   */
  pause(): void {
    this.state.status = 'paused';
    this.state.lastUpdated = new Date().toISOString();
  }

  /**
   * Resume a paused loop
   */
  async resume(): Promise<GoalState> {
    if (this.state.status !== 'paused') {
      throw new Error('Cannot resume: loop is not paused');
    }

    this.state.status = 'running';
    this.state.lastUpdated = new Date().toISOString();

    return this.runLoop();
  }

  /**
   * Cancel the current loop
   */
  cancel(): void {
    this.state.status = 'failed';
    this.state.lastUpdated = new Date().toISOString();
  }
}

/**
 * Factory function to create a planning loop
 */
export function createPlanningLoop(client: OpenAIClient, config: PlanningLoopConfig, goal: string): PlanningLoop {
  return new PlanningLoop(client, config, goal);
}
