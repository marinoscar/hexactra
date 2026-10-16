#!/bin/bash
# E2E test runner for Hexactra Chrome extension

set -e

echo "Running Hexactra E2E tests..."

# Navigate to the chrome-extension directory
cd "$(dirname "$0")/.."

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    pnpm install
fi

# Run tests
echo "Running E2E test suite..."
pnpm run test

# Check test results
if [ $? -eq 0 ]; then
    echo ""
    echo "========================================="
    echo "All E2E tests passed!"
    echo "========================================="
    echo ""
    echo "Next steps:"
    echo "1. Load the extension in Chrome"
    echo "2. Follow the DEMO_GUIDE.md for usage examples"
    echo "3. Test with your own API endpoint"
else
    echo ""
    echo "========================================="
    echo "Some tests failed. Please review the output above."
    echo "========================================="
    exit 1
fi
