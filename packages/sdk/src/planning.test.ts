//! Tests for AI planning and browser action loop

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PlanningLoop,
  createPlanningLoop,
  PlanningLoopConfig,
  BrowserAction,
} from './planning';

describe('PlanningLoop', () => {
  const config: PlanningLoopConfig = {
    maxSteps: 10,
    stepTimeout: 5000,
    maxRetries: 3,
    minConfidence: 0.8,
  };

  let loop: PlanningLoop;

  beforeEach(() => {
    loop = createPlanningLoop(
      // @ts-expect-error - Mock client
      {},
      config,
      'Test goal'
    );
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

    it('should fail for invalid actions', async () => {
      // Type without text
      const action: BrowserAction = { type: 'type', selector: '#input' };
      const result = await loop.executeAction(action);

      expect(result.success).toBe(false);
    });
  });

  describe('pause/resume/cancel', () => {
    it('should pause the loop', () => {
      loop.pause();
      expect(loop.getState().status).toBe('paused');
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
