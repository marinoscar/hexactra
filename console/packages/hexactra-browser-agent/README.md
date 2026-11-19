# @marinoscar/hexactra-browser-agent

The Hexactra browser toolset for [`@marinoscar/hexactra-agent`](../hexactra-agent/README.md): what an agent needs to drive a real browser and the node's desktop.

- **Tools** (`/tools`): observe, navigate, click, type, pointer, desktop, look, `request_human`, `type_handoff_secret`, `finish`, in the order the model is offered them (the order is part of the cached prompt prefix: never sorted).
- **Gates** (`/gates`): the site gate (allowed sites) and the risk gate (the confirmation gate and saved approvals) with the target classification in `/policy`. They implement the harness's `Gate` interface; the host plugs them into its pipeline.
- **Vision** (`/vision`, `/round`, `/context-settings`): screenshots with numbered marks, the screenshot window, how a round is shown to the model.
- **Instructions** (`/instructions`): the browser agent's system instructions, composed from sections.
- **`BrowserPort`** (`/browser-port`): the browser as a port: `act`, `typeSecret`, `capture`, `captureTrace`. The host binds it to its fabric session; this package never imports a fabric client.
- **`/testing`**: `FakeBrowser`, a scriptable fake site, and `fakeBrowserRun()`, a browser context over the harness fakes.

It depends on the harness and on `zod`, and on nothing else: no console code, no NestJS, no Prisma (a test scans the built output). The secrets tool families (saved logins, identity details, cards) are not here yet: they reach console services and stay in the app until a `SecretsPort` exists (`docs/decisions/agent-packages.md`).

**Stability: experimental** (`0.1.0-next.x`, one real host). Not published to npm yet.

## Use

```ts
import { createRunLoop } from '@marinoscar/hexactra-agent/engine';
import { GatePipeline, ToolRegistry } from '@marinoscar/hexactra-agent';
import { browserInstructions, browserTools, riskGate, siteGate, assembleRoundInput, observeRound, sitesLine, VISION_NOTES } from '@marinoscar/hexactra-browser-agent';

const loop = createRunLoop(ports, { run, memory, ext: browserExt });   // ext: the BrowserPort, the allowed sites, the marks, the masking hooks
const registry = new ToolRegistry().registerAll([...browserTools.core, browserTools.typeSecret, browserTools.finish]);
await loop.run({ instructions: browserInstructions(askTopics), registry, pipeline: new GatePipeline([siteGate, riskGate]), visionNotes: VISION_NOTES, observe: observeRound, assembleInput: assembleRoundInput, contextLines: (c) => [sitesLine(c)], summarizeGuidance, aboutOwner: '' });
```

`apps/api/src/runner/host/build-context.ts` is the full example.

## Add a tool

One file per tool or small family in `src/tools/`, written with `defineRunnerTool`, registered in `src/tools/index.ts` at the position it should be offered, tested alone against `fakeBrowserRun()` in `test/`. A tool imports no loop code and no other tool (`test/imports.spec.ts`). A new tool changes the pinned tool list of the console's characterisation spec: update it deliberately. The checklist is in `console/docs/runner.md`.

## Build

```bash
npm run build:packages   # from console/: the harness first, then this package
npm run test:packages
```
