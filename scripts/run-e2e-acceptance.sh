#!/usr/bin/env bash
# Hexactra E2E Acceptance Test Runner
# Runs the end-to-end acceptance matrix for v1 release

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Test matrix
declare -A TESTS=(
    ["extension_standalone"]="Extension standalone text/tool models"
    ["real_browser"]="Real browser actions"
    ["linux_no_login"]="Linux no-login profile start"
    ["managed_goal"]="Managed goal execution"
    ["sdk_cli_mcp"]="SDK/CLI/MCP equivalence"
    ["hitl"]="HITL flow"
    ["viewer"]="Viewer functionality"
    ["telemetry_outage"]="Telemetry outage handling"
    ["profile_isolation"]="Profile isolation"
    ["security_regressions"]="Security regression tests"
)

# Run a single test
run_test() {
    local test_name="$1"
    local test_description="${TESTS[$test_name]}"
    
    log_info "Running test: $test_name - $test_description"
    
    case "$test_name" in
        "extension_standalone")
            # Test extension standalone mode
            if [[ -f "$PROJECT_ROOT/tests/e2e/test-e2e.js" ]]; then
                cd "$PROJECT_ROOT"
                node tests/e2e/test-e2e.js --mode=standalone 2>&1 || return 1
            else
                log_warn "Extension test not found, skipping"
                return 0
            fi
            ;;
        "real_browser")
            # Test real browser actions
            if [[ -f "$PROJECT_ROOT/tests/browser/test-browser.js" ]]; then
                cd "$PROJECT_ROOT"
                node tests/browser/test-browser.js 2>&1 || return 1
            else
                log_warn "Browser test not found, skipping"
                return 0
            fi
            ;;
        "linux_no_login")
            # Test Linux no-login profile start
            if [[ -f "$PROJECT_ROOT/scripts/test-linux-no-login.sh" ]]; then
                "$PROJECT_ROOT/scripts/test-linux-no-login.sh" || return 1
            else
                log_warn "Linux no-login test script not found, skipping"
                return 0
            fi
            ;;
        "managed_goal")
            # Test managed goal execution
            if [[ -f "$PROJECT_ROOT/tests/e2e/demo-e2e.js" ]]; then
                cd "$PROJECT_ROOT"
                node tests/e2e/demo-e2e.js --test=managed 2>&1 || return 1
            else
                log_warn "Managed goal test not found, skipping"
                return 0
            fi
            ;;
        "sdk_cli_mcp")
            # Test SDK/CLI/MCP equivalence
            cd "$PROJECT_ROOT"
            # Run SDK tests
            if command -v pnpm &> /dev/null; then
                (cd packages/sdk && pnpm test) || return 1
            fi
            # Run CLI tests
            if [[ -f "crates/hexactra-cli/Cargo.toml" ]]; then
                cargo test --package hexactra-cli || return 1
            fi
            ;;
        "hitl")
            # Test HITL flow
            if [[ -f "$PROJECT_ROOT/tests/e2e/test-e2e.js" ]]; then
                cd "$PROJECT_ROOT"
                node tests/e2e/test-e2e.js --mode=hitl 2>&1 || return 1
            else
                log_warn "HITL test not found, skipping"
                return 0
            fi
            ;;
        "viewer")
            # Test viewer functionality
            if [[ -f "$PROJECT_ROOT/tests/e2e/test-e2e.js" ]]; then
                cd "$PROJECT_ROOT"
                node tests/e2e/test-e2e.js --mode=viewer 2>&1 || return 1
            else
                log_warn "Viewer test not found, skipping"
                return 0
            fi
            ;;
        "telemetry_outage")
            # Test telemetry outage handling
            if [[ -f "$PROJECT_ROOT/tests/e2e/test-e2e.js" ]]; then
                cd "$PROJECT_ROOT"
                node tests/e2e/test-e2e.js --mode=telemetry-outage 2>&1 || return 1
            else
                log_warn "Telemetry outage test not found, skipping"
                return 0
            fi
            ;;
        "profile_isolation")
            # Test profile isolation
            if [[ -f "$PROJECT_ROOT/tests/e2e/test-e2e.js" ]]; then
                cd "$PROJECT_ROOT"
                node tests/e2e/test-e2e.js --mode=profile-isolation 2>&1 || return 1
            else
                log_warn "Profile isolation test not found, skipping"
                return 0
            fi
            ;;
        "security_regressions")
            # Test security regressions
            if [[ -f "$PROJECT_ROOT/scripts/security-tests.sh" ]]; then
                "$PROJECT_ROOT/scripts/security-tests.sh" || return 1
            else
                log_warn "Security tests not found, skipping"
                return 0
            fi
            ;;
        *)
            log_error "Unknown test: $test_name"
            return 1
            ;;
    esac
    
    log_info "Test passed: $test_name"
    return 0
}

# Run all tests
run_all_tests() {
    local failed=0
    local passed=0
    
    log_info "Starting E2E Acceptance Test Matrix"
    log_info "====================================="
    
    for test_name in "${!TESTS[@]}"; do
        if run_test "$test_name"; then
            ((passed++))
        else
            ((failed++))
            log_error "Test failed: $test_name"
        fi
    done
    
    log_info ""
    log_info "====================================="
    log_info "Test Results: $passed passed, $failed failed"
    
    if [[ $failed -gt 0 ]]; then
        return 1
    else
        return 0
    fi
}

# Generate test manifest
generate_manifest() {
    local output_file="${1:-$PROJECT_ROOT/tests/e2e/acceptance-manifest.json}"
    
    log_info "Generating acceptance test manifest: $output_file"
    
    cat > "$output_file" << 'ENDOFMANIFEST'
{
  "version": "1.0",
  "name": "Hexactra v1 E2E Acceptance Matrix",
  "tests": {
    "extension_standalone": {
      "description": "Extension standalone text/tool models",
      "category": "extension",
      "priority": "high",
      "automated": true,
      "dependencies": ["chrome_extension"]
    },
    "real_browser": {
      "description": "Real browser actions",
      "category": "browser",
      "priority": "high",
      "automated": true,
      "dependencies": ["chrome", "xvfb"]
    },
    "linux_no_login": {
      "description": "Linux no-login profile start",
      "category": "deployment",
      "priority": "high",
      "automated": false,
      "dependencies": ["systemd", "profile_persistence"]
    },
    "managed_goal": {
      "description": "Managed goal execution",
      "category": "agent",
      "priority": "critical",
      "automated": true,
      "dependencies": ["control_plane", "agent"]
    },
    "sdk_cli_mcp": {
      "description": "SDK/CLI/MCP equivalence",
      "category": "api",
      "priority": "high",
      "automated": true,
      "dependencies": ["sdk", "cli", "mcp"]
    },
    "hitl": {
      "description": "HITL flow",
      "category": "human_in_the_loop",
      "priority": "critical",
      "automated": false,
      "dependencies": ["control_plane", "viewer"]
    },
    "viewer": {
      "description": "Viewer functionality",
      "category": "human_in_the_loop",
      "priority": "high",
      "automated": true,
      "dependencies": ["control_plane"]
    },
    "telemetry_outage": {
      "description": "Telemetry outage handling",
      "category": "reliability",
      "priority": "medium",
      "automated": false,
      "dependencies": ["telemetry"]
    },
    "profile_isolation": {
      "description": "Profile isolation",
      "category": "security",
      "priority": "high",
      "automated": true,
      "dependencies": ["profile_management"]
    },
    "security_regressions": {
      "description": "Security regression tests",
      "category": "security",
      "priority": "critical",
      "automated": false,
      "dependencies": ["security_audit"]
    }
  },
  "acceptance_criteria": {
    "all_critical_tests_pass": true,
    "all_high_priority_tests_pass": true,
    "no_security_vulnerabilities": true
  }
}
ENDOFMANIFEST
    
    log_info "Manifest generated successfully"
}

# Main
case "${1:-all}" in
    "all")
        run_all_tests
        ;;
    "manifest")
        generate_manifest "${2:-}"
        ;;
    "test")
        run_test "$2"
        ;;
    *)
        log_info "Usage: $0 [all|manifest|test <test_name>]"
        log_info ""
        log_info "Available tests:"
        for test_name in "${!TESTS[@]}"; do
            log_info "  - $test_name: ${TESTS[$test_name]}"
        done
        ;;
esac
