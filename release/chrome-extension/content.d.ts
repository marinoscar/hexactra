/**
 * Type definitions for semantic snapshot data
 */
export interface ElementInfo {
    tagName: string;
    id?: string;
    className?: string;
    role?: string;
    text?: string;
    accessibleName?: string;
    visible: boolean;
    position?: {
        x: number;
        y: number;
    };
    attributes: Record<string, string>;
    childrenCount: number;
}
export interface DocumentSnapshot {
    url: string;
    title: string;
    elements: ElementInfo[];
}
/**
 * Get accessible DOM elements with semantic information
 */
export declare function getSemanticSnapshot(): DocumentSnapshot;
/**
 * Get stable selectors for elements
 *
 * Stable selectors:
 * - ID selector if available and unique
 * - Class-based selector with tag name
 * - nth-child fallback for uniqueness
 */
export declare function getStableSelector(element: Element): string | null;
/**
 * Check if element is a password field (excluded from snapshots)
 */
export declare function isPasswordField(element: Element): boolean;
/**
 * Check if element is interactable
 */
export declare function isInteractable(element: Element): boolean;
/**
 * Safely interact with an element
 */
export declare function interactWithElement(element: Element, action: 'click' | 'focus' | 'select'): boolean;
/**
 * Detect and report inaccessible frames
 */
export declare function detectInaccessibleFrames(): FrameInfo[];
/**
 * Type definitions
 */
export interface FrameInfo {
    src: string;
    accessible: boolean;
    reason?: string | null;
}
//# sourceMappingURL=content.d.ts.map