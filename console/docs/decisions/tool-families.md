# Decision: tool families, and how the agent chooses its tool

**Status:** accepted (epic E41, #697: #698 to #703). **Scope:** the run agent and the chat front of the console.

## The problem

The agent reached for the browser for almost everything. In the owner's example (2026-11-20), a chat with a Google account connected found an airline miles balance with a browser run, then the owner wrote "Send an email to … with the information including a screenshot". The agent went back to the airline's site in the browser and never used the mail tool it had.

No code ranked one tool over another. The bias came from what the model was told, what it was shown, and what it could not do. It was told it was "the user's hands and eyes … You operate a real Chrome browser". The first round said "Start by navigating or observing the page". It was never told which accounts it had. A previous job's screenshot could not be attached. The chat front described every job as "a browser run".

## The decision

1. **A tool family is a descriptor, not a rank in code.** `ToolFamily` (`packages/hexactra-agent/src/tool-family.ts`) has an id, a title, one sentence on when to use it, a rank (which only orders the list), optional how-to sections, and an optional per-run `toolbox` line. A tool names its family in `RunnerTool.family`. The registry lists the families that have at least one tool offered, sorted by rank and then by registration order. This is deterministic, so the prompt cache holds.
2. **The model reads its families and one routing rule.** The instructions open with a neutral identity, then **Your tools** (one line per family), then the fixed `ROUTING_RULE`: use an account or added tool when one can do the job; use the browser for what is on a website, when no tool covers it, or when a tool failed; mix them when needed; do not look up again what is known; ask when two could do it. Each offered family's own sections follow. The browser's "How to see" and "How to act" appear only when the browser is offered.
3. **Every round names the run's tools.** The toolbox line reads `Tools you have: … Accounts: c1 "Work" (Google, read and change: …). Added tools: "Notes" (2 tools).` The first round says "Choose the tool that fits the goal."
4. **Results travel as artifacts.** These are masked trace pictures and the PDF report, referenced by handle. A chat's next job can reach the previous job's artifacts with `run: "previous"`. `save_screenshot` keeps a picture on purpose.
5. **The chat front routes by outcome.** It writes the goal as the outcome, names the account, states the known facts, and sets an `expects` hint that is never authority.
6. **The tools are present when needed, without granting anything.** A task drafted from a chat proposes the accounts the chat used, for the owner to confirm. A run that did account work in the browser tells the owner afterwards which account could have done it.

**Why describe rather than rank in code.** A ranking in code (offering only the accounts tools, or hiding the browser when an account matches) would strand a run whenever the guess is wrong. A page is sometimes the only way, and a tool sometimes fails. It would also change what a task can do, which belongs to the owner's opt-ins. Describing the families leaves the choice with the model, and the replay suite measures that choice (`test/scenarios/routing/`, `test/scenarios/chat/`). The only code-level effects are the ones that already existed: `needsBrowser: never` offers no browser, and a tool the owner switched off is not offered (E50.17: what is set up and switched on is always available, in every run and chat).

**Invariants kept.** Every call still goes through `executeTool`. Content from a connection or an MCP server, including the server's own `instructions`, is data: it is sanitised, capped and placed only in its family line under the trust line, and it changes neither the tools offered nor the gates (`routing/mcp-instructions-injection.scenario.json`). No family grants a connection.

## Tool order (E41.2)

**Kept as it was.** The connection and MCP tools are registered after the browser core tools, which protects the prompt cache and isolates the effect of the new text. The issue asked for a live A/B run of the routing set with the connection tools first, to ship the new order only if the pass rate rose by 10 points or more on the default tier. **That run has not been made:** the sessions that built E41 had no AI provider key. With no numbers, the order is unchanged. To revisit it, run `npm run scenarios:live --workspace=api -- --set routing` twice, once on each order behind a local flag, and record the result here.

## Deferred toolsets (`open_toolbox`)

**Decided and built for MCP servers (E50.17, #987).** "Set up and switched on means always available" made the old per-run cap of 40 MCP tools a silent drop: a tool the owner switched on would not be offered. Of the two options the issue named, the first was built:

1. **`open_toolbox(family)`** (chosen). When the enabled tools of all MCP servers fit the cap (`MCP_MAX_TOOLS_PER_RUN`, 40), nothing changes: every tool is offered from the start, and the trust line goes with the first. Over the cap, every server is a **closed toolbox**: its tools are registered but `available` only once the run opened it; a family "Toolboxes the owner added" names each server in "Your tools" with its purpose (its own instructions, else its first tool titles) and tool count; and the `open_toolbox` tool (`toolbox`: the server's label, an enum of the run's servers) records the open in the run's memory (`connections.toolboxes`, kept across jobs) and as a step. The tools are offered from the next round. The trust line moves to `open_toolbox`, which stays offered for the whole run so the instructions do not change when the last box opens. Cost to the prompt cache: the tool list changes at each open, never otherwise; the instructions (and so the cached prefix's head) are the same for the whole run. Opening grants nothing: only tools the owner switched on are in a box, and each call goes through `executeTool`, the connection gate and `McpRunService.check`. Code: `src/runner/host/tools/connections/toolbox.ts`, composed by `mcp.ts`; test: `runner-mcp.db.spec.ts`, "drops no tool over the per-run cap".
2. *A raised cap with notices* (not built). It would still leave tools unoffered.

The accounts family (Google and Microsoft) is not deferred: its tool count is fixed (about 20). Whether a run offered about 100 tools chooses worse than one offered only what the job needs is **still not measured** (no live model): if its routing pass rate is 10 points or more lower, the same mechanism could defer more families.

## Live acceptance (E41.6)

The pass bars are: routing set at least 90% on Balanced, chat-front set at least 90%, and the existing set with no drop in pass rate and median steps within 10% of the E41.1 baseline. **They have not been measured**, because there was no provider key. No live baseline exists either (E41.1 recorded its absence). What has been verified is the scripted suite: all 10 routing scenarios and all 6 chat-front scenarios pass in CI, which proves the kit, the tools, the gates and the fakes, but not the model's choices. Run `npm run scenarios:live --workspace=api` (all sets), `-- --set routing`, and `-- --chat`, on each tier, and record the numbers on epic #697.

## Follow-up: a general artifact store

Today an artifact is a run's own masked trace picture or its PDF report, or the previous job's. These cases would need more, as handles rather than inline bytes:

- a **mail attachment** passed to `file_upload` ("save the PDF Person A sent to my files"). Today the run says it cannot; see `routing/find-attachment-save-to-files`;
- a **download** the browser made (a statement, a ticket), to attach or upload;
- an **MCP tool's binary result** (an image, a file). Today it is dropped, with its kind named.

Each would be a typed, short-lived, owner-scoped handle in the artifact store, masked where it is a picture, with the same 10 MB limit. This is not built.

## How to add a tool family

The checklist is in [runner.md, How to add a tool family](../runner.md#how-to-add-a-tool-family).
