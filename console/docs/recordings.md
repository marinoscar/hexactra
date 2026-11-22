# Run recordings (epic #755)

A run can keep a **video** of its browser tab. The owner switches it on per task (or per manual run), watches it on the run page, and an admin decides how long recordings are kept. Decision record: [`docs/decisions/run-recordings.md`](../../docs/decisions/run-recordings.md).

In short:

- **Off by default.** Task form → **Record video**, the start-run form's switch, or a benchmark's **Record video** tick per policy and **Record all** (the trial runs of the ticked policies, #845; the benchmark-wide `recordVideo: true` of #841 records every policy). The choice is fixed on the run when it is created (`runs.record_video`, from the task's `recordVideo` or the start request's `record`); a task parameter, an agent policy, a page or the model cannot turn it on. MCP tools neither show nor set it.
- **Continuous, not masked.** The extension records the session tab with a CDP screencast and encodes it to VP8; the console turns it into a WebM file. **The video is not masked**: a card number or an address on the page is visible. Typed passwords show as dots, as on screen. This is the one exception to "every stored image is masked" ([runs.md](runs.md#what-is-masked)), and the recording is **not part of the trace**.
- **Owner-only.** Played on the run page through a 15-minute signed link. Never in a JSON or PDF export, a delivery, run files, an agent tool, the model's context or the MCP server.
- **Retention.** Admin → Browser agent → **Run recordings**: delete after N days (default **30**) or keep indefinitely. A nightly job enforces it. Deleting a run deletes its recording.
- **Never changes a run.** A recorder error marks the recording `failed`; the run's result is unchanged.

## How a recording is made

| Step | Who | What |
|---|---|---|
| Start | Runner host (`runner/host/recorder-port.ts`) | When the browser session is ready and the snapshot says `recordVideo`, it creates a `run_recordings` row (`recording`) and sends `record_start` to the fabric. |
| Capture | Extension (`src/recorder.ts`, offscreen document) | `Page.startScreencast` (JPEG frames, at most 1280 px wide) → WebCodecs `VideoEncoder` (VP8, a key frame at least every 2 s) → whole records of the `HXR1` framed stream (`apps/chrome-extension/src/recording-format.ts`). |
| Pull | Runner host | Every 10 s, `record_pull` returns the bytes written since the last pull (at most 8 MiB). Each chunk is stored as a part object `run-recordings/<user>/<run>/part-NNNNN.hxr`. |
| Stop | Runner host | When the run ends (done, failed, stopped, crashed) or `maxMinutes` is reached: `record_stop` returns the last bytes; the row becomes `processing` and the finalize job is queued. |
| Finalize | Job `browser.recordings.finalize` | Reads the parts in order and muxes them into one `recording.webm` with its duration and cues (seekable), deletes the parts, sets `ready` with its size and duration (or `failed`). |

The recorder's fabric calls are read-only and made by the runner host, like trace screenshots; they are not agent tools, take no budget and are not seen by the stall detector.

### Nothing is kept out of a recording

A recording withholds nothing (the owner's decision, #882). Every frame of the tab is kept, also while the fabric types a secret or a saved value, while a password or card field has focus, and while a secret or sign-in request is open. What is typed into the page can be seen: a one-time code, a username, a card number. A password field shows dots, as on screen. Everything else on the page is in it too: names, addresses, balances, a document the agent opened.

The recording is held (no frame kept) only while the owner has paused the run; it goes on while the run waits for the owner's answer.

**Limits.** The recording follows the tab that was active when it started; a page the agent opens in a new tab is not in the video. A run whose browser restarted (a new session) continues in a new recording, and the video skips the time in between (`note: restarted`).

## Statuses

| Status | Meaning |
|---|---|
| `recording` | The run is working; parts are being stored. |
| `processing` | The run ended; the finalize job is joining the parts. |
| `ready` | One `recording.webm`; playable. |
| `failed` | The extension could not record (no WebCodecs, tab closed, storage error). `error` holds a short code; the run is unaffected. |

No row is created when storage is not configured (the Doctor check `runs.trace_storage` already warns about that).

## Watching and deleting

| Route | Permission | What |
|---|---|---|
| `GET /api/runs/:id/recording` | `runs:read`, owner | The recording's status, size, duration, `expiresAt` (from the policy), or 404. |
| `POST /api/runs/:id/recording/link` | `runs:read`, owner | A signed playback URL valid for 15 minutes. |
| `GET /api/recordings/:token` | the signed link | Streams `video/webm` with HTTP Range (206), `Cache-Control: no-store`. |
| `DELETE /api/runs/:id/recording` | `runs:delete`, owner | Deletes the recording and its objects; audited as `runs.recording_deleted`. |

The run page shows a **Recording** card: the player, the status, "This video is not masked", the date it will be deleted, and Delete. There is no MCP tool and no SDK or CLI command for a recording ([parity.md](parity.md)).

## Retention

System settings namespace `recordings` (`/api/system-settings`, `system_settings:write` to change):

| Field | Default | Meaning |
|---|---|---|
| `keepDays` | `30` | Delete a finished recording this many days after it was made (1–3650). `null` keeps recordings indefinitely. |
| `maxMinutes` | `60` | The longest one recording can be (1–480). The recorder stops at this length; the run goes on. |

The job `browser.recordings.retention` runs daily at 03:30 (the `@Cron` only enqueues it). When `keepDays` is set, it deletes `ready` and `failed` recordings whose `createdAt` is older than `keepDays`, 500 at a time, at most 50,000 per pass; it never touches a `recording` or `processing` one. Rows are deleted first, objects after commit; a storage error logs a count and does not keep the row. The totals are in the audit event `runs.recordings_purged`. Expiry is computed when the job runs, so shortening `keepDays` applies to recordings already stored. The Doctor check `runs.recordings_retention` warns when the job has not succeeded for 48 hours.

A run's recording also goes with its run: deleting a run by hand, by filter or by run retention removes the recording objects too.

## Size

Roughly 2–8 MB per minute at 1280 px, depending on how much the page moves (the screencast only sends changed frames). One hour, the default cap, is at most a few hundred MB.
