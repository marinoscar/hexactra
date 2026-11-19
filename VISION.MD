# Hexactra — Product Vision and Technical Architecture

> **Status:** Foundational vision and proposed architecture (not a statement of shipped capabilities). Sections 26 and 27, and the status notes in Sections 11 and 12.2, record what is implemented in this repository; implemented does not mean proven on a deployed stack.  
> **Repository:** https://github.com/marinoscar/hexactra  
> **Document version:** 1.2  
> **Date:** November 16, 2026  
> **Product:** Hexactra  
> **Tagline:** Human-like interaction. Agent-powered execution.

---

## 1. Executive summary

**Hexactra is a portable, self-hostable computer-use runtime that allows authorized AI agents to operate real applications through the same graphical interfaces that humans use.** It exposes a consistent control surface through an HTTP API, an SDK, a CLI, and Model Context Protocol (MCP). It runs persistent graphical browser sessions on remote hosts, even when nobody is logged into the host operating system, while keeping human operators in control of access, authentication, and high-impact actions.

The initial focus is **real graphical Chrome on Linux**, with persistent browser profiles, retained website sessions, a Chrome Manifest V3 extension, a local native-messaging bridge, and a Rust session runtime. **The Chrome extension must also be a usable, standalone AI browser assistant** with built-in chat, AI provider/model settings, and direct control of permitted browser tabs; running a Hexactra server must not be mandatory for local browser automation. The architecture must not tie the public API to Chrome or Linux: future adapters can control other browsers and desktop applications, and host agents can eventually run on Windows and macOS where the operating system permits.

**Hexactra has a built-in AI browser/computer-use agent as well as interfaces for externally hosted agents.** A human can open the Chrome extension, choose an OpenAI-compatible model, enter a natural-language goal, and let the built-in agent observe the browser, plan actions, execute them through the extension, verify results, and request human assistance as needed. External agents can also use Hexactra through its SDK, CLI, HTTP API, and MCP. The platform does not itself train or host foundation models by default.

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
2. **Unattended hosting on machines you own:** launch real, headful Chrome sessions on a Linux node with no interactive host-user login. The primary node is a machine on the owner's **residential network** (for example a mini PC at home), because many sites block or challenge datacenter IP addresses; the node connects outbound over HTTPS and needs no inbound port. See [docs/nodes.md](docs/nodes.md).
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
14. **Built-in AI execution:** observe, reason, act, verify, and replan toward a natural-language goal.
15. **Standalone extension:** native Side Panel chat, model/provider configuration, and real browser-control tools without a daemon for ordinary browser interactions.
16. **OpenAI-compatible models:** custom API base URL, API key, model ID, optional inference parameters, and capability-based interoperability with cloud or self-hosted providers.
17. **Remote session startup:** a remote API/MCP/CLI caller can cause a boot-time Linux daemon to launch visible Chrome using a specified persistent profile even when nobody is logged into the host.

### 3.2 Non-goals for version 1

- Building or hosting a foundation model.
- Replacing Claude Code, OpenCode, Pi, or other general-purpose agent frameworks. Hexactra **does include** its own purpose-built goal-driven computer-use agent and also works with external frameworks.
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

**A human emulator with its owner's full powers.** Hexactra is the owner's own hands and eyes on their own computer (Section 27). The agent may do anything the owner could do sitting at the machine: see the screen, click and type anywhere with real input, run JavaScript in the page, and use the OS desktop. Controls that exist only to limit the agent are opt-in per task. Controls that protect the owner stay on, because they cost the agent nothing: secrets never reach the model, Stop and takeover always work, and every action is audited.

---

## 4. Users and representative scenarios

### 4.1 Target users

- Developers embedding computer-use in agentic applications.
- Operators automating repeatable workflows across SaaS applications.
- Individuals running self-hosted agents from a home server or mini PC: a **node** on their residential network, unattended (its own desktop, nobody logged in) or attended (the person's own desktop and Chrome), used on demand from the web app, the Android app, MCP and the API.
- Teams needing observable, auditable automation with human approvals.
- Researchers testing browser-control methods and experiential memory.

### 4.2 Representative end-to-end scenarios

**Remote persistent browser.** An agent on a laptop starts a session using a Chrome profile stored on an unattended Linux node at home (a residential IP the site already trusts), signs in with human assistance if necessary, performs a task, disconnects, and later resumes the same profile from a different device.

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

> **As built:** the control plane below is the fabric. The goal-level loop (observe, reason, act, verify) is not in it; it is the console's goal runner (Section 26.3), a client of the control plane's `/v1` API.

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

A **saved approval** (console, epic #549) is not an exception: it is the owner's own standing decision, created only by the owner's tick on a request the server issued, and matched by the server on the page's real registrable domain, the gate's category and the element's exact label. The owner can see, narrow, pause and revoke every one, and every use is on the audit trail. An owner-saved **memory** is data the agent may read, never an instruction and never a permission; only the owner's own act writes one.

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

**Home node (the primary deployment).** A Linux machine the owner runs on a residential network, installed and managed entirely with the `hexactra` CLI. It connects outbound over HTTPS to the console (`https://<console>/fabric/`): no inbound port, no VPN. It runs real, headful **Google Chrome** with the Hexactra extension installed by Chrome enterprise policy, in one or both modes, each registered as its own host:

- **Unattended:** a persistent full desktop (XFCE) on a virtual display (Xvnc) with Chrome rendering on the machine's integrated GPU, started at boot as a dedicated `hexactra` OS user with nobody logged in. The owner opens the remote desktop from the console, signs into Chrome once per profile, and the agent then drives that profile.
- **Attended:** the person's own logged-in desktop (an X11 session for now) and their own Chrome profile; the person can also view and control that desktop remotely.

Both modes may run on one machine at once (for example hosts `mini-pc` and `mini-pc-attended`). Why residential: sites block or challenge datacenter IPs, and a node at home keeps a residential IP. A VPS-hosted browser (the bundled container host) remains available as an **opt-in** option for sites that do not care about IP reputation. Details: [docs/nodes.md](docs/nodes.md).

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

The shipped wire contract (`RemoteAction` in `crates/hexactra-core/src/remote.rs`; [docs/remote-control-api.md](docs/remote-control-api.md)) goes beyond this sketch. It adds `evaluate` (any JavaScript in the page), trusted positional input (`click_at`, `mouse`, `drag`, `scroll_at`, `type_keys`, `key`), marked screenshots (`screenshot` with `marks`), and the node's OS desktop (`desktop_*`). See Section 27.

### 9.2 Driver implementations

1. **ChromeExtensionDriver — primary v1:** DOM discovery, navigation and tabs; through `chrome.debugger`, trusted mouse and keyboard input (`Input.*`), JavaScript (`Runtime.evaluate`) and viewport capture. No CDP domain is ever `enable`d, and Chrome runs with `--silent-debugger-extension-api`, so pages see a person, not a debugger.
2. **DesktopInputDriver — shipped (xdotool):** the host agent drives the node's whole X11 desktop (pointer, keyboard, full-screen capture) for native dialogs, file pickers, permission prompts and other windows. Human takeover uses the same desktop.
3. **CDPDriver — optional:** carefully scoped local Chrome DevTools Protocol adapter; must not expose an unauthenticated debugging interface.
4. **Alternative browser drivers — future:** Chromium variants, Firefox, WebKit, OS accessibility APIs, or other adapters based on tested capability coverage.

The agent chooses its way of acting like a person would:
- **Selectors** when the DOM is clear (fast and exact).
- **What it sees and positions** when the DOM is not: canvas, custom widgets, hover menus, sliders, drag and drop. Screenshots are in CSS pixels, so a point on the image is the point `click_at` takes.
- **JavaScript** when that is quicker.
- **The OS desktop** for anything outside the page.

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

The Linux runtime provides a visible graphical Chrome instance inside a managed display environment: on an unattended node, a virtual desktop backed by the machine's real GPU (so Chrome reports real graphics hardware, not a software renderer); on an attended node, the person's own desktop. A remote viewer shows the same desktop to an authorized human, for every host the same way: console → fabric WebSocket relay → the node agent's outbound HTTPS tunnel → the node's local desktop server, which is never reachable from the network. Human takeover suspends agent input through the central control lease; releasing takeover returns control only after the session is revalidated.

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
- Human takeover preempts agent input after the current action reaches a safe boundary. Viewers watch by default; input from a viewer is forwarded only while that viewer holds the takeover lease, and the fabric enforces it.
- Leases are short-lived, renewable, and released or expired on disconnect.
- Authorization is reevaluated before each sensitive action and at resume boundaries.
- A queued action cannot execute after the session owner revokes consent simply because it was accepted earlier.

---

## 11. Human in the Loop: first-class capability

**HITL is a mandatory core subsystem in v1, not an optional integration added after browser automation works.**

AI-driven UI tasks routinely encounter a boundary at which a human must supply knowledge, demonstrate possession, approve a change, or take direct control. Hexactra must handle this through structured state, not by asking an agent to improvise with credentials or MFA.

> **Implementation status (epic #285, "Ask a human").** The question model, the fabric handoffs, the console's question broker and its channels described in 11.2-11.6 and 12.1 are implemented in this repository and covered by an end-to-end test against a real Chromium (`tests/e2e/remote-control.e2e.mjs`). Items marked *future* are not. The reference documentation is `docs/remote-control-api.md` (fabric handoffs and `type_secret`) and `console/docs/questions.md` (question types, channel rules, REST, webhooks). The earlier HITL scaffolding (the control plane's unmounted `hitl_broker` and interaction-request routes with their out-of-band and passkey-challenge storage, the `secret_transport` module, and the extension's local HITL stub) was never served and has been removed.

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

Every request is a **typed question**: an `input` type says what answer is expected, and a `kind` (`captcha`, `code`, `passkey`, `login`, `confirmation`, `other`) says why it is asked. The answer comes back typed, so an agent never parses free text to learn what a person decided.

| `input` | The person gives | Constraints | Typed response |
|---|---|---|---|
| `none` | Nothing: they act (in the browser or elsewhere), then press Done | | `outcome` |
| `takeover` | Nothing: they operate the browser themselves, then press Done | | `outcome` |
| `text` | Nonsecret text | `max_length`, `pattern`, `multiline` | `value` |
| `secret` | A password, one-time code or recovery code | `max_length` | Withheld: typed into the page by the fabric, never returned |
| `choice` | One option (1-10, each `{ id, label, description? }`) | | `value`: the option id |
| `multi_choice` | Several options | `min_selections`, `max_selections` | `values`: option ids |
| `number` | A number | `min`, `max`, `step`, `unit` | `value`: a canonical decimal |
| `confirm` | Approve or deny | `confirm_label`, `deny_label`, `risk` (`low` or `high`, default `high`) | `value`: `approve` or `deny` |

Every response carries `outcome` (`completed`, or `cancelled` when the person declines), the answering `channel`, `by` (who answered) and the time. An answer that breaks a constraint is refused before it is recorded.

How the original request types map onto it:

| Request type | Examples | Implemented as |
|---|---|---|
| SECRET_TEXT, OTP_CODE | Password, SMS/email/TOTP code, recovery field | `secret` (kind `login` or `code`), browser-bound |
| OUT_OF_BAND_CONFIRMATION | Authenticator push, email approval link | `none` (kind `login` or `other`): the person acts on their device and presses Done; the agent then checks the page |
| PASSKEY_OR_SECURITY_KEY | WebAuthn, platform passkey, FIDO key | `takeover` or `none` (kind `passkey`), through the host's remote viewer where it has one |
| ACTION_APPROVAL | Submit a purchase, send a message, delete data | `confirm`, `risk: high` by default |
| HUMAN_TAKEOVER | CAPTCHA, native dialog, ambiguous UI | `takeover` or `none` (kind `captcha`) with the viewer link |
| INFORMATION_REQUEST | Nonsecret missing data, a decision between options | `text`, `choice`, `multi_choice`, `number` |
| SECURITY_EXCEPTION_REQUEST | Site or operation blocked by policy | Not a question: policy refuses the action (no implicit bypass) |

**Important distinctions:**
- Entering a code is not the same as approving an action.
- A human saying “approved” does not prove that a website's challenge succeeded; Hexactra must observe the website state.
- Some WebAuthn ceremonies cannot be completed through a remote viewer, even if the human can see the browser. Report the limitation and suggest a supported local flow.
- Hexactra supports a human completing an allowed CAPTCHA but does not attempt unauthorized evasion or automatic bypass.

### 11.3 Where questions live: the fabric and the console

Questions are split between the two layers of Section 26:

- **The fabric's handoffs** (`/v1/sessions/{id}/handoffs`) are browser-bound. A handoff pauses one browser session: its actions return `409 handoff_pending` until a person answers, cancels, or the handoff expires. A handoff is **the only place a secret is typed**: the agent sends a `type_secret` action naming the handoff, and the control plane types the value into the page (11.6). Each handoff has a single-use 256-bit response token (stored as a digest) and is announced to the fabric's signed webhooks (`handoff.created`, `handoff.resolved`, `handoff.cancelled`, `handoff.expired`).
- **The console's question broker** (`/api/questions`) is what people use. It holds:
  - *free-standing questions* that need no browser (every type but `secret`), asked by an agent through REST, the CLI (`hexactra questions ask`) or MCP (`ask_human`);
  - a mirror of every handoff the console opens, so one Inbox shows both;
  - an **owner** per question (only that user sees or answers it), the asker (`user:…`, `agent:…`, `run:…`) and an audit trail of asked, answered, cancelled and expired;
  - the **channels** that reach the person (12.1): its Inbox (web, the Android app, CLI/TUI, MCP `inbox_answer`), notifications (in-app, Web Push, email, the Android app) with quick-answer buttons, and signed outbound webhooks.

**Channel rules** in the console (the same functions decide what a channel offers and what an incoming answer may be):

| Answer | Where it may be collected |
|---|---|
| Public: `choice`, `multi_choice`, `text`, `number`, a low-risk `confirm` | Any channel, including a notification button (a low-risk confirm, or a choice of exactly two options) and a webhook receiver |
| `secret` | Only on the signed-in question page. Every other channel gets a link, never the value or a way to send one |
| High-risk `confirm` | Only where the console signs the person in (web, Android app, CLI/TUI) |
| `none`, `takeover` | The signed-in question page or Inbox |

- **The first answer wins.** Answering is a conditional update on a still-pending question; a later answer from any channel is refused (409), and the question is withdrawn from every other channel.
- **Webhook answers** use a single-use answer token issued once per public question and sent in the `questions.question.asked` payload. The receiver posts the answer with the token in the `x-question-token` header; the token is stored only as a SHA-256 digest, answers that one question once before it expires, and is not spent by an invalid answer.
- **Notification buttons** carry a single-use signed token naming the question and the answers it allows, spent in the database.
- **Not yet:** chat apps (Slack, Teams, Telegram) are post-v1 channels (#293). MCP elicitation (the server asking the client's user in a form) is offered on the stateless protocol revision 2026-07-28 only, for a delegated run's public question, and a secret is never elicited; other clients ask with `ask_human` and wait (`wait_s`, `question_status`). SMS delivery, email reading and vault integrations remain future (Section 12).

### 11.4 HITL state machine

The implemented lifecycle is deliberately small:

~~~text
fabric handoff:    pending -> completed | cancelled | expired
console question:  pending -> answered  | cancelled | expired
~~~

- `cancelled` means the person declined (or the asker withdrew the question, or its session ended); a `deny` of a `confirm` is a completed answer, not a cancellation.
- Expiry: a handoff expires after its timeout (10 s to 24 h, default 10 min). A console question defaults to 1 h; the `questions.expire` job marks overdue ones expired and withdraws their handoffs.
- Transitions are atomic and single-use: the response token stops working once the handoff resolves, and a console answer is a conditional update on `status = pending`. A response is tied to one question and cannot be replayed on another session or website.

*Future:* explicit delivery states (`PENDING_DELIVERY`, `DELIVERY_FAILED`, retries per provider) and a `CLAIMED` state for a person who has opened a question but not answered. Today delivery is best effort per channel (a channel failure is logged and does not block the others), and the Inbox always shows what is pending.

### 11.5 Interaction request schema

A fabric handoff, as created (`POST /v1/sessions/{id}/handoffs`):

~~~json
{
  "kind": "confirmation",
  "prompt": "Approve the order of 2 items for 48.00?",
  "input": "confirm",
  "confirm_label": "Place order",
  "deny_label": "Cancel",
  "risk": "high",
  "timeout_ms": 600000,
  "page": { "url": "https://shop.example.test/checkout", "title": "Checkout" }
}
~~~

A console question as it is read back (`GET /api/questions/{id}`, camelCase):

~~~json
{
  "id": "…", "askedBy": "agent:renewal-bot", "runId": null, "browserBound": false,
  "input": "choice", "kind": "other", "prompt": "Which plan should I renew?",
  "options": [{ "id": "basic", "label": "Basic" }, { "id": "team", "label": "Team", "description": "5 seats" }],
  "status": "answered",
  "response": { "outcome": "completed", "value": "team", "valueWithheld": false, "channel": "web", "by": "user:…", "answeredAt": "…" },
  "expiresAt": "…"
}
~~~

**The request for a secret never includes a saved value**, and a secret answer reads back as `valueWithheld: true` (fabric: `value_withheld`) with no value, everywhere.

### 11.6 Secret response handling

For username, password, OTP, and recovery codes, what ships:

1. In the console, the person answers on the signed-in question page; no console notification, webhook or chat message carries a secret or a way to send one. Integrations that talk to the fabric directly can also answer through the handoff's single-use response token (its answer page or its `handoff.*` webhooks) or the operator CLI; those are operator-configured channels.
2. The question page shows the page title, the requesting run or agent, and why the value is needed (showing the full origin is *future*).
3. The console relays the value to the fabric's handoff in that one request and never stores or logs it. The fabric holds it **in memory only**, never in its state database, and erases it (memory zeroed) when it is used, when the session ends, or 10 minutes after the answer.
4. The agent, the goal runner and the console's MCP tools type it with the fabric's **`type_secret` action** (`{ "type": "type_secret", "handoff_id", "selector", "clear", "submit" }`). The control plane checks the handoff belongs to that session, asked for a secret and was answered, takes the value once, and sends the bound host an ordinary `type` command. Only that host-bound command contains the value; operation views, events, webhooks, logs and traces show the handoff id and selector only.
5. A second `type_secret`, or one after expiry, fails with `409 secret_unavailable`; the agent asks again.
6. The secret is never returned to the agent's tool response, the console, the SDK or the CLI. The deprecated `POST /v1/handoffs/{id}/claim` route still returns it once to operator and service tokens, but no first-party caller uses it, and it is scheduled for removal.
7. After application, only a sanitized result is reported (succeeded or failed, as for `type`).
8. On a session change, cancellation, or expiration, the value is discarded.

**Security reality:** any website receiving credentials can observe those values; Hexactra cannot guarantee that a compromised site or browser will not capture them. Keep the trust boundary explicit. Offer browser takeover as the preferred path when safer than relaying sensitive values through the runtime. Zeroization is best effort; the managed runtimes (the console's Node process) cannot promise perfect memory erasure.

**Stored secrets (epic E37, #579).** The owner may also *save* a secret instead of typing it each time: a login and its authenticator code, identity details, and a payment card. The handling rules above carry over unchanged, and the provider model of Section 12.2 is how they are met:

1. A saved secret lives in the owner's **provider**: their own Vault, or a built-in store the console embeds (logins only). The model, the console's database (apart from the built-in store's ciphertext), logs, spans, screenshots and exports never hold a value.
2. **The fabric is the only component that holds a value, and only to type it.** The agent names an item by a per-run reference and a field by its key; the control plane asks the provider, types with trusted input and wipes. The model never sees a value or its length. On the Vault path the console never sees one either.
3. **The origin a secret is released for is read from the browser at the moment of typing**, never from model or page text, and only an exact match is used; otherwise the owner is asked.
4. **A card needs the owner's approval per merchant with an amount limit.** No rule covers every merchant. A bank's own verification step is never passed.
5. **An unreachable provider makes the agent ask the owner**; it does not fail a run by itself.
6. **Unattended use is a choice per task**, never a default, and a run that signed in unattended keeps the confirmation before payments on unless the task says otherwise.

Status: implemented in this repository and tested against a fake Vault and fake extensions; **not yet proven on a deployed stack with a real Vault and node** (acceptance, #624). Reference: `console/docs/secrets.md`; threat model: `console/docs/security-secrets.md`. Residual risk: see Section 27.2.

### 11.7 HITL sequence: SMS/email OTP

~~~mermaid
sequenceDiagram
  participant A as Agent (goal runner, MCP or SDK)
  participant K as Hexactra Console
  participant F as Fabric control plane
  participant H as Browser host
  participant P as Person (owner)
  A->>K: request_human / browser_request_human (input: secret)
  K->>F: POST /v1/sessions/{id}/handoffs
  F-->>K: handoff (session paused)
  K-->>P: Inbox item + notification (link only)
  P->>K: Signed-in question page: the code
  K->>F: respond (value relayed, not stored)
  F-->>K: handoff completed, value_withheld
  K-->>A: completed, value withheld
  A->>K: type the secret (selector)
  K->>F: action type_secret {handoff_id, selector}
  F->>H: type (value, once)
  H-->>F: result
  F-->>K: operation succeeded (no value)
  K-->>A: typed
~~~

### 11.8 HITL sequence: phone prompt, passkey, or security key

- Ask with `input: none` (kind `login` or `other`) when the user must respond on a separate trusted device: they act there, then press Done.
- Give clear, contextual instructions but do not ask the agent to impersonate the authenticator.
- For a passkey or hardware security key, ask with `input: takeover` (kind `passkey`); when the host registered a remote viewer, the question links to it.
- *Future:* where browser and authenticator support require local presence and that presence is unavailable, return an explicit **HUMAN_ACTION_UNSUPPORTED_ON_THIS_HOST** outcome rather than inventing a bypass. Today the person declines the question (`cancelled`).
- After the user acts, independently check the page/navigation/authentication state before declaring success.

### 11.9 HITL safety and authorization

- Human answers are not general instructions to the agent.
- The question page shows the page title (and the remote viewer, when the host has one), so the person sees which site asks; warnings for mismatched or unusual origins are *future*.
- A question can be answered only by its owner (implemented); explicitly delegated approvers are *future*.
- Agents must not fabricate human responses or self-approve privileged actions. The MCP tools tell agents to relay only answers the user gave (`inbox_answer`), and a high-risk confirm is never offered on a webhook or a notification button. An agent holding its user's personal access token is that user to the API, so each agent framework gets its own low-role user until scoped tokens exist (Section 26.5).
- Restrict which actions a human approval authorizes: include session, action type, target, parameters where possible, expiration, and single-use semantics.
- High-impact actions (payments, irreversible changes, sending sensitive data) may require a separate approval (`confirm`, high risk), even after successful login. The goal runner asks before purchases unless the task turns that off.
- The input request must be initiated by trusted runtime detection/policy, not by obeying arbitrary instructions embedded on a website.
- A failed or suspicious challenge should not automatically trigger repeated OTP prompts indefinitely; add request quotas/backoff and abuse safeguards (*future*).

---

## 12. Future provider hooks: notifications and credentials

V1 must provide the **abstraction seams**, while implementing only the human provider. Future integrations should plug in without changing browser automation contracts.

### 12.1 HumanInteractionProvider

**Implemented as the console's question channel registry.** A channel is a `QuestionChannel` registered with the `QuestionChannelRegistry` (`console/apps/api/src/questions/channels/`):

~~~typescript
interface QuestionChannel {
  id: string;                               // open vocabulary: inbox, notifications, webhook, ...
  canCollect(q: QuestionView): boolean;     // the channel rules (11.3)
  deliver(q: QuestionView, ctx: QuestionChannelContext): Promise<void>;
  withdraw(q: QuestionView, ctx: QuestionChannelContext): Promise<void>;
}
~~~

The channel **delivers a prompt or access path**, never a secret. The broker remains responsible for recording the answer, enforcing ownership and the channel rules, and resuming the run. Delivery and withdrawal run as queue jobs (`questions.deliver`), never inline in a request.

Implemented channels: `inbox` (web, Android app, CLI/TUI, MCP), `notifications` (in-app, Web Push, email, the Android app, with quick-answer buttons) and `webhook` (signed outbound webhooks with single-use answer tokens). The fabric's own webhooks (`handoff.*`) are a second, lower-level path for integrations that talk to the fabric directly.

Post-v1 channels: Slack, Teams and Telegram adapters (#293), SMS and custom self-hosted notification services. Each must have an explicitly authorized owner mapping and a secure return channel, and follows the same rules: public answers only, secrets link-only.

### 12.2 CredentialProvider

**Implemented for saved logins, identity details and cards, as the secrets provider of epic E37 (#579);** this supersedes the earlier post-v1 vault epic E11 (#70) for logins. The design below was the target; what shipped differs in one respect that matters: the provider does not *resolve a credential for the agent*, it releases **one field to the fabric for typing** and the agent only names the item.

In the fabric (`crates/hexactra-credential-resolver`) the contract is the `SecretsProvider` trait:

~~~rust
trait SecretsProvider {
    fn id(&self) -> &str;                         // "vault", "builtin", "test"
    async fn lookup(owner, origin, kind)  -> Vec<ItemSummary>;   // never a value
    async fn release(ReleaseRequest)      -> SecretValue;        // one field, one origin, one purpose
    async fn one_time_code(CodeRequest)   -> (SecretValue, expires_at);
}
~~~

Providers: the owner's **Vault** (over its agent credential API, OAuth, exact-origin binding, a per-item opt-in) and the console's **built-in store** (the same rules, embedding Vault's packages, logins only). `SecretValue` is a zeroizing buffer with no `Debug`, `Clone` or `Serialize`. The owner's provider is registered with the control plane per owner, in memory only, with a short-lived token; a session reaches only its own owner's provider. Not built: other password managers (#628), moving logins between providers (#626), identity details and cards in the built-in store (#627). Details: `console/docs/secrets.md`, `docs/remote-control-api.md` ("Secrets from a provider").

The original sketch, kept for the extension points it names:

~~~typescript
interface CredentialProvider {
  id: string;
  capabilities(): CredentialCapability[];
  resolve(input: CredentialRequestContext): Promise<CredentialResolution>;
}
~~~

Possible later providers: operating-system keychain, 1Password, Bitwarden, HashiCorp Vault, cloud secret managers, or a user-supplied provider adapter.

**Design constraints for future vaults:**
- Resolve by **logical credential reference + origin + principal + approved purpose**, not by asking an agent for an arbitrary password.
- Prefer opaque secret handles and a trusted worker injection pathway rather than disclosing raw values to agent code or the model (the `type_secret` action is that pathway for human-supplied secrets today).
- Keep provider credentials separate from target website credentials.
- Scope permissions to particular profiles, origins, users, and actions.
- Support access revocation, rotation, expiration, and provider errors.
- Allow policy to require fresh human approval even when a vault holds a credential.
- Never ingest vault secrets into OTel, operation results, or AEF.
- A missing/unavailable vault must gracefully fall back to HITL human entry if policy permits.

### 12.3 Resolution policy and provider selection

Future policy can rank **safe existing browser session -> approved credential provider -> human request -> blocked**. This ordering is configurable and never silently escalates permissions. Human presence remains mandatory for operations requiring fresh possession or consent.

Extension points:

~~~text
QuestionChannelRegistry (console)
  ├── inbox                         [implemented]
  ├── notifications                 [implemented: in-app, Web Push, email, Android]
  ├── webhook                       [implemented: signed, single-use answer tokens]
  ├── chat (Slack, Teams, Telegram) [post-v1, #293]
  └── sms / custom                  [future]

SecretsProvider (fabric, E37)
  ├── vault                         [implemented: the owner's Vault, OAuth]
  ├── builtin                       [implemented: the console's embedded store, logins only]
  ├── test                          [implemented: tests and development]
  └── other password managers       [future, #628]
~~~

No third-party connector is silently enabled, and no incoming webhook can supply a secret: a webhook answer token is issued only for public answers and answers one question once.

### 12.4 How requests become automatable later

The API makes requests machine-readable and policy-controlled from day one: every question is typed, with constraints a receiver can render as a form or buttons. A future approved connector can notify a user, receive a protected reply, or retrieve a permitted credential from a vault. The automation is in *routing and handling known request types*, not in removing the human authority required by the website, device, or policy.

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
- The agent acts as its owner, with the owner's accounts and authority (Section 27). It is not a tool for defeating identity checks. A code sent to the owner, a passkey, a password it was not given, or a CAPTCHA puzzle it cannot pass goes to the owner as a handoff. Ticking an "I am not a robot" box, as a person would, is fine.
- Page content is never a source of authority. With full powers, a prompt injection could act with the owner's authority, so the owner's controls stay available: Stop, takeover, the audit trail, and per-task allowed sites and purchase confirmation (opt-in).
- A stored secret is fetched and typed by the fabric. It never enters the console's database, a model's context, a step, a log, a span, a screenshot or an export. The origin it is released for is read from the browser at the moment of typing and only an exact match is used. A card needs the owner's approval per merchant with an amount limit. A provider that is unreachable makes the agent ask the owner (Section 11.6, "Stored secrets"; `console/docs/security-secrets.md`).

### 13.4 Recommended v1 exposure model

Nodes reach the console over its authenticated HTTPS endpoint (only the host protocol is published, at `/fabric/`), so no private network is required; a private network such as Tailscale is an optional extra. Public exposure requires hardened authentication, TLS, Origin checks, rate limits, CSRF protection for dashboard workflows, and authenticated remote viewing. Never assume that knowing the session ID is sufficient authorization.

### 13.5 Audit is not telemetry

Every sensitive authorization, takeover, secret request completion (metadata only), action invocation, state transition, and credential-provider use should have an independently durable audit record. Audit capture is not optional just because telemetry export is turned off. The console's run trace (Section 26.8) is a masked record for people to read and export; it does not replace the audit record. Provider use is audited three ways, none of them the console's run trace: the fabric emits a value-free `secrets.lookup` or `secrets.release` event for every provider action (kept in memory, the newest 2,000), the console copies a whitelist of those fields into a durable table the owner reads as **Activity** (180 days), and the provider keeps its own record (Vault's agent activity).

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

**Not AEF: the console's memories and saved approvals (epic #549).** The console keeps a small set of facts the owner saved (people, accounts, preferences) and the owner's saved approvals, for the owner's own runs. They are console features, written only by the owner's own act, readable, editable and deletable on their own pages. They are not the experiential memory of the AEF, which stays independent, optional and post-v1: nothing is learned from pages or runs, nothing is shared, and no vector store or graph is required.

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
- Verify host boot -> Chrome session without a human OS login, on a home node on a residential network (epic #333).

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
- [ ] A remote API/MCP/CLI caller can trigger boot-time-daemon startup of a **real visible Chrome session with a selected persistent profile** while no human is logged into Linux; extension/worker readiness is verified before reporting success.

### Built-in AI and standalone extension
- [ ] Chrome extension Side Panel supports natural-language chat/goals, live progress, history, pause/resume/stop and human assistance.
- [ ] A locally installed extension runs an AI browser task with no Rust server, native messaging host, MCP client, or external agent framework.
- [ ] AI emits typed action requests that the extension actually performs on permitted tabs, followed by verified observations and replanning.
- [ ] User can configure arbitrary supported OpenAI-compatible API endpoints, model IDs and keys, select inference parameters, and test compatibility.
- [ ] Cloud and local OpenAI-style endpoints are supported by feature negotiation; unsupported optional tools/vision/streaming are handled explicitly.
- [ ] A managed AI goal runner can execute durable goals in remote browser sessions and report progress through SDK/CLI/MCP.

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

**Hexactra is both a built-in AI computer-use operator and an infrastructure layer for external agents—not a replacement for general-purpose agent frameworks.**

It should make it straightforward for any authorized agent to request computer actions on a real, persistent, remotely hosted session. It should make the intervention of a human feel like a controlled part of execution, not a failure or a workaround. And it should make the resulting behavior understandable through tracing, audit evidence, and operator observation.

The initial demonstrations must show (a) a person giving the standalone Chrome extension a natural-language goal and watching it operate real tabs with a configured OpenAI-compatible model, and (b) a remote agent launching a Chrome profile on an unattended, logged-out Linux host and pursuing a goal through the managed runtime. The underlying product is intentionally broader: **a portable, secure, observable execution plane for human-like interaction with software**.

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

---

## 25. AI-native computer use, standalone Chrome extension, and remote startup (v1 requirements)

**This section is normative and expands Sections 3, 6–11, 16, 19, 20 and 22. Where earlier descriptions suggest that Hexactra only exposes low-level tools to an external agent, this section takes precedence.** Hexactra ships an AI-powered operator *and* a remote control runtime.

### 25.1 The two product entry points

**A. Standalone Chrome extension (local AI assistant, required in v1).** A user installs Hexactra in an already-running Chrome browser, opens the built-in UI, configures an OpenAI-compatible model provider, and types a goal. The extension observes relevant pages, calls the model, interprets typed tool/action requests, and operates authorized tabs. The extension is fully usable without installing the Rust daemon, using a remote host, running MCP, or creating a developer application. It is limited to what a Chrome MV3 extension can access. Local execution does not promise to continue after Chrome closes.

**B. Remote managed computer-use runtime (required in v1).** A remotely running agent or human invokes HTTP/SDK/CLI/MCP against a control service. The Rust daemon starts and maintains a *real graphical, visible (non-headless)* Chrome instance on an unattended Linux host using a chosen persistent Chrome user profile. Clients can submit natural-language goals to Hexactra's managed AI operator, or they can use lower-level browser tools directly. The AI model and the remote agent never get unrestricted OS/browser privileges. MCP clients are of two kinds: self-hosted frameworks authenticate with a personal access token, and hosted assistants (ChatGPT, Claude) sign in with OAuth and receive only the scopes the owner consents to (Section 27.2).

The same extension code provides the **browser actuator** in both modes. The local AI runner and the managed AI runner must use compatible action/observation/tool contracts and safety rules, even though their runtimes and durability guarantees differ.

### 25.2 The Chrome extension must actually operate Chrome

The extension is **not just a scraper, telemetry collector, or passive page observer**. It must receive authorized AI-generated browser instructions and execute real actions in Chrome, within user grants and browser restrictions.

Minimum capabilities:

- **Browser context:** enumerate/select/open/close permitted tabs, navigate URLs, switch windows/tabs, track navigation and document state.
- **Perception:** inspect semantic DOM, visible text, accessible roles/names, inputs/buttons/links, selected and disabled states, frame contexts, dialogs where exposed, and optional screenshots.
- **Actions:** click/focus, type/clear fields, select options, check/uncheck, keypress, scroll, navigate, fill and submit forms, wait for conditions, and open links.
- **Interaction control:** observe new tabs, popups, modals, navigation, validation errors, downloads, loading/idle, and login challenges as allowed by Chrome.
- **Verification:** after each significant action, return a structured result and refreshed page observation; an “action delivered” response alone does not establish goal completion.
- **Full powers (Section 27):** run JavaScript in the page; click, hover, drag, scroll and type by position with trusted input through `chrome.debugger`; and use the node's OS desktop (native dialogs, file pickers, other windows) through the host agent's desktop driver.

Build a typed **BrowserDriver** boundary around these operations. Use selectors when the DOM is clear, and what the agent sees on a marked screenshot when it is not. The model proposes a command; **Hexactra validates it before the extension acts**: its shape, its bounds, and the task's opt-in policy.

Chrome does not permit control of every internal page, native security prompt, cross-origin context, or managed-browser target. A restricted capability must produce an explicit error or a human-intervention request, never a fictitious success. Neither browser permissions nor website protections should be bypassed surreptitiously.

### 25.3 AI execution loop: emulate an authorized human operator

The built-in agent is goal-directed, not a fixed workflow recorder. It interprets a person's intent, observes the current screen/page, selects one or more actions, executes them, checks progress and adjusts to new information—similar to how a human operator adapts as an interface changes.

~~~text
HUMAN GOAL
   |
   v
Read user's policy, current Chrome tab and provider configuration
   |
   v
OBSERVE: capture fresh relevant DOM/accessibility state (+ screenshot if enabled)
   |
   v
REASON: invoke configured OpenAI-compatible model
   |
   v
PROPOSE: receive structured browser action / tool call / completion assessment
   |
   v
VALIDATE: schema, allowed origin, action policy, live target, budgets, HITL
   |
   v
ACT: extension performs actual Chrome command (or desktop fallback if managed)
   |
   v
VERIFY: fresh page state, result, progress toward original goal
   |
   +-- complete -> display evidence and outcome
   +-- needs human -> pause, request help, resume after revalidation
   +-- recoverable failure -> bounded replan and retry
   +-- exceeded limits -> stop with honest partial/failed outcome
   +-- more steps needed -> OBSERVE again
~~~

Key design requirements:

1. Use **typed tool calls** with the owner's full powers (Section 27): selector actions, trusted positional input, `run_javascript` (any JavaScript in the page), tabs, and the OS desktop. Shell access on the node is not a tool.
2. **The model sees the screen.** Every round starts with a screenshot of the page, with the interactive elements boxed and numbered (`click_mark n`). `look` refreshes it, or shows the whole desktop. A model that refuses images continues text-only, with `observe_elements` and `read_text`.
3. Account for dynamic DOM, redirects, new tabs, elements that move or disappear, modals, loading states, and inaccurate model predictions. Reobserve and replan.
4. Provide step limit, duration limit, provider-call timeout, maximum token/cost budget where known, backoff, infinite-loop/no-progress detection, and an always-accessible Stop command. **Met in the console by agent policies (epic #398, Section 26.6):** six budgets (actions, model calls, active minutes, input tokens, output tokens, cost), each of which may be unlimited; stall detection that is always on (failures in a row, a repeated action, no progress, no action), which nudges the model, escalates to a stronger model tier, asks a person or ends the run as `stalled`; and Stop, which always works. A stopped run records a typed reason.
5. Never automatically retry irreversible/non-idempotent clicks after an ambiguous timeout without rechecking state.
6. Request human intervention for what only the owner has: passwords the agent was not given, OTPs, passkeys, authenticator approvals, and CAPTCHA puzzles it cannot pass (Sections 11–12). Approval before purchases is an opt-in per task.
7. Keep natural-language user instructions distinct from **untrusted website content**. A page cannot promote text to higher-priority system instructions, grant permissions, or authorize new actions.
8. Treat model outputs as proposals and verify claimed completion against observable evidence. Do not invent a successful task outcome.
9. Make task history and status understandable to the human without exposing private chain-of-thought or raw credentials.
10. Permit an external agent to use low-level execution instead of the built-in reasoning loop, subject to identical server-side authorization in managed mode.

Suggested goal-run states: CREATED, RUNNING, WAITING_FOR_HUMAN, PAUSED_BY_USER, RESUMING, COMPLETED, LIMIT_REACHED, FAILED and CANCELLED. A run is traceable by a durable ID in managed mode.

### 25.4 Any OpenAI-compatible AI provider, not a provider-specific application

Hexactra must support **any endpoint implementing its documented OpenAI-compatible contract**, not a fixed list of branded services. The user supplies base URL, model ID and authentication details. Examples include cloud models, API gateways and self-hosted endpoints such as llama.cpp server, LocalAI, vLLM, Ollama and LM Studio **when that deployment's API/model behavior is compatible**.

**Baseline v1 model dialect:** OpenAI-style Chat Completions messages/responses over HTTP, with optional structured function/tool calling where supported. If a compatible text model lacks native tools, Hexactra may request structured JSON actions and validate them against the same allowlisted schema. Unsupported native tool calling is not a reason to execute free-form model-generated code.

| Configurable field | Required use |
|---|---|
| Provider alias | Friendly human label; arbitrary provider is accepted |
| Base URL | User-supplied HTTPS or approved private/loopback HTTP for local use |
| Model identifier | Arbitrary model ID; no required vendor-defined enum |
| API authentication | Optional key/Bearer as needed; separate secret from target website password |
| Sampling | Temperature/top-p/seed where supported; omit unsupported fields |
| Output and context limits | Max output tokens, context policy, prompt size and summarization |
| Reasoning settings | Optional reasoning-effort or provider options only when compatible |
| Tools | OpenAI-style tool calls or validated structured-response fallback |
| Streaming | SSE if supported; otherwise standard nonstreaming HTTP |
| Vision | Capability-gated screenshots; not mandatory for text-only models |
| Timeouts/budgets | Model request timeout, retry policy, task cost/token/step limits. In the console these are an **agent policy** (Section 26.6): budgets per run, model tiers (`fast`, `standard`, `frontier`: a run starts on one tier and escalates to a stronger one when it stalls, with an optional fallback model on a provider error), and reasoning effort and output caps per tier |

Do **not** equate “OpenAI-compatible” with universal support for all optional OpenAI API features, OpenAI Responses API, images, streaming, tools, or strict JSON schema. Expose an explicit **capability matrix**, a **Test Connection** function and actionable validation errors. Support manual model entry when list-models endpoints are absent. Prefer a small interoperable baseline plus optional feature negotiation, not a fake universal guarantee. Provider model output must always pass the action validator.

A custom inference URL may point to a secured home/local model server, including servers fronted by a personal domain and bearer authentication. Neither the UI nor API should assume that inference requires a cloud provider or a publicly hosted endpoint.

### 25.5 The Chrome extension requires a real, independent UI

Implement **Chrome Side Panel (MV3)** as the main experience; an action-popup can launch it. The standalone extension must offer:

**Chat / Agent workspace**
- Natural-language goal composer, Send/Run, streamed/progressively updated responses and readable action history.
- Current selected tab/site scope, explicit access grants and active provider/model indicator.
- Task state, active step, last observation/result, completion evidence and recoverable errors.
- Pause, Resume, Stop, Take Over, and corrective instruction controls.
- Local nonsecret goal history, with retention settings and clear/delete controls.
- Human-assistance prompts for login, OTP, approval or takeover, with expiry and target origin shown.

**AI Provider / Settings workspace**
- Add, edit, test, choose and remove multiple OpenAI-compatible provider configurations.
- Enter custom endpoint URL, model name/ID and masked API key (or a session-only key).
- Adjust supported model parameters, streaming/tool/vision options, default agent instruction, max steps, timeouts, output limits and safety approvals.
- Configure site/tab scope, screenshot/context sharing, whether a run is local or attached to a managed host and whether human approval is required for sensitive actions.
- Surface feature-test results and warn when selected provider lacks needed capabilities.

**Security considerations**
- Model API keys stay in privileged extension contexts. Never inject provider keys into web-page content scripts or echo them into chat/model prompts, logs, telemetry, tool results, exported histories or page DOM.
- A key saved in standard Chrome extension storage is **not guaranteed to have hardware-backed vault protection**. Offer session-only usage, clear warnings and later vault connectors; do not label normal browser storage as a secure credential vault.
- Request minimal host permissions for user-approved sites and selected inference endpoints; require explicit consent when sending page text/screenshot context to a remote AI service.
- Restrict unsafe HTTP endpoints other than explicitly approved local/private configurations. Any unusual custom host permission must be visible to the user.
- Chrome Manifest V3 service workers are ephemeral. Keep important nonsecret run state in extension storage/IndexedDB, recover from service-worker shutdown/reload, and revalidate actions before retrying.
- Do not claim local extension jobs survive Chrome being closed, or that the extension can start the operating system's desktop session.

**No native messaging requirement in local mode.** The extension can communicate with compatible model servers and control permitted tabs through sanctioned extension APIs. In remote managed mode the *same extension* additionally connects to a local native host, which relays validated actions from the external control plane.

### 25.6 Unattended remote session startup — non-negotiable

This is a direct requirement carried over from the original remote-control architecture paper.

**A remote authenticated agent must be able to contact a continuously available Linux daemon while NO human is logged into Linux, select one of several persistent Chrome profiles, launch visible real Chrome using that profile, and begin controlling it with the Hexactra extension.**

Exact conceptual sequence:

~~~text
Remote SDK / CLI / MCP / AI agent
    -> Authenticated Hexactra control API
    -> Authorize session request, selected host and saved profile
    -> Boot-time Rust Linux daemon / host agent
    -> Reserve exclusive profile lock and create/reuse graphical display
    -> Start Chrome (not headless) with persistent user-data directory
    -> Load/activate registered Hexactra Chrome MV3 extension
    -> Extension initiates Chrome Native Messaging to Rust native host
    -> Session worker handshakes and verifies browser health/capabilities
    -> Control plane returns READY session + remote viewer/session identifiers
    -> Run built-in Hexactra AI goal OR execute low-level SDK/MCP actions
    -> Optional human viewer/takeover + HITL
    -> Disconnect/reconnect without losing authorized browser session
~~~

The daemon must be independently started at boot (for example by systemd) and must not rely on a human graphical login. A Linux graphical runtime (display server/compositor, optional isolated container, viewer) must be created on demand. The user selects the desired saved Chrome profile; profile isolation, host affinity and one-writer locking are required. Previously authenticated website sessions may be usable, subject to browser encryption and website rules. Do not promise every site will remain logged in.

A successful start response requires evidence that Chrome, extension, worker and control channel are ready; profile in-use, native-host failure, display failure, crash and handshake mismatch are explicit errors. A lost remote client connection must not automatically destroy the browser. Stop/idle/TTL semantics must be intentional, and reconnection should preserve session identity where feasible.

The host is assumed powered on; remote boot of a powered-off computer requires separately supported Wake-on-LAN/IPMI and is out of scope for v1. **Extension-only mode cannot substitute for the host daemon.**

### 25.7 Shared contracts, implementation boundaries and technology decisions

~~~mermaid
flowchart TB
  HUMAN["Chrome user"] --> PANEL["Chrome Side Panel chat and settings"]
  PANEL --> LOCAL["TypeScript local AI goal runner"]
  LOCAL --> EXT["Chrome extension action/observation driver"]
  EXT <--> CHROME["Local Chrome and tabs"]

  CLIENT["Remote SDK / CLI / MCP"] --> MANAGED["Console goal runner (TypeScript)"]
  MANAGED --> CORE["Rust control plane (fabric)"]
  CORE --> WORKER["Rust Linux host agent/session worker"]
  WORKER --> NATIVE["Rust Native Messaging host"]
  NATIVE --> REXT["Same extension driver"]
  REXT <--> REMOTEBROWSER["Remote graphical Chrome/persistent profile"]

  LOCAL --> LLM["Configurable OpenAI-compatible model endpoint"]
  MANAGED --> LLM
  LOCAL -. "local human requests" .-> PANEL
  MANAGED -. "server HITL broker" .-> CORE
~~~

> **As built (issue #588):** the managed goal runner is the console's TypeScript runner (`console/apps/api/src/runner/`, Section 26.3), not a Rust component. The Rust control plane is the fabric: it executes actions and holds sessions, leases and handoffs, and has no agent loop. The Rust planning loop sketched here was removed; see [docs/decisions/one-agent-loop.md](docs/decisions/one-agent-loop.md). Where this section says "Rust managed AI goal runner", read "console goal runner".

| Responsibility | Local extension mode | Managed remote mode |
|---|---|---|
| Goal orchestration | TypeScript extension agent | Console goal runner (TypeScript, on the console, not on the host) |
| AI provider | TypeScript OpenAI-compatible adapter | The console's platform AI service |
| Browser actuator | Chrome extension | Same extension, Native Messaging and session worker |
| Lifecycle | Existing Chrome/browser session | Boot-time daemon, persistent sessions and host control |
| Persistence | Extension storage/IndexedDB | Console database for runs; the fabric's SQLite for sessions and operations; profile volumes |
| HITL | Secure extension-controlled human prompt/takeover | Durable server Human Interaction Broker/dashboard |
| Telemetry | Local diagnostics and optional permitted export | OTel traces/metrics/logs and durable audit |
| SDK/MCP | Not required | Full HTTP/SDK/CLI/MCP access |

Define and version the same **Goal, Observation, BrowserAction, ActionResult, RunStatus, ProviderCapabilities, HITLRequest and VerificationResult** schemas for both runtimes. The two TypeScript runners (the extension's and the console's) share these contracts; the Rust side carries no agent behavior, so there is no TypeScript-versus-Rust drift to test. The managed Linux daemon needs no Node.js: the goal runner runs in the console.

### 25.8 Interactions with Human in the Loop

The AI may detect that it needs a username/password, SMS/email OTP, TOTP code from an authenticator app, phone push approval, passkey/hardware security key, or the human's judgment. It must transition to **WAITING_FOR_HUMAN**, clearly identify the intended origin and task, and stop entering further values until an authorized response/takeover is received. Secrets must not become model input or ordinary telemetry.

**V1:** use the built-in human prompt/UI in standalone extension mode and the existing durable Human Interaction Broker/dashboard in managed mode. **Later:** use the planned credential vault, email/SMS/push/messaging integration hooks without changing AI browser-action protocols. An authenticator requiring user presence must be completed by the human on the appropriate device; the AI must not claim to have defeated or reproduced that authentication mechanism.

### 25.9 Managed AI goal API and MCP

> **As built:** this contract was delivered by the console, not by the control plane, and under other names. A goal is started with `POST /api/runs` (MCP `run_goal`, CLI `hexactra runs start`); status, events, cancel and takeover are the run's routes, MCP tools and CLI commands (Section 26.3, `console/docs/api-tasks-runs.md`). The `/api/v1/agent-runs` routes, the `hexactra agent run` commands and the `hexactra_agent_*` tools below were never built and are kept only as the original proposal.

In addition to low-level browser actions, the managed service must offer a goal-level contract:

~~~text
POST   /api/v1/agent-runs               # start goal in selected session/profile
GET    /api/v1/agent-runs/{run_id}       # sanitized status
GET    /api/v1/agent-runs/{run_id}/events
POST   /api/v1/agent-runs/{run_id}/pause
POST   /api/v1/agent-runs/{run_id}/resume
POST   /api/v1/agent-runs/{run_id}/cancel
~~~

Illustrative CLI (not implemented yet):

~~~bash
hexactra sessions start --host home-linux --profile personal
hexactra agent run --session sess_123 --goal "Find the newest invoice and summarize the amount due"
hexactra agent status --run run_123
hexactra agent pause --run run_123
~~~

Proposed MCP tools include **hexactra_agent_run**, **hexactra_agent_status**, **hexactra_agent_pause**, **hexactra_agent_resume**, and **hexactra_agent_cancel**. They invoke the same policy-controlled run subsystem as the SDK and dashboard, and should never return secret values or grant actions unapproved permissions.

### 25.10 Roadmap and acceptance gates

These are **v1 requirements**, not optional “later” aspirations.

1. **Local AI browser vertical slice:** install MV3 extension alone, configure an OpenAI-compatible endpoint, submit a goal in Side Panel, observe/act/verify across several pages, view action progress and stop safely.
2. **Generic provider conformance:** test at least one OpenAI cloud-style endpoint, one self-hosted endpoint, one native-tool-capable model and one text-only/JSON-fallback model; reject malformed tools, unsupported parameters and invalid credentials gracefully.
3. **Remote no-login startup:** from a different machine, call a boot-time daemon when the Linux host has no logged-in desktop user; select a saved Chrome profile; receive a healthy non-headless graphical session with the extension active.
4. **Managed agent goals:** start a goal remotely over SDK/CLI/MCP; survive client disconnect; preserve browser session; show progress, observe completion and optionally take over.
5. **HITL both modes:** pause for OTP/password/passkey/approval, securely ask the human and resume or fail clearly. Integrations with external vaults/notifiers remain future capabilities.
6. **OTel and security:** trace AI provider latency, tool/action counts, errors and goal states without logging page secrets or raw prompts. Durable audit, action authorization, origin binding, stop controls and protection from malicious page instructions remain required.
7. **Portability:** a user can use the extension alone with no host service, while a Rust managed host can start browser sessions independently of Chrome being previously open and without desktop login.

The Phase 2 extension milestone in Section 19 must therefore include **Side Panel, model settings, provider adapter and local agent loop**, and Phase 3 must include **remote browser bootstrap plus managed AI goal execution**. Neither should be deferred to a future release merely because SDK/MCP exposes primitive actions first.

### 25.11 Additional architecture questions to resolve in ADRs

- Precise OpenAI-compatible baseline and tool-schema fallback; optional Responses API support.
- Versioned conformance suite shared by the TypeScript local runner and the console's managed runner (the Rust runner this item assumed does not exist).
- Chrome extension permission grants, restricted debugging domains, side-panel lifecycle and HTTP access to user-selected inference servers.
- Safe BYOK API-key storage modes in the standalone extension and transition to future OS vaults.
- Which agent-generated actions require explicit approval even inside a broad natural-language request.
- Resource, token/latency and privacy policies for screenshot- and vision-heavy computer use.
- Reliable browser profile bootstrapping and remote viewer behavior under an unattended Linux system service.
- Whether model inference runs near the browser worker or control plane in distributed deployments; keep the action policy boundary invariant.

### 25.12 Reference documentation

- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome debugger API and restricted CDP domains](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome MV3 service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome extension network requests and host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [OpenAI Chat Completions reference](https://platform.openai.com/docs/api-reference/chat)

## 26. Console and fabric

**Status: implemented in this repository (console/ and crates/).** This section records the architecture the platform grew into while implementing Sections 16, 19 and 25. Where it differs from earlier sections, it describes what exists; earlier sections still describe the product intent.

### 26.1 Two layers

- **Hexactra Fabric** (`crates/`) is the browser execution layer:
  - the Rust control plane (`/v1`: sessions, actions, handoffs, host commands, artifacts, events, webhooks), with durable SQLite state;
  - host agents (`hexactra-agent`) that keep a browser per profile on a home node (the primary deployment), a desktop or an optional VPS container, long-polling the control plane over HTTPS with per-host credentials;
  - the extension and native host that act inside each browser.
- **Hexactra Console** (`console/`) is the single user-facing control point. It is an application on the EnterpriseAppBase platform packages, and it adds:
  - identity, roles, personal access tokens and, for hosted AI apps, an OAuth 2.1 authorization server with per-scope consent and a Connected apps page;
  - tasks, runs and steps;
  - the server-side AI goal runner;
  - the chat (Section 26.7);
  - schedules, the handoff Inbox, notifications (web, email, Web Push and the Android app), outbound webhooks and alerts;
  - telemetry, the Doctor checks, and fleet management.

  Only the console holds the fabric's service token. The fabric's ports are not published (Section 26.4).

### 26.2 One capability, every surface

Every capability is a REST operation under `/api` (the OpenAPI document is at `/api/docs`). It is also present on the web app, the `hexactra` CLI and TUI, and the MCP server (`POST /api/mcp`, or `hexactra mcp serve` over stdio), unless a recorded reason says otherwise. `console/packages/shared/capabilities.json` is the registry. Each surface's tests fail when a capability it names is missing, or when an operation, command or tool belongs to no capability.

The TypeScript SDK (`console/packages/sdk`) is generated from the same OpenAPI document. Recipes for three agent frameworks (Hermes Agent, OpenClaw and Pi) are run against a live console in CI.

### 26.3 The goal runner

This is the repository's only agent loop. The fabric (`crates/`) has none: it executes the actions the runner sends (decision record: [docs/decisions/one-agent-loop.md](docs/decisions/one-agent-loop.md)).

- **Runs are durable state machines** (`queued → running → waiting_human → running → succeeded | failed | cancelled`).
- **Each advance is a queue job.** The runner calls the model in chunks, with the transcript persisted after each chunk.
- **Waits release the worker.** A run waiting for a person ends its job, and the answered handoff enqueues the continuation.
- **Policy is enforced server-side before every action:** the run's **agent policy** (Section 26.6), snapshotted when the run starts (the built-in Balanced by default: 60 actions, 20 active minutes, $2), and the task's opt-ins: allowed sites, and confirmation before purchases and irreversible steps (off by default, Section 27).
- **The model sees the screen:** each round starts with a marked screenshot (Section 27).
- **The model never sees secrets.** A person types codes and passwords into a handoff, and the runner asks the fabric to type them into the page (`type_secret`), so neither the model nor the console holds them (Section 11.6).
- **External agents are recorded the same way.** An agent driving a browser directly through the console is recorded as a run of trigger `external`, so the person sees every step and can stop it.

### 26.4 Deployment

One compose stack on a VPS (`console/docs/runbooks/vps-stack.md`):
- the console (nginx, API, web, Postgres);
- the fabric control plane on a private network, with only its host protocol published at `/fabric/`;
- optionally, a bundled browser host (moving to opt-in, because a VPS IP is often challenged).

The primary browser hosts are **home nodes** on the owner's residential network, installed with `hexactra agent install` and enrolled with a one-time token over HTTPS (Section 8.1, [docs/nodes.md](docs/nodes.md); epic #333 adds unattended and attended modes with a remote desktop for every host). Day-2 operations are in `console/docs/runbooks/operations.md`, and measured capacity in `console/docs/runbooks/capacity.md`.

### 26.5 What stays open

- A native Android module. The app is a Trusted Web Activity: its notification buttons (Stop run, Approve) are Web Push actions handled by the service worker, which is enough today.
- Scoped personal access tokens. A personal access token keeps every permission of its user; scopes exist for hosted apps that sign in with OAuth. Until tokens are scoped too, use a dedicated low-role user per agent framework.
- Windows and macOS hosts (post-v1, Section 19).

### 26.6 Agent policies (epic #398)

A run's models and limits come from an **agent policy**: a named, versioned, personal bundle that a person defines once and reuses. It replaces the per-task step, time and model fields, which are deprecated.

- **Four built-ins, read-only:** Economy, **Balanced** (the default), Thorough and Unlimited. A person duplicates one to edit a copy, picks one default, and may assign a policy to a task or schedule, or to a single run ("Run with..."). Policies move between people and deployments as a JSON file (`hexactra.agent-policies`) that carries no ids, user or secret.
- **Model tiers, not model names.** A policy starts on a tier (`fast`, `standard`, `frontier`) and may escalate to a stronger one, up to its highest tier. Each tier is a model, a reasoning effort, an output cap and an optional fallback model, defined once per deployment and overridable per user; a policy may pin a model to a tier. The model changes only between chunks, so provider prompt caching holds.
- **Six budgets, each optionally unlimited:** actions, model calls, active minutes (time waiting for a person never counts), input tokens, output tokens and cost in US dollars, priced from a table the administrator maintains. A budget set to `null` is unlimited. The administrator may set **ceilings** that no policy can exceed, which also cap an unlimited policy. A used-up budget ends the run after one wrap-up call, and the run records a typed `stop_reason`. **A run a chat starts is the exception (epic #536):** its owner is in the conversation, answers the agent's questions and can press Stop, so its budgets are soft: counted, shown and warned about near and over the limit, never enforced. Runs no person is watching (schedules, tasks, the API, MCP) keep hard budgets.
- **Stall detection is always on**, even for an unlimited policy: repeated failures, a repeated action, no visible progress, or rounds with no action nudge the model, escalate a tier, ask a person or end the run as `stalled`, as the policy says.
- **Context settings** (screenshots kept, calls per chunk, observation size, prune batch) bound how much the model re-reads each round.
- **A snapshot per run.** The policy, the effective budget and the resolved tiers are written onto the run when it starts and never change, so editing a policy never alters a run in flight.
- **Visible.** The run page shows the policy, tier, model and a live budget meter; alerts fire for runs over a cost threshold, runs that keep stalling and one expensive run.

Detail, the settings and the API: `console/README.md`, "Agent policies".

Status: shipped in epic #398 (E31). Not offered: policies shared across an organization (a JSON file is the sharing path), and a per-request model classifier (routing is escalate-on-stall).

---

### 26.7 Chat (epic #482)

**Status: implemented in `console/` and covered by automated tests; not yet run end to end on a deployed stack with a real model, a real node and a phone (#510).**

The console has a second way to start work, next to Task → Run: a chat (`/chat`, `console/docs/chat.md`).

- **A front door, not a second agent.** The owner types what they want. A light orchestrator turn (a queue job, its own AI feature, no browser) replies, asks at most one clarifying question, or starts a run. That run is an ordinary run (trigger `chat`): the same goal runner, agent policy, budgets, steps and audit trail.
- **The work shows in the thread.** A Browser card follows the run and opens the live view, with Stop and Take over. When the run ends, its result is a message.
- **Requests are answered in the thread.** An approval or a code is a card in the chat; it is the same question, under the same channel rules, as in the Inbox (Section 11.3). The Inbox keeps the requests of scheduled, API and MCP runs.
- **Secrets stay out.** A code typed into a card goes to the fabric handoff (Section 11.6). It is not stored in a chat message and reaches no model; the orchestrator reads chat messages only.
- **Limits are the owner's.** A chat carries the same opt-ins as a task (allowed sites, confirmation before purchases, on by default in a chat). The orchestrator cannot set them, and what the owner types to a working run is advice in its log, not a permission.
- **Steering and follow-ups.** A message typed while a run works is read by the runner at its next chunk. A request after a run has ended starts a new run on the same profile, told how the last one ended.
- **A chat can become a task.** The AI drafts a name and a standalone goal; the owner reviews and saves it in the task form.
- **A web surface.** The CLI, TUI and MCP have no chat, by recorded decision (Section 26.2): a hosted AI app is already a chat and shows the run and question cards in its own thread.

Not included: video streaming, one browser session kept open across a chat's runs, several runs of one chat at once, and chat apps as channels (#293).

### 26.8 Runs you can trust and replay (epic #536)

- **A confirmed step is remembered.** When the owner approves an irreversible step (a payment, an order) and the run then does not succeed, the result says the confirmed step was carried out, and "Run again" asks before it repeats the job.
- **Every run keeps a trace:** its steps, the questions it asked and the answers given (never a secret's value), the owner's guidance from the chat, and screenshots of the key moments (asked, before and after a confirmed step, a stall, the end).
- **Masked always.** Trace screenshots are masked in the page by the extension before the picture is taken, so no unmasked trace image exists; text is masked on every read and export by one pattern table (cards, IBANs, SSNs, routing and account numbers, emails, phones, tokens). Masking is pattern-based: a name or a balance is not a pattern, and reports say "masked", never "anonymised".
- **Export.** The owner downloads a run as a JSON trace file or a PDF report. There is no unmasked export, for any role.
- **Not the audit trail.** The trace is a masked record for people. The durable, sanitized Execution Events remain the audit trail (Section 13.5).

Detail: `console/docs/runs.md` and `console/docs/chat.md`.

## 27. Human emulator: full powers (epic #366)

**Decision (owner, November 2026).** Hexactra is a personal human emulator: the owner's own hands and eyes on the owner's own computer. The agent must work at the same level as a person sitting at the machine, so it gets **full powers**.
- Restrictions that only limited the agent are removed, or are opt-in per task.
- Protections for the owner stay, because they cost the agent nothing.

### 27.1 What the agent can do

| Capability | How | Where |
|---|---|---|
| See the page | Each model round starts with a screenshot in CSS pixels, with the interactive elements boxed and numbered, and a list of the marks (selector, label, center). `look` refreshes it. | Extension `screenshot { marks }`; console `vision.ts` |
| See the whole computer | `look` with `screen: "desktop"`: a full-screen capture of the node | Host agent `desktop_screenshot` (ImageMagick) |
| Act by element | `click`, `type_text`, `click_mark n` | Extension (DOM), `click_at` at the mark's center |
| Act by position, with real input | `click_at`, `hover_at`, `drag`, `scroll_at`, `type_keys`, `key` (with modifiers). Pages see `isTrusted: true` events. | Extension `chrome.debugger` `Input.*` |
| Run JavaScript | `run_javascript` / `evaluate`: any script, in the page's main world, whatever its CSP, with top-level `await` | Extension `Runtime.evaluate` |
| Use the OS desktop | `desktop_click`, `desktop_type`, `desktop_key`, `desktop_scroll`, `desktop_drag`: native file pickers, OS dialogs, permission prompts, other windows | Host agent, `xdotool` (argv only, never a shell) |
| Open anything | Any URL a person could type (`file:`, `chrome:`, `data:`...), except `javascript:` (use `evaluate`) | Contract `check_navigable_url` |
| Room to work | An agent policy sets the run's budgets: the default Balanced allows 60 actions, 120 model calls, $2 and 20 active minutes; Thorough 200 actions and 60 minutes; **Unlimited** sets none (Section 26.6) | Console agent policies |

### 27.2 What stays, and why

- **Secrets never reach the model.** Codes and passwords the owner gives are typed by the fabric (`type_secret`). This is privacy, not a limit: the agent can still sign in.
- **The owner is always in control.** Stop, takeover of the desktop, and a durable record of every step.
- **Opt-in limits per task.** Allowed sites, and confirmation before purchases and irreversible steps. Both are off by default.
- **Budgets are opt-in per policy and never reduce the agent's powers.** A policy bounds how long and how much a run spends, not what the agent may do; the owner may pick Unlimited, and an administrator's ceilings are the only hidden cap. Stop, takeover and stall detection still apply to an unlimited run.
- **Owner-only checks go to the owner.** A code sent to the owner's phone, a passkey touch, or a CAPTCHA puzzle the agent cannot pass becomes a handoff. The agent ticks an "I am not a robot" box itself, as a person would.
- **Page content never grants authority.** With full powers, a prompt injection in a page could act with the owner's authority. That is the main risk of this decision, and why the owner's controls above stay. Use allowed sites for tasks that visit untrusted sites. Hosted assistants (ChatGPT, Claude) get scoped consent, not full powers: the owner ticks what each may do, its sensitive browser actions wait for the owner's approval, and every call is on the audit trail (console `docs/security-hosted-clients.md`).
- **Remembered approvals are another owner-controlled setting** (console, epic #549). The owner may tick "Don't ask again" on any approval, payments included; the server then lets the same step through on the same site without asking. The residual risk is named on the card: an agent steered by a page on that same site could reach the remembered button. Brakes: exact host and label matching, optional limits (amount, scope, expiry), every use recorded and notified, an alert on unusual use, and **Pause all**.
- **Saved secrets are opt-in per task** (epic E37, #579). Saved logins (and their authenticator codes), identity details and payment cards are each a separate switch on a task or a chat, each off by default, all behind the owner's own switch and the deployment's. A scheduled task signs in from a saved login with nobody present only if the owner turned that on for that task. **Unattended payment is a further, separate choice** (`unattendedPayments: allow`), and a card is then typed only at a merchant the owner approved, under an amount limit they set. Even with every switch on, the model never sees a value: the fabric types it (Section 11.6).
- **The residual risk is stated plainly.** A saved login plus a remembered approval plus a schedule moves money with nobody watching. Origin binding stops a look-alike site; it does not stop a real page steering the agent, and a compromised console, node or provider token reaches what the owner opened to agents. The brakes are the ones above (allowed sites, purchase confirmation, Pause all, Stop, takeover, the Activity list and the audit record) plus the per-merchant limit for cards and a virtual card with its own limit from the bank. Threat by threat, what stops it and what does not: `console/docs/security-secrets.md`.
- **Stealth.** No `--enable-automation`, no WebDriver, no CDP port, no `enable`d CDP domain, and `--silent-debugger-extension-api`: the browser looks like a person's.

### 27.3 Status

Shipped in epic #366 (E29): the contract (#367), the extension (#368), the host agent's desktop driver (#369), the console goal runner, external API and MCP (#370), and these documents (#371).

Upstream seam: image tool outputs in the platform's `runTools` (marinoscar/EnterpriseAppBase#1175). Until it ships, the console carries the screenshot in the next round's input.

Epic E37 (#579) adds saved logins, identity details and cards the agent uses without seeing them (Sections 11.6, 12.2, 13.3 and the bullets above); it is implemented and tested against fakes, and its acceptance session on the owner's deployed stack is still to be recorded (#624).

The desktop needs `xdotool` and `imagemagick` on the node. `hexactra agent install` installs them in every mode that has an X11 desktop, and `hexactra agent update` adds them on older nodes (#373).
