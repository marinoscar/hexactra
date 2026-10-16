//! Test setup for Hexactra E2E tests

import { vi } from 'vitest';

// Mock Chrome API before any tests run
const mockChromeAPI = {
  runtime: {
    id: 'mock-extension-id',
    onMessage: {
      addListener: vi.fn(),
    },
    sendMessage: vi.fn(),
    onSuspend: {
      addListener: vi.fn(),
    },
    onSuspendClosed: {
      addListener: vi.fn(),
    },
    onStartup: {
      addListener: vi.fn(),
    },
  },
  tabs: {
    query: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    get: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(),
  },
  sidePanel: {
    open: vi.fn(),
  },
  action: {
    onClicked: {
      addListener: vi.fn(),
    },
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    sync: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
  },
  windows: {
    WINDOW_ID_CURRENT: -1,
  },
};

// Global mock for Chrome API
global.chrome = mockChromeAPI as any;

// Mock console methods to reduce noise in tests
(global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
