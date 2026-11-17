# Capacity and sizing

Measured limits of the fabric control plane, what bounds a deployment in practice, and how to size one.

## 1. The control plane, measured

The harness is [`scripts/load/fabric-load.mjs`](../../../scripts/load/fabric-load.mjs). It starts a release `hexactra-control` and drives three things against it:
- **N simulated hosts.** Each has M profiles and runs one long-poll loop per profile (one browser each). The hosts speak the real host protocol (register, `/next`, post the result), and answer every action after a simulated browser time.
- **S concurrent sessions.** Each sends A `navigate` actions in a row.
- **Two clients** on the event stream `/v1/events`, as the console runs.

It measures the control plane (dispatch, long-poll fan-out, state, events), not Chromium.

**Test machine:** 4 vCPU, 15 GB RAM, Linux. The harness and the server shared the machine, so these are lower bounds.

| Hosts × profiles | Sessions | Browser time | Actions/s | Latency p50 / p95 / p99 (ms) | Control-plane overhead p50 / p95 | Peak RSS |
|---|---|---|---|---|---|---|
| 1 × 1 | 1 | 150 ms | 6.5 | 155 / 157 / 158 | 5 / 7 ms | 12 MB |
| 4 × 2 | 8 | 150 ms | 51 | 155 / 160 / 164 | 5 / 10 ms | 15 MB |
| 10 × 4 | 40 | 150 ms | 248 | 154 / 178 / 220 | 4 / 28 ms | 22 MB |
| 25 × 4 | 100 | 150 ms | 587 | 156 / 216 / 248 | 6 / 66 ms | 33 MB |
| 50 × 4 | 200 | 150 ms | 1,044 | 168 / 266 / 289 | 18 / 116 ms | 52 MB |
| 50 × 8 | 400 | 150 ms | 1,177 | 218 / 314 / 365 | 68 / 164 ms | 79 MB |
| 100 × 4 | 400 | 50 ms | 1,528 | 122 / 183 / 204 | 72 / 133 ms | 78 MB |
| 100 × 4 | 800 | 50 ms | 1,827 | 324 / 466 / 497 | 274 / 416 ms | 133 MB |

- Zero errors in every configuration, and every event reached both stream clients.
- Memory grows with sessions and events at about 0.15 MB per session.

**Tuning this test found and fixed.** Session placement picked the most recently seen host that had the profile, so every session of a profile went to one host. The others sat idle:
- 50 hosts × 4 profiles reached 26 actions/s, at 7.7 s p50 latency.
- Placement now prefers the host with the fewest active sessions (`create_session_for` in `crates/hexactra-control/src/runtime/store.rs`, with a unit test).
- The same run now reaches 1,044 actions/s at 168 ms.

Rerun it:

```bash
cargo build --release -p hexactra-control
node scripts/load/fabric-load.mjs --hosts 50 --profiles 4 --sessions 200 --actions 15 --browser-ms 150
```

## 2. What bounds a real deployment

The control plane is not the limit: one 4-core machine handles more than a thousand actions a second. The real limits are, in order:

1. **Browsers.** Each open profile is a Chromium using 300–600 MB of RAM and a fraction of a core while pages render.
   - `HEXACTRA_MAX_BROWSERS` caps how many a host keeps open. An idle browser closes after `HEXACTRA_IDLE_SHUTDOWN_S` (900 s).
   - Rule of thumb: 2 GB of RAM per concurrently active browser on the host, OS and page spikes included.
2. **Goal-runner concurrency.** A run that is executing holds one job slot of the console's API process for up to 30 minutes.
   - `JOBS_WORKER_CONCURRENCY` (default 2) is therefore the number of AI runs that execute at once per API instance.
   - Runs waiting for a person release their slot.
   - Set it to the concurrent runs you expect, at most the number of browsers.
3. **The model.** Every model call is a provider round trip: the provider's latency and rate limits set run speed, and its price sets the bill. Administration → AI sets the per-user and per-organization caps. The agent policy's budgets bound each run ([section 3](#3-model-cost-per-run-as-a-sizing-input)), and the **Run budget exceeded** and **Expensive run** alerts watch tokens and cost.
4. **Postgres.** Runs write a row per step, and screenshots go to object storage. This write rate is small next to the browsers', but the console's database was not load-tested here. Watch it on the platform's database panels.

## 3. Model cost per run, as a sizing input

Browsers and machines are the fixed cost; the model is the variable one. Size it with the same numbers the console records.

- **Worst case per run is the policy's budget.** The built-in Balanced stops a run at 60 actions, 120 model calls, $2 and 20 active minutes, Economy at $0.50, Thorough at $10, and Unlimited sets none. Concurrent runs times the cost budget is the most you can spend at once; a ceiling (`browserAgentCeilings.maxCostUsd`) caps even Unlimited ([operations runbook](operations.md#budget-ceilings-run-time-and-why-a-run-stopped)). Costs are only exact for models in the price table ([Model prices](operations.md#model-prices)).
- **Typical cost per run is measured.** A task card shows its last 30 days (runs, cost, tokens, average cost of a successful run). Multiply the average by the runs a day you expect, then compare with the per-user and per-organization AI caps. Chart `app.runs.cost`, `app.runs.model_calls`, `app.runs.input_tokens_per_call` and `app.runs.tokens` on Administration → Telemetry → Browser agents.
- **Input tokens dominate**, because every call re-sends the context: the goal, the step log, the screenshots and the tool output of the chunk. Two policy settings move that most:

| Setting | Effect on input tokens | Cost of lowering it |
|---|---|---|
| `callsPerChunk` | Within a chunk, input grows roughly with the square of the calls, so smaller chunks re-send less tool output. A chunk boundary adds a fresh screenshot and step log | More chunks; less short-term memory for the model |
| `screenshotsKept` | Each kept screenshot costs tokens on every round it stays (the fixture assumes 850 per image) | The model sees less of what changed; `0` is text only |

- **Measured on the fixture** of the console README ([Context settings](../../README.md#context-settings)): a scripted 30-action run on a large page. The pre-policy settings (20 calls per chunk, 1 screenshot) sent 443,728 input tokens in 31 model calls; Balanced (10 calls, 2 screenshots) sent 364,417 for the same run, 18% fewer, although it keeps one more image. This measures context size with a fake model, not provider prices or success on real sites: confirm on your own tasks with the task spend line.
- **Escalation costs more per call.** A run that stalls moves up a tier; Frontier is usually the dearest model. Standard and Frontier on the same model at different reasoning effort keep the provider cache warm.

## 4. Sizing

Browsers belong on **nodes at home** where you can: a residential IP faces fewer challenges than a VPS ([docs/nodes.md](../../../docs/nodes.md)). An unattended node also runs a desktop (XFCE), so add about 1 GB of RAM for it. The bundled VPS host is optional.

| Deployment | Console + fabric machine | Browser hosts | Settings |
|---|---|---|---|
| Just me (1–3 profiles) | 2 vCPU, 4 GB on one VPS | One home node (a mini PC, 8 GB), or the bundled host | `HEXACTRA_MAX_BROWSERS=2`, `JOBS_WORKER_CONCURRENCY=2` |
| Family or small team (≈10 profiles, ≤5 runs at once) | 4 vCPU, 8 GB | Home nodes, unattended plus attended desktops where people already sign in | `HEXACTRA_MAX_BROWSERS=3` per node, `JOBS_WORKER_CONCURRENCY=5` |
| Team fleet (≈50 profiles, ≤20 runs at once) | 4 vCPU, 8 GB for console and fabric | 5–10 hosts of 4 vCPU and 8–16 GB, 3–6 browsers each | `JOBS_WORKER_CONCURRENCY=20`, or 2 API replicas with `JOBS_WORKER_MODE` split |
| Large (hundreds of profiles) | As above. The control plane holds 100 hosts × 4 profiles at under 150 MB | One host per 4–6 browsers | Drain hosts for maintenance (Fleet → Drain); the **Browser host offline** alert watches them |

Check a sizing in production on **Administration → Telemetry → Browser agents**:
- run duration p95 against the browser time you expect;
- runs started against runs finished;
- waits for a person.
