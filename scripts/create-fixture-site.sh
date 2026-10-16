#!/usr/bin/env bash
# Deterministic browser fixture site generator
# Creates a static HTML site with forms, SPA nav, tabs, nested frames,
# OTP and approval challenges for testing

set -e

OUTPUT_DIR="${1:-fixtures}"

echo "Creating deterministic browser fixture site in $OUTPUT_DIR..."

mkdir -p "$OUTPUT_DIR"

# Create main index page with navigation and forms
cat > "$OUTPUT_DIR/index.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Browser Fixture Site</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .nav { display: flex; gap: 10px; margin-bottom: 20px; }
        .nav button { padding: 8px 16px; cursor: pointer; }
        .content { min-height: 300px; border: 1px solid #ccc; padding: 20px; }
        .form-section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; }
        .tabs { display: flex; gap: 5px; margin-bottom: 15px; }
        .tabs button { padding: 8px 16px; cursor: pointer; }
        .tab-content { display: none; padding: 15px; border: 1px solid #ccc; }
        .tab-content.active { display: block; }
        iframe { width: 100%; height: 200px; border: 1px solid #999; margin-top: 20px; }
    </style>
</head>
<body>
    <h1>Browser Fixture Site</h1>
    
    <!-- Navigation -->
    <div class="nav">
        <button onclick="showPage('home')">Home</button>
        <button onclick="showPage('forms')">Forms</button>
        <button onclick="showPage('tabs')">Tabs</button>
        <button onclick="showPage('frames')">Frames</button>
        <button onclick="showPage('challenges')">Challenges</button>
    </div>

    <!-- Home Page -->
    <div id="home" class="content">
        <h2>Home</h2>
        <p>Welcome to the browser fixture site.</p>
        <p>Use this site to test browser automation capabilities.</p>
        <button id="home-btn">Home Button</button>
    </div>

    <!-- Forms Page -->
    <div id="forms" class="content" style="display: none;">
        <h2>Forms</h2>
        <div class="form-section">
            <h3>Simple Form</h3>
            <input type="text" id="simple-input" placeholder="Enter text">
            <button onclick="submitForm('simple')">Submit</button>
        </div>
        
        <div class="form-section">
            <h3>Login Form</h3>
            <input type="email" id="login-email" placeholder="Email">
            <input type="password" id="login-password" placeholder="Password">
            <button onclick="submitForm('login')">Login</button>
        </div>
        
        <div class="form-section">
            <h3>Checkbox Form</h3>
            <label><input type="checkbox" id="checkbox-1"> Option 1</label><br>
            <label><input type="checkbox" id="checkbox-2"> Option 2</label><br>
            <label><input type="checkbox" id="checkbox-3"> Option 3</label>
        </div>
    </div>

    <!-- Tabs Page -->
    <div id="tabs" class="content" style="display: none;">
        <h2>Tabs</h2>
        <div class="tabs">
            <button onclick="showTab('tab1', this)">Tab 1</button>
            <button onclick="showTab('tab2', this)">Tab 2</button>
            <button onclick="showTab('tab3', this)">Tab 3</button>
        </div>
        <div id="tab1" class="tab-content active">
            <p>This is tab 1 content.</p>
        </div>
        <div id="tab2" class="tab-content">
            <p>This is tab 2 content.</p>
        </div>
        <div id="tab3" class="tab-content">
            <p>This is tab 3 content.</p>
        </div>
    </div>

    <!-- Frames Page -->
    <div id="frames" class="content" style="display: none;">
        <h2>Nested Frames</h2>
        <p>Parent page content</p>
        
        <iframe src="frame1.html" title="Frame 1"></iframe>
        <iframe src="frame2.html" title="Frame 2"></iframe>
    </div>

    <!-- Challenges Page -->
    <div id="challenges" class="content" style="display: none;">
        <h2>Challenges</h2>
        
        <!-- OTP Challenge -->
        <div class="form-section">
            <h3>OTP Verification</h3>
            <p>Enter the OTP sent to your phone (use any 6-digit number)</p>
            <input type="text" id="otp-input" maxlength="6" placeholder="123456">
            <button onclick="verifyOtp()">Verify OTP</button>
        </div>

        <!-- Approval Challenge -->
        <div class="form-section">
            <h3>Approval Required</h3>
            <p>This action requires human approval:</p>
            <button id="approval-btn">Request Approval</button>
        </div>

        <!-- Delayed Action -->
        <div class="form-section">
            <h3>Delayed Response</h3>
            <button onclick="delayedAction()">Trigger Delayed Action</button>
            <span id="delayed-result" style="margin-left: 10px;"></span>
        </div>

        <!-- Conditional Content -->
        <div class="form-section">
            <h3>Conditional Visibility</h3>
            <button onclick="toggleConditional()">Toggle Content</button>
            <div id="conditional-content" style="display: none; margin-top: 10px;">
                <p>This content appears after clicking the button.</p>
            </div>
        </div>
    </div>

    <script>
        // Navigation
        function showPage(pageId) {
            document.querySelectorAll('.content').forEach(c => c.style.display = 'none');
            document.getElementById(pageId).style.display = 'block';
        }

        // Tabs
        function showTab(tabId, btn) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.getElementById(tabId).classList.add('active');
            document.querySelectorAll('.tabs button').forEach(b => b.style.background = '');
            btn.style.background = '#007bff';
            btn.style.color = 'white';
        }

        // Forms
        function submitForm(type) {
            console.log('Form submitted:', type);
            alert('Form submitted: ' + type);
        }

        // OTP
        function verifyOtp() {
            const otp = document.getElementById('otp-input').value;
            if (otp.length === 6 && /^\d+$/.test(otp)) {
                alert('OTP verified successfully!');
            } else {
                alert('Invalid OTP. Please enter a 6-digit number.');
            }
        }

        // Approval
        document.getElementById('approval-btn').onclick = function() {
            console.log('Approval requested');
            this.disabled = true;
            setTimeout(() => {
                alert('Approval granted (simulated)');
                this.disabled = false;
            }, 1000);
        };

        // Delayed action
        function delayedAction() {
            const result = document.getElementById('delayed-result');
            result.textContent = 'Processing...';
            setTimeout(() => {
                result.textContent = 'Done!';
            }, 2000);
        }

        // Conditional content
        function toggleConditional() {
            const content = document.getElementById('conditional-content');
            content.style.display = content.style.display === 'none' ? 'block' : 'none';
        }
    </script>
</body>
</html>
EOF

# Create frame1.html (nested iframe)
cat > "$OUTPUT_DIR/frame1.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Frame 1</title>
    <style>
        body { padding: 20px; }
    </style>
</head>
<body>
    <h3>Frame 1 Content</h3>
    <p>This is the first nested iframe.</p>
    <input type="text" id="frame1-input" placeholder="Input in frame 1">
    <button onclick="alert('Button in frame 1 clicked')">Frame 1 Button</button>
</body>
</html>
EOF

# Create frame2.html (nested iframe)
cat > "$OUTPUT_DIR/frame2.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Frame 2</title>
    <style>
        body { padding: 20px; }
    </style>
</head>
<body>
    <h3>Frame 2 Content</h3>
    <p>This is the second nested iframe.</p>
    <button id="frame2-btn">Click me</button>
    
    <script>
        document.getElementById('frame2-btn').onclick = function() {
            alert('Button in frame 2 clicked!');
        };
    </script>
</body>
</html>
EOF

# Create README for fixtures
cat > "$OUTPUT_DIR/README.md" << 'EOF'
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
EOF

echo "Fixture site created successfully in $OUTPUT_DIR"
echo ""
echo "To start the fixture server:"
echo "  cd $OUTPUT_DIR && python3 -m http.server 8000"
echo "Then open http://localhost:8000 in Chrome"