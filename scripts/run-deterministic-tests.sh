#!/usr/bin/env bash
# Deterministic workflow test runner
# Tests the Chrome extension's deterministic workflow capabilities

set -e

echo "=== Hexactra Deterministic Workflow Tests ==="
echo ""

# Configuration
FIXTURE_PORT="${FIXTURE_PORT:-8000}"
FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fixtures"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/browser"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    
    # Kill fixture server if running
    if [ -n "$FIXTURE_PID" ]; then
        kill $FIXTURE_PID 2>/dev/null || true
    fi
    
    # Kill Playwright browsers
    pkill -f "playwright" 2>/dev/null || true
}

trap cleanup EXIT

# Check prerequisites
check_prerequisites() {
    echo "Checking prerequisites..."
    
    # Check if Python is available
    if ! command -v python3 &> /dev/null; then
        echo -e "${RED}Error: python3 is required${NC}"
        exit 1
    fi
    
    # Check if Node.js is available
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: node is required${NC}"
        exit 1
    fi
    
    # Check if pnpm is available
    if ! command -v pnpm &> /dev/null; then
        echo -e "${YELLOW}Warning: pnpm not found, trying npm${NC}"
        if ! command -v npm &> /dev/null; then
            echo -e "${RED}Error: npm is required${NC}"
            exit 1
        fi
    fi
    
    echo -e "${GREEN}Prerequisites check passed${NC}"
}

# Start fixture server
start_fixture_server() {
    echo ""
    echo "Starting fixture server on port $FIXTURE_PORT..."
    
    cd "$FIXTURE_DIR"
    python3 -m http.server "$FIXTURE_PORT" &
    FIXTURE_PID=$!
    
    # Wait for server to be ready
    local max_attempts=10
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -s "http://localhost:$FIXTURE_PORT/index.html" > /dev/null 2>&1; then
            echo -e "${GREEN}Fixture server started successfully${NC}"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 0.5
    done
    
    echo -e "${RED}Error: Fixture server failed to start${NC}"
    return 1
}

# Install test dependencies
install_test_deps() {
    echo ""
    echo "Installing test dependencies..."
    
    cd "$TESTS_DIR"
    
    if command -v pnpm &> /dev/null; then
        pnpm install
    else
        npm install
    fi
    
    # Install Playwright browsers
    if command -v pnpm &> /dev/null; then
        pnpm exec playwright install chromium
    else
        npx playwright install chromium
    fi
    
    echo -e "${GREEN}Test dependencies installed${NC}"
}

# Run deterministic tests
run_deterministic_tests() {
    echo ""
    echo "=== Running Deterministic Workflow Tests ==="
    echo ""
    
    cd "$TESTS_DIR"
    
    # Check if fixture site is accessible
    if ! curl -s "http://localhost:$FIXTURE_PORT/index.html" > /dev/null 2>&1; then
        echo -e "${RED}Error: Fixture site not accessible at http://localhost:$FIXTURE_PORT${NC}"
        exit 1
    fi
    
    # Run tests
    if command -v pnpm &> /dev/null; then
        pnpm exec playwright test deterministic.spec.js
    else
        npx playwright test deterministic.spec.js
    fi
    
    local exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        echo ""
        echo -e "${GREEN}=== All Deterministic Tests Passed ===${NC}"
    else
        echo ""
        echo -e "${RED}=== Some Tests Failed ===${NC}"
    fi
    
    return $exit_code
}

# Generate test report
generate_report() {
    echo ""
    echo "=== Test Report ==="
    echo ""
    echo "Fixture Site: http://localhost:$FIXTURE_PORT"
    echo "Test Directory: $TESTS_DIR"
    echo "Test File: deterministic.spec.js"
    echo ""
    echo "Test Categories:"
    echo "  - Basic Navigation Flow"
    echo "  - Form Interactions"
    echo "  - Tab Management"
    echo "  - Frame Interaction"
    echo "  - Challenge Handling"
    echo "  - Recovery Scenarios"
    echo "  - Action Instrumentation"
    echo "  - Error Handling"
    echo "  - Performance"
    echo ""
}

# Main execution
main() {
    echo "Hexactra Deterministic Workflow Test Suite"
    echo "==========================================="
    echo ""
    
    # Parse command line arguments
    case "${1:-all}" in
        check)
            check_prerequisites
            ;;
        server)
            start_fixture_server
            ;;
        install)
            install_test_deps
            ;;
        run)
            check_prerequisites
            start_fixture_server
            install_test_deps
            run_deterministic_tests
            generate_report
            ;;
        report)
            generate_report
            ;;
        all)
            check_prerequisites
            start_fixture_server
            install_test_deps
            run_deterministic_tests
            generate_report
            ;;
        *)
            echo "Usage: $0 {check|server|install|run|report|all}"
            echo ""
            echo "Commands:"
            echo "  check    - Check prerequisites"
            echo "  server   - Start fixture server only"
            echo "  install  - Install test dependencies"
            echo "  run      - Run all tests"
            echo "  report   - Generate test report"
            echo "  all      - Run everything (default)"
            exit 1
            ;;
    esac
}

main "$@"
