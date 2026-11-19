# Hexactra Security Guide

## Overview

This guide covers security considerations, best practices, and threat modeling for Hexactra.

## Security Principles

Hexactra follows these security principles:

1. **Defense in Depth**: Multiple layers of security controls
2. **Least Privilege**: Components run with minimum necessary permissions
3. **Fail Securely**: Default deny for all operations
4. **Audit Trail**: All sensitive operations are logged
5. **Data Minimization**: Only collect what's necessary

## Authentication and Authorization

### Token-Based Authentication

All API endpoints (except `/health`) require authentication:

```
Authorization: Bearer <token>
```

Tokens are issued by the identity provider and include scopes for granular access control.

### Scopes

- `sessions:read` - List and view sessions
- `sessions:write` - Create and manage sessions
- `interaction:read` - View HITL requests
- `interaction:write` - Approve/reject HITL requests

## Sensitive Data Handling

### Secrets Management

Secrets (passwords, API keys, OTPs) are handled with special care:

1. **Never logged**: Secrets are never included in logs or error messages
2. **In-memory only**: Secrets are stored in memory, never persisted
3. **Short TTL**: Secrets have short time-to-live (default: 15 minutes)
4. **One-time use**: Retrieved secrets are consumed and removed

### Data Redaction

All user data is redacted before storage:

```json
{
  "original": "password123",
  "redacted": "********"
}
```

## Threat Model

### Attack Vectors

| Attack Vector | Mitigation |
|--------------|------------|
| API key theft | Token rotation, short TTL |
| Man-in-the-middle | TLS 1.3 only |
| Privilege escalation | Non-root service user |
| Cross-site scripting | Content Security Policy |
| Native host abuse | Permission boundaries |
| Prompt injection from page content (the agent has full powers) | The goal, not page text, is authority; live view, Stop and takeover; per-task allowed sites and confirmation (see below) |
| Stolen API token (it can drive the owner's computer) | Private tokens, scoped agent users, revocation |

### Trusted Components

- **Control Plane**: Full trust, handles authentication
- **Agent**: Partial trust, executes browser actions
- **Chrome Extension**: Partial trust, user-facing interface
- **Worker**: Partial trust, manages sessions

## Node Security Invariants

Every node (a machine that runs browsers for the console, [nodes.md](nodes.md)) keeps these:

1. **No inbound ports.** A node only dials out over HTTPS to `https://<console>/fabric/`.
2. **The desktop server is local only** (a Unix socket or 127.0.0.1 with credentials only the agent can read).
3. **Tunnels are authenticated at both ends:** the node's leg by its own host credential, the viewer's leg by a single-use token that lasts 30 seconds.
4. **Remote-desktop access is bound** to one host, one user and one organization, stored in the database and revocable.
5. **Watching is the default.** Input passes only while a person holds the takeover lease, enforced by the fabric.
6. **Opening, closing, taking over and releasing a desktop are audited.**
7. **Tokens never appear in URLs or logs.**

The unattended desktop runs as a dedicated `hexactra` OS user. Items 2–6 ship with epic #333 (#338, #339, #342).

## The agent has full powers (epic #366)

Hexactra is a personal human emulator (VISION §27). The agent works on the owner's behalf, with the owner's authority, at the level of a person sitting at the machine. **This is a deliberate decision by the owner**: restrictions that only limited the agent were removed or made opt-in.

**What changed:**

| Before | Now |
|---|---|
| No JavaScript action | `evaluate` / `run_javascript`: any script in the page, whatever its CSP |
| DOM selector actions only (synthetic events) | Trusted mouse and keyboard by position through `chrome.debugger`, plus marked screenshots the model sees every round |
| The browser only | The node's OS desktop through `xdotool` (native dialogs, file pickers, other windows) |
| `http(s)` and `about:blank` only | Any URL but `javascript:` |
| Confirmation before purchases by default; 40 steps, 15 minutes | Confirmation is opt-in per task. Limits are an agent policy: the built-in Balanced by default (60 actions, 20 active minutes, $2), or Unlimited when the owner chooses |
| "Never try to solve a bot check" | The agent ticks an "I am not a robot" box as a person would; puzzles it cannot pass go to the owner |

**What stays, and why:**
- **Secrets never reach the model or the console.** The fabric types handoff secrets itself (`type_secret`).
- **Stop, takeover and the audit trail** always work. Every action is a recorded run step, with typed text replaced by its length.
- **Per-task opt-ins:** allowed sites, and confirmation before purchases.
- **No shell on the node.** `xdotool` runs with an argument vector, never through a shell. There is no "run a command" action.
- **The API token is now the key to the computer.** Anyone holding a console token with `runs:write`, or the fabric API token, can do anything the owner can do in that browser and on that desktop. Keep tokens private, scope agent users, and revoke on doubt.

**Residual risk: prompt injection.** Page content is untrusted. A malicious page could try to instruct the model, and with full powers a successful injection acts with the owner's authority. Mitigations:
- the instructions tell the model that the user's goal, not page text, is authority;
- every step is visible live and can be stopped;
- for tasks that visit sites you do not trust, set **allowed sites** and turn on **confirmation**.

### Budgets and stall detection are safety nets, not authorization

A run's budgets, model tiers and stall detection come from its **agent policy** ([console README](../console/README.md#agent-policies)). They limit how long and how much a run spends. They never grant or remove what the agent may do: that stays with the owner's full powers, the task's opt-ins (allowed sites, confirmation before purchases) and Stop.

- **Policies are server-side.** The console enforces them in the goal runner, never in the browser, the extension, a page or the model. What a model says (for example "the budget is fine" or "I may continue") authorizes nothing.
- **A policy is snapshotted onto the run** when it starts, together with the effective budget and the resolved model tiers. The runner reads only that snapshot, so editing a policy, a user's tiers or an administrator's ceiling cannot loosen a run already in flight, and a prompt injection cannot change them.
- **Ceilings bind everyone.** An administrator's `browserAgentCeilings` cap every budget, including a policy set to unlimited. A policy has no field that widens the task's opt-ins: allowed sites and confirmation stay on the task.
- **Exports hold no secrets or identity.** A policy file (`hexactra.agent-policies`) holds names, descriptions and specs: no ids, user, version, usage, key or credential. A model pin is a model name, not a key; `includePins=false` leaves even those out. An import is validated as a whole, and a pin or a budget this deployment does not allow is dropped or clamped rather than trusted. Provider keys stay encrypted in the credential store and are never in a policy, a run snapshot, a run step, an event, an alert or a log.
- **Stall detection keeps no content.** It holds only digests, normalised selectors and URLs without a query, never typed text (only its length), a secret or an image.
- **Unlimited is not unprotected.** A policy with every budget unlimited (the built-in Unlimited) still has **Stop**, which always works and ends a run at its next step; **takeover** of the desktop; **stall detection**, which is always on and nudges the model, moves it to a stronger tier, hands it to a person or ends the run as `stalled`; the administrator's ceilings; and the run's audit trail. The page for an unlimited policy says so, and the cost alerts can be switched on for anyone who uses one.
- **Limits of the net.** A page that deliberately keeps changing can defeat the no-progress signal; the repeated-action and failure signals and Stop still apply. Cost is a lower bound while a model has no price in the price table, so the cost budget cannot stop spend it cannot see.
- **Every stop is typed and visible.** A run records why it ended (`stop_reason`), and routing between tiers is a step in its timeline.

## Security Best Practices

### Network Security

1. **Use TLS**: Always use HTTPS for API communication
2. **Firewall rules**: Restrict access to required ports only
3. **Network segmentation**: Isolate Hexactra from other services

### Configuration Security

1. **Environment variables**: Use for sensitive configuration
2. **File permissions**: Restrict config file access
3. **Secrets management**: Use external secrets manager in production

### Operational Security

1. **Regular updates**: Keep all components updated
2. **Audit logging**: Enable and monitor audit logs
3. **Access control**: Implement least privilege access

## Compliance

### Data Protection

Hexactra is designed to help with:

- **GDPR**: Data minimization, right to erasure
- **SOC 2**: Audit trails, access controls
- **HIPAA**: Encryption, access logging (with proper configuration)

### Audit Logging

All sensitive operations are logged:

```json
{
  "event": "session.created",
  "timestamp": "2024-10-17T10:30:00Z",
  "user_id": "user_123",
  "session_id": "sess_abc",
  "ip_address": "192.168.1.100"
}
```

## Security Checklist

### Pre-Deployment

- [ ] TLS configured for all endpoints
- [ ] API keys rotated and stored securely
- [ ] Firewall rules in place
- [ ] Audit logging enabled
- [ ] Access controls configured

### Post-Deployment

- [ ] Monitor logs for anomalies
- [ ] Regular security audits
- [ ] Key rotation schedule
- [ ] Incident response plan

## Agent Experience Framework Security

### Optional Integration

The AEF is **optional** and disabled by default:

- No AEF dependency for core functionality
- AEF failure does not impact Hexactra operation
- No credentials sent to AEF providers

### Data Protection

AEF-specific security controls:

1. **Consent required**: Opt-in before any export
2. **Sanitization**: All data sanitized before export
3. **Separate stores**: Experience and audit data isolated
4. **Time-limited retention**: Experience data auto-deleted

### Provider Conformance

AEF providers must:

- Support health check endpoints
- Handle authentication separately
- Not override Hexactra authorization rules
- Fail gracefully without breaking sessions

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do not** open a public GitHub issue
2. Email security@hexactra.io with details
3. Wait for response before disclosure
4. Credit researchers appropriately

## Next Steps

- Review the [Operations Guide](./operations.md) for operational security
- Set up monitoring and alerting
- Implement regular security audits
- Train team on security best practices
