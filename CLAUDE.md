# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Hexactra is currently **documentation-only**. There is no application code, build system, linter, or test suite yet. The repo contains:

- `VISION.MD` — the authoritative product vision and technical architecture (~1,470 lines, 25 sections). Treat it as the source of truth; it describes a *proposed* design, not shipped capability.
- `README.md` — one-line description.
- `scripts/link-github-subissues.mjs` + `.github/workflows/link-hexactra-subissues.yml` — the only executable code: an idempotent Node script (no dependencies, Node 22) that attaches existing epic issues (hard-coded `epicChildren` map, epics #1–#93) as native GitHub sub-issues. It refuses to run against any repo other than `marinoscar/hexactra`.

Commands:

```bash
GITHUB_TOKEN=... node scripts/link-github-subissues.mjs --check   # dry run
GITHUB_TOKEN=... node scripts/link-github-subissues.mjs           # apply (needs Issues:write)
```

The workflow runs on push when the workflow file itself changes, or via `workflow_dispatch`.

## Product in one paragraph

A portable, self-hostable computer-use runtime letting authorized AI agents operate real graphical browsers (initially Chrome on Linux) through an HTTP API, TypeScript SDK, CLI and MCP, with persistent profiles, human-in-the-loop (HITL) control, and OpenTelemetry. The Chrome extension must also work **standalone** as an AI browser assistant (built-in chat, provider/model settings, OpenAI-compatible providers) without a Hexactra server — a v1 requirement (§25).

## Architecture (see VISION.MD §5–§6, §18)

Three runtime domains: clients → Rust control plane → execution hosts.

- **Control plane** (Rust, Axum): identity/authz, policy, sessions, leases, HITL broker, durable audit/event store, artifact broker. Authoritative for everything.
- **Host agent** → **session worker** → **native messaging host** (all Rust) ↔ **Chrome MV3 extension** (TypeScript) in visible Chrome with a persistent profile. Worker↔native host over local IPC (Unix sockets); native host↔extension over Chrome Native Messaging.
- Clients (SDK/CLI/MCP/web UI) go only through the control plane API — never directly to Chrome debugging ports.
- Distribution changes topology, **not** client commands, session IDs, authorization rules, or behavior (control plane and host agent may be one process locally).

Design invariants to preserve when writing docs or code:

- Web pages, content scripts, memory recommendations and model output are **never** a source of authorization.
- Large artifacts move via short-lived authorized handles, not inside control messages.
- Telemetry (OTel) is not the audit trail; durable sanitized Execution Events are.
- Secret Material (passwords, OTPs, tokens) has stricter handling than ordinary task input (§11–§13).
- The public API must not be tied to Chrome or Linux; drivers are pluggable.
- The Agent Experience Framework (AEF) is an independent, optional product boundary that only consumes redacted outcomes (§17).

Planned monorepo layout (target, directories do not exist yet): Cargo workspace `crates/hexactra-{control,agent,worker,native-host,cli,mcp,core,telemetry}`, pnpm workspace `packages/{sdk,contracts}`, `apps/{chrome-extension,dashboard}`, `api/openapi.yaml` + `api/schemas/`, `deploy/`, `docs/`, `tests/`. Planned stack: Rust/Tokio/Axum/Clap/Serde/SQLite, React+TypeScript dashboard, OpenAPI-generated SDKs.

## Editing VISION.MD

- Keep the status banner honest: it's a vision/proposal, not a statement of shipped features.
- Section numbers are cross-referenced (e.g. "§25"); renumbering breaks references.
- Recent commits promoted AI control, the standalone extension, OpenAI-compatible providers and unattended remote launch to **v1 requirements** (§25, with §19–§20 milestones/definition-of-done). Keep those sections consistent when changing scope.
- Don't pin "latest" dependency versions in the vision; versions belong in lockfiles/implementation READMEs.
