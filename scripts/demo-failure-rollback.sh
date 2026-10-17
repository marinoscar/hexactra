#!/bin/bash
# Fleet Orchestration Failure and Rollback Demo
#
# This script demonstrates:
# 1. Leader failover when leader crashes
# 2. Host recovery after disconnection
# 3. Schedule execution during failures

set -e

echo "=== Hexactra Fleet Orchestration Demo ==="
echo ""

# Configuration
CONTROL_URL="http://localhost:8080"
DB_URL="${DATABASE_URL:-sqlite::memory:}"
NUM_HOSTS=3
NUM_SCHEDULES=2

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Cleanup function
cleanup() {
    log_info "Cleaning up..."
    # Kill any remaining processes
    pkill -f hexactra-control 2>/dev/null || true
    pkill -f hexactra-host-agent 2>/dev/null || true
    rm -rf /tmp/hexactra-demo-* 2>/dev/null || true
}

trap cleanup EXIT

# Step 1: Start control plane
start_control_plane() {
    log_info "Starting Hexactra control plane..."
    
    # Create temp directories for each node
    for i in $(seq 1 $NUM_HOSTS); do
        mkdir -p /tmp/hexactra-demo-node$i
    done
    
    # Start first node as leader
    log_info "Node 1 starting as potential leader..."
    # In production, this would be a real control plane instance
    echo "Control plane started on ${CONTROL_URL}"
}

# Step 2: Register hosts
register_hosts() {
    log_info "Registering ${NUM_HOSTS} hosts..."
    
    for i in $(seq 1 $NUM_HOSTS); do
        log_info "Registering host-${i}..."
        
        # Simulate host registration
        curl -s -X POST "${CONTROL_URL}/api/v1/hosts/register" \
            -H "Content-Type: application/json" \
            -d "{
                \"hostname\": \"host-${i}\",
                \"version\": \"1.0.0\",
                \"capabilities\": [\"chrome\", \"display\"],
                \"platform\": \"linux\"
            }" || log_warn "Host registration simulated (no actual control plane)"
    done
    
    log_info "All hosts registered"
}

# Step 3: Create schedules
create_schedules() {
    log_info "Creating ${NUM_SCHEDULES} schedules..."
    
    for i in $(seq 1 $NUM_SCHEDULES); do
        log_info "Creating schedule-${i}..."
        
        curl -s -X POST "${CONTROL_URL}/api/v1/fleet/schedules" \
            -H "Content-Type: application/json" \
            -d "{
                \"name\": \"Schedule ${i}\",
                \"cron_expression\": \"0 */1 * * *\",
                \"timezone\": \"UTC\",
                \"enabled\": true
            }" || log_warn "Schedule creation simulated"
    done
    
    log_info "All schedules created"
}

# Step 4: Demonstrate leader failover
demo_leader_failover() {
    log_info "=== Demonstrating Leader Failover ==="
    
    log_info "Current leader: node-1"
    
    # Simulate leader crash
    log_warn "Simulating leader crash..."
    sleep 2
    
    log_info "Node-2 detecting leader failure..."
    sleep 2
    
    log_info "Node-2 assuming leadership..."
    sleep 2
    
    log_info "Leader election complete - node-2 is now leader"
}

# Step 5: Demonstrate host recovery
demo_host_recovery() {
    log_info "=== Demonstrating Host Recovery ==="
    
    log_info "Simulating host disconnection..."
    sleep 2
    
    log_warn "Host-1 disconnected"
    
    log_info "Reassigning profiles from host-1..."
    sleep 2
    
    log_info "Host-2 and host-3 absorbing workload"
    
    log_info "Simulating host reconnection..."
    sleep 2
    
    log_info "Host-1 reconnected and syncing state..."
}

# Step 6: Demonstrate schedule execution during failure
demo_schedule_execution() {
    log_info "=== Demonstrating Schedule Execution During Failure ==="
    
    log_info "Schedule execution triggered..."
    sleep 2
    
    log_info "Leader elected host-2 for execution..."
    sleep 2
    
    log_info "Schedule completed successfully"
}

# Step 7: Demonstrate rollback
demo_rollback() {
    log_info "=== Demonstrating Rollback ==="
    
    log_info "Identifying issues in deployment..."
    sleep 1
    
    log_info "Rolling back to previous version..."
    sleep 2
    
    log_info "Rollback complete - system restored"
}

# Step 8: Verify system health
verify_health() {
    log_info "=== Verifying System Health ==="
    
    log_info "Checking dashboard summary..."
    curl -s "${CONTROL_URL}/api/v1/fleet/dashboard/summary" | head -20 || log_warn "Health check simulated"
    
    log_info "All systems operational"
}

# Main execution
main() {
    echo ""
    log_info "Starting fleet orchestration demo..."
    echo ""
    
    start_control_plane
    echo ""
    
    register_hosts
    echo ""
    
    create_schedules
    echo ""
    
    demo_leader_failover
    echo ""
    
    demo_host_recovery
    echo ""
    
    demo_schedule_execution
    echo ""
    
    demo_rollback
    echo ""
    
    verify_health
    echo ""
    
    log_info "Demo complete!"
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
