# @marinoscar/hexactra-kgraph

Versioned with Changesets (`.changeset/`), together with `@marinoscar/hexactra-agent` and `@marinoscar/hexactra-browser-agent`. Publishing is off: see `docs/decisions/agent-packages.md`.

## 0.1.0-next.0 (unreleased)

- The package (E46.2, #776): the typed graph (`./schema`), the validator (`./validate`), the ports (`./ports`), the testing kit and store conformance kit (`./testing`), the README and `docs/`.
- Procedures as callable tools (E46.22, #796): `./mcp` (host-neutral descriptors and handlers for `procedures_list`, `procedure_get`, `procedure_run`, over `ProcedureStorePort` and a `ProcedureRunPort`) and, in `./harness`, `runSubProcedure` and `bindParameters` (a procedure called as a tool inside a run, depth 1).
