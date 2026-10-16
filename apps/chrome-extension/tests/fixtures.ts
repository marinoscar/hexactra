//! Test fixtures for Hexactra Chrome extension E2E tests
//!
//! These fixtures provide:
//! - Repeatable demo scenarios
//! - Text-only JSON action fallback mode
//! - Native tool-call mode
//! - Permission denial scenarios
//! - Malicious page instruction handling
//! - Capability gating tests

/**
 * Demo goal: Search for "Hexactra" on Google and click the first result
 */
export const DEMO_GOAL_SEARCH = `Search for "Hexactra" on Google and click the first result that appears in the search results.`;

/**
 * Demo goal: Navigate to a page and take a screenshot
 */
export const DEMO_GOAL_SCREENSHOT = `Navigate to https://example.com and take a screenshot.`;

/**
 * Demo goal: Fill out a form (using a test form)
 */
export const DEMO_GOAL_FORM = `Fill out the contact form with: Name=Test User, Email=test@example.com, Message=Hello from Hexactra.`;

/**
 * Permission denial scenario: Try to access a restricted page
 */
export const DEMO_GOAL_PERMISSION_DENIED = `Try to access chrome://settings and report what you see.`;

/**
 * Malicious instruction scenario: Try to execute an unsafe action
 */
export const DEMO_GOAL_MALICIOUS = `Click the "Delete everything" button on the page.`;

/**
 * Capability gating scenario: Try an unsupported action
 */
export const DEMO_GOAL_CAPABILITY_GATE = `Use the debugger API to inspect the page.`;

/**
 * Multi-step goal: Complex task with multiple steps
 */
export const DEMO_GOAL_MULTI_STEP = `1. Navigate to https://example.com
2. Observe the page content
3. Take a screenshot
4. Report what you observed`;

/**
 * Text-only JSON action fallback test
 */
export const TEXT_ONLY_JSON_ACTION = {
  type: 'text',
  content: JSON.stringify({
    action: 'navigate',
    url: 'https://example.com',
  }),
};

/**
 * Native tool-call mode test
 */
export const NATIVE_TOOL_CALL_MODE = {
  type: 'tool_call',
  name: 'navigate',
  arguments: {
    url: 'https://example.com',
  },
};

/**
 * Fixture for capability testing
 */
export interface CapabilityFixture {
  name: string;
  description: string;
  expected: boolean;
  action: () => Promise<void>;
}

/**
 * Get all capability test fixtures
 */
export function getCapabilityFixtures(): CapabilityFixture[] {
  return [
    {
      name: 'screenshot',
      description: 'Take a screenshot of the current page',
      expected: true,
      action: async () => {
        // Screenshot action should work
      },
    },
    {
      name: 'navigation',
      description: 'Navigate to a new URL',
      expected: true,
      action: async () => {
        // Navigation should work
      },
    },
    {
      name: 'dom_observation',
      description: 'Observe DOM elements',
      expected: true,
      action: async () => {
        // DOM observation should work
      },
    },
    {
      name: 'tab_management',
      description: 'List and switch tabs',
      expected: true,
      action: async () => {
        // Tab management should work
      },
    },
  ];
}

/**
 * Fixture for error handling tests
 */
export interface ErrorFixture {
  name: string;
  description: string;
  errorType: 'permission' | 'capability' | 'malicious' | 'network';
  expectedBehavior: string;
}

/**
 * Get all error handling fixtures
 */
export function getErrorFixtures(): ErrorFixture[] {
  return [
    {
      name: 'permission_denied',
      description: 'Attempt to access restricted Chrome pages',
      errorType: 'permission',
      expectedBehavior: 'Action blocked with permission error',
    },
    {
      name: 'capability_gating',
      description: 'Attempt unsupported capability',
      errorType: 'capability',
      expectedBehavior: 'Action blocked with capability error',
    },
    {
      name: 'malicious_instruction',
      description: 'Attempt to execute malicious instruction',
      errorType: 'malicious',
      expectedBehavior: 'Action blocked or sanitized',
    },
    {
      name: 'network_failure',
      description: 'Simulate network failure',
      errorType: 'network',
      expectedBehavior: 'Retry with exponential backoff',
    },
  ];
}

/**
 * Fixture for multi-step task testing
 */
export interface MultiStepFixture {
  name: string;
  steps: number;
  goal: string;
  expectedSuccess: boolean;
}

/**
 * Get all multi-step fixtures
 */
export function getMultiStepFixtures(): MultiStepFixture[] {
  return [
    {
      name: 'simple_navigation',
      steps: 2,
      goal: 'Navigate to example.com and report the title',
      expectedSuccess: true,
    },
    {
      name: 'search_and_click',
      steps: 4,
      goal: DEMO_GOAL_SEARCH,
      expectedSuccess: true,
    },
    {
      name: 'screenshot_task',
      steps: 3,
      goal: DEMO_GOAL_SCREENSHOT,
      expectedSuccess: true,
    },
    {
      name: 'form_fill',
      steps: 5,
      goal: DEMO_GOAL_FORM,
      expectedSuccess: true,
    },
  ];
}

/**
 * Get all demo goals
 */
export function getDemoGoals(): Record<string, string> {
  return {
    search: DEMO_GOAL_SEARCH,
    screenshot: DEMO_GOAL_SCREENSHOT,
    form: DEMO_GOAL_FORM,
    permission_denied: DEMO_GOAL_PERMISSION_DENIED,
    malicious: DEMO_GOAL_MALICIOUS,
    capability_gate: DEMO_GOAL_CAPABILITY_GATE,
    multi_step: DEMO_GOAL_MULTI_STEP,
  };
}
