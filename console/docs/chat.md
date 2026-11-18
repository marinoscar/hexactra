# Chat: ask, follow and answer in one thread

`/chat` is the console's second way to get something done, next to Task → Run. You say what you want; the assistant asks one question when it must, starts a browser run, shows the browser, asks for approvals and codes in the thread, and reports the result. A good chat can be saved as a task. This page is the reference (epic #482); the user guide is the README's [Chat](../README.md#chat) section.

**What was checked, and what was not.** Everything here is covered by automated tests with scripted models and an in-memory fabric, and by page checks in Chromium against a mocked API at 360, 390, 768, 1024 and 1440 px in light and dark. It has not yet been run end to end on a deployed stack with a real model, a real node, a real push notification, a phone or the Android app. That acceptance run is tracked in #510.

## How a chat becomes runs

A chat is a `Conversation` with `ChatMessage` rows. It holds no agent of its own: **a job a chat starts is an ordinary run** (trigger `chat`, `runs.conversation_id`), with the same runner, agent policy, budgets, steps and audit trail as a run started from a task.

```
you type ──► POST /api/chats/:id/messages ──► job chat.turn
                                                │  AI feature chat_orchestrator (no browser)
                                                ├─ plain reply
                                                ├─ ask_user   → one clarifying question, with chips
                                                ├─ start_run  → Run (trigger chat) → job goal.run → the browser
                                                ├─ guide_run  → a line for the live run
                                                ├─ stop_run   → cancels the live run
                                                └─ draft_task → a task draft to review
run ends ──► one result message in the thread
```

- **One turn at a time.** A turn takes a lease on the chat (`turn_lease_until`) and records the newest message it took up (`answered_seq`), so a message is answered once however many jobs were queued. A crashed turn's lease runs out after three minutes.
- **Clarify once, then act.** The assistant is told to ask at most one question before starting, and only when the answer changes what is done. Questions during the work come from the browser agent (`request_human`).
- **One run per chat at a time.** `start_run` is refused while a run is live.
- **The model is set by an administrator** under Administration → AI, feature "Chat: understand the request and start browser runs". Until then the thread says no model is set up.

## The thread

The page follows one event stream, `GET /api/chats/:id/stream` (server-sent events; reconnect with `afterSeq`):

| Event | Carries |
|---|---|
| `chat` | title and status |
| `message` | each new message, in order |
| `turn` | whether the assistant is working on a reply |
| `run` | the chat's newest run: status, activity, steps, cost, result |
| `question` | the request that run waits on; never a response |
| `guidance` | what became of each message passed to a working run |
| `heartbeat` | every 15 s of silence |

Message kinds and how they render:

| Kind | Shown as |
|---|---|
| `text` | a bubble (yours on the right, the assistant's on the left); a `system` line in the middle |
| `clarify` | a bubble with suggested answers to tap |
| `run` | the **Browser** card: what the browser is doing, its picture, **Open browser**, the steps |
| `result` | the result card: how it ended, steps, cost, **Run again**, **Save as task** |
| `task_draft` | a draft with **Review and save** |

**Open browser** shows the browser large: beside the thread from 1200 px, above it on a tablet, full screen on a phone. From there you can **Stop** the run or **Take over** the node's desktop (the existing viewer and takeover lease).

## Requests in the chat

When the agent needs you, the request is a card in the thread, not only an Inbox item. It is the same `Question` row either way, answered through the same route (`POST /api/questions/:id/answer`) under the same channel rules ([questions.md](questions.md)).

- **Approval** (`confirm`): the page it is about, **Review**, and Deny / Allow. A high-risk approval asks twice and needs a signed-in web session.
- **Code or password** (`secret`): a masked field in the card, and "Enter it in the browser myself" (take over).
- **Sign-in** (#524): the agent is told that signing in is its job. It asks for the username (`kind: login`, `input: text`, a card titled "Sign-in needed"), types it, asks for the password (`kind: login`, `input: secret`), types it through the handoff, and asks for a code the same way. It asks for a takeover only for a passkey, a puzzle it cannot pass, or after you declined to give a credential. These are instructions to a model: a model can still choose otherwise.
- **Choice, text, number**: the same form the Inbox uses.

The Inbox still lists a chat run's request, with **Answer in chat**. Scheduled, API and MCP runs use the Inbox as before.

## Secrets

- A secret typed into a request card goes to the fabric handoff. The fabric types it into the page (`type_secret`). It is **not** stored in `chat_messages`, not logged, and no model receives it.
- The assistant's input is built from chat messages only, never from a question or its answer. It has no tool that takes a secret and is told never to ask for one.
- While a run waits for a secret, the browser's picture is hidden in the card and in the pane, and none is fetched.
- After submit the card collapses to "Provided"; the value is not rendered again.

## Limits

A chat has the same opt-in limits as a task, in **Chat settings**: the sites its runs may visit, and **Ask me before a purchase or another step that is hard to undo** (on by default in a chat). The machine, browser profile and agent policy are set there too.

**The limits are yours, never the model's.** The assistant cannot set them: `start_run` takes a goal and nothing else. Guidance cannot change them either: it is a line in the run's log, and the runner checks allowed sites and the purchase confirmation in code.

## Steering and follow-ups

- **While a run is live**, what you type is passed to the working agent (`guide_run` → `run_guidance`). The runner reads pending lines between chunks, each once. Your message shows **Queued for the agent**, then **Seen by the agent**, or **Not seen: the job had ended**. It can take a few actions to land, because a chunk is not interrupted.
- **After a run has ended**, asking for more starts a new run on the same browser profile, so sign-ins hold. The new run is given the previous goal and how it ended as context. The browser session itself is not kept open between runs.

## Notifications

A chat run's notifications (the request, its reminders, "Run finished") open the chat at the run instead of the Inbox; their buttons (Approve, Stop run, Remind me in 15 min) work as before. The service worker shows no notification for a chat that is open and in front in a focused window.

## Save as task

On a run that succeeded, the result card has **Save as task** (needs `tasks:write`); you can also ask in words. The assistant writes a name and a standalone goal from the conversation (`POST /api/chats/:id/task-draft`). Machine, profile, policy and limits are copied from the chat's settings. Nothing is saved until you press Save in the task form, which opens prefilled; the draft travels in the page's navigation state, not in the URL. With no usable model answer, the draft is the goal of the chat's newest run. The chat then shows "Saved as the task …" with a link.

## Other clients

The chat is a web surface, recorded in `packages/shared/capabilities.json` (`chats.manage`):

| Client | Decision |
|---|---|
| Web, phone browser, Android app | the chat |
| CLI | none: start a job with `hexactra runs start`, answer with `hexactra inbox answer` |
| TUI | none: the TUI is for watching and answering |
| MCP | none: a hosted AI app is already a chat; it starts runs with `run_goal` and shows the run and question cards in its own thread ([mcp-apps.md](mcp-apps.md)) |

The REST routes under `/api/chats` are in the OpenAPI document and the generated SDK.

## Permissions and data

- `chat:read` to see chats, `chat:write` to write, rename, archive and delete. Drafting a task also needs `tasks:write`.
- A chat is its owner's: another user's chat is a 404.
- Deleting a chat deletes its messages and its runs; it is refused while a run is live. Archiving makes it read-only until unarchived.
- Chats are in the user-owned data registry: they are exported and purged with the account.

## Not in this version

- Video or WebRTC streaming; the noVNC desktop embedded in the thread.
- One browser session kept open across runs of a chat; several runs of one chat at once.
- The assistant's text arriving word by word; voice.
- Slack, Teams and Telegram as chat channels (#293).
