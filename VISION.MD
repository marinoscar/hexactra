# Hexactra — Product Vision and Technical Architecture

> **Status:** Foundational vision and proposed architecture (not a statement of shipped capabilities)  
> **Repository:** https://github.com/marinoscar/hexactra  
> **Document version:** 1.0  
> **Date:** October 15, 2026  
> **Product:** Hexactra  
> **Tagline:** Human-like interaction. Agent-powered execution.

---

## 1. Executive summary

**Hexactra is a portable, self-hostable computer-use runtime that allows authorized AI agents to operate real applications through the same graphical interfaces that humans use.** It exposes a consistent control surface through an HTTP API, an SDK, a CLI, and Model Context Protocol (MCP). It runs persistent graphical browser sessions on remote hosts, even when nobody is logged into the host operating system, while keeping human operators in control of access, authentication, and high-impact actions.

The initial focus is **real graphical Chrome on Linux**, with persistent browser profiles, retained website sessions, a Chrome Manifest V3 extension, a local native-messaging bridge, and a Rust session runtime. The architecture must not tie the public API to Chrome or Linux: future adapters can control other browsers and desktop applications, and host agents can eventually run on Windows and macOS where the operating system permits.

Hexactra is **not an LLM, chatbot, or autonomous reasoning framework**. Its job is to provide a dependable, secure execution environment to models and agents chosen by the developer. An external agent determines *what to attempt*; Hexactra enforces *what is permitted*, carries out authorized UI actions, reports the results, and offers human intervention when needed.

A first-class requirement is **Human in the Loop (HITL)**. Authentication, one-time passwords, passkeys, physical security keys, consent prompts, missing credentials, and sensitive approvals are routine parts of computer use. Hexactra must not assume that an agent can or should satisfy them unaided. When human input is required, execution pauses safely, an authorized human is prompted, and the workflow resumes only when the required input or approval has been supplied. **In v1, all such requests go to a built-in human-interaction mechanism.** The interfaces for notifications, credential vaults, and other providers are designed now but external integrations are implemented later.

Hexactra includes **OpenTelemetry** instrumentation from the beginning for distributed tracing, metrics, and structured logs. Operational telemetry is separate from the authoritative execution/audit log and separate from any future experiential memory engine.

### One-sentence promise

> Give any authorized agent a secure, observable, resumable way to use real software as a person would, with explicit human control over the points where human participation is necessary.

## 2. The problem

AI agents are powerful at planning, but real business and personal work still happens inside applications built for people:

- SaaS products require browsing, clicks, typing, scrolling, dialogs, downloads, and navigation.
- APIs may not exist, may be incomplete, may require separate integrations, or may omit critical workflows.
- Authentication, device verification, OTP challenges, passkeys, and unexpected security prompts interrupt otherwise useful automation.
- Browser sessions are difficult to persist and resume across machines, agent frameworks, and client disconnections.
- Traditional RPA solutions can be brittle; pure screenshot-based loops can be slow and costly.
- Scripts written for one website often fail when layout, timing, or authentication state changes.
- Remote execution is difficult to observe, debug, authorize, pause, and hand back to a person.
- Agents need operational traces and, eventually, a way to learn from prior successful and unsuccessful interactions.

Hexactra addresses the **execution and control** part of this problem. A separate, optional Agent Experience Framework may later address **experiential learning and cross-website skill reuse**.

## 3. Vision, goals, and non-goals

### 3.1 Goals

1. **Real computer use:** operate genuine, visible browser sessions rather than substituting a mock browser or a headless-only representation.
2. **Unattended hosting:** launch graphical Chrome sessions on a Linux host with no interactive host-user login.
3. **Persistent identity:** allow intentional reuse of isolated browser profiles and their signed-in sessions across jobs.
4. **Remote control:** allow agents and human operators on different devices to access the same authorized session.
5. **Developer portability:** support SDK, CLI, and MCP clients without requiring the client to run alongside Chrome.
6. **Deployment portability:** ship native binaries and OCI container options, with a standalone mode free of mandatory external services.
7. **Driver independence:** use Chrome Extension integration first, without embedding Chrome assumptions in the public contract.
8. **Human authority:** make HITL, approvals, takeover, and sensitive-data handling part of the execution model.
9. **Observable execution:** correlate action requests across the API, session worker, native bridge, and browser.
10. **Recoverability:** tolerate client disconnects, transient agent outages, browser errors, and restarts where recoverable.
11. **Composable automation:** expose low-level capabilities and reusable higher-level operations, without forcing a particular model or agent framework.
12. **Security by default:** apply explicit identity, authorization, isolation, auditability, and least privilege.
13. **Extensibility:** define connector seams now for credential vaults, messaging, notification channels, alternate drivers, and independent agent memory.

### 3.2 Non-goals for version 1

- Building or hosting a foundation model.
- Replacing Claude Code, OpenCode, Pi, or other agent orchestration frameworks.
- Requiring a knowledge graph, vector database, LLM gateway, or experiential memory service for basic browser control.
- Automatically intercepting SMS messages, reading email inboxes, extracting authenticator-app codes, or retrieving credentials from third-party vaults.
- Automatically bypassing MFA, passkeys, CAPTCHAs, bot-detection controls, or website access restrictions.
- Guaranteeing that a hardware-bound or user-presence-required authentication ceremony can be completed remotely.
- Offering fully managed multitenant SaaS, Kubernetes orchestration, or enterprise SSO on day one.
- Implementing generalized cross-OS desktop automation before Linux Chrome is dependable.
- Recording all screen contents or every page field indefinitely.
- Treating a notification as an authorization to perform an action.

### 3.3 Guiding design principles

**Protocol first, implementation second.** The remote API and action/event schemas outlive any specific language, client SDK, driver, or transport.

**A single policy boundary.** SDK, CLI, MCP, and Web UI are clients of the same authenticated control plane, not separate privileged implementations.

**Small native components.** Native host and OS integration should be narrow, well-tested, independently restartable, and implemented in Rust.

**No fragile client attachment.** Remote agent connections may come and go; sessions belong to Hexactra, not to one TCP connection or one MCP tool invocation.

**Human assistance is a state transition.** Missing authentication is neither a crash nor permission to guess secrets.

**Secrets are not agent output.** The public API can request and complete a secret-handling workflow without returning the secret to the model transcript.

**Observe without surveillance.** Instrument operations and health while minimizing captured user content.

**Progressive enhancement.** Standalone installations must work without an observability collector, credential vault, Redis, cloud provider, or graph database.

**Behavior over vendor labels.** Evaluate a driver by real reliability, security, latency, and coverage rather than by whether it uses DOM, CDP, screenshots, or OS-level input.

---

## 4. Users and representative scenarios

### 4.1 Target users

- Developers embedding computer-use in agentic applications.
- Operators automating repeatable workflows across SaaS applications.
- Individuals running self-hosted agents from a home server or mini PC.
- Teams needing observable, auditable automation with human approvals.
- Researchers testing browser-control methods and experiential memory.

### 4.2 Representative end-to-end scenarios

**Remote persistent browser.** An agent on a laptop starts a session using a Chrome profile stored on an unattended Linux machine, signs in with human assistance if necessary, performs a task, disconnects, and later resumes the same profile from a different device.

**MCP integration.** An MCP client calls browser tools on a remote Hexactra service; the service owns lifecycle, authorization, artifacts, and telemetry. The MCP server does not own the browser process.

**OTP challenge.** A website requests a six-digit OTP sent by SMS. Hexactra creates a human-interaction request, makes it visible in the owner's inbox, pauses the workflow, accepts a short-lived code from the human, enters it only into the designated website field, and resumes after verifying the result.

**Authenticator or phone approval.** A site asks the user to approve a sign-in on a phone. Hexactra requests confirmation or a takeover; it does not claim to simulate possession of the phone.

**Unknown username/password.** An agent reaches a login form. Hexactra asks the owner to supply credentials securely or complete the form directly in takeover mode. It does not put credentials into an MCP result, logs, trace attributes, or future memory.

**Passkey/security key.** A browser presents an authentication ceremony requiring physical presence or a platform authenticator. Hexactra notifies the human, offers browser takeover or supported local authentication, and reports an explicit unsupported/blocked state if the ceremony cannot be fulfilled.

**Investigation and recovery.** A browser action fails. The operator can inspect a trace, view redacted artifacts, take over the session, and release control back to the agent without creating a new browser profile.

---

## 5. Conceptual model and terminology

- **Control Plane:** authoritative API service for identity, policy, session lifecycle, state, leases, artifacts, HITL requests, and audit.
- **Host Agent:** Rust component on a machine capable of running one or more browser or desktop sessions. It registers capabilities and receives authorized work.
- **Session Worker:** execution process associated with a browser session; translates canonical actions into driver-specific commands and results.
- **Browser Driver:** pluggable implementation of semantic actions, snapshots, navigation, and other browser operations.
- **Chrome Extension:** TypeScript MV3 code inside graphical Chrome that discovers browser state and executes supported browser-side actions.
- **Native Messaging Host:** narrow Rust process launched by Chrome to bridge extension messaging to the session worker over local IPC.
- **Profile:** persisted browser user data scoped to an owner and trust boundary, possibly containing authenticated website sessions.
- **Session:** a live browser/desktop instance bound to a profile, worker, policy, and owner.
- **Operation:** durable record of a requested command or workflow step, including asynchronous progress and final outcome.
- **Control Lease:** exclusive right to inject input into a session during a bounded interval.
- **Interaction Request:** durable HITL request for a human response, secret, approval, or takeover.
- **Secret Material:** password, OTP, token, recovery code, and related sensitive values. It requires stricter handling than ordinary task input.
- **Connector:** provider adapter for notifications, credential resolution, or another optional integration.
- **Execution Event:** durable, sanitized state change used for audit and recovery.
- **Telemetry:** traces, metrics, and diagnostic logs; not the authoritative audit trail.
- **Agent Experience Framework (AEF):** independent, future memory/learning system that may consume redacted outcomes and provide reusable guidance.

---

## 6. Architecture overview

Hexactra has three principal runtime domains: **client interfaces**, **control plane**, and **execution hosts**. The AEF and telemetry backends are optional adjacent systems.

~~~mermaid
flowchart TB
    subgraph Clients["Clients and developer interfaces"]
      SDK["TypeScript SDK / future Python SDK"]
      CLI["Rust CLI"]
      MCP["MCP stdio / Streamable HTTP"]
      UI["Human operator web UI"]
    end

    SDK --> API
    CLI --> API
    MCP --> API
    UI --> API

    subgraph CP["Rust control plane"]
      API["Authenticated API / authorization"]
      SESS["Session orchestration and leases"]
      HITL["Human interaction broker"]
      AUDIT["Durable event and audit store"]
      ART["Artifact broker"]
      API --> SESS
      API --> HITL
      SESS --> AUDIT
      HITL --> AUDIT
      SESS --> ART
    end

    SESS <-->|"Authenticated command channel"| AGENT

    subgraph Host["Host agent and isolated browser runtime"]
      AGENT["Rust host agent"]
      WORKER["Rust session worker"]
      NATIVE["Rust native messaging host"]
      EXT["TypeScript Chrome MV3 extension"]
      CHROME["Visible Chrome + persistent profile"]
      VIEW["Desktop viewer / human takeover"]
      AGENT --> WORKER
      WORKER <-->|"Local IPC"| NATIVE
      NATIVE <-->|"Chrome Native Messaging"| EXT
      EXT <--> CHROME
      WORKER <--> VIEW
      VIEW <--> CHROME
    end

    CP -. "OTLP / structured diagnostics" .-> OBS["Optional OTel Collector and backend"]
    CP -. "Redacted outcomes only" .-> AEF["Optional independent Agent Experience Framework"]
~~~

### 6.1 Ownership boundaries

| Component | Owns | Does not own |
|---|---|---|
| Control plane | Authentication/authorization, policies, sessions, leases, HITL, job states, audit | Local keyboard/mouse hardware |
| Host agent | Host registration, capability discovery, session process lifecycle, reconnect | Global user policy |
| Session worker | Browser driver, action dispatch, state/snapshots, local takeover control | Remote client identity decisions |
| Native host | Framed Chrome extension messaging and local IPC | User-facing API and persistent session lifecycle |
| Chrome extension | Browser-side observation and supported browser actions | Credentials policy, user approvals, external network control port |
| SDK/CLI/MCP | Typed access and user-friendly tooling | Direct privileged access to Chrome debugging ports |
| Web UI | User observation, secure answers, explicit approvals and takeover | Independent bypass of control-plane authorization |
| AEF | Optional experience ingestion and guidance | Authority to override user permissions |

### 6.2 Canonical execution path

A client authenticates to the control plane. The control plane authorizes the specific action on the specific session, records the operation, and dispatches it to the correct host worker. The worker uses a driver and returns a structured result or intermediate state. Large artifacts are referenced by short-lived, authorized handles rather than embedded in control messages.

A web page, content script, memory recommendation, or model response is **never** trusted as a source of authorization.

### 6.3 Central vs local deployments

The API and host agent may run in the same process/machine for standalone use or on different machines for distributed use. Distribution must change topology, **not** client commands, session IDs, authorization rules, or behavior.

---

## 7. Technology stack

The following are selected architectural preferences, not commitments to specific package versions.

| Layer | Default technology | Reason |
|---|---|---|
| Core runtime | Rust | Portable binaries, memory safety, async host infrastructure |
| Async engine | Tokio | Well-supported Rust async ecosystem |
| HTTP service | Axum | Typed routing, middleware, streaming |
| CLI | Clap | Native cross-platform CLI |
| Serialization | Serde | Versioned JSON data contracts |
| API specification | OpenAPI | Language-neutral SDK generation and documentation |
| Local persistence | SQLite | Standalone operations without an external database |
| Container integration | Docker/Podman adapter (e.g., Bollard) | Isolated per-session environments on Linux |
| Local IPC | Unix sockets on Linux; abstract transport interface | Narrow, private communication between worker and native bridge |
| Browser integration | Chrome MV3 extension in TypeScript | Direct access to Chrome extension APIs |
| Browser bridge | Chrome Native Messaging via Rust host | Local extension-to-native channel |
| Browser observation | DOM/accessibility-focused snapshots, supported extension APIs, optional CDP capabilities | High-quality semantic actions with visual fallback |
| Desktop input/viewer | Pluggable desktop driver; Selkies-based remote viewer as initial Linux option | Native dialogs, observations, human takeover |
| TypeScript SDK | TypeScript published as npm package | Adoption by agent builders and Node-based apps |
| MCP | Rust implementation with stdio and Streamable HTTP | No mandatory Node runtime on a deployed host |
| Dashboard | React + TypeScript | Sessions, approvals, secrets input, diagnostics |
| Telemetry | OpenTelemetry traces/metrics/logs using OTLP | Vendor-neutral instrumentation |
| Rust instrumentation | tracing, tracing-subscriber, tracing-opentelemetry, opentelemetry-otlp | Correlated diagnostics |
| Optional collector | OpenTelemetry Collector | Export routing, batching, processing |
| Optional memory | Independent AEF connector | Avoid coupling execution to learning infrastructure |

### Why hybrid Rust and TypeScript?

Rust owns **native, unattended infrastructure**. TypeScript owns **Chrome-native application code and web/developer experience**. An SDK user should not need Rust installed; an unattended Linux host should not require Node.js to keep its sessions alive. MCP and CLI may be compiled Rust tools while an npm SDK remains available.

### Dependency policy

Do not pin an unverified “latest” major release in the vision. Maintain toolchain/version choices in lockfiles and implementation READMEs, with CI testing against supported OS/browser versions.

---

## 8. Deployment and portability

### 8.1 Deployment modes

**Standalone:** One binary/service hosts the control API, agent, SQLite state, Chrome runtime, and optional dashboard. Useful for home servers, mini PCs, and development.

**Distributed:** A central control service manages multiple host agents. Agents establish outbound authenticated connections and register capabilities; inbound ports on each execution machine are not required.

**Containerized:** Publish multi-architecture OCI images for supported Linux targets. Chrome sessions may run in isolated containers with explicit resource limits and persistent profile volumes.

**Native host-agent:** Install a Rust agent and native messaging host on a compatible physical/virtual desktop system. Relevant OS session requirements are adapter-specific.

**Remote developer:** An SDK, CLI, or MCP client connects to an existing Hexactra server over authenticated HTTPS or a private overlay network.

### 8.2 Platform targets

| Platform | Intended role | Release priority | Important limitation |
|---|---|---|---|
| Linux x86_64 | Unattended browser host and control server | v1 first-class | Requires supported graphical runtime and Chrome/Chromium build |
| Linux ARM64 | Browser host where compatible binaries exist | Later validation | Chrome, graphics, and container compatibility vary |
| Windows x86_64/ARM64 | Client and future native host agent | Client early; host later | Interactive desktop/user-session restrictions differ from Linux |
| macOS | Client and future native host agent | Client early; host later | GUI permissions and user-session handling differ |
| Kubernetes | Control/worker scheduling | Future | Not required for standalone operation |
| Android/iOS | Remote dashboard/client | Future responsive UI | Not general unattended browser hosts |

**Portability means a stable public contract, not identical OS internals.** Linux unattended sessions are an explicit first milestone. Windows/macOS host capability should not be claimed until implemented and tested.

### 8.3 Operational requirements

- Support startup at boot without a logged-in Linux desktop user.
- Treat browser-profile directories as owned persistent volumes with strict permissions.
- Never mount the same writable Chrome profile into two active instances.
- Keep a crashed/restarting browser distinguishable from an intentionally stopped session.
- Permit host and API upgrades without silently discarding pending HITL requests.
- Do not require Redis, PostgreSQL, Kubernetes, an OTel collector, or AEF for v1.
- Never expose Docker control sockets, Native Messaging, raw DevTools/CDP ports, or unprotected desktop streams publicly.
- Use a reverse proxy and TLS when exposing a remote deployment; private-overlay transport is recommended initially.
- Support outbound host registration/reconnection with bounded retries, identity checks, and replay-safe commands.

---

## 9. Browser execution and driver architecture

### 9.1 BrowserDriver contract

The public API exposes **capabilities**, not implementation-specific Chrome commands. A conceptual driver contract is:

~~~typescript
interface BrowserDriver {
  capabilities(): Promise<DriverCapabilities>;
  navigate(input: NavigateInput): Promise<ActionResult>;
  snapshot(input?: SnapshotInput): Promise<BrowserSnapshot>;
  screenshot(input?: ScreenshotInput): Promise<ArtifactRef>;
  click(locator: Locator): Promise<ActionResult>;
  type(input: TypeInput): Promise<ActionResult>;
  keypress(input: KeypressInput): Promise<ActionResult>;
  scroll(input: ScrollInput): Promise<ActionResult>;
  tabs(): Promise<TabSummary[]>;
}
~~~

This illustrates intent; final interfaces and schemas must be versioned in the contract packages. Unsupported driver features yield explicit **UNSUPPORTED_CAPABILITY** results, never silent guesswork.

### 9.2 Driver implementations

1. **ChromeExtensionDriver — primary v1:** DOM/a11y-oriented discovery, navigation, tabs, interactions, and supported debugger access where permissions and Chrome APIs allow.
2. **DesktopInputDriver — required fallback:** pointer, keyboard, screen capture, native dialogs, and human takeover on the supported host/desktop.
3. **CDPDriver — optional:** carefully scoped local Chrome DevTools Protocol adapter; must not expose an unauthenticated debugging interface.
4. **Alternative browser drivers — future:** Chromium variants, Firefox, WebKit, OS accessibility APIs, or other adapters based on tested capability coverage.

Semantic locators (roles, accessible names, stable IDs, text, frame context) are preferred over raw screen coordinates where reliable. Screen-coordinate actions remain important when semantics are unavailable.

### 9.3 Browser command safety

- Identify the target session, tab, frame, document, and locator context.
- Guard against stale snapshots and navigations that invalidate an action.
- Use bounded timeouts, cancellation, and documented retry semantics.
- Report whether an operation may already have applied before a timeout; do not blindly replay non-idempotent clicks.
- Carry operation IDs, sequence IDs, version, and correlation IDs in internal messages.
- Permit screenshots/snapshots to be selectively redacted when sensitive UI is visible.
- Store screenshots as artifacts with access checks, retention limits, and expiring references.

### 9.4 Chrome extension and bridge

The MV3 extension communicates with the native messaging host using Chrome's supported API. Content scripts cannot call Native Messaging directly: messages are routed through extension-controlled contexts.

The native host is a narrow Rust process launched by Chrome. It translates framed JSON messages to a private local session-worker channel, manages reconnects, and validates message structure. Because Chrome controls its lifecycle, **it must not be the durable session manager**.

Respect Chrome Native Messaging size limits: send small control/event envelopes and use authenticated artifact storage for images or large snapshots. Keep diagnostics on stderr; stdout is reserved for the native message protocol.

### 9.5 Graphical browser and human observation

The Linux runtime provides a visible graphical Chrome instance inside a managed display environment. A remote viewer shows the same browser state to an authorized human. Human takeover suspends agent input through the central control lease; releasing takeover returns control only after the session is revalidated.

No capability should assume a human desktop login on the physical Linux host.

---

## 10. Canonical API and execution semantics

### 10.1 Public surfaces

- **HTTP API:** canonical service for sessions, profiles, actions, operations, HITL, artifacts, policies, and status.
- **TypeScript SDK:** typed client of the API; published to npm.
- **Rust CLI:** portable native client for scripting, operations, and local MCP adapter startup.
- **MCP:** selected agent-facing tools over stdio or authenticated Streamable HTTP, implemented as an adapter to the same authorization and operation services.
- **Dashboard:** authenticated human interface for session visibility, assistance, approval, and takeover.
- **Event stream:** SSE or WebSocket for status and interaction updates, with a durable catch-up API.

### 10.2 Conceptual API resources

~~~text
POST   /api/v1/sessions
GET    /api/v1/sessions
GET    /api/v1/sessions/{session_id}
POST   /api/v1/sessions/{session_id}/actions
GET    /api/v1/operations/{operation_id}
POST   /api/v1/operations/{operation_id}/cancel
POST   /api/v1/sessions/{session_id}/control-lease
POST   /api/v1/sessions/{session_id}/takeover
GET    /api/v1/profiles
GET    /api/v1/hosts
GET    /api/v1/interactions
GET    /api/v1/interactions/{interaction_id}
POST   /api/v1/interactions/{interaction_id}/respond
POST   /api/v1/interactions/{interaction_id}/cancel
GET    /api/v1/artifacts/{artifact_id}
GET    /api/v1/events
~~~

Routes are **proposed** and will be refined before implementation. Secret responses require a special protected path and must not appear in ordinary operation retrieval.

### 10.3 Session lifecycle

~~~text
CREATED -> PROVISIONING -> STARTING -> READY
                                    -> DEGRADED -> RECOVERING -> READY
                                    -> FAILED
READY -> STOPPING -> STOPPED
READY -> IDLE -> READY
~~~

An action can independently become **WAITING_FOR_HUMAN** while the underlying Chrome session remains open. Distinguish operation states from session states to avoid unnecessary teardown.

### 10.4 Operation lifecycle

~~~text
ACCEPTED -> AUTHORIZED -> QUEUED -> RUNNING -> SUCCEEDED
                                   |-> WAITING_FOR_HUMAN -> RUNNING
                                   |-> RETRYABLE_FAILURE
                                   |-> FAILED
                                   |-> CANCELLED
                                   |-> TIMED_OUT
~~~

Every operation is bound to a subject, session, permission scope, idempotency key where applicable, and trace/audit correlation IDs. Long-running actions return an operation handle and progress events. An MCP tool may yield a concise “interaction required” response or an operation reference according to client protocol capabilities; neither discloses the secret.

### 10.5 Lease and concurrency model

- Multiple clients may **observe** the same permitted session.
- Only one principal/role at a time may actively **inject input**.
- Human takeover preempts agent input after the current action reaches a safe boundary.
- Leases are short-lived, renewable, and released or expired on disconnect.
- Authorization is reevaluated before each sensitive action and at resume boundaries.
- A queued action cannot execute after the session owner revokes consent simply because it was accepted earlier.

---

## 11. Human in the Loop: first-class capability

**HITL is a mandatory core subsystem in v1, not an optional integration added after browser automation works.**

AI-driven UI tasks routinely encounter a boundary at which a human must supply knowledge, demonstrate possession, approve a change, or take direct control. Hexactra must handle this through structured state, not by asking an agent to improvise with credentials or MFA.

### 11.1 Requirements

1. Any authorized action or policy rule may request a human interaction.
2. An interaction must identify the requester, browser session, triggering operation, reason, target origin, expected answer type, and expiration.
3. The operation pauses safely without losing the browser profile or surrounding task context.
4. The human sees enough context to verify what they are being asked to do.
5. Responses are accepted only from an authorized, authenticated human or explicitly authorized future provider.
6. The system routes responses only to the permitted destination and resumes the intended operation.
7. Sensitive values are never returned to LLM prompts, MCP tools, ordinary SDK results, traces, logs, audit payloads, or AEF.
8. Every interaction can expire, be denied, be cancelled, or be abandoned.
9. A human can elect to **take over the browser** instead of providing a textual value.
10. Future notifier and vault providers must be interchangeable without changing browser-driver code.

### 11.2 HITL request taxonomy

| Request type | Examples | Expected v1 handling |
|---|---|---|
| SECRET_TEXT | Username, password, recovery field, application-specific secret | Protected human entry or takeover |
| OTP_CODE | SMS/email/TOTP one-time code | Protected short-lived input |
| OUT_OF_BAND_CONFIRMATION | Authenticator push, email approval link, mobile “approve sign in” | Prompt human to complete externally; human confirms, then runtime verifies website state |
| PASSKEY_OR_SECURITY_KEY | WebAuthn, platform passkey, FIDO security key, phone-as-key | Human takeover/local authenticator as supported; otherwise explicit blocked outcome |
| ACTION_APPROVAL | Send message, submit purchase, delete account, export sensitive data | Approve/deny with contextual scope |
| HUMAN_TAKEOVER | CAPTCHA, native dialog, ambiguous UI, unfamiliar challenge | Exclusive browser-control lease and viewer |
| INFORMATION_REQUEST | Nonsecret missing data required to continue | Typed human response |
| SECURITY_EXCEPTION_REQUEST | Site/operation blocked by explicit policy | No implicit bypass; require separately authorized policy change if allowed |

**Important distinctions:**
- Entering a code is not the same as approving an action.
- A human saying “approved” does not prove that a website's challenge succeeded; Hexactra must observe the website state.
- Some WebAuthn ceremonies cannot be completed through a remote viewer, even if the human can see the browser. Report the limitation and suggest a supported local flow.
- Hexactra supports a human completing an allowed CAPTCHA but does not attempt unauthorized evasion or automatic bypass.

### 11.3 v1 interaction channel: built-in human inbox

V1 implements a **Human Interaction Broker** and one concrete **BuiltInHumanProvider**:

1. Save the request's nonsecret metadata and pending state durably.
2. Publish an **interaction.required** event to authenticated, subscribed clients.
3. Display a pending item in the Hexactra dashboard's human inbox.
4. Permit the user to open a secure response page, verify the destination/site and task, and enter the required value or approve/deny.
5. For device-bound or graphical challenges, permit takeover of the browser where supported.
6. Resume the suspended operation only after checking authorization, freshness, one-time-use, lease state, and driver/browser state.

**No SMS delivery, email sending/reading, push-notification gateway, external chat bot, password manager, or credential vault integration is required or claimed for v1.** The event API and provider contracts make these possible later. If the user is not connected to the dashboard, the request remains pending until its expiration; an external notification is not guaranteed in v1.

The CLI and SDK may render a sanitized “human input required” notice and link to the authenticated dashboard. A headless MCP client can receive the same nonsecret request metadata.

### 11.4 HITL state machine

~~~text
CREATED -> PENDING_DELIVERY -> AWAITING_HUMAN -> CLAIMED -> RESPONDED
             |                     |               |          |
             |                     |               |          -> CONSUMED -> RESUMED
             |                     |               -> EXPIRED
             |                     -> DENIED
             -> DELIVERY_FAILED / RETRYING

Any pending state -> CANCELLED
Any terminal state: immutable except permitted audit annotations
~~~

State transitions must be atomic and replay-safe. Claim/response operations use optimistic version checks or equivalent concurrency guards. A response is tied to one interaction ID and cannot be replayed on another session or website.

### 11.5 Interaction request schema (conceptual)

~~~json
{
  "interaction_id": "hint_01EXAMPLE",
  "schema_version": "1",
  "session_id": "sess_01EXAMPLE",
  "operation_id": "op_01EXAMPLE",
  "requesting_principal": "agent:example",
  "owner_principal": "user:example",
  "kind": "OTP_CODE",
  "reason_code": "AUTH_CHALLENGE",
  "display": {
    "title": "Authentication code required",
    "message": "Enter the code you received to continue sign-in.",
    "site_origin": "https://example.com",
    "requested_fields": [
      { "name": "code", "type": "secret", "max_length": 12 }
    ]
  },
  "destination": {
    "kind": "BROWSER_FIELD",
    "session_bound": true,
    "origin_bound": true
  },
  "status": "AWAITING_HUMAN",
  "expires_at": "2026-10-15T23:30:00Z",
  "trace_id": "example-trace-id"
}
~~~

This is an illustrative schema, not a deployed endpoint or claim that each field is final. In practice, **the request for a secret must not itself include a saved value**. The secret response travels through a protected channel and is consumed once.

### 11.6 Secret response handling

For username, password, OTP, and recovery codes:

1. The human authenticates to the dashboard independently of the target website.
2. The UI clearly displays the website origin, requesting session, requested fields, and why the information is needed.
3. Input is submitted over an authenticated TLS-protected channel; use appropriate CSRF defenses and session-bound authorization.
4. Secret material is held only as long as necessary in a constrained, ephemeral server/worker handoff; never store it in the ordinary interaction row.
5. The control service delivers the value only to an authorized, bound execution destination; the worker injects it into the intended browser control or uses the approved takeover path.
6. The secret is never returned to the agent's tool response or stored as retrievable browser snapshot data by Hexactra. Redact before exporting artifacts where technically possible.
7. After application, report only a sanitized result such as **provided**, **applied**, **rejected**, **expired**, or **human action required again**.
8. Zeroize/clear transient buffers on a best-effort basis and expire the secret reference. Do not promise perfect memory erasure in managed runtimes.
9. On origin mismatch, session/profile change, cancellation, approval revocation, or expiration, reject and discard the response.

**Security reality:** any website receiving credentials can observe those values; Hexactra cannot guarantee that a compromised site or browser will not capture them. Keep the trust boundary explicit. Offer browser takeover as the preferred path when safer than relaying sensitive values through the runtime.

### 11.7 HITL sequence: SMS/email OTP

~~~mermaid
sequenceDiagram
  participant A as External Agent
  participant C as Hexactra Control Plane
  participant B as Browser Worker
  participant H as Authorized Human
  A->>C: Request browser action
  C->>B: Execute authorized action
  B-->>C: Authentication challenge detected
  C->>C: Persist nonsecret HITL request and pause operation
  C-->>A: interaction_required + operation reference
  C-->>H: In-app inbox/event notification
  H->>C: Authenticated one-time OTP submission
  C->>C: Check owner, TTL, origin, session, state
  C->>B: Protected, one-use secret handoff
  B->>B: Enter OTP in bound browser context
  B-->>C: Site result observed
  C-->>A: Sanitized operation result
~~~

### 11.8 HITL sequence: phone prompt, passkey, or security key

- Issue **OUT_OF_BAND_CONFIRMATION** if the user must respond on a separate trusted device.
- Give clear, contextual instructions but do not ask the agent to impersonate the authenticator.
- For a passkey or hardware security key, offer **HUMAN_TAKEOVER** when the local execution environment and authentication device allow it.
- Where browser and authenticator support require local presence and that presence is unavailable, return **HUMAN_ACTION_UNSUPPORTED_ON_THIS_HOST** rather than inventing a bypass.
- After the user acts, independently check the page/navigation/authentication state before declaring success.

### 11.9 HITL safety and authorization

- Human answers are not general instructions to the agent.
- The dashboard must make malicious or mismatched website origins visible and may require an extra warning for unusual sites.
- A request can be fulfilled only by the bound owner or an explicitly delegated approver.
- Agents cannot fabricate human responses or self-approve privileged actions.
- Restrict which actions a human approval authorizes: include session, action type, target, parameters where possible, expiration, and single-use semantics.
- High-impact actions (payments, irreversible changes, sending sensitive data) may require a separate **ACTION_APPROVAL**, even after successful login.
- The input request must be initiated by trusted runtime detection/policy, not by obeying arbitrary instructions embedded on a website.
- A failed or suspicious challenge should not automatically trigger repeated OTP prompts indefinitely; add request quotas/backoff and abuse safeguards.

---

## 12. Future provider hooks: notifications and credentials

V1 must provide the **abstraction seams**, while implementing only the human provider. Future integrations should plug in without changing browser automation contracts.

### 12.1 HumanInteractionProvider

~~~typescript
interface HumanInteractionProvider {
  id: string;
  capabilities(): InteractionCapability[];
  deliver(request: PublicInteractionRequest): Promise<DeliveryReceipt>;
  cancel(interactionId: string): Promise<void>;
}
~~~

The provider **delivers a prompt or access path**, not necessarily a secret. The trusted Human Interaction Broker remains responsible for recording the response, enforcing authorization, and resuming the operation.

Possible later providers: email notification, SMS, mobile push, Slack, Teams, webhooks, and custom self-hosted notification services. Each must have an explicitly authorized owner mapping and a secure return channel.

### 12.2 CredentialProvider

~~~typescript
interface CredentialProvider {
  id: string;
  capabilities(): CredentialCapability[];
  resolve(input: CredentialRequestContext): Promise<CredentialResolution>;
}
~~~

Possible later providers: local encrypted credential store, operating-system keychain, 1Password, Bitwarden, HashiCorp Vault, cloud secret managers, or a user-supplied provider adapter.

**Design constraints for future vaults:**
- Resolve by **logical credential reference + origin + principal + approved purpose**, not by asking an agent for an arbitrary password.
- Prefer opaque secret handles and a trusted worker injection pathway rather than disclosing raw values to agent code or the model.
- Keep provider credentials separate from target website credentials.
- Scope permissions to particular profiles, origins, users, and actions.
- Support access revocation, rotation, expiration, and provider errors.
- Allow policy to require fresh human approval even when a vault holds a credential.
- Never ingest vault secrets into OTel, operation results, or AEF.
- A missing/unavailable vault must gracefully fall back to HITL human entry if policy permits.

### 12.3 Resolution policy and provider selection

Future policy can rank **safe existing browser session -> approved credential provider -> human request -> blocked**. This ordering is configurable and never silently escalates permissions. Human presence remains mandatory for operations requiring fresh possession or consent.

Conceptual extension points:

~~~text
InteractionBroker
  ├── BuiltInHumanProvider          [v1]
  ├── EmailNotificationProvider     [future]
  ├── SMSNotificationProvider       [future]
  ├── MobilePushProvider            [future]
  ├── ChatNotificationProvider      [future]
  └── CustomWebhookProvider         [future]

CredentialResolver
  ├── NoVaultProvider               [v1]
  ├── LocalSecureStoreProvider      [future]
  ├── ExternalVaultProvider         [future]
  └── CustomCredentialProvider      [future]
~~~

No third-party connector is silently enabled, and no incoming webhook can supply a secret without authenticated owner binding and request-level authorization.

### 12.4 How requests become automatable later

The API must make requests machine-readable and policy-controlled from day one. A future approved connector can notify a user, receive a protected reply, or retrieve a permitted credential from a vault. The automation is in *routing and handling known request types*, not in removing the human authority required by the website, device, or policy.

---

## 13. Identity, policy, and threat model

### 13.1 Principals and scopes

Distinct principals include **human user**, **external agent/client**, **host agent**, **service account**, and **connector identity**. API credentials may be scoped to actions like session observe, navigate, input, manage profile, request HITL, answer HITL, and administer hosts.

The control plane authorizes **who may perform which action on which session/profile under what conditions**. Browser ownership and HITL answer rights are not inferred from possession of a URL.

### 13.2 Trust boundaries

1. Internet/agent client to authenticated control API.
2. Control plane to registered host agent.
3. Host agent to sandboxed browser worker.
4. Session worker to Native Messaging bridge and Chrome extension.
5. Trusted extension logic to untrusted website DOM/content.
6. Human dashboard to secret handoff destination.
7. Telemetry/audit/experience pipelines to their downstream stores.

### 13.3 Non-negotiable security requirements

- TLS for remote API/control connections; certificate and token validation.
- Outbound host registration with per-host identity, revocation, and least privilege.
- No public unauthenticated desktop viewer, CDP port, native IPC socket, or Docker control socket.
- Validate and minimize extension permissions; scope allowed native origins/extension IDs.
- Isolate browser profiles and containers by owner/trust boundary.
- Per-session exclusive input leases and explicit human takeover.
- Treat DOM text, website screenshots, downloaded files, and content-script events as untrusted.
- Defend against prompt injection, phishing attempts, malicious pages, cross-origin confusion, request replay, and confused-deputy failures.
- Apply rate limits to OTP prompts, credential requests, approval attempts, and login retries.
- Secure default retention for audit, artifacts, and session data; delete/expire by policy.
- Encrypt sensitive data at rest where persisted (profile storage requires careful key/OS support); **do not persist v1 submitted OTP/password values by default**.
- Show origin and target context before human enters credentials or approves irreversible actions.
- Allow the owner to terminate a session, revoke agents, revoke leases, and delete browser profiles.
- Log denial/approval decisions without logging sensitive values.
- Treat remote websites' terms, rate limits, and authentication requirements as constraints, not obstacles to bypass automatically.

### 13.4 Recommended v1 exposure model

Initially support private networks such as Tailscale and an optional authenticated HTTPS reverse proxy. Public exposure requires hardened authentication, TLS, Origin checks, rate limits, CSRF protection for dashboard workflows, and authenticated remote viewing. Never assume that knowing the session ID is sufficient authorization.

### 13.5 Audit is not telemetry

Every sensitive authorization, takeover, secret request completion (metadata only), action invocation, state transition, and credential-provider use should have an independently durable audit record. Audit capture is not optional just because telemetry export is turned off.

---

## 14. OpenTelemetry and observability

OTel is a **first-class cross-cutting architectural feature**. It must be usable without a collector but capable of exporting vendor-neutral OTLP data when configured.

### 14.1 Three signals

**Distributed traces**
- Request/operation lineage across SDK/MCP/CLI, API, dispatcher, host agent, worker, local bridge, and extension.
- Start/end times, bounded operation types, success/failure categories, and links to session/operation IDs (privacy-safe).
- Trace-context propagation across trusted HTTP and internal messaging envelopes.
- Explicit spans for queued execution, native message transit, action completion, and time awaiting human response.
- **Waiting for a human should be modeled without keeping expensive open spans indefinitely**; link the original operation trace to resume/completion traces and record a wait-duration metric.

**Metrics**
- Sessions by lifecycle state, failed launches, unexpected browser exits, worker/host heartbeats, action latency/error rates, timeouts.
- HITL pending/completed/denied/expired counts and response latency, **without secret value or full account identifiers**.
- Resource utilization and artifact-store size.
- Host reconnect counts, queue depth, profile-lock conflicts, takeover frequency.
- Avoid high-cardinality user IDs, full URLs, interaction IDs, and session IDs as metric labels.

**Structured diagnostic logs**
- Component, severity, timestamp, correlation ID, sanitized status/error code.
- Never log password/OTP contents, cookie material, full form fields, access tokens, or raw secret-provider responses.

### 14.2 OpenTelemetry implementation design

- Rust: structured tracing with OpenTelemetry bridge and OTLP exporter.
- TypeScript SDK: optional instrumentation via the OTel API; no dependency on a specific backend.
- Chrome extension: bounded, lightweight structured events correlated through internal message IDs; avoid heavyweight extension-runtime dependencies.
- HTTP OTLP export to an optional local or remote OTel Collector.
- Graceful behavior when exporter unavailable; telemetry export failure cannot prevent a browser action from executing.
- Configurable sampling, redaction, resource attributes, endpoint, timeouts, and export enabled/disabled.
- Trace context must **not** be injected into arbitrary website requests.

The current upstream Rust OTel ecosystem distinguishes maturity levels among signals; verify instrumentation package compatibility at implementation time.

### 14.3 Three independent data planes

| Plane | Purpose | Examples | Retention rule |
|---|---|---|---|
| Operational telemetry | Performance and diagnosis | Browser click latency, crashes, traces | Configurable, possibly sampled |
| Execution/audit store | Authoritative state and accountability | Action attempted, human approved, session recovered | Durable and policy-defined |
| Agent Experience data | Optional learning and reuse | Sanitized lessons, site navigation patterns, failure recovery | Independent opt-in policy |

OTel spans are **not** a substitute for durable work state and are **not** a credential storage or experience memory mechanism.

### 14.4 Baseline dashboards/alerts

Provide useful documentation or sample dashboards for session health, action latency/errors, host reachability, HITL wait duration, and browser crashes. Add alerts for failed host heartbeats, repeated native messaging disconnects, high failure rates, and an unusual volume of credential requests.

---

## 15. Durable state, profiles, artifacts, and recovery

### 15.1 Minimal v1 storage model

Use SQLite for standalone control-plane metadata and durable event state. Conceptual tables/entities:

- users/principals and API credential metadata
- registered hosts and reported capabilities
- browser profiles and ownership
- sessions and lifecycle status
- operations and status transitions
- leases and takeover state
- interaction requests and nonsecret answers/approval metadata
- execution/audit events
- artifact metadata and access policies
- connector/provider registrations (schema reserved for future use)

**Do not** put raw passwords/OTP values in SQLite interaction rows. Large snapshots and screenshots belong in a separately controlled artifact store with retention and owner-scoped access.

### 15.2 Profile model

- One writable owner per running browser profile.
- Stable profile identifiers and explicit human-friendly aliases.
- Profile-level host affinity or carefully coordinated migration; Chrome profile directories are not assumed safe for simultaneous access.
- Separate ephemeral and persistent profiles.
- Per-profile backup/export and deletion mechanisms after security review.
- Cookie and website auth persistence follows site/browser behavior; never guarantee indefinite login.

### 15.3 Recovery behavior

- Client disconnect: operation and browser continue or pause according to durable server state.
- Agent/host disconnect: mark host unavailable; do not claim command success; reconcile operation idempotently on reconnect.
- Native bridge crash: reconnect and revalidate browser state without silently replaying a potentially executed click.
- Chrome crash: record failure, attempt bounded restart if policy permits, preserve profile integrity.
- Human request expiry: transition operation to an explicit terminal or policy-defined recoverable state.
- Server restart: reload durable operations/interactions; reconcile with live hosts.
- Browser profile locked: fail cleanly; never corrupt it by force-opening duplicate writers.
- Takeover interrupted: expire lease; require reassessment before automation resumes.

---

## 16. Remote API, SDK, CLI, and MCP experience

### 16.1 SDK

Publish **@hexactra/sdk** for TypeScript consumers. The SDK should expose typed sessions, profiles, host capabilities, browser actions, artifacts, operation polling/event subscription, takeover requests, and sanitized HITL metadata.

The SDK should support asynchronous operations, cancellation, errors, and idempotency. It must not automatically relay secrets into application logs or model contexts.

~~~typescript
import { Hexactra } from "@hexactra/sdk";

const hx = new Hexactra({
  baseUrl: process.env.HEXACTRA_URL!,
  apiKey: process.env.HEXACTRA_API_KEY!
});

const session = await hx.sessions.start({ profile: "personal" });
await hx.browser.navigate(session.id, "https://example.com");

const snapshot = await hx.browser.snapshot(session.id);
console.log(snapshot);

// An operation requiring human input returns a sanitized
// interaction reference; the human responds in Hexactra's UI.
~~~

Example API is illustrative, not a promise that these precise symbols already exist.

### 16.2 CLI

The compiled Rust CLI should work on development machines without running Chrome locally.

~~~bash
hexactra login
hexactra hosts list
hexactra profiles list
hexactra sessions start --profile personal
hexactra browser navigate --session sess_123 https://example.com
hexactra browser snapshot --session sess_123
hexactra interactions list
hexactra interactions open hint_123
hexactra sessions takeover sess_123
hexactra sessions stop sess_123
~~~

Commands are proposed. The CLI must never print submitted secret values into shell history or CI logs, and should prefer opening the protected dashboard for human credential input.

### 16.3 MCP

Expose a selected, coherent set of browser/session tools with sanitized outcomes:

~~~text
hexactra_session_start
hexactra_session_status
hexactra_session_stop
hexactra_navigate
hexactra_snapshot
hexactra_click
hexactra_type
hexactra_screenshot
hexactra_request_human
hexactra_interaction_status
hexactra_request_takeover
~~~

The MCP service delegates to the same control plane. Avoid exposing a generic “execute arbitrary shell on host” primitive in v1. Sensitive approval resolution and secret submission must remain out of ordinary MCP tool results.

Support local **stdio MCP** and authenticated remote **Streamable HTTP** where feasible. A local stdio adapter can simply connect to a remote API; it should not require a local browser.

### 16.4 Developer experience quality bar

- Stable versioned API schemas and SDK types.
- Good errors: e.g., SESSION_NOT_READY, PROFILE_IN_USE, INTERACTION_REQUIRED, APPROVAL_DENIED, HOST_OFFLINE, ORIGIN_MISMATCH, UNSUPPORTED_CAPABILITY.
- Example applications for CLI, SDK, and MCP.
- Reproducible local startup and integration tests.
- Structured operation results and observable progress, not silent blocking for minutes.
- Safe cancellation/timeout behavior and documentation of irreversible commands.

---

## 17. Agent Experience Framework: independent product boundary

Hexactra is the **action executor**; the proposed independent Agent Experience Framework (AEF) is a future **memory and guidance subsystem**. It is not a prerequisite for v1.

Optional integration may:
- Ingest sanitized action outcomes and failure patterns with consent.
- Store reusable hints and partial skills across analogous websites.
- Recall navigation strategies and evaluate whether retrieval reduces agent steps.
- Retain provenance, freshness, permissions, and feedback separately from operational logs.
- Use future graph/vector providers without affecting Hexactra execution availability.

The AEF must not:
- Store OTP/password contents, cookies, security tokens, or raw sensitive form values.
- Grant permissions or approve actions.
- Force deterministic workflow replay where adaptable reasoning is still required.
- Become the authoritative source of session state or audit evidence.

Integration should be through a separate SDK/HTTP API or events, with explicit opt-in and redact-before-export processing.

---

## 18. Repository and packaging strategy

A **single monorepo** is recommended initially, combining Rust/Cargo and TypeScript/pnpm workspaces.

~~~text
hexactra/
├── VISION.MD
├── README.md
├── Cargo.toml
├── pnpm-workspace.yaml
├── api/
│   ├── openapi.yaml
│   └── schemas/
│       ├── actions/
│       ├── events/
│       └── interactions/
├── crates/
│   ├── hexactra-control/       # Rust control plane/API
│   ├── hexactra-agent/         # Rust host agent
│   ├── hexactra-worker/        # Rust session worker
│   ├── hexactra-native-host/   # Chrome native messaging bridge
│   ├── hexactra-cli/           # Rust CLI
│   ├── hexactra-mcp/           # Rust MCP adapter
│   ├── hexactra-core/          # Domain model, policy, state, HITL
│   └── hexactra-telemetry/     # OTel and structured diagnostics
├── packages/
│   ├── sdk/                    # @hexactra/sdk
│   └── contracts/              # Generated TS types
├── apps/
│   ├── chrome-extension/       # MV3 TypeScript
│   └── dashboard/              # React TypeScript
├── deploy/
│   ├── systemd/
│   ├── docker/
│   └── examples/
├── docs/
│   ├── architecture/
│   ├── security/
│   ├── hitl/
│   ├── observability/
│   └── deployment/
└── tests/
    ├── protocol/
    ├── end-to-end/
    ├── security/
    └── interoperability/
~~~

This is the **target organization**, not a claim that the directories already exist.

### 18.1 Binaries and packages

- **hexactrad:** Rust control daemon/server.
- **hexactra-agent:** Rust host agent (or a role of the daemon).
- **hexactra-native-host:** Rust Native Messaging executable.
- **hexactra:** compiled CLI, optionally providing a local stdio MCP bridge.
- **@hexactra/sdk:** npm TypeScript SDK.
- **Chrome extension:** signed/unpacked build artifact depending on installation mode.
- **OCI images:** supported Linux server and browser host runtime distributions.

Exact binary/process consolidation is an implementation choice; logical responsibilities and security boundaries remain separate.

### 18.2 Build and release expectations

- GitHub Actions CI for Rust, TypeScript, API schema checks, and integration tests.
- Cargo workspace, pnpm workspace, reproducible builds and lockfiles.
- Linux x86_64 native binaries and OCI image first.
- Signed release artifacts/checksums; SBOM and vulnerability scanning as release hardening.
- Explicit compatibility matrix for browser versions, extension versions, and protocol versions.
- Database migration strategy and version negotiation for independently updated agents.

---

## 19. Implementation plan and milestones

Build **vertical slices** through the complete system before proliferating interfaces.

### Phase 0 — Contracts and threat model

- Define session/action/operation/HITL schemas and error taxonomy.
- Define role/scope model, control leases, privacy boundaries, and secret handling.
- Record architecture decisions on in-memory secret lifetime, browser isolation, and origin checks.
- Set up Cargo/pnpm workspaces, linting, builds, CI, and minimal telemetry.

**Exit:** contract review, core threat model, passing scaffold CI.

### Phase 1 — Unattended Linux browser runtime

- Launch real Chrome graphically on an unattended Linux host.
- Manage persistent and ephemeral profiles.
- Start/stop/restart browser sessions.
- Enable authenticated remote viewing.
- Verify host boot -> Chrome session without a human OS login.

**Exit:** an authorized remote operator can create, observe, stop, and resume a profile-backed session.

### Phase 2 — Extension, bridge, driver, and actions

- Build the TypeScript Chrome MV3 extension.
- Build the Rust Native Messaging host with versioned envelopes.
- Add semantic snapshots and primary navigation/click/type interactions.
- Add desktop-input fallback and capability discovery.
- Return artifacts via authorized references.
- Capture initial OTel spans, metrics, and structured logs.

**Exit:** a remote client can navigate, inspect, click, type, and screenshot through the control API.

### Phase 3 — Durable operations, permissions, and remote agents

- Implement SQLite-backed operations, session leases, audit events, and idempotency policy.
- Add token/scoped authorization and bound host enrollment.
- Support disconnect/reconnect/reconciliation without duplicate side effects.
- Prove use from a second machine over authenticated HTTPS/private overlay.

**Exit:** a session survives client disconnects and reliably rejects unauthorized or conflicting input.

### Phase 4 — HITL v1 (must ship in first release)

- Implement the Human Interaction Broker, request taxonomy, durable state machine, and event stream.
- Build the dashboard inbox and protected response UI.
- Support OTP, username/password, nonsecret answer, approval/deny, out-of-band confirmation, and takeover workflows.
- Enforce single-use response, origin/session binding, TTL, cancellation, and redaction.
- Add integration tests for SMS-style OTP, push-auth confirmation, and unsupported passkey paths.

**Exit:** an agent pauses at authentication; the user can provide input or take over; the agent resumes; no secret reaches the public tool result or telemetry.

### Phase 5 — SDK, CLI, and MCP

- Publish first TypeScript SDK.
- Ship compiled Rust CLI.
- Expose policy-compatible MCP stdio and HTTP tools.
- Provide examples and conformance tests verifying equivalent behavior across clients.

**Exit:** an external MCP agent or SDK application can complete the same authorized browser workflow with the same HITL semantics.

### Phase 6 — V1 hardening and release

- Add health dashboards, export configuration, alerts, artifact retention, backup/recovery documentation, and security hardening.
- Test crash recovery, profile contention, operator takeover, disconnected hosts, and secret redaction.
- Publish Linux installation instructions and supported environment matrix.

**Exit:** v1 acceptance criteria are met; no future provider is needed for basic operation.

### Later phases (not v1 commitments)

- Notification channel plugins: SMS, email, mobile push, collaboration tools.
- Credential-provider adapters: local secure store, external vaults, user-defined providers.
- Windows/macOS host-agent drivers with OS-specific session and consent architecture.
- Additional browsers, native desktop apps, richer accessibility control.
- Advanced policy, enterprise identity, multi-tenant deployment, HA storage and orchestration.
- Independent AEF integration, learning evaluation, and reusable interaction skills.
- Broader deployment automation, fleet management, and scheduling of agent tasks.

---

## 20. Definition of done for version 1

Hexactra v1 is ready when all of the following are demonstrably true:

### Runtime and portability
- [ ] Real graphical Chrome starts unattended on the supported Linux environment.
- [ ] Persistent profiles survive session restarts without simultaneous-writer corruption.
- [ ] Native binary and documented container deployment work without a mandatory cloud dependency.
- [ ] A separate computer can connect using an authenticated API.

### Execution
- [ ] Sessions can start, stop, navigate, snapshot, click, type, and take screenshots.
- [ ] Capabilities and unsupported actions are explicit.
- [ ] Browser worker and Native Messaging failure paths are handled.
- [ ] Client disconnect does not accidentally destroy a persistent session.
- [ ] One writer/takeover lease is enforced per interactive session.

### Human in the Loop
- [ ] Login requiring human username/password input can pause/resume safely.
- [ ] OTP from SMS, email, or authenticator can be provided manually through the protected UI.
- [ ] Push-approval request can pause until the human acts externally and the site result is verified.
- [ ] Hardware/passkey challenge offers supported human takeover or an explicit unsupported outcome.
- [ ] Approval and denial paths work independently of authentication prompts.
- [ ] Interactions expire, cannot be replayed, and are bound to owner/session/origin.
- [ ] Agent/MCP/SDK results contain no secret responses.
- [ ] External notifier/vault providers are not required or falsely advertised as implemented.

### Observability and security
- [ ] Distributed traces correlate trusted control-plane and runtime operations.
- [ ] Metrics cover sessions, actions, browser failures, and HITL wait time.
- [ ] Structured logs are redacted by default.
- [ ] Durable audit records are independent of OTel sampling/export.
- [ ] Tests reject unauthorized access and prove sensitive values do not appear in standard logs, API events, artifacts, or trace attributes.
- [ ] Public browser debugging and native host ports are not exposed.

### Developer experience
- [ ] API contract and errors are documented and versioned.
- [ ] TypeScript SDK, Rust CLI, and MCP workflows are usable from another machine.
- [ ] End-to-end demo includes an authentication challenge handled by a human.
- [ ] Installation, configuration, upgrading, and local troubleshooting are documented.

---

## 21. Quality, tests, and evaluation

### 21.1 Required test layers

- **Unit:** policy, state machines, interaction TTL, type validation, redaction, idempotency.
- **Contract:** Rust/TypeScript serialization parity, API version negotiation, MCP tool schemas.
- **Integration:** daemon ↔ agent ↔ worker ↔ native bridge ↔ extension.
- **End-to-end:** real Chrome, persistent profile, navigation, OTP prompt, human takeover, resume.
- **Fault injection:** extension disconnect, browser crash, expired OTP, host reconnect, double-submit, retry after unknown outcome.
- **Security:** malicious page messages, untrusted DOM text, CSRF, unauthorized HITL answers, profile isolation, trace/log secret leaks.
- **Compatibility:** supported Chrome versions and Linux images; later OS-specific test matrices.
- **Performance:** action throughput, latency, session startup, memory footprint, idle resource usage, HITL response time.

### 21.2 Meaningful product metrics

- Browser session start success rate.
- Median and tail action latency.
- Successful completion rate for permitted workflows.
- Recovery rate from transient browser/host failures.
- Repeated-action rate and avoidable agent tool loops.
- HITL completion/expiry/deny percentages and median wait time.
- Unauthorized access attempts blocked.
- Number of secret/PII telemetry leaks (release target: zero in controlled test suites).
- Profile corruption incidents (target: zero in controlled tests).
- Fraction of unsupported operation requests clearly reported rather than incorrectly claimed successful.

Do not use a single “agent completed task” metric as a substitute for security, user satisfaction, reliability, and truthfulness of outcomes.

---

## 22. Architectural decisions and open questions

### Decisions established by this vision

1. Project name is **Hexactra**.
2. Rust owns native control/service/agent/CLI infrastructure; TypeScript owns Chrome extension and primary npm SDK/dashboard.
3. The canonical execution authority is the control plane; CLI and MCP do not bypass it.
4. Linux graphical Chrome is the initial host runtime and product milestone.
5. A browser-driver abstraction separates public actions from Chrome-specific mechanisms.
6. Persistent profiles, authenticated distributed access, and remote takeover are first-class.
7. HITL with a built-in human responder ships in v1.
8. Notification and credential-vault integrations are future plugin implementations with contracts designed now.
9. OTel is built in; exporter/collector deployment remains optional.
10. Durable execution/audit and optional AEF memory are independent from telemetry.
11. Standalone installation requires no mandatory Redis, PostgreSQL, Kubernetes, or Node.js runtime.
12. Security policy, origin binding, least privilege, and secret redaction are mandatory.

### Questions to resolve through architecture decision records (ADRs)

- Whether the standalone server and host agent share a process or only share crates.
- Which Linux graphical display stack and viewer transport deliver best unattended reliability.
- Whether to use Docker, Podman, or both in the first supported release.
- How to distribute, sign, and update the extension when using persistent local Chrome profiles.
- Which Chrome extension permissions/CDP domains are justified and reliable in target versions.
- Exact secret handoff implementation and threat-model review before the first credential flow ships.
- Which authentication mechanism is used for remote human dashboard users in standalone mode.
- Whether to permit browser-initiated automatic HITL detection versus explicit agent request plus policy heuristics.
- Artifact storage layout and default retention, especially around screenshots during authentication.
- How to support host migration without violating Chrome profile locking and encryption boundaries.
- Open-source license and contribution/security disclosure policies.
- When to introduce a central relational database for distributed/high-availability operation.

Open questions must not undermine the required functional or security invariants above.

---

## 23. Product positioning

**Hexactra is a computer-use infrastructure layer, not another agent framework.**

It should make it straightforward for any authorized agent to request computer actions on a real, persistent, remotely hosted session. It should make the intervention of a human feel like a controlled part of execution, not a failure or a workaround. And it should make the resulting behavior understandable through tracing, audit evidence, and operator observation.

The initial demo can be a browser controlling one site. The underlying product is intentionally broader: **a portable, secure, observable execution plane for human-like interaction with software**.

The long-term ambition is to reduce the friction between agents and the real application environments in which people work, while preserving user consent, authentication boundaries, and the ability to intervene at any time.

---

## 24. Background and technical references

Background concept paper (earlier, separate design exploration):

- [Remote Control & Agent Experience architecture paper](https://gist.githubusercontent.com/marinoscar/df576b62371b06e4f007e321e9e56fde/raw/66b0ed0a30ad3b2038af22f6a6b221b437071f70/remote_control_and_agent_experience_architecture_paper.md)

Primary upstream implementation references (verify exact versions during implementation):

- [Chrome Extensions — Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome Extensions — API reference](https://developer.chrome.com/docs/extensions/reference/api/)
- [Chrome Extensions — Message passing and security](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/)
- [OpenTelemetry documentation](https://opentelemetry.io/docs/)
- [OpenTelemetry Rust instrumentation](https://opentelemetry.io/docs/languages/rust/)
- [OpenTelemetry context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)

**Document rule:** this vision records intended product behavior and architectural boundaries. Individual sections may describe future capabilities and conceptual APIs; they must not be presented as already implemented. As code is shipped, track implementation status in project plans, ADRs, API specifications, and release notes rather than editing the vision to imply unfinished components exist.
