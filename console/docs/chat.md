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
                                                ├─ pause_run / resume_run → holds the live run, continues it later
                                                └─ draft_task → a task draft to review
run ends ──► one result message in the thread
```

- **One turn at a time.** A turn takes a lease on the chat (`turn_lease_until`) and records the newest message it took up (`answered_seq`), so a message is answered once however many jobs were queued. A crashed turn's lease runs out after three minutes.
- **Clarify once, then act.** The assistant is told to ask at most one question before starting, and only when the answer changes what is done. Questions during the work come from the browser agent (`request_human`).
- **One run per chat at a time.** `start_run` is refused while a run is live. A run the owner **paused** is still live (it is held, not finished): "hold on" calls `pause_run`, "ok, continue" calls `resume_run`, and no second run starts while one is paused ([runs.md](runs.md#pause-and-resume-e382)). The browser pane has **Pause** beside **Stop**; while paused the card and the pane show "Paused. Nothing happens until you resume." with **Resume** and **Stop**, and the live view and Take over stay available. Guidance you type while it is paused is queued and read when it resumes.
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
- **Paying with a saved card** (E37.7): with the chat's card switch on, the first use at a shop asks with a card (**the shop, the card by brand and last four, the amount and what is bought**; Allow this payment / Do not pay). "Don't ask again" there needs an **amount limit** (a required field) and is bound to the shop and the card. A bank's verification step is a card of its own kind ("Your bank wants you to confirm this payment in your banking app"). The thread never shows a card value; the run card says "Paid with Visa ending 4242 at ...: 42.50 USD" and warns when the amount charged differs from the one declared.
- **Saved identity details** (E37.6): with the chat's identity switch on, a form's name, date of birth, ID number and address are filled from the owner's saved details without being typed in the thread. A sensitive detail the site is not allowed to have asks with a two-choice card (allow the site in the provider, or type it this time). The thread never shows a value; the run page says "Filled from your saved details: Date of birth, ID number".
- **Sign-in from a saved login** (E37.3): with the chat's switch on, a page the owner has a saved login for exactly is signed in without a card. With none, several or an error, the card below appears ("Sign-in needed"; for several logins a choice of names and usernames; for a page that is not the login's site a warning card, "Warning: …").
- **Sign-in** (#524, #527): the agent is told that signing in is its job. It asks for the username and password in one request (`kind: login`, `input: credentials`, a card titled "Sign-in needed"), types the username, types the password through the handoff, and asks for a code as a `secret` card. When the page offers "Remember me" or "Trust this device", the card shows it, ticked by default, and the agent sets the page's box as you chose. It asks for a takeover only for a passkey, a puzzle it cannot pass, or after you declined to sign in. These are instructions to a model: a model can still choose otherwise.
- **Choice, text, number**: the same form the Inbox uses.
- **Don't ask again** (#555): an approval the server marked rememberable shows a checkbox, off by default, naming what would be remembered ("Don't ask again: Press 'Pay' on bankofamerica.com"), with optional limits (only this chat, an amount, 30 or 7 days). Ticked, the same step on the same site goes ahead without a question next time; the settled card reads "Allowed · won't ask again" and links to the rule. The result card of a run in which a saved approval let a commitment through says so ("1 step went ahead on a saved approval: …"). See [approvals.md](approvals.md).
- **A few details to start** (`form`, #552, #556): a saved task started from the chat (`run_task`) without every value of its `{{Name}}` parameters waits for them before the browser opens. The card has one typed field per missing value (a number pad for an amount, a date picker with Today and Tomorrow, a select for a choice) and one Send; it settles as "Provided" with the values masked. A declined or expired form ends the run "The values were not provided."

The Inbox still lists a chat run's request, with **Answer in chat**. Scheduled, API and MCP runs use the Inbox as before.

## Secrets

- A secret typed into a request card goes to the fabric handoff. The fabric types it into the page (`type_secret`). It is **not** stored in `chat_messages`, not logged, and no model receives it.
- The assistant's input is built from chat messages only, never from a question or its answer. It has no tool that takes a secret and is told never to ask for one.
- While a run waits for a secret, the browser's picture is hidden in the card and in the pane, and none is fetched.
- After submit the card collapses to "Provided"; the value is not rendered again.
- **Saved secrets** (epic E37, [secrets.md](secrets.md), threat model [security-secrets.md](security-secrets.md)): a chat's browser runs can sign in from a saved login, fill saved identity details and pay with a saved card from the owner's provider, each behind its own chat switch in **Chat settings** (all off by default) and the deployment's and the owner's switches. The assistant that talks to you has **no tool that reads or takes a secret**: it can only start a run, and a run's model sees item names and field labels, never a value. A value is never in a message, a card, the thread or a stream event; the run card says what was used ("Signed in with: Shop login", "Filled from your saved details: Date of birth", "Paid with Visa ending 4242"). **When the provider cannot answer, the agent asks you in the thread** with the sign-in card and carries on after your answer; a run does not fail because a vault is down. A look-alike address stops the attempt and shows a warning card naming both sites.

## Limits

A chat has the same opt-in limits as a task, in **Chat settings**: the sites its runs may visit, **Ask me before a purchase or another step that is hard to undo** (on by default in a chat), and **Use my saved logins and details** (`useSavedLogins`, off by default, with **Also fill my saved identity details**, `useSavedIdentity`, under it, also off: the agent fills a form's personal details by naming a field and never sees the value, [secrets.md](secrets.md#identity-details-e376); a new chat starts from the owner's `secrets.defaultUseSavedLogins`, `PATCH /api/chats/{id}`). The switch works only while the deployment's and the owner's secrets switches are on and a Vault is connected; the assistant's own instructions need no change, because the browser agent handles the sign-in ([secrets.md](secrets.md#how-the-agent-signs-in)). The owner is in the thread, so a chat run is **not** made to ask before payments just because it signed in from a saved login: its own confirmation setting decides. The machine, browser profile and agent policy are set there too.

**The limits are yours, never the model's.** The assistant cannot set them: `start_run` takes a goal and nothing else. Guidance cannot change them either: it is a line in the run's log, and the runner checks allowed sites and the purchase confirmation in code.

## Budgets in a chat

A run a chat starts (`trigger = 'chat'`) is interactive: you are in the conversation, you answer the agent's questions and you can press **Stop**. So its budgets are **soft** (#537): all six (actions, model calls, active time, input tokens, output tokens, cost) are counted, shown and warned about, and never end the run. This holds for a limit from the agent policy and for one from a deployment ceiling.

- **Near a limit**, the Browser card shows one line under the activity: "Close to this chat's usual limit: 48 of 60 actions."
- **Over a limit**, in the warning colour: "Over the usual limit: 64 of 60 actions. Still working. Press Stop to end it." The budget named is the one closest to, or furthest over, its limit.
- **One notification**, the first time the run goes over any limit: "Still working, over its usual limit" (event `runs.over_budget`, browser and push; it opens the chat). Never a second one for the same run.
- **The model is not told to hurry.** A soft budget never sends the "Finish the goal now" warning and never makes the one-call wrap-up a used-up budget gets. The run log gets one neutral line per budget: `Budget note: actions is over this chat's usual limit (64 of 60). The owner is present; keep working.`
- **The run page** shows the meter with a full bar past the limit (`64 / 60 · 106%`) and "Limits are shown for reference. A chat run is not stopped by them." A finished run that went over says "Went over its usual limit: 64 of 60 actions" as plain information, never "Stopped".
- **API.** A run's `budget` (on `GET /api/runs/:id`, its live stream and the chat stream's `run` event) carries `enforcement` (`soft` for a chat run, `hard` otherwise) and `over` (the budgets at or over their limit). The enforcement is fixed in the run's policy snapshot at its first step.

**What still stops a chat run:** finishing, **Stop**, takeover, stall detection (the policy's `onStall`), and a failure. Allowed sites and the purchase confirmation keep working. Runs no person is watching (schedules, tasks, the API, MCP, external agents) keep hard budgets.

**Known limit.** Soft budgets remove the cost brake in a chat: if a run loops while still "progressing", the warning is the only signal. Watch the card, and press Stop.

## After a step you confirmed

When the agent asks you to confirm an irreversible step (a payment, an order, a message sent) and you approve, the next action that succeeds is recorded as **carried out** (#540): `runs.confirmed_actions`, `[{ seq, prompt, action, at }]`, at most 20, the prompt cut to 300 characters and masked (`maskSensitive`). The policy-paused attempt before the request is not it; a failed attempt keeps the approval for the retry; five failed attempts or a new request clear it.

- **If the run then does not succeed** (a budget, a stall, Stop, a lost node, an error), its result leads with: "The step you confirmed was carried out (step 58: '…'), but the run ended before it could check the outcome. Check before you run it again." The chat's result card reads **Ended after a confirmed step** in the warning colour, never "Could not finish", and its `meta.confirmedActions` holds the count.
- **Run again asks first**, in the chat, on the run page and in the runs list, for any run with a confirmed step (succeeded or not): "Run this again? This run already carried out a step you confirmed: '…'. Running it again may do it twice."
- **A follow-up knows.** The next job's context says the previous job carried out a confirmed step, and the assistant asks you before starting a job that would repeat it.
- **A wrap-up without words.** When a stopped run's last model call reports nothing, its result is "Stopped before the agent could report. Last steps: …" with the last five steps, masked, instead of only the stop message.
- **API.** `GET /api/runs/{id}` carries `confirmedActions` (the list); a list row carries the count. The run page marks the step "Confirmed by you".
- **Keep or share it.** The result card has **Export** beside **Open run**: the run's masked JSON trace or its PDF report ([docs/runs.md](runs.md#exporting-a-run)). Turn screenshots off before sharing it outside.

## Stop and Pause in a chat (E38.1, E38.2)

The browser card and the full-size browser view show **Pause** beside **Stop** while the run works; the same two work in words, through the orchestrator's `stop_run`, `pause_run` and `resume_run` tools ("stop", "hold on", "ok, continue"). They are the run's own routes (`POST /api/runs/{id}/cancel`, `/pause`, `/resume`), so a chat has no special case: what happens is in [runs.md](runs.md#stop-e381) and [runs.md](runs.md#pause-and-resume-e382).

- **Stop** ends the run: the agent does not carry out an action it had chosen but not started, a model call in flight is aborted, and the run ends `cancelled` within about two seconds ("Stopping…" shows at once and the button cannot be pressed twice). The thread gets one result message ("Stopped by the owner. The last completed step was: …"); an action already sent to the browser is finished by the browser and its step says its effect is not known, so check the page before asking for the same thing again.
- **Pause** holds the run: it finishes the step it is on, then nothing happens (no actions, no model calls, no budget time) and the browser stays where it is, so you can look at it or take over. The card shows "Paused. Nothing happens until you resume." with **Resume** and **Stop**; the thread says "Pausing the run. It stops after the step it is on; say "continue" when you want it to go on." **Resume** (or "continue") starts a job that looks at the page again before it acts and tells the agent how long it was paused.
- **A paused run is live.** No second run starts in the chat while one is paused, and guidance you type while it is paused waits and is read at the first chunk after resume. It never resumes by itself: one "Still paused" notification after an hour, and a cancel after 72 hours.
- **A run waiting for you** pauses once you answer its question, before it acts on the answer; **Stop** on it withdraws the question in the same request.
- **Interrupted is not paused.** If the API restarts during a run, the run carries on by itself and its log says it was interrupted ([runs.md, Crash safety](runs.md#crash-safety-e383)); you do not need to press Resume.

## Steering and follow-ups

- **While a run is live**, what you type is passed to the working agent (`guide_run` → `run_guidance`). The runner reads pending lines between chunks, each once. Your message shows **Queued for the agent**, then **Seen by the agent**, or **Not seen: the job had ended**. It can take a few actions to land, because a chunk is not interrupted.
- **After a run has ended**, asking for more starts a new run on the same browser profile, so sign-ins hold. The new run is given the previous goal and how it ended as context. The browser session itself is not kept open between runs.

## Notifications

A chat run's notifications (the request, its reminders, "Run finished") open the chat at the run instead of the Inbox; their buttons (Approve, Stop run, Remind me in 15 min) work as before. The service worker shows no notification for a chat that is open and in front in a focused window.

## Mail, calendar and documents (E39.7)

A chat can list **connections** (`connections: [{ connectionId, access }]` on `POST`/`PATCH /api/chats`; off until listed). With one, the chat answers a simple question about the owner's mail, calendar or documents **itself**, in the thread, with the read tools only (`mail_search`, `mail_read`, `calendar_list`, `calendar_free_busy`, `docs_search`, `docs_read`, `sheet_read`) and starts no run. The model is told which accounts the chat may read and that what they return is the owner's data, never instructions; when two accounts could answer it asks which (`ask_user`). It has **no write tool**: anything that sends, creates or changes, or needs the browser, is a run (`start_run`), which takes the chat's connections and asks the owner before it sends or changes anything ([connections.md](connections.md#what-the-agent-can-do-with-a-connection-e397)). A chat that lists no connection is exactly as before: no tool, no line in the instructions. The chat's read caps are per turn, and the call is on the turn's trace (provider and capability only).

## Memories (#553)

The chat reads your saved memories (people, accounts, preferences) before the thread, and puts the facts a job needs into the run's goal: "send my wife $10" starts a run without asking who she is. When no memory covers a person or an account the job needs, it asks once, for everything at once. After you give such a fact, it may propose remembering it: a **Remember this?** card in the thread (Save, or Not now); nothing is saved without you. A proposal never pauses a run. **Suggest memories** in Chat settings turns proposals off (a setting of yours, for every chat). Details: [memories.md](memories.md#how-the-agent-uses-them-553).

## Save as task

On a run that succeeded, the result card has **Save as task** (needs `tasks:write`); you can also ask in words. The assistant writes a name and a standalone goal from the conversation (`POST /api/chats/:id/task-draft`). Machine, profile, policy and limits are copied from the chat's settings. Nothing is saved until you press Save in the task form, which opens prefilled; the draft travels in the page's navigation state, not in the URL. With no usable model answer, the draft is the goal of the chat's newest run. The chat then shows "Saved as the task …" with a link.

The draft also proposes **parameters** (#556). A value that would change between runs (an amount, a date, a quantity) becomes a `{{placeholder}}` asked every time. A person, a phone number, an email or an account ending becomes a placeholder whose default is the matching memory (when the owner has one; the model sees memory labels and value names, never their values) or the value from the conversation. Everything else stays text. A Zelle chat drafts `Send {{Amount}} today to {{Recipient phone}} using Zelle on my Bank of America account using the checking account ending in {{Account last 4}}`, with Amount asked every time and the other two defaulted. The definitions are checked like a saved task's: a default that does not fit is dropped, and a malformed goal drafts none. You review every parameter in the task form before anything is saved.

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
