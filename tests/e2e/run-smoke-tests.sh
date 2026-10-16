#!/bin/bash
# E03 Smoke Test Script
# Tests the end-to-end functionality of Hexactra unattended Linux host

set -e

echo "=========================================="
echo "Hexactra E03 Smoke Test Suite"
echo "=========================================="
echo ""

# Test 1: Verify Rust build
echo "[TEST 1] Verifying Rust build..."
if ! cargo build --package hexactra-core > /dev/null 2>&1; then
    echo "FAIL: Rust build failed"
    exit 1
fi
echo "PASS: Rust build successful"
echo ""

# Test 2: Run unit tests
echo "[TEST 2] Running unit tests..."
if ! cargo test --package hexactra-core --lib > /dev/null 2>&1; then
    echo "FAIL: Unit tests failed"
    exit 1
fi
echo "PASS: All unit tests passed"
echo ""

# Test 3: Verify profile registry
echo "[TEST 3] Testing profile registry..."
if ! cargo test --package hexactra-core profile > /dev/null 2>&1; then
    echo "FAIL: Profile registry tests failed"
    exit 1
fi
echo "PASS: Profile registry tests passed"
echo ""

# Test 4: Verify viewer module
echo "[TEST 4] Testing viewer module..."
if ! cargo test --package hexactra-core viewer > /dev/null 2>&1; then
    echo "FAIL: Viewer tests failed"
    exit 1
fi
echo "PASS: Viewer tests passed"
echo ""

# Test 5: Verify chrome module
echo "[TEST 5] Testing chrome module..."
if ! cargo test --package hexactra-agent chrome > /dev/null 2>&1; then
    echo "FAIL: Chrome tests failed"
    exit 1
fi
echo "PASS: Chrome tests passed"
echo ""

# Test 6: Verify systemd service file
echo "[TEST 6] Verifying systemd service file..."
if [ ! -f "deploy/systemd/hexactra-agent.service" ]; then
    echo "FAIL: Systemd service file not found"
    exit 1
fi
echo "PASS: Systemd service file exists"
echo ""

# Test 7: Verify Chrome install script
echo "[TEST 7] Verifying Chrome install script..."
if [ ! -f "deploy/chrome/install-chrome.sh" ]; then
    echo "FAIL: Chrome install script not found"
    exit 1
fi
echo "PASS: Chrome install script exists"
echo ""

# Test 8: Verify agent config example
echo "[TEST 8] Verifying agent config example..."
if [ ! -f "config/agent.toml.example" ]; then
    echo "FAIL: Agent config example not found"
    exit 1
fi
echo "PASS: Agent config example exists"
echo ""

# Test 9: Verify Chrome config example
echo "[TEST 9] Verifying Chrome config example..."
if [ ! -f "deploy/chrome/chrome-config.toml.example" ]; then
    echo "FAIL: Chrome config example not found"
    exit 1
fi
echo "PASS: Chrome config example exists"
echo ""

# Test 10: Verify agent binary can be built
echo "[TEST 10] Building agent binary..."
if ! cargo build --package hexactra-agent --bin hexactra-agent > /dev/null 2>&1; then
    echo "FAIL: Agent binary build failed"
    exit 1
fi
echo "PASS: Agent binary built successfully"
echo ""

echo "=========================================="
echo "All E03 smoke tests passed!"
echo "=========================================="
echo ""
echo "Summary:"
echo "- Rust build: OK"
echo "- Unit tests: OK"
echo "- Profile registry: OK"
echo "- Viewer module: OK"
echo "- Chrome module: OK"
echo "- Systemd service: OK"
echo "- Chrome install script: OK"
echo "- Config examples: OK"
echo "- Agent binary: OK"
echo ""
echo "Next steps:"
echo "1. Run deploy/chrome/install-chrome.sh to install Chrome"
echo "2. Copy deploy/systemd/hexactra-agent.service to /etc/systemd/system/"
echo "3. Start the agent: systemctl start hexactra-agent"
