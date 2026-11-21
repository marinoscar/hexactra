# Decision record: run recordings are continuous video, unmasked, owner-only

Issue #756 (epic E45, #755). Decided 2026-11-21 by the owner.

## Context

A run keeps a **trace**: its steps, its questions and 5 to 40 screenshots of key moments. Every trace screenshot is masked in the page before it is taken (VISION §26.8, epic #536), and the masked trace is what the owner exports, shares and delivers.

The owner wants to **watch a run as a video**. Two designs were possible:

| Option | What it records | Masking | Result |
|---|---|---|---|
| A. A video stitched from masked screenshots, one after each action and about 1 per second while waiting | Still frames | Every frame masked, by the same in-page masker | Keeps the invariant. Choppy; a slideshow, not a video |
| B. A continuous screencast of the session tab | Every repaint of the page | **None.** The in-page masker draws boxes for one frame around a screenshot; it cannot stay on while the agent works, because the agent's own screenshots and clicks would see the boxes | Smooth, faithful video |

**Decision: B**, chosen by the owner, with the limits below.

## Decision

1. **Opt-in per task, and per manual run.** A task's **Record video** switch (`recordVideo`, off by default) and the start-run form's switch. The choice is copied into the run's policy snapshot. A task parameter, an agent policy, a page or the model cannot turn it on.
2. **Continuous video of the session tab.** The extension runs a CDP screencast (`Page.startScreencast`, through the `debugger` permission it already has) and encodes the frames to WebM (VP8) with WebCodecs in an offscreen document. No `tabCapture` (it needs a user gesture, and unattended runs have none) and no ffmpeg on the node.
3. **Not masked.** A password typed into a page shows as dots, as on screen; a card number, an address or a balance on the page is visible in the video. This is a deliberate exception to the masked-trace invariant. **The recording is not part of the trace.**
4. **Mitigations (they reduce exposure; they are not masking):**
   - no frame is kept while the fabric types a secret (`type_secret`);
   - no frame is kept while a field that matches the sensitive-pattern table (`packages/contracts/sensitive-patterns.json`) has focus;
   - the recording pauses while a secret or credentials request is open;
   - the player says "This video is not masked".
5. **Owner-only reach.** A recording is played only by its owner, through a short-lived signed link. It is **never** in a run export (JSON or PDF), a delivery, a run-files bundle, an agent tool's artifact, the model's context or Hexactra's MCP server. A support role has no unmasked access either.
6. **Retention.** An admin system setting `recordings.keepDays`, default **30**, or `null` = **keep indefinitely**. A nightly job (`browser.recordings.retention`) deletes older recordings; deleting a run deletes its recording. A second setting, `recordings.maxMinutes` (default 60), caps one recording.
7. **The video never changes a run.** A recorder error marks the recording `failed`; the run's outcome, steps and budget are unchanged. Stop ends the recording with the run. Recording calls are read-only fabric calls made by the runner host, like trace capture; they are not agent tools.

## Transport

The runner starts the recorder when the browser session is ready (`record_start`), pulls the encoded bytes every 10 seconds (`record_pull`, at most 8 MiB per pull) and stops it when the run ends (`record_stop`). A pulled chunk returns through the existing result → artifact-store path as `mime` + base64 `data`, under the 64 MiB native-messaging frame limit. Each chunk is stored as a part object; a job (`browser.recordings.finalize`) joins the parts, in order, into one `recording.webm`. The muxer writes a streamable WebM, so the parts concatenate into a valid file.

## Size

At 1280 px wide and the screencast's changed-frames-only rate, expect roughly 2–8 MB per minute, depending on how much the page moves. The 60-minute cap and the 30-day default bound storage.

## What did not change

- Trace screenshots, exports and the PDF stay masked, for every role.
- The trace is not the audit trail; neither is a recording.
- Stop takes effect before the next action; every agent tool still goes through `executeTool`.
