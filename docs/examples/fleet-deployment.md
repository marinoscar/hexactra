# Fleet Orchestration Example Deployments

This directory contains example deployments for Hexactra fleet orchestration.

## Quick Start (Single Node)

```bash
# Start with SQLite (no fleet features)
docker run -p 8080:8080 \
  -e DATABASE_URL=sqlite:///hexactra.db \
  -v $(pwd)/data:/data \
  hexactra/control-plane
```

## Multi-Host Deployment

### Database Setup

```bash
# PostgreSQL for HA
docker run --name hexactra-db \
  -e POSTGRES_USER=hexactra \
  -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=hexactra \
  -v hexactra-data:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:14

# Create database
psql -h localhost -U hexactra -d hexactra < crates/hexactra-control/migrations/*.sql
```

### Control Plane

```bash
# Start control plane with PostgreSQL
docker run --name hexactra-control \
  --network host \
  -e DATABASE_URL=postgresql://hexactra:secret@localhost:5432/hexactra \
  -p 8080:8080 \
  hexactra/control-plane
```

### Host Agents

```bash
# Register and start host agents
docker run --name hexactra-host-1 \
  --network host \
  --privileged \
  -e HEXACTRA_CONTROL_URL=http://localhost:8080 \
  -e HEXACTRA_HOST_ID=host-1 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  hexactra/host-agent

docker run --name hexactra-host-2 \
  --network host \
  --privileged \
  -e HEXACTRA_CONTROL_URL=http://localhost:8080 \
  -e HEXACTRA_HOST_ID=host-2 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  hexactra/host-agent
```

## Kubernetes Deployment

### Helm Chart (Example)

```yaml
# values.yaml
controlPlane:
  replicaCount: 3
  database:
    url: postgresql://hexactra:secret@pg-ha:5432/hexactra
  leaderElection:
    enabled: true
    lockDurationSeconds: 30

hostAgents:
  replicas: 3
  nodeSelector:
    kubernetes.io/os: linux
```

### Deploy

```bash
helm upgrade --install hexactra ./charts/hexactra \
  -f values.yaml \
  --namespace hexactra \
  --create-namespace
```

## Failure Recovery

### Simulating Leader Failover

```bash
# Start with 3 control plane nodes
docker run --name hexactra-control-1 ...
docker run --name hexactra-control-2 ...
docker run --name hexactra-control-3 ...

# Kill leader
docker stop hexactra-control-1

# Another node will automatically assume leadership
# Verify:
curl http://localhost:8080/api/v1/fleet/leader/info
```

### Host Recovery

```bash
# If a host goes offline
# 1. Check status
curl http://localhost:8080/api/v1/fleet/hosts/health

# 2. Wait for reassignment (if profile affinity is set)
# 3. Restart host agent when ready
docker start hexactra-host-1
```

## Monitoring Setup

### Prometheus Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'hexactra'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: /api/v1/fleet/health/metrics
```

### Grafana Dashboard

```json
{
  "panels": [
    {
      "title": "Active Hosts",
      "type": "graph",
      "targets": [
        {
          "expr": "hexactra_active_hosts"
        }
      ]
    },
    {
      "title": "Pending HITL Requests",
      "type": "graph",
      "targets": [
        {
          "expr": "hexactra_pending_hitl_requests"
        }
      ]
    }
  ]
}
```

## Testing

### Integration Tests

```bash
# Run fleet orchestration tests
cargo test -p hexactra-control --test fleet_integration

# Test leader election
cargo test -p hexactra-control leader_election

# Test scheduling
cargo test -p hexactra-control scheduler
```

### Failure Scenarios

1. **Network Partition**: Test behavior when host loses connectivity
2. **Database Failover**: Test recovery when database switches
3. **Leader Crash**: Verify automatic failover

## Rollback

### Rolling Back a Deployment

```bash
# If issues occur, rollback to previous version
helm rollback hexactra --history 1

# Or manually:
docker stop hexactra-control
docker run hexactra/control-plane:v0.9.0 ...
```
