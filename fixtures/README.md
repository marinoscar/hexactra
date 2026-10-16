# Browser Fixture Site

This directory contains a deterministic static HTML site for testing browser automation.

## Structure

- `index.html` - Main page with navigation, forms, tabs, and challenges
- `frame1.html` - First nested iframe
- `frame2.html` - Second nested iframe

## Features

### Navigation
- Home, Forms, Tabs, Frames, and Challenges pages

### Forms
- Simple text input
- Login form (email + password)
- Checkbox options

### Tabs
- Three tabbed content sections

### Nested Frames
- Two iframes with their own content and buttons

### Challenges
- OTP verification (accepts any 6-digit number)
- Approval button (simulates human-in-the-loop approval)
- Delayed action (shows loading state)
- Conditional visibility toggle

## Usage

1. Start a local server:
   ```bash
   cd fixtures
   python3 -m http.server 8000
   ```

2. Open in browser: `http://localhost:8000`

3. Test automation scenarios:
   - Navigate between pages
   - Fill and submit forms
   - Switch tabs
   - Interact with iframe content
   - Handle OTP challenges
   - Trigger approval flows

## Testing Scenarios

1. **Basic Navigation**: Click each nav button
2. **Form Filling**: Fill inputs and submit
3. **Tab Switching**: Click tab buttons
4. **Frame Interaction**: Access iframe elements
5. **OTP Flow**: Enter 6-digit OTP
6. **Approval Flow**: Click approval button
7. **Delayed Action**: Wait for delayed response
8. **Conditional Content**: Toggle visibility

## Deterministic Workflow Tests

The `tests/browser/deterministic.spec.js` file contains comprehensive tests that verify:

- **Reproducible scripted flow**: Same actions produce same results
- **Element state instrumentation**: Can read/write all form fields deterministically
- **Tab management**: Opening, switching, and closing tabs works reliably
- **Frame interaction**: Nested iframes are accessible and controllable
- **Recovery scenarios**: Page refresh, navigation history, error handling
- **Performance**: Actions complete within expected time limits

### Test Categories

1. **Basic Navigation Flow**
   - Page loads correctly
   - Navigation between pages is deterministic
   - Elements are found by stable selectors

2. **Form Interactions**
   - Text inputs can be filled and verified
   - Checkboxes can be checked/unchecked
   - Form submission works reliably

3. **Tab Management**
   - Tab switching is deterministic
   - State persists across tab changes
   - Navigation history works correctly

4. **Frame Interaction**
   - Nested iframes are accessible
   - Elements in frames can be interacted with
   - Frame content is isolated properly

5. **Challenge Handling**
   - OTP verification accepts valid inputs
   - Delayed actions complete within expected time
   - Conditional visibility toggles correctly

6. **Recovery Scenarios**
   - Page refresh doesn't break navigation
   - Navigation history works correctly
   - Missing elements are handled gracefully

7. **Action Instrumentation**
   - Element states can be captured deterministically
   - Stable selectors work correctly
   - Interactions complete quickly

## Running Tests

```bash
# Start the fixture server
cd fixtures
python3 -m http.server 8000

# In another terminal, run tests
cd tests/browser
npm test
```

## Integration with Chrome Extension

The fixture site is designed to work with the Hexactra Chrome extension:

1. Load the fixture site in Chrome
2. Open the extension's Side Panel
3. Use the extension to:
   - Observe DOM elements (semantic snapshots)
   - Click elements by selector
   - Type into form fields
   - Take screenshots
   - Switch between tabs

## Determinism Guarantees

The fixture site provides these determinism guarantees:

- **Stable selectors**: Elements have predictable IDs and classes
- **Consistent state**: No random elements or changing content
- **Predictable timing**: Actions complete within known time bounds
- **Reproducible results**: Same inputs produce same outputs
