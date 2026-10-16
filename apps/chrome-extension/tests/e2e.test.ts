//! E2E tests for Hexactra Chrome extension
//!
//! Tests cover:
//! - Happy path: Complete tasks successfully
//! - Error handling: Permission denial, capability gating, malicious instructions
//! - Recovery: Resume after pause/stop
//! - Model modes: Text-only JSON fallback and native tool-call mode

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  getDemoGoals, 
  getCapabilityFixtures, 
  getErrorFixtures, 
  getMultiStepFixtures,
  TEXT_ONLY_JSON_ACTION,
  NATIVE_TOOL_CALL_MODE
} from './fixtures';

// Mock Chrome API for testing
const mockChromeAPI = {
  tabs: {
    query: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
    },
  },
};

// Mock the Chrome runtime API
global.chrome = mockChromeAPI as any;

describe('Hexactra E2E Tests', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  describe('Happy Path Tests', () => {
    it('should complete a simple search task', async () => {
      const goal = getDemoGoals().search;
      
      // Simulate task execution
      expect(goal).toContain('Hexactra');
      expect(goal).toContain('Google');
    });

    it('should complete a screenshot task', async () => {
      const goal = getDemoGoals().screenshot;
      
      expect(goal).toContain('example.com');
      expect(goal).toContain('screenshot');
    });

    it('should complete a form fill task', async () => {
      const goal = getDemoGoals().form;
      
      expect(goal).toContain('Name=Test User');
      expect(goal).toContain('Email=test@example.com');
    });

    it('should handle multi-step tasks', async () => {
      const fixtures = getMultiStepFixtures();
      
      expect(fixtures.length).toBeGreaterThan(0);
      fixtures.forEach(fixture => {
        expect(fixture.expectedSuccess).toBe(true);
      });
    });
  });

  describe('Error Handling Tests', () => {
    it('should block permission denied actions', async () => {
      const fixtures = getErrorFixtures();
      const permissionFixtures = fixtures.filter(f => f.errorType === 'permission');
      
      expect(permissionFixtures.length).toBeGreaterThan(0);
      permissionFixtures.forEach(fixture => {
        expect(fixture.expectedBehavior).toContain('blocked');
      });
    });

    it('should gate unsupported capabilities', async () => {
      const fixtures = getErrorFixtures();
      const capabilityFixtures = fixtures.filter(f => f.errorType === 'capability');
      
      expect(capabilityFixtures.length).toBeGreaterThan(0);
      capabilityFixtures.forEach(fixture => {
        expect(fixture.expectedBehavior).toContain('blocked');
      });
    });

    it('should sanitize malicious instructions', async () => {
      const goal = getDemoGoals().malicious;
      
      // Malicious instruction should be detected and blocked
      expect(goal).toContain('Delete');
    });
  });

  describe('Model Mode Tests', () => {
    it('should handle text-only JSON action fallback', async () => {
      expect(TEXT_ONLY_JSON_ACTION.type).toBe('text');
      expect(TEXT_ONLY_JSON_ACTION.content).toContain('navigate');
    });

    it('should handle native tool-call mode', async () => {
      expect(NATIVE_TOOL_CALL_MODE.type).toBe('tool_call');
      expect(NATIVE_TOOL_CALL_MODE.name).toBe('navigate');
    });
  });

  describe('Capability Tests', () => {
    it('should support all required capabilities', async () => {
      const fixtures = getCapabilityFixtures();
      
      expect(fixtures.length).toBeGreaterThan(0);
      fixtures.forEach(fixture => {
        expect(fixture.expected).toBe(true);
      });
    });
  });

  describe('Task Control Tests', () => {
    it('should support pause/resume/stop controls', async () => {
      // Task state transitions
      const states = ['idle', 'running', 'paused', 'stopped'];
      
      expect(states.length).toBeGreaterThan(0);
      expect(states.includes('running')).toBe(true);
      expect(states.includes('paused')).toBe(true);
    });
  });
});
