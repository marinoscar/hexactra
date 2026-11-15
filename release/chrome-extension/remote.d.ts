export declare const NATIVE_HOST_NAME = "com.hexactra.nativehost";
export type RemoteAction = {
    type: 'navigate';
    url: string;
    tab_id?: number;
} | {
    type: 'click';
    selector: string;
    tab_id?: number;
} | {
    type: 'type';
    selector: string;
    text: string;
    clear?: boolean;
    submit?: boolean;
    tab_id?: number;
} | {
    type: 'press';
    key: string;
    selector?: string;
    tab_id?: number;
} | {
    type: 'scroll';
    dx?: number;
    dy?: number;
    selector?: string;
    tab_id?: number;
} | {
    type: 'screenshot';
    tab_id?: number;
} | {
    type: 'text';
    selector?: string;
    max_chars?: number;
    tab_id?: number;
} | {
    type: 'elements';
    max_elements?: number;
    tab_id?: number;
} | {
    type: 'wait_for';
    selector: string;
    timeout_ms?: number;
    tab_id?: number;
} | {
    type: 'tabs';
} | {
    type: 'new_tab';
    url?: string;
} | {
    type: 'activate_tab';
    tab_id: number;
} | {
    type: 'close_tab';
    tab_id: number;
} | {
    type: 'back';
    tab_id?: number;
} | {
    type: 'forward';
    tab_id?: number;
} | {
    type: 'reload';
    tab_id?: number;
};
export interface BridgeRequest {
    type: 'request';
    id: string;
    action: RemoteAction;
    deadline_ms?: number;
}
export interface BridgeResponse {
    type: 'response';
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}
/** Error raised for an action that cannot be performed. */
export declare class ActionError extends Error {
}
/** Only web pages may be opened remotely (mirrors check_navigable_url in Rust). */
export declare function isNavigableUrl(url: string): boolean;
/** Wait until a tab finishes loading (status "complete") or the deadline passes. */
export declare function waitForTabComplete(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab>;
export declare function pageClick(selector: string): {
    __error: string;
} | {
    __error?: undefined;
};
export declare function pageType(selector: string, text: string, clear: boolean, submit: boolean): {
    __error: string;
} | {
    __error?: undefined;
};
export declare function pagePress(key: string, selector: string | null): {
    __error: string;
} | {
    __error?: undefined;
};
export declare function pageScroll(dx: number, dy: number, selector: string | null): {
    __error: string;
    x?: undefined;
    y?: undefined;
} | {
    x: number;
    y: number;
    __error?: undefined;
};
export declare function pageText(selector: string | null, maxChars: number): {
    __error: string;
    text?: undefined;
    truncated?: undefined;
    url?: undefined;
    title?: undefined;
} | {
    text: string;
    truncated: boolean;
    url: string;
    title: string;
    __error?: undefined;
};
export declare function pageHistoryGo(delta: number): {
    __error: string;
} | {
    __error?: undefined;
};
export declare function pageExists(selector: string): {
    found: boolean;
};
export declare function pageElements(max: number): {
    elements: Record<string, unknown>[];
    url: string;
    title: string;
};
/** Execute one remote action. Throws ActionError on failure. */
export declare function executeAction(action: RemoteAction, deadline: number): Promise<unknown>;
/** Handle one request frame and build the response frame. */
export declare function handleRequest(req: BridgeRequest): Promise<BridgeResponse>;
/** Close every window; Chromium then exits normally. */
export declare function closeAllWindows(): Promise<number>;
/** Start the remote-control bridge once per service-worker lifetime. */
export declare function startRemoteBridge(): void;
//# sourceMappingURL=remote.d.ts.map