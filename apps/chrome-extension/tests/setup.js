"use strict";
//! Test setup for Hexactra E2E tests
// Mock Chrome API before any tests run
const mockChromeAPI = {
    runtime: {
        id: 'mock-extension-id',
        onMessage: {
            addListener: jest.fn(),
        },
        sendMessage: jest.fn(),
        onSuspend: {
            addListener: jest.fn(),
        },
        onSuspendClosed: {
            addListener: jest.fn(),
        },
        onStartup: {
            addListener: jest.fn(),
        },
    },
    tabs: {
        query: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        remove: jest.fn(),
        get: jest.fn(),
    },
    scripting: {
        executeScript: jest.fn(),
    },
    sidePanel: {
        open: jest.fn(),
    },
    action: {
        onClicked: {
            addListener: jest.fn(),
        },
    },
    storage: {
        local: {
            get: jest.fn(),
            set: jest.fn(),
            remove: jest.fn(),
        },
        sync: {
            get: jest.fn(),
            set: jest.fn(),
            remove: jest.fn(),
        },
    },
    windows: {
        WINDOW_ID_CURRENT: -1,
    },
};
// Global mock for Chrome API
global.chrome = mockChromeAPI;
// Mock console methods to reduce noise in tests
global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
// Cleanup after each test
afterEach(() => {
    jest.clearAllMocks();
});
//# sourceMappingURL=setup.js.map