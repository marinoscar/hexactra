//! Tests for AI planning and browser action loop

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import {
  PlanningLoop,
  createPlanningLoop,
  PlanningLoopConfig,
  BrowserAction,
  BrowserObservation,
} from './planning';
import { OpenAIClient, ChatMessage } from './openai';

// Mock dependencies
const mockCreateChatCompletion = vi.fn();
const mockObserve = vi.fn();

vi.mock('./openai', async () => {
  const actual = await vi.importActual('./openai');
  return {
    ...actual,
    OpenAIClient: class {
      constructor() {}
      createChatCompletion = mockCreateChatCompletion;
    },
  };
});

describe('PlanningLoop', () => {
  const config: PlanningLoopConfig = {
    maxSteps: 10,
    stepTimeout: 5000,
    maxRetries: 3,
    minConfidence: 0.8,
  };

  let client: OpenAIClient;
  let loop: PlanningLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - Mock client
    client = new OpenAIClient();
    loop = createPlanningLoop(client, config, 'Test goal');
  });

  describe('initialization', () => {
    it('should create a planning loop with initial state', () => {
      const state = loop.getState();

      expect(state.goal).toBe('Test goal');
      expect(state.status).toBe('pending');
      expect(state.stepCount).toBe(0);
      expect(state.maxSteps).toBe(10);
    });
  });

  describe('observe', () => {
    it('should return browser observation', async () => {
      const observation = await loop.observe();

      expect(observation).toBeDefined();
      expect(observation.url).toBeDefined();
      expect(observation.elements).toBeDefined();
    });
  });

  describe('getModelProposal', () => {
    it('should get action proposal from model', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({
        id: 'test',
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'propose_action',
                    arguments: JSON.stringify({
                      reasoning: 'Click the button to proceed',
                      action: 'click',
                      selector: '#submit-btn',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });

      const result = await loop['getModelProposal']();

      expect(result.reasoning).toBe('Click the button to proceed');
      expect(result.action?.type).toBe('click');
      expect(result.action?.selector).toBe('#submit-btn');
    });

    it('should throw error if no proposal from model', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({
        id: 'test',
        choices: [{ message: { role: 'assistant', content: 'Hello' } }],
      });

      await expect(loop['getModelProposal']()).rejects.toThrow('No action proposal from model');
    });
  });

  describe('validateAction', () => {
    it('should validate click action with selector', () => {
      const action: BrowserAction = { type: 'click', selector: '#button' };
      const result = loop['validateAction'](action);

      expect(result.valid).toBe(true);
    });

    it('should reject click action without selector', () => {
      const action: BrowserAction = { type: 'click' };
      const result = loop['validateAction'](action);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Selector required for click action');
    });

    it('should validate type action with text', () => {
      const action: BrowserAction = { type: 'type', selector: '#input', text: 'hello' };
      const result = loop['validateAction'](action);

      expect(result.valid).toBe(true);
    });

    it('should reject type action without text', () => {
      const action: BrowserAction = { type: 'type', selector: '#input' };
      const result = loop['validateAction'](action);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Text required for type action');
    });

    it('should validate navigate action with URL', () => {
      const action: BrowserAction = { type: 'navigate', url: 'https://example.com' };
      const result = loop['validateAction'](action);

      expect(result.valid).toBe(true);
    });

    it('should validate wait action with duration', () => {
      const action: BrowserAction = { type: 'wait', duration: 1000 };
      const result = loop['validateAction'](action);

      expect(result.valid).toBe(true);
    });
  });

  describe('executeAction', () => {
    it('should execute click action successfully', async () => {
      const action: BrowserAction = { type: 'click', selector: '#button' };

      const result = await loop.executeAction(action);

      expect(result.success).toBe(true);
    });

    it('should retry failed actions', async () => {
      // First two calls fail, third succeeds
      vi.spyOn(loop, 'executeAction').mockResolvedValueOnce({ success: false, error: 'Error 1' })
        .mockResolvedValueOnce({ success: false, error: 'Error 2' })
        .mockResolvedValueOnce({ success: true });

      const action: BrowserAction = { type: 'click', selector: '#button' };
      const result = await loop.executeAction(action);

      expect(result.success).toBe(true);
    });

    it('should fail after max retries', async () => {
      vi.spyOn(loop, 'executeAction').mockResolvedValue({ success: false, error: 'Persistent error' });

      const action: BrowserAction = { type: 'click', selector: '#button' };
      const result = await loop.executeAction(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('after 3 retries');
    });
  });

  describe('runIteration', () => {
    it('should complete a successful iteration', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({
        id: 'test',
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({
                      reasoning: 'Test reasoning',
                      action: 'click',
                      selector: '#button',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });

      const result = await loop.runIteration();

      expect(result.success).toBe(true);
      expect(result.shouldContinue).toBe(true);
    });

    it('should stop when max steps reached', async () => {
      // Set maxSteps to 0 for testing
      loop = createPlanningLoop(client, { ...config, maxSteps: 0 }, 'Test');
      const result = await loop.runIteration();

      expect(result.shouldContinue).toBe(false);
    });
  });

  describe('runLoop', () => {
    it('should run until completion', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({
        id: 'test',
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({
                      reasoning: 'First step',
                      action: 'click',
                      selector: '#button1',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });

      const state = await loop.runLoop();

      expect(state.status).toBe('completed');
      expect(state.stepCount).toBeGreaterThan(0);
    });
  });

  describe('pause/resume/cancel', () => {
    it('should pause the loop', () => {
      loop.pause();
      expect(loop.getState().status).toBe('paused');
    });

    it('should resume a paused loop', async () => {
      loop.pause();
      const state = await loop.resume();

      expect(state.status).toBe('completed');
    });

    it('should throw error if resuming non-paused loop', async () => {
      await expect(loop.resume()).rejects.toThrow('Cannot resume: loop is not paused');
    });

    it('should cancel the loop', () => {
      loop.cancel();
      expect(loop.getState().status).toBe('failed');
    });
  });
});
