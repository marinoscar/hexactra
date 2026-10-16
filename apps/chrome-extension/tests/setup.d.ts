declare const mockChromeAPI: {
    runtime: {
        id: string;
        onMessage: {
            addListener: any;
        };
        sendMessage: any;
        onSuspend: {
            addListener: any;
        };
        onSuspendClosed: {
            addListener: any;
        };
        onStartup: {
            addListener: any;
        };
    };
    tabs: {
        query: any;
        create: any;
        update: any;
        remove: any;
        get: any;
    };
    scripting: {
        executeScript: any;
    };
    sidePanel: {
        open: any;
    };
    action: {
        onClicked: {
            addListener: any;
        };
    };
    storage: {
        local: {
            get: any;
            set: any;
            remove: any;
        };
        sync: {
            get: any;
            set: any;
            remove: any;
        };
    };
    windows: {
        WINDOW_ID_CURRENT: number;
    };
};
//# sourceMappingURL=setup.d.ts.map