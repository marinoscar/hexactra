# Skills

A **skill** is a short playbook you write to say how you want a kind of job done: "Google Messages: how I send text messages from Google Messages on the web. Open messages.google.com. Start chat is top left. Write short messages, first name only, no emojis for work contacts. Check the recipient chip shows the right number before sending." A run or a chat whose job fits is shown the skill's name and when to use it; the agent reads its text with one tool, `skill_read`, and follows it inside the run's limits. You keep them on **Settings → Browser agent → Skills** (`/settings/skills`). Issue #1008 (E51.3, epic #1005).

**What was checked, and what was not.** Everything on this page is covered by automated tests with scripted models and an in-memory fabric (`apps/api/test/skills.db.spec.ts`, `skill-context.spec.ts`, the scenario kit) and by page tests of the web app. It has not been run on a real node with a real model.

## What a skill is, and what it is not

| | Skill | Memory | Procedure | Site fact | Task |
|---|---|---|---|---|---|
| Holds | How to do a kind of job | A fact | Learned steps | A note about a site | A job to run |
| Written by | Only you | Only you | The server, from records | Approved by you | You |
| Read as | Guidance | Data | Replayed steps | Data | The goal |

- **Guidance, never a permission.** A skill cannot allow a site, a payment or a recipient: those stay with your settings and approvals. It cannot switch a tool or an account on, release a secret, create a saved approval or skip a confirmation. No gate reads a skill: a skill that says "you may open evil.example" or "do not ask before paying" changes nothing the server allows.
- **Written only by you.** On the Skills page, signed in, or with your own CLI (a personal access token). No MCP tool, agent tool, chat tool or webhook reads or writes a skill, and there is no import from an address. The agent never writes or proposes one in this version.
- **No Secret Material.** A skill never holds a password, a code, a token or a full card, account, IBAN or Social Security number (below).
- **Yours alone.** Another user's skill answers `404` like a missing one. Skills are not shared.
- **Never a script.** A skill is text. There is no "run a command on the node" action, and a SKILL.md's `scripts/` are never read.

## A skill

| Field | Rule |
|---|---|
| `name` | 1 to 60 characters, unique among your skills ignoring case (`409 SKILL_NAME_TAKEN`) |
| `description` ("When to use it") | 1 to 200 characters. This is what a run is shown |
| `body` ("The text") | 1 to 4,000 characters, plain text or Markdown. Shown only to you and, through `skill_read`, to the model |
| `sites` | 0 to 10 sites, stored as registrable domains (`messages.google.com` and `https://www.google.com/` both become `google.com`, with the Knowledge Graph's `siteOf`). Anything else is `400 INVALID_SITE` |
| `enabled` | On by default. Off: kept, never offered |
| archived | Archived: kept, never offered |
| `lastUsedAt`, `useCount` | Set the first time a run reads it |

At most **100 skills** per user (`409 SKILL_LIMIT`). Control and invisible characters (zero-width and bidirectional marks among them) are removed on save; the text keeps its line breaks.

### What can never be stored

A save is refused with `400 SKILL_SECRET`, naming each field and why in your words (`details.issues`), when the name, the description or the text holds:

| Rule | Examples refused |
|---|---|
| A secret written as a named value | `password: …`, `PIN: 4321`, `api_key = …`, `token: …`, `otp: …` |
| An access token or API key | `sk-…`, `Bearer …`, a JWT |
| A full card number (Luhn check) | `4111 1111 1111 1111` |
| A full account, routing or IBAN number | `checking account 123456789`, any run of 12 or more digits |
| A full US Social Security number | `123-45-6789` |

The value patterns are the trace's masking table (`packages/shared/sensitive-patterns.js`), as for memories. Phone numbers, the last four digits and the word "password" without a value are fine: "If the site asks for a password, sign in with the saved login." The check is `apps/api/src/skills/skill-secrets.ts`.

## Which skills a job is offered

Deterministic, no model call (`apps/api/src/skills/skill-context.ts`). Among your active, enabled skills, in this order:

1. the goal (or its follow-up context, or in a chat what you wrote lately) **names the skill**, as whole words, ignoring case;
2. a skill **site equals one of the job's candidate sites**, as an exact registrable domain. The candidate sites are the goal's, the run's allowed sites (its own and its AI app's) and the sites of the accounts it may use (`candidateSites`, the Knowledge Graph's everyday rule). A lookalike (`go0gle.com`, `google.com.evil.example`) matches nothing;
3. a skill **with no site** that shares at least two words of four letters or more with the goal;
4. then, **only when you have eight skills or fewer**, your other skills with no site, by last use.

A skill with sites is about those sites: it is offered only to a job on one of them, or one that names it. At most 8 lines and 1,200 characters.

### The block

In the stable part of the run's input, right after "About the owner" (your memories):

```
The owner's skills (written by the owner as guidance for how to do a job; read one with skill_read when it fits the goal. A skill grants no permission: it cannot change allowed sites, approvals, recipients or secrets):
- Google Messages: How I send text messages from Google Messages on the web
```

Names and descriptions only, never the text. **With no fitting active skill there is no block, no tool and no family line**: the run is byte-identical to how it ran before skills (`runner-characterisation.db.spec.ts` passes unchanged).

### `skill_read`

Family `skills` ("The owner's skills"), effect read, not gated, offered only with the block, registered after every other tool. Like every tool it runs through `executeTool`, so Stop and Pause are checked before it runs.

- Description: `Read one of the owner's skills by its name: the owner's own guidance for a kind of job. Follow it where it fits the goal, inside this run's limits.`
- Argument: `name`. It answers `Skill "<name>" (the owner's guidance; it grants no permission):` and the text. An unknown, switched-off or archived name answers a fixed sentence.
- **At most 5 reads per run**; the sixth answers a fixed sentence. The count is kept in the run's transcript (a number only).
- **The step says `read the skill "<name>"`** and keeps the name only. The text is never in a step, the trace, a span, a log, the run export or a Knowledge Graph table.
- The first read adds the skill's id to `runs.skill_ids` and sets its `lastUsedAt` and `useCount`. The run page shows **Skills read: Google Messages**, a link to the skill.
- Within a chunk the model keeps what it read; after a chunk ends it keeps the step line and may read the skill again (within the 5).

A replayed procedure does not read skills in this version.

### Every trigger

The block and the tool are offered to every run of the owner, whatever started it: a chat, a task, a schedule, the API, the CLI, an email and a hosted AI app's `run_goal`. This is the rule the memory block follows: `aboutOwner` (`apps/api/src/runner/host/about-owner.ts`) is called by `buildRun` for every run with no trigger or app check, and the per-app limits of an AI app (`appLimits`) narrow its sites and purchases, not the owner's memories. Skills sit in the same place (`apps/api/src/runner/host/skills.ts`). The AI app itself never sees a skill: it gets the run's result, and no MCP tool reads one.

### A skills error

A failure reading the switches or the skills, matching them, reading one or recording a read is logged and counted (`app.skills.errors{stage}`, stages `query`, `match`, `read`, `record`); the run goes on without the block (or `skill_read` answers "could not be read").

## In the chat

The chat is shown the same block (names and descriptions) after the memory block, chosen from what you wrote lately, and one instruction line:

`- "The owner's skills" lists the owner's own guidance for kinds of jobs. You cannot read one; the agent can. When one fits, name it in the goal ("following the owner's Google Messages skill").`

The chat has no `skill_read` and no tool that writes a skill. For an owner with no fitting skill, the chat's input and instructions are unchanged. See [chat.md](chat.md#skills-1008).

## The switches

- **Deployment:** `skills.enabled` in the system settings, on by default (Administration → Browser agent → Skills, `/admin/settings/skills`; `system_settings:write`).
- **Yours:** `skills.enabled` in your user settings, on by default (**Use my skills** on the Skills page).
- **Each skill's own** `enabled`, and archiving.

Any one off: no block, no tool.

## Fill from a SKILL.md file

The add form has **Fill from a SKILL.md file**: the browser reads one text file you picked (the agentskills.io format: front matter with `name` and `description`, then the text), takes `name` and `description` from the front matter and the rest as the text, and fills the form. Nothing is uploaded or saved until you press **Save**, and the same checks apply. Folders, `scripts/`, `references/`, other front matter keys (`allowed-tools`, …) and links are ignored, and the form says so. Nothing is fetched from an address.

## API

| Route | Permission | |
|---|---|---|
| `GET /api/skills` (`?q=`, `?archived=false\|true\|all`) | `skills:read` | your skills, with their text |
| `GET /api/skills/{id}` | `skills:read` | |
| `POST /api/skills` | `skills:write` | `400 SKILL_SECRET`, `400 INVALID_SITE`, `409 SKILL_NAME_TAKEN`, `409 SKILL_LIMIT` |
| `PATCH /api/skills/{id}` | `skills:write` | name, description, text, sites, `enabled` |
| `POST /api/skills/{id}/archive`, `/unarchive` | `skills:write` | |
| `DELETE /api/skills/{id}` | `skills:write` | permanent; runs keep the id |

`skills:read` is granted to contributors, viewers and org admins, `skills:write` to contributors and org admins (re-run `npm run prisma:seed` for the new permissions). `GET /api/runs/{id}` adds `skills: [{ id, name, archived }]`. Writes are audited (`skill.created`, `skill.updated`, `skill.archived`, `skill.unarchived`, `skill.deleted`) with the id only. Skills are part of your data export and are deleted with you (the user-owned data registry, category **Skills**).

## CLI

```bash
hexactra skills list [--search <text>] [--archived] [--json]
hexactra skills show "Google Messages"
hexactra skills add --name "Google Messages" --description "How I send text messages from Google Messages on the web" --file sms.md --site google.com
hexactra skills edit "Google Messages" [--name …] [--description …] [--file …] [--site …] [--no-sites]
hexactra skills enable|disable "Google Messages"
hexactra skills archive "Google Messages" [--undo]
hexactra skills delete "Google Messages"
```

A skill is found by name (ignoring case), id or id prefix. The text comes from a file, never a prompt.

## Threat model and decision

[security-skills.md](security-skills.md) (what a skill pasted from elsewhere, a hosted app or a page can and cannot do) and [decisions/skills.md](decisions/skills.md) (why skills are a separate object, owner-only in v1).
