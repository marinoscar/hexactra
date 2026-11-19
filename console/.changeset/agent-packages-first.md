---
'@marinoscar/hexactra-agent': patch
'@marinoscar/hexactra-browser-agent': patch
---

The agent harness and the Hexactra browser toolset move out of the console API into workspace packages (E38.9, #614). `@marinoscar/hexactra-agent` is the generic harness (loop, tools, gates, budgets, checkpoints, ports, `createRunLoop`, `./testing` with `runHarnessHostConformance`); `@marinoscar/hexactra-browser-agent` is the browser and desktop toolset on top of it. No behaviour change.
