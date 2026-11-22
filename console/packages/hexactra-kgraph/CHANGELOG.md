# @marinoscar/hexactra-kgraph

Versioned with Changesets (`.changeset/`), together with `@marinoscar/hexactra-agent` and `@marinoscar/hexactra-browser-agent`. Publishing is off: see `docs/decisions/agent-packages.md`.

## 0.1.0-next.0 (unreleased)

The first version, built in epic E46 (#770). Experimental; every host keeps it off by default.

- **The package** (E46.2, #776): the typed graph (`./schema`), the validator (`./validate`), the ports (`./ports`), the in-memory fakes and the store conformance kit (`./testing`).
- **Argument provenance** (E46.5, #779): the neutral trace (`TraceEvent`, `bindArguments`, `resultShapeOf`). It holds no typed text, secret, page text or reasoning.
- **The compiler** (E46.7, #781): `compileTrace`. Deterministic and model-free, from server-recorded facts only. What it cannot express safely becomes an `agent` step.
- **The executor** (E46.8, #782): `executeProcedure` with resume points and the crash-safety contract (`onCommitIntent`, `unknown`). It never retries on its own. `test/second-host.spec.ts` is a minimal second host.
- **The harness bridge** (E46.9, #783): `./harness` (`replayPhase`, `harnessToolInvoker` through `executeTool`, `harnessJudge`, `harnessProbe`, `watchCalls`). It is the only folder that imports `@marinoscar/hexactra-agent`.
- **The state machine and verified admission** (E46.10, #784): `VERSION_TRANSITIONS`, `canTransition`, `activate`, and verification runs in `replayPhase` (`verify`).
- **Outcome checks** (E46.11, #785): `checkOutcome`, `learnShape` and `isAuditRun`. Shapes hold statistics, never values.
- **The circuit breaker** (E46.12, #786): `breaker` and `BREAKER`.
- **The surface graph** (E46.13, #787): screens and elements from element fingerprints. A pointer click with element facts replays as a click on the element.
- **The recovery ladder** (E46.15–E46.16, #789, #790): `RecoveryLadder`, `RUNGS` and `RECOVERY_LIMITS`, plus `JudgePort.locate`. The model rung is never used for a commit-class step.
- **Repair** (E46.17, #791): `diffVersions` and `classifyRepair` (`structural` or `sensitive`, with reasons).
- **Segments, judges, branches and loops** (E46.18, #792): per-segment resume, `foreach` from a repeated list walk, `mergeBranches` from two runs.
- **The view model** (E46.19, #793): `./view` (`buildGraphView`, `stepList`, `readableDiff`, `healthOf`, `defaultMask`).
- **Procedures as tools** (E46.22, #796): `./mcp` (host-neutral descriptors and handlers for `procedures_list`, `procedure_get` and `procedure_run`, over `ProcedureStorePort` and a `ProcedureRunPort`). In `./harness`, `runSubProcedure` and `bindParameters` let a procedure be called as a tool inside a run, depth 1.
- **Export and import** (E46.23, #797): `./transfer` (`exportFile`, `exportProcedure`, `readTransferFile`; the `hexactra.kgraph` file, `formatVersion` 1).
- **Matching** (E46.27, #849): `./match` (`matchProcedures`, `sitesInText`, `siteOf`, `wordsOf`, `cleanReplayRate`, `MATCHABLE_STATES`). Deterministic, with no I/O and no model: exact registrable-domain sites (no lookalikes), accounts, normalised words; only `active` versions; at most 5 by default. The store port gains `listActiveProceduresForSites(owner, sites)`, with conformance cases in `runStoreConformance` and the in-memory store.
- **Documentation** (E46.25, #799): the README quick start, `docs/concepts.md`, `docs/host-guide.md`, `docs/security.md` and the generated `docs/schema.md`. `test/docs-examples.spec.ts` runs every block marked runnable in the README and in `docs/`.
- **Site facts** (E46.30, #852): `SiteFact` and its schema (`src/schema/site-fact.ts`, in `docs/schema.md`), fact identity (`siteFactKey`), `validateSiteFact` with a `SecretCheckPort`, `deriveSiteFacts` (navigation, sign-in, quirk and timing proposals from server-recorded facts, no model), the optional `SiteFactStorePort`, `InMemorySiteFactStore` and `runSiteFactStoreConformance`. `compile` also exports `screenIdOf`.
