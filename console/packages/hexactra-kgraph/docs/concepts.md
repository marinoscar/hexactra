# Concepts

## The idea

An agent loop is an *interpreter*: a model decides every step of every run. A procedure turns the model into a *compiler and repairer*: it discovers the path once, the steps are kept, later runs replay them with a check after each, and the model returns only when a check fails.

## The graph

Per owner, the graph holds **procedures** and what they touch.

| Node | What |
|---|---|
| `Task` | The owner's saved task a procedure belongs to. |
| `Procedure` | A task's learned way of doing its job, across versions. |
| `ProcedureVersion` | One immutable, runnable graph of steps. |
| `Step` | One step (kinds below). |
| `Site` | A registrable domain a step touches (`example.com`). |
| `Screen`, `Element` | A site's surface graph: screens, and elements by role, label and selector candidates. |
| `Account` | A connected account by reference (connection id and provider). Never a token. |
| `Tool` | A tool by name, family and whether it commits. |
| `SecretRef` | A saved login, identity or card by label. Never the value. |
| `Parameter` | A declared task input; `sensitive` ones never reach the graph or a judge. |
| `Output` | A named value the procedure produces. |

| Edge | From → to |
|---|---|
| `uses` | step → tool, site, account, secret reference |
| `then` | step → step (control flow; `loop: true` only from a `foreach` body back to its `foreach`) |
| `feeds` | step → later step (data flow: an output fills an argument) |
| `on` | step → screen or element |
| `transition` | screen → screen |
| `version_of` | version → procedure |

## Step kinds

| Kind | Does | Model call |
|---|---|---|
| `call` | Runs a tool with bound arguments. | no |
| `extract` | Reads a value from an earlier result: a field path, or a bounded pattern over its text. | no |
| `judge` | One small model call with a **fixed output schema**. It gets the task's goal (the owner's words) and its declared inputs; it stores no instruction from a run. | one, small |
| `ask` | The owner is asked (`confirm`, `missing_input`, `choice`); the host's gates decide when. | no |
| `check` | A postcondition on its own. | no |
| `branch` | A guard on observed state picks `then` or `else`. | no |
| `foreach` | Repeats a body once per item of a list output (bounded by `maxItems`). | no |

Every step may carry `checks` (postconditions run after it), `sites`, a `segment` and `commitClass`.

## Bindings

Where an argument comes from:

| Kind | Value |
|---|---|
| `literal` | A fixed value. Allowed only when it passes the sensitive-value check. |
| `parameter` | A declared task parameter, filled by the run's inputs. |
| `output` | An earlier step's result, optionally a field `path` (`items.0.link`). |
| `judge` | A field of an earlier judge step's result. |
| `secret` | A saved login, identity or card by reference: the host's secret path types it. |

## Checks

Each has a `tolerance` (0 exact … 1 anything).

| Kind | Passes when |
|---|---|
| `location` | The page is on the host and the path matches the pattern (`*` one segment, `**` any). |
| `view_digest` | The view digest (a hash of structure, not text) is close to the recorded one. |
| `element_present` | The element (by surface-graph id or selector) is present. |
| `result_shape` | A step's result has `ok` as expected and the listed fields. |

## Versions and states

`candidate` (compiled, never replayed) → `verified` (one clean replay) → `active` → `suspended` (circuit breaker) → `retired`. A suspended version can be restored to `active`. `canTransition(from, to)` is the table; a store refuses anything else.

A version records why it differs from its parent: `initial`, `structural` (promotes after a clean run), `sensitive` (adds or changes a send, a payment, a recipient, a site, an account or a credential: waits for the owner).

## Modes

Per task: `off` (AI only; nothing captured), `learn` (the AI runs as before; a procedure is compiled and never executed), `reuse` (compiled steps run without the model; the AI repairs). `effectiveMode` folds the four switches (deployment, user, task, run) into one: `off` unless every level allows it.
