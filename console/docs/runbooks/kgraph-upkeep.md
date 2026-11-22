# Runbook: Knowledge Graph upkeep

The `kgraph.upkeep` job (epic E46, #798) keeps each owner's Knowledge Graph small and current. A daily cron (03:00) enqueues it while the deployment switch (`kgraph.enabled`) is on; an administrator can run it now with `POST /api/kgraph/admin/upkeep` (`kgraph:admin`).

## What it does, per owner whose own switch is on

1. **Traces:** deletes `kg_traces` of runs whose compiled version was verified (now active) or retired.
2. **Old versions:** keeps the active, suspended and candidate versions, the newest 5 retired versions per procedure and anything a pending review needs; deletes older `retired` and `rejected` versions.
3. **Stale procedures:** a procedure not run for `kgraph.retentionDays` days (system setting; `null` keeps them) is retired, not deleted. The task learns again on its next run.
4. **Orphans:** removes `Element` and `Site` nodes no remaining version references.
5. **Duplicates:** merges `Element` nodes of the same site, role, label and anchor into the oldest (it keeps the union of selector candidates and the merged keys). Versions keep their embedded fingerprints, so no active version changes. Shared sub-sequences across procedures are **not** merged yet (each procedure keeps its own steps).
6. **Health:** recomputes each procedure's health (`good`, `flaky`, `failing`, `new`) for the Map.

It never runs for a user whose switch is off (their data is kept untouched), never changes an active version, and is idempotent.

## Checks

- Admin → Doctor → `kgraph.upkeep`: passes when the job succeeded in the last 2 days while the feature is on.
- Logs: `kgraph upkeep: {"traces":…,"versions":…,"stale":…,"orphans":…,"duplicates":…,"health":…}`.

## If it fails

Look at the job's `lastError` in Admin → Jobs. A failed run leaves what it already did (each action is a plain delete or update); the next run continues. To stop it, turn the deployment switch off.
