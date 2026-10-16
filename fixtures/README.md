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
