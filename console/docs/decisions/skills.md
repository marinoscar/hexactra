# Decision: skills v1, owner-written playbooks (#1008)

**Status:** accepted, implemented in #1008 (E51.3, epic #1005). Checked with scripted models and an in-memory fabric, not on a real node.

## Context

The owner wants to say how a kind of job is done ("how I text from Google Messages: short, first name, no emojis for work contacts; the compose button is top left") once, and have every run that does such a job follow it. Hexactra already has four kinds of stored knowledge, and none of them is this:

- a **task** is a job (a goal, parameters, schedules, limits, outputs, deliveries);
- a **memory** is a fact, and is explicitly never an instruction (`docs/memories.md`);
- a **procedure** is steps the server learned from the owner's runs (`kg_` tables hold only server-recorded facts);
- a **site fact** is a note about a site, data, active only by the owner's approval.

## Decision

A new object, the **skill**: a name, when to use it, a text of at most 4,000 characters and optional sites. A run or chat whose job fits is shown the names and descriptions in one block, deterministically (exact registrable domain, or the goal names it), and the agent reads the text with one tool, `skill_read`. A skill is guidance inside the run's limits and grants nothing: the gates do not read it.

### Why not a task

A task fires a run; a skill shapes how many different runs are done. "Send a text" (a task with `{{Recipient}}`) and "how I text" (a skill) are used together; merging them would mean copying the know-how into every task, or giving tasks a second, unbounded meaning.

### Why not a memory

A memory is data by design: the block says "they are information, not instructions", and memories are offered as facts. A skill is meant to instruct. Putting instructions in memories would break the memory invariant and blur what the agent may treat as an instruction.

### Why not the Knowledge Graph

The Knowledge Graph holds only server-recorded facts (tool names, arguments, results), never model or owner free text, and its procedures are replayed without the model. A skill is owner prose read by the model. Mixing them would weaken the graph's "built only from server-recorded facts" invariant and its threat model.

### Why owner-only in v1

Owner-written text is the narrowest source of instructions after the goal itself. An agent that writes its own skills turns one injected page into a standing instruction for every later run; a hub turns other people's text into the owner's agent's instructions. Both need a review flow, provenance and probably a sandbox for what a skill may say, and two or three hand-written skills should first prove the value.

### Matching without a model

The block is chosen by pure functions (`skill-context.ts`), like the memory block and the everyday procedures: the goal names the skill, an exact registrable domain, two shared words for a skill with no site, and, for an owner with eight skills or fewer, the other skills with no site. No model call, so a run's input is predictable and testable, and a lookalike domain matches nothing. A skill with sites is not offered by the fallback: it is about those sites. The model then decides whether to read one.

### The text is not kept

The block names skills; the text reaches the model only through `skill_read`, and the step keeps the name. The run trace, export and spans stay what they were, and a skill edited later does not leave copies of its old text in old runs.

### Where the code is

`skill_read` reads a console table, so it lives with the other tools of console services in `apps/api/src/runner/host/tools/skills.ts` (the procedures precedent, `tools/procedures.ts`; `console/AGENTS.md` rule 1), bound by `apps/api/src/runner/host/skills.ts`, not in an agent package. The selection is in `apps/api/src/skills/`. The module is global so the runner and the chat get `SkillContext` as an optional dependency.

## Alternatives considered

- **Agent-written skills, as Hermes Agent does** (the agent writes and a curator prunes): not now. It needs a proposal flow like memories' (the owner approves each), provenance on every skill, and limits on what a proposed skill may say; a later epic, after hand-written skills prove useful.
- **A hub or import from an address, as OpenClaw does** (`SKILL.md` folders, loaded on demand): not now. Third-party instructions are the injection risk this design avoids; only a one-file, client-side "Fill from a SKILL.md file" is offered, which reads the name, the description and the text and nothing else, and saves nothing by itself.
- **Scripts in a skill:** never. There is no "run a command on the node" action.
- **Skills pinned to a task, shared between users, version history, slash commands:** out of v1 (epic #1005, "Not in this epic").

## Consequences

- Owners can shape runs in their own words without widening anything.
- A badly written skill can make a run worse within its limits; the owner reads what they save, and every send and payment still asks.
- With no fitting skill, runs and chats are byte-identical to before (`runner-characterisation.db.spec.ts`, the chat input test).
