# Memories

A **memory** is a fact you let the agent use, so it does not have to ask you each time: a person ("My wife: name, the phone she uses for Zelle"), an account ("Checking account: the bank and the last four digits"), a preference ("Aisle seat") or another fact. You keep them on **Settings → Browser agent → Memories** (`/settings/memories`, also in the avatar menu). This page covers storing them (#551). How the agent reads and proposes them is #553 (epic #549).

## What a memory is, and what it is not

- **Data, never an instruction and never a permission.** A memory tells the agent who "my wife" is. It does not let the agent do anything it could not do before, and nothing a memory says changes a task's allowed sites, policy or confirmation setting.
- **Written only by you.** You type it on the Memories page or with the CLI. When the agent suggests one (#553), it is saved only when you approve the suggestion. Nothing a web page says can create or change a memory.
- **Yours alone.** A user only ever sees their own memories; another user's id answers `404` like a missing one. Memories are not shared between users or organizations.
- **Small and plain.** A few hundred facts in PostgreSQL. No embeddings, no vector store. Text is stored as typed and always shown as plain text.

## What can never be stored

No Secret Material. A write is refused with `422 MEMORY_HOLDS_SECRET`, naming each field that failed, when:

| Rule | Examples refused |
|---|---|
| A detail's **name** says it is a secret | `password`, `passcode`, `pin`, `otp`, `cvv`, `cvc`, `security answer`, `token`, `secret`, `api key` |
| A **value** is a full card number (Luhn check) | `4242 4242 4242 4242` |
| A value is a full account, routing or IBAN number | `account: 123456789012`, a 9-digit routing number after "routing", any run of 12 or more digits |
| A value is a full US Social Security number | `123-45-6789` |
| A value is an access token or API key | `sk-…`, `Bearer …`, a JWT |

The value patterns are the masking table of the run trace (`packages/shared/sensitive-patterns.js`, #538), so what a trace masks and what a memory refuses agree. Keep the **last four digits** instead: "ending 0659" is accepted, and so are phone numbers, email addresses and names. The check runs on the label, the aliases and the note as well (`apps/api/src/memories/memory-secrets.ts`).

## Rules

- At most **500 active** memories per user (`409 MEMORY_LIMIT`).
- A **label** is unique among your active memories, ignoring case (`409 MEMORY_LABEL_TAKEN`). An archived memory frees its label.
- Aliases: at most 10, stored lower-cased. Details: at most 20, 500 characters a value. Note: at most 1000 characters.
- **Supersede, do not duplicate.** A changed value creates a new version and marks the old one `superseded` (one transaction). The history stays readable; a superseded version is never given to the agent. Editing the label, aliases, note or kind changes the memory in place.
- **Archived** memories are kept but not given to the agent. **Delete** is permanent and removes the history too.
- `source` is `owner` for a memory you typed and `agent_proposed` for an approved suggestion, with the run or chat it came from (`sourceRunId`, `sourceConversationId`: plain ids, so deleting the run or the chat keeps the memory). A request body can never set `source`, `status`, `userId` or the source ids.

## The API

| Route | Permission | Notes |
|---|---|---|
| `GET /api/memories?kind=&status=&q=` | `memories:read` | Active by default; `status` is `active`, `superseded`, `archived` or `all`; `q` searches the label, aliases and values. |
| `GET /api/memories/{id}` | `memories:read` | With `history`, the older versions, newest first. |
| `POST /api/memories` | `memories:write` | `{ kind, label, aliases?, attributes, note? }`. |
| `PATCH /api/memories/{id}` | `memories:write` | Label, aliases, note, kind. |
| `POST /api/memories/{id}/supersede` | `memories:write` | `{ attributes, … }`: the new version. |
| `POST /api/memories/{id}/archive`, `/unarchive` | `memories:write` | |
| `DELETE /api/memories/{id}` | `memories:write` | Permanent, with its history. |
| `GET /api/memories/export` | `memories:read` | The export file, below. |

Contributors and organization administrators get both permissions; a viewer gets `memories:read`. The OpenAPI reference is at `/api/docs`; the SDK types are regenerated from it.

**Audit events** `memory.created`, `memory.superseded`, `memory.archived`, `memory.deleted`, `memory.exported` carry ids, kind and source only, never a label, an alias, a note or a value. The counter `app.memories.writes` has the labels `op` and `source`.

**Hosted AI apps and MCP:** no tool reads or writes memories. ChatGPT, Claude and other apps connected over MCP cannot see them ([parity.md](parity.md#what-memories-added-e36)).

## The export file

`GET /api/memories/export` (`hexactra memories export`, **Export** on the page) returns `hexactra-memories-<yyyymmdd>.json`:

```json
{
  "kind": "hexactra.memories",
  "formatVersion": 1,
  "exportedAt": "2026-11-18T12:00:00.000Z",
  "memories": [
    { "kind": "person", "label": "My wife", "aliases": ["wife"], "attributes": { "name": "Person A", "phone": "555-010-6020" },
      "note": null, "status": "active", "source": "owner", "lastUsedAt": null, "createdAt": "2026-11-18T10:00:00.000Z" }
  ]
}
```

Active and archived memories, not the superseded versions. No ids: not of the memory, the user, a run or a chat.

## The CLI

```bash
hexactra memories list [--kind person|account|preference|fact] [--search <text>] [--archived] [--json]
hexactra memories show <id|prefix|label> [--json]
hexactra memories add "My wife" --kind person --attr "name=Person A" --attr "phone=555-010-6020" --alias wife
hexactra memories rm <id|prefix|label>
hexactra memories export [-o file.json]
```

Values come from flags only; the CLI never prompts for a value that could be a secret.
