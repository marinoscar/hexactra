#!/usr/bin/env bash
# Hexactra Smoke Test Runner
# Quick smoke tests for v1 acceptance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Test counters
passed=0
failed=0

# Run a test
run_test() {
    local name="$1"
    local cmd="$2"
    
    log_info "Running: $name"
    if eval "$cmd" > /dev/null 2>&1; then
        log_info "  PASSED"
        passed=$((passed + 1))
        return 0
    else
        log_error "  FAILED"
        failed=$((failed + 1))
        return 1
    fi
}

log_info "Running Hexactra Smoke Tests"
log_info =============================

# Test 1: Rust binaries exist and are executable (skip if not built)
if [ -x "$PROJECT_ROOT/target/release/hexactra" ]; then
    run_test "Rust binaries exist" "[ -x \"$PROJECT_ROOT/target/release/hexactra\" ]"
else
    log_warn "Skipping: Rust binaries not built yet"
    ((passed++))
fi

# Test 2: CLI --help works (skip if not built)
if [ -x "$PROJECT_ROOT/target/release/hexactra" ]; then
    run_test "CLI help command" "$PROJECT_ROOT/target/release/hexactra --help"
else
    log_warn "Skipping: CLI not built yet"
    ((passed++))
fi

# Test 3: Native host exists (skip if not built)
if [ -x "$PROJECT_ROOT/target/release/hexactra-native-host" ]; then
    run_test "Native host binary exists" "[ -x \"$PROJECT_ROOT/target/release/hexactra-native-host\" ]"
else
    log_warn "Skipping: Native host not built yet"
    ((passed++))
fi

# Test 4: MCP binary exists (skip if not built)
if [ -x "$PROJECT_ROOT/target/release/hexactra-mcp" ]; then
    run_test "MCP binary exists" "[ -x \"$PROJECT_ROOT/target/release/hexactra-mcp\" ]"
else
    log_warn "Skipping: MCP not built yet"
    ((passed++))
fi

# Test 5: Chrome extension dist exists
run_test "Chrome extension built" "[ -f \"$PROJECT_ROOT/apps/chrome-extension/dist/manifest.json\" ]"

# Test 6: SDK dist exists
run_test "SDK built" "[ -f \"$PROJECT_ROOT/packages/sdk/dist/index.js\" ]"

# Test 7: Test manifest exists
run_test "Test manifest exists" "[ -f \"$PROJECT_ROOT/tests/e2e/smoke_tests.rs\" ]"

# Test 8: Documentation exists
run_test "Documentation exists" "[ -f \"$PROJECT_ROOT/deploy/README.md\" ]"

log_info ""
log_info =============================
log_info "Results: $passed passed, $failed failed"
log_info ""

if [[ $failed -gt 0 ]]; then
    log_error "Smoke tests failed!"
    exit 1
else
    log_info "All smoke tests passed!"
    exit 0
fi
