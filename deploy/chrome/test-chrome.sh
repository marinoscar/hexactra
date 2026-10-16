#!/bin/bash
# Test Chrome runtime for Hexactra

set -e

echo "=== Testing Chrome Runtime ==="

# Check if Xvfb is installed
if ! command -v Xvfb &> /dev/null; then
    echo "ERROR: Xvfb not found. Please run install-chrome.sh first."
    exit 1
fi

# Check if Chrome is installed
if ! command -v google-chrome &> /dev/null && ! command -v chromium &> /dev/null; then
    echo "ERROR: Chrome/Chromium not found. Please run install-chrome.sh first."
    exit 1
fi

echo "Starting virtual display..."
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -auth /tmp/xvfb-auth.XXXXXX &
XVFB_PID=$!

# Wait for Xvfb to start
sleep 2

echo "Verifying display..."
if ! DISPLAY=:99 xset q &> /dev/null; then
    echo "ERROR: Failed to connect to virtual display"
    kill $XVFB_PID 2>/dev/null || true
    exit 1
fi

echo "Testing Chrome with virtual display..."
if command -v google-chrome &> /dev/null; then
    CHROME_CMD="google-chrome"
else
    CHROME_CMD="chromium"
fi

# Test Chrome in virtual display (without actually opening windows)
DISPLAY=:99 $CHROME_CMD --version
echo "Chrome version: $(DISPLAY=:99 $CHROME_CMD --version 2>&1 | head -1)"

# Clean up
echo "Stopping virtual display..."
kill $XVFB_PID 2>/dev/null || true

echo ""
echo "=== Chrome runtime test passed ==="
echo ""
echo "Next steps:"
echo "1. Start the Xvfb service: systemctl start xvfb"
echo "2. Start the Hexactra agent: systemctl start hexactra-agent"
echo "3. Verify the agent is running: systemctl status hexactra-agent"
