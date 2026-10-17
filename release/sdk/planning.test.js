"use strict";
//! Tests for AI planning and browser action loop
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const planning_1 = require("./planning");
(0, vitest_1.describe)('PlanningLoop', () => {
    const config = {
        maxSteps: 10,
        stepTimeout: 5000,
        maxRetries: 3,
        minConfidence: 0.8,
    };
    let loop;
    (0, vitest_1.beforeEach)(() => {
        loop = (0, planning_1.createPlanningLoop)(
        // @ts-expect-error - Mock client
        {}, config, 'Test goal');
    });
    (0, vitest_1.describe)('initialization', () => {
        (0, vitest_1.it)('should create a planning loop with initial state', () => {
            const state = loop.getState();
            (0, vitest_1.expect)(state.goal).toBe('Test goal');
            (0, vitest_1.expect)(state.status).toBe('pending');
            (0, vitest_1.expect)(state.stepCount).toBe(0);
            (0, vitest_1.expect)(state.maxSteps).toBe(10);
        });
    });
    (0, vitest_1.describe)('observe', () => {
        (0, vitest_1.it)('should return browser observation', async () => {
            const observation = await loop.observe();
            (0, vitest_1.expect)(observation).toBeDefined();
            (0, vitest_1.expect)(observation.url).toBeDefined();
            (0, vitest_1.expect)(observation.elements).toBeDefined();
        });
    });
    (0, vitest_1.describe)('validateAction', () => {
        (0, vitest_1.it)('should validate click action with selector', () => {
            const action = { type: 'click', selector: '#button' };
            const result = loop['validateAction'](action);
            (0, vitest_1.expect)(result.valid).toBe(true);
        });
        (0, vitest_1.it)('should reject click action without selector', () => {
            const action = { type: 'click' };
            const result = loop['validateAction'](action);
            (0, vitest_1.expect)(result.valid).toBe(false);
            (0, vitest_1.expect)(result.error).toBe('Selector required for click action');
        });
        (0, vitest_1.it)('should validate type action with text', () => {
            const action = { type: 'type', selector: '#input', text: 'hello' };
            const result = loop['validateAction'](action);
            (0, vitest_1.expect)(result.valid).toBe(true);
        });
        (0, vitest_1.it)('should reject type action without text', () => {
            const action = { type: 'type', selector: '#input' };
            const result = loop['validateAction'](action);
            (0, vitest_1.expect)(result.valid).toBe(false);
            (0, vitest_1.expect)(result.error).toBe('Text required for type action');
        });
        (0, vitest_1.it)('should validate navigate action with URL', () => {
            const action = { type: 'navigate', url: 'https://example.com' };
            const result = loop['validateAction'](action);
            (0, vitest_1.expect)(result.valid).toBe(true);
        });
        (0, vitest_1.it)('should validate wait action with duration', () => {
            const action = { type: 'wait', duration: 1000 };
            const result = loop['validateAction'](action);
            (0, vitest_1.expect)(result.valid).toBe(true);
        });
    });
    (0, vitest_1.describe)('executeAction', () => {
        (0, vitest_1.it)('should execute click action successfully', async () => {
            const action = { type: 'click', selector: '#button' };
            const result = await loop.executeAction(action);
            (0, vitest_1.expect)(result.success).toBe(true);
        });
        (0, vitest_1.it)('should fail for invalid actions', async () => {
            // Type without text
            const action = { type: 'type', selector: '#input' };
            const result = await loop.executeAction(action);
            (0, vitest_1.expect)(result.success).toBe(false);
        });
    });
    (0, vitest_1.describe)('pause/resume/cancel', () => {
        (0, vitest_1.it)('should pause the loop', () => {
            loop.pause();
            (0, vitest_1.expect)(loop.getState().status).toBe('paused');
        });
        (0, vitest_1.it)('should throw error if resuming non-paused loop', async () => {
            await (0, vitest_1.expect)(loop.resume()).rejects.toThrow('Cannot resume: loop is not paused');
        });
        (0, vitest_1.it)('should cancel the loop', () => {
            loop.cancel();
            (0, vitest_1.expect)(loop.getState().status).toBe('failed');
        });
    });
});
//# sourceMappingURL=planning.test.js.map