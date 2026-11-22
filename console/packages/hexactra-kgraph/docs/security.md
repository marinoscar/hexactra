# Security

## Threat model

The main threat is **a page, an email or a tool result steering what gets learned**: text that, if it became part of a procedure, would make every later run do what an attacker wants (self-written memory is an attack surface: MINJA, MemoryGraft). A second threat is a procedure **holding secret material** that later leaks through a view, an export or a model call.

## Rules the package enforces

- **A judge step carries no free-text instruction.** The schema is strict and the validator reports `judge_instruction`. A judge gets the owner's goal, its declared inputs and a fixed output schema.
- **No secret in the graph.** A `literal` that looks like secret material is a `sensitive_literal` violation. A secret is a `SecretRef` (a label) or a `sensitive` parameter.
- **No secret to a model or a third-party API.** A secret or sensitive value never flows into a judge input or an argument of a tool in the `accounts` or `mcp:*` families (`sensitive_flow`).
- **Commits are marked.** A step whose tool commits must be commit-class (`commit_class`), so the host intent-records it and never repeats it when its outcome is unknown.
- **Sites are declared.** Every site a step or check touches is declared on the version (`undeclared_site`), so a change of site is visible and classifiable as sensitive.

## Rules a host must keep

- Build procedures from **server-recorded facts** (tool names, arguments, results), never from model free text or page prose.
- Run every tool through the one wrapper with its gates; **the graph never grants anything**: not a site, a connection, a recipient, a secret or a saved approval.
- A change that adds or changes a send, a payment, a recipient, a site, an account or a credential is approved **only by the owner**, signed in, in the host's own UI.
- Show labels and references, never typed values, secrets or account numbers.
- A failure of the package never fails a run: fall back to the agent.
