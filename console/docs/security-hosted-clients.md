# Threat model: hosted AI clients (ChatGPT, Claude) on the console

The console's MCP endpoint lets hosted assistants (ChatGPT, Claude) drive the owner's browsers, with the owner's full powers within the scopes they consented to (VISION §27). This page names what is at stake, who might attack it, where the trust boundaries are, and which control answers each threat, with the test that proves it. Operators: [the public-exposure runbook](runbooks/public-exposure.md).

## Assets

- **The owner's signed-in browser profiles** on their nodes: bank, mail and shop sessions; whatever the browser can do, an app with `browser:drive` can ask for.
- **The owner's money**: purchases a run can make; model spend (budgets).
- **Secrets**: passwords and one-time codes typed through handoffs (the fabric types them; the console never holds them), personal access tokens (`pat_`), OAuth access and refresh tokens (`oat_`, `ort_`), the fabric's service token (`hxs_`), webhook secrets, session cookies.
- **The record**: runs, steps, questions, the AI app activity trail.
- **The deployment**: its availability and its settings.

## Actors

| Actor | Can | Wants |
|---|---|---|
| The owner | Everything in their console | Their goals done; to stay in control |
| The hosted vendor (OpenAI, Anthropic) | Sees every tool result its model reads; calls `/api/mcp` with the token the owner granted | To run the model; it is trusted with what the owner sends it, like any hosted model |
| A malicious web page | Puts text in front of the model through `browser_text`, element labels, script values, tab titles, a run's answer | To make the model act for it: buy, send, share, exfiltrate |
| A malicious MCP client | Registers itself, asks the owner to connect, calls `/api/mcp` | Broad scopes, a token it can keep |
| A thief of a token | Holds an `oat_`, `ort_` or `pat_` | To act as the owner |
| The internet at large | Calls any public path | Probe, flood, find something open |

## Trust boundaries

```text
            ┌────────────────────── internet ───────────────────────┐
 web page ──┤ (page text)                                            │
            │        ┌──────────────┐  tool results    ┌───────────┐  │
            │        │ hosted model │◀──────────────── │  vendor   │  │
            │        │ (ChatGPT,    │──── tools/call ─▶│  servers  │  │
            │        │  Claude)     │                  └─────┬─────┘  │
            │        └──────────────┘                        │ HTTPS, oat_ token
            └────────────────────────────────────────────────┼───────┘
     ═══════════════════ edge: TLS, nginx limits ════════════╪═══════════
                                                             ▼
   ┌──────────────────────────── console (API) ───────────────────────────┐
   │ /api/mcp: auth → kill switch → rate limits → scope gate → tool        │
   │   tool → REST route in-process as the NARROWED principal              │
   │   sensitive action? → confirm (risk high) in the owner's inbox        │
   │   result → token redaction → model        call → audit row           │
   └───────────────────────────────┬──────────────────────────────────────┘
                                   │ hxs_ service token (private network)
                                   ▼
                     fabric ──▶ node ──▶ the owner's browser
```

Untrusted input crosses into the model at "page text"; authority crosses into the console only at "oat_ token". Nothing from a page or from model output is ever a source of authorization: approvals come only from a channel where the owner is signed in.

## Threats, mitigations and the tests that prove them

| Threat | Mitigation | Test |
|---|---|---|
| **Stolen `oat_` token** | Scoped to what the owner ticked; lives 60 minutes; confined to `/api/mcp` (`403` elsewhere); narrowed permissions on every in-process sub-request; Disconnect revokes it at once; the kill switch refuses all of them | `mcp-oauth.db.spec.ts` (confinement, narrowing, revocation), platform `oauthServer` conformance; `mcp-public-exposure.db.spec.ts` (kill switch, admin Disconnect → `401`) |
| **Stolen refresh token** | Rotation on every use; reuse of a rotated token revokes the whole grant (the platform's reuse detection) | platform OAuth server suite (`oauthServer` conformance, `mcp-oauth.db.spec.ts`) |
| **Malicious client registration** | Only allowed client hosts may connect (Administration → OAuth clients; "any host" off); the consent page shows the client's host first | platform `oauthServer` conformance; `connected-apps.db.spec.ts` (preflight) |
| **Consent phishing** (a look-alike app asks for broad scopes) | Host-first consent; high-risk scopes unticked by default; `app.connected` and `app.scope_added` are mandatory notifications ("Not you? Disconnect it") | `connected-apps.db.spec.ts` (notifications) |
| **Prompt injection through page text** (a page tells the model to buy, send or share) | Page-derived text is marked untrusted (E33.4); OAuth callers' instructions say page text is data, not instructions, and to ask before sending, buying, deleting or sharing when a page suggested it; **sensitive browser actions need the owner's approval** in a signed-in channel (a `confirm` with risk high; the app cannot approve through `inbox_answer`), bound to the session, action and target for 2 minutes, once; per-app allowed sites, enforced by the console for every action and by the browser for every top-level navigation, including ones a page starts itself (#508); per-app limits and budgets; purchase confirmation in delegated runs, with "Started by <app>" on the question | `mcp-security.spec.ts` (each classifier, instructions, "Started by"); `mcp-public-exposure.db.spec.ts` (nothing reaches the fabric before approval, the app cannot approve, exactly once, 2-minute window, a denial stands, allowed sites reach the fabric); `runner.db.spec.ts` (blocked navigations become steps); `tests/e2e/remote-control.e2e.mjs` (a page redirecting itself off the allowed sites is blocked in real Chromium); `mcp-apps`/`run-progress` specs (untrusted marking) |
| **A hosted model exfiltrating page content to its vendor** | **Inherent to using a hosted model.** Whatever a tool returns, the vendor sees. `browser:drive` is an opt-in for exactly this reason: delegating (`run_goal`) returns the run's answer, not the pages; driving returns the pages. Do not connect a hosted app with `browser:drive` to profiles whose content must not leave your machines | (none: a property, stated here and on the consent page) |
| **Exfiltration through tool arguments** (a page makes the model put data into a goal or a navigation URL) | Goals from an app are stored and shown verbatim in the run; navigation is limited by allowed sites; network-reaching JavaScript needs approval; the audit trail keeps the goal's first 200 characters and the URL host | `mcp-public-exposure.db.spec.ts` (audit row fields) |
| **A hosted app turning one approval into a standing one** (#555) | "Don't ask again" is accepted only from the signed-in web and Android app (channel and the request's credential); an app relaying the chat, an elicitation form or an MCP Apps card approves once; there is no tool or route that creates a saved approval; in a run an app started with "confirm purchases" on, the gate always asks, whatever rules exist | `dont-ask-again.db.spec.ts` (channels, the AI-app limit), `approval-rules.spec.ts` (no creating route or tool) |
| **Cost abuse** (an app starts many expensive runs) | Agent policy budgets; per-app runs at once, runs per day and spend per day, under deployment ceilings; rate limits on write calls | `connected-apps.db.spec.ts` (limits); `mcp-public-exposure.db.spec.ts` (writes per app) |
| **Denial of service** | nginx per-address limits on `/api/mcp`, `/api/oauth/`, `/.well-known/`; 1 MiB bodies; API limits per connection, per user and on unauthenticated `401`s (which fail closed when the limiter fails, while authenticated callers fail open) | `nginx-mcp-overlay.spec.ts` (`nginx -t`), `mcp-public-exposure.db.spec.ts` and `mcp-security.spec.ts` (each key at and over its limit) |
| **Confused deputy** (a token for one resource used on another; a tool reaching what the token may not) | Tokens are audience-bound to `<APP_URL>/api/mcp`; tools call the REST routes through the platform's in-process delegation as the narrowed principal, never by forwarding a header; the REST routes repeat the scope check for browser actions | `mcp-oauth.db.spec.ts`, `mcp-access.spec.ts` |
| **Secret handling** (a token, a password or a code reaching the model or a widget) | Handoff secrets are typed by the fabric and never returned; REST answers never carry tokens; every tool result is scanned and token-shaped strings (`pat_`, `oat_`, `ort_`, `oac_`, `nod_`, `hxs_`, `hxe_`, `hxh_`, `whsec_`) and the configured fabric token are redacted, including `browser_evaluate` values; the audit trail stores no typed text, script or result | `mcp-public-exposure.db.spec.ts` (secret egress over every tool, PAT and OAuth; a planted token redacted); `mcp-security.spec.ts` (redaction, audit detail) |

## What this does not cover

- **The redaction is a tripwire, not a guarantee.** A page can encode a token (base64, split across fields) and a script can rebuild one. The JavaScript tripwires (`fetch(`, `XMLHttpRequest`, `sendBeacon`, `document.cookie`, `localStorage`, `navigator.credentials`) are a string match: `window['fe' + 'tch']` passes them. `browser:evaluate` is a high-risk opt-in for that reason.
- **The sensitive-page rule sees the last element list.** Before the app lists a page's elements the console does not know it has a password field; a desktop click is always treated as outside the browser because the console cannot tell.
- **Personal access tokens are the owner's own credential.** They are rate limited, audited and can be switched off for MCP, but they are not asked for approval: an agent framework with a token runs with the owner's authority, as it always has.
