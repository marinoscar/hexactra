//! Hexactra Chrome extension - Content script for DOM observation
/**
 * Get accessible DOM elements with semantic information
 */
export function getSemanticSnapshot() {
    function getElementInfo(element) {
        // Skip non-interactable elements
        if (element instanceof HTMLElement) {
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height)
                return null;
            if (element.hidden)
                return null;
        }
        const tagName = element.tagName.toLowerCase();
        // Get semantic information
        const role = element.getAttribute('role') ||
            element.getAttribute('type') ||
            getImplicitRole(tagName, element);
        return {
            tagName,
            id: element.id || undefined,
            className: element.className || undefined,
            role: role ?? undefined,
            text: element.textContent?.trim().substring(0, 100) || undefined,
            accessibleName: element.getAttribute('aria-label') ||
                element.getAttribute('title') ||
                getAccessibleName(element) ||
                undefined,
            visible: isElementVisible(element),
            position: getElementPosition(element) ?? undefined,
            attributes: getRelevantAttributes(element),
            childrenCount: element.children.length,
        };
    }
    function getImplicitRole(tagName, element) {
        const roles = {
            'a': 'link',
            'button': 'button',
            'input': getInputType(element),
            'select': 'combobox',
            'textarea': 'textbox',
            'img': 'img',
            'article': 'article',
            'aside': 'complementary',
            'nav': 'navigation',
            'main': 'main',
            'section': 'region',
            'h1': 'heading',
            'h2': 'heading',
            'h3': 'heading',
            'h4': 'heading',
            'h5': 'heading',
            'h6': 'heading',
            'ul': 'list',
            'ol': 'list',
            'li': 'listitem',
        };
        return roles[tagName] || null;
    }
    function getInputType(element) {
        const type = element.type?.toLowerCase();
        switch (type) {
            case 'text':
            case 'search':
            case 'email':
            case 'url':
            case 'tel':
            case 'password':
                return 'textbox';
            case 'button':
            case 'submit':
            case 'reset':
                return 'button';
            case 'checkbox':
                return 'checkbox';
            case 'radio':
                return 'radio';
            case 'range':
                return 'slider';
            case 'color':
                return 'colorpicker';
            case 'date':
            case 'time':
            case 'datetime-local':
            case 'month':
            case 'week':
                return 'spinbutton';
            default:
                return 'input';
        }
    }
    function getAccessibleName(element) {
        // Try various accessible name algorithms
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel)
            return ariaLabel.trim();
        const ariaLabelledBy = element.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
            const labelElement = document.getElementById(ariaLabelledBy);
            if (labelElement)
                return labelElement.textContent?.trim() || null;
        }
        // For form elements, try title or surrounding label
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const id = element.id;
            if (id) {
                const label = document.querySelector(`label[for="${id}"]`);
                if (label)
                    return label.textContent?.trim() || null;
            }
        }
        // For images, try alt text
        if (element instanceof HTMLImageElement) {
            return element.alt || null;
        }
        return null;
    }
    function isElementVisible(element) {
        if (element instanceof HTMLElement) {
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden')
                return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }
        return true;
    }
    function getElementPosition(element) {
        if (element instanceof HTMLElement) {
            const rect = element.getBoundingClientRect();
            return { x: Math.round(rect.left), y: Math.round(rect.top) };
        }
        return null;
    }
    function getRelevantAttributes(element) {
        const attributes = {};
        const relevantAttrs = [
            'aria-pressed',
            'aria-checked',
            'aria-expanded',
            'aria-selected',
            'aria-disabled',
            'aria-required',
            'aria-invalid',
            'aria-describedby',
            'aria-controls',
            'href',
            'src',
            'value',
            'placeholder',
            'name',
            'type',
        ];
        relevantAttrs.forEach(attr => {
            const value = element.getAttribute(attr);
            if (value)
                attributes[attr] = value;
        });
        return attributes;
    }
    // Get document-level information
    const documentInfo = {
        url: window.location.href,
        title: document.title,
        elements: [],
    };
    // Collect elements - limit to prevent oversized messages
    const allElements = Array.from(document.querySelectorAll('*'));
    let count = 0;
    for (const element of allElements) {
        if (count >= 500)
            break; // Limit elements
        // Skip password fields
        if (isPasswordField(element))
            continue;
        const info = getElementInfo(element);
        if (info) {
            documentInfo.elements.push(info);
            count++;
        }
    }
    return documentInfo;
}
/**
 * Get stable selectors for elements
 *
 * Stable selectors:
 * - ID selector if available and unique
 * - Class-based selector with tag name
 * - nth-child fallback for uniqueness
 */
export function getStableSelector(element) {
    // Try ID first (most stable when unique)
    if (element.id) {
        const idSelector = `#${CSS.escape(element.id)}`;
        // Verify ID is unique in document
        const matches = document.querySelectorAll(idSelector);
        if (matches.length === 1 && matches[0] === element) {
            return idSelector;
        }
    }
    // Build selector from tag and classes
    const parts = [element.tagName.toLowerCase()];
    const className = element.className;
    if (className && typeof className === 'string') {
        const classes = className.trim().split(/\s+/).filter(c => c.length > 0);
        if (classes.length > 0) {
            // Use first two classes for specificity
            parts.push(`.${classes.slice(0, 2).map(c => CSS.escape(c)).join('.')}`);
        }
    }
    // Add nth-child if needed for uniqueness
    const parent = element.parentElement;
    if (parent) {
        const siblings = Array.from(parent.children).filter(e => e.tagName === element.tagName);
        if (siblings.length > 1) {
            const index = siblings.indexOf(element);
            parts.push(`:nth-child(${index + 1})`);
        }
    }
    return parts.join(' > ');
}
/**
 * Check if element is a password field (excluded from snapshots)
 */
export function isPasswordField(element) {
    if (element instanceof HTMLInputElement) {
        return element.type.toLowerCase() === 'password';
    }
    return false;
}
/**
 * Check if element is interactable
 */
export function isInteractable(element) {
    if (element instanceof HTMLElement) {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden')
            return false;
        if (style.pointerEvents === 'none')
            return false;
        // Check visibility
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return false;
    }
    return true;
}
/**
 * Safely interact with an element
 */
export function interactWithElement(element, action) {
    if (!isInteractable(element))
        return false;
    try {
        switch (action) {
            case 'click':
                if (element instanceof HTMLElement) {
                    element.click();
                }
                break;
            case 'focus':
                if (element instanceof HTMLElement) {
                    element.focus();
                }
                break;
            case 'select':
                if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                    element.select();
                }
                else if (element instanceof HTMLSelectElement) {
                    element.focus();
                }
                break;
        }
        return true;
    }
    catch (error) {
        console.error('Interaction failed:', error);
        return false;
    }
}
/**
 * Detect and report inaccessible frames
 */
export function detectInaccessibleFrames() {
    const frames = Array.from(document.querySelectorAll('iframe, frame'));
    const frameInfos = [];
    for (const frame of frames) {
        let accessible = true;
        let reason = null;
        try {
            // Try to access the iframe's contentDocument
            // This will throw if cross-origin
            const contentDoc = frame instanceof HTMLIFrameElement
                ? frame.contentDocument
                : frame.contentDocument;
            if (!contentDoc) {
                accessible = false;
                reason = 'No content document available';
            }
        }
        catch (error) {
            accessible = false;
            reason = 'Cross-origin restriction';
        }
        frameInfos.push({
            src: frame.getAttribute('src') || frame.getAttribute('name') || 'unnamed',
            accessible,
            reason,
        });
    }
    return frameInfos;
}
// Expose functions to window for background script access
window.getSemanticSnapshot = getSemanticSnapshot;
window.getStableSelector = getStableSelector;
window.isInteractable = isInteractable;
window.interactWithElement = interactWithElement;
window.detectInaccessibleFrames = detectInaccessibleFrames;
//# sourceMappingURL=content.js.map