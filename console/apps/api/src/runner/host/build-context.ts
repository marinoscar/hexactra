// Binds the ports of a run to the console's services and builds its RunContext, tools and gates (E38.5). This is the one place that knows
// both the harness and the console: everything the loop and the tools reach is bound here.
import { randomUUID } from 'node:crypto';

import { ASK_TOPICS } from '../../approvals/approval-match';
import { readAppLimits } from '../../policies/policy-snapshot';
import { readRunInputs } from '../../tasks/task-params.schemas';
import { assembleRoundInput, observeRound, sitesLine, VISION_NOTES } from '@marinoscar/hexactra-browser-agent/round';
import type { BrowserHooks, BrowserState } from '@marinoscar/hexactra-browser-agent/context';
import { ScreenshotWindow } from '@marinoscar/hexactra-browser-agent/context-settings';
import { siteGate } from '@marinoscar/hexactra-browser-agent/gates';
import { riskGate } from '@marinoscar/hexactra-browser-agent/gates';
import { browserInstructions } from '@marinoscar/hexactra-browser-agent/instructions';
import { currentUrl, currentUrlOf } from '@marinoscar/hexactra-browser-agent/page';
import { domainAllowed } from '@marinoscar/hexactra-browser-agent/policy';
import { browserTools } from '@marinoscar/hexactra-browser-agent/tools';
import { instructionsWithOutputs, outputsHandle, outputsNudge, outputsWrapUpNote } from '../outputs';
import { readOutputs } from '../../tasks/task-outputs.schemas';
import { BudgetTracker, GatePipeline, ToolRegistry, type LoopProfile, type Ports, type RunnerTool } from '@marinoscar/hexactra-agent';
import { createRunLoop, type RunLoop } from '@marinoscar/hexactra-agent/engine';
import { guidanceSummary } from '../trace';
import { readUsedSavedCards } from '../saved-cards';
import { readUsedSavedIdentity } from '../saved-identity';
import { readUsedSavedLogins } from '../saved-logins';
import { beginCardPay, cardCovers, endCardPay, type SavedCardToolsContext } from '../saved-card-tools';
import { FabricBrowser } from './fabric-browser';
import { GOAL_RUN_HOP_MARGIN_MS, GOAL_RUN_MAX_RUNTIME_MS } from '../goal-run.enqueue';
import type { HostContext, HostExt } from './context';
import type { HostDeps } from './deps';
import { eventsPort } from './events-port';
import { approvalPort } from './approvals-port';
import { AiModelPort } from './model-port';
import { PrismaRunStore } from './prisma-run-store';
import { picturesPort } from './pictures-port';
import { policyPort } from './policy-port';
import { questionPort } from './question-port';
import { readMasking } from './read-masking';
import { aboutOwner } from './about-owner';
import { buildSavedCardContext } from './card-context';
import { priceTable } from './policy-snapshot';
import { controlPort } from './control-port';
import type { RunStart } from './start';
import { originOf } from './tools/secrets-support';
import { buildSavedCardTools } from './tools/saved-card-tools';
import { savedIdentityTools } from './tools/saved-identity';
import { savedLoginTools } from './tools/saved-logins';
import { proposeMemory, proposeSavingLogin } from './tools/propose';

export interface BuiltRun {
  /** The harness's loop for this run: `loop.run(profile)` drives it. */
  loop: RunLoop<HostContext['memory'], HostExt>;
  ctx: HostContext;
  profile: LoopProfile<HostContext>;
}

export async function buildRun(d: HostDeps, s: RunStart): Promise<BuiltRun> {
  const { run, db, userId, orgId, lease, tr, stop, session, memory, snapshot, stall, flags } = s;
  const sessionRef = { id: s.sessionId };
  const sessionId = () => sessionRef.id;
  const app = snapshot.appLimits ?? readAppLimits(run.appLimits);
  const policy = policyPort(snapshot, Boolean(d.modelTiers));
  const effective = policy.policy.effectiveBudget;
  // Starts from what the run already used in earlier jobs and chunks, so a continued run never gets a fresh budget.
  const tracker = new BudgetTracker(effective, {
    actions: run.stepCount,
    modelCalls: run.modelCalls,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: Number(run.costUsd),
    costKnown: run.costKnown,
    activeMs: run.activeMs,
    warned: memory.warned,
    overNoticed: memory.overNoticed,
  });
  // Context efficiency (#406): every knob is the run's own snapshot, never a constant.
  const context = snapshot.spec.context;
  const shotWindow = new ScreenshotWindow(context.screenshotsKept, context.pruneBatch);

  const unattended = !run.conversationId && run.trigger !== 'chat';
  const allowedDomains = run.task?.allowedDomains ?? run.conversation?.allowedDomains ?? [];
  const appDomains = app?.allowedDomains ?? [];
  const sites = {
    allowed: (url: string) => domainAllowed(url, allowedDomains) && domainAllowed(url, appDomains),
    text: [allowedDomains.join(', ') || null, appDomains.length ? `the app's: ${appDomains.join(', ')}` : null].filter(Boolean).join('; '),
  };
  const used = { logins: readUsedSavedLogins(run.usedSavedLogins), identity: readUsedSavedIdentity(run.usedSavedIdentity), cards: readUsedSavedCards(run.usedSavedCards) };

  const browser = new FabricBrowser(session, d.fabric, sessionId);
  const masking = readMasking(memory, browser, () => currentUrlOf(browser));
  const store = new PrismaRunStore(d, userId, run.id, lease, { run, session, sessionId: () => sessionRef.id });
  const ports: Ports = {
    model: new AiModelPort(d.ai, userId, orgId),
    store,
    questions: questionPort({ d, userId, runId: run.id, run, session, sessionId, memory, saveLoginOn: flags.saveLogin }),
    control: controlPort(stop, db, run.id),
    policy,
    events: eventsPort(d.tasks, d.notifier, userId, run),
    telemetry: tr,
    clock: { now: () => d.clock() },
    ids: { uuid: () => randomUUID() },
    approvals: approvalPort({ d, userId, orgId, run, currentUrl: () => currentUrlOf(browser), hasBrowser: () => Boolean(sessionRef.id) }),
    pictures: picturesPort({ d, userId, runId: run.id, memory, browser, masking, hasBrowser: () => Boolean(sessionRef.id) }),
  };
  const browserState: BrowserState = { labels: new Map(), marks: new Map(), view: null };
  const identityParams = readRunInputs(run.inputs)?.identity ?? [];
  const hooks: BrowserHooks = {};
  const ext: HostExt = {
    browser,
    sites,
    state: browserState,
    shotWindow,
    observationChars: context.observationChars,
    // The opt-ins of the run's task, or of the chat that started it (#484); an ad-hoc run has none. An UNATTENDED run that signed in with a saved
    // login keeps it on whatever the task says, unless the task set `unattendedPayments: allow` (E37.3): it turns on the moment the run first uses one.
    confirmRisky: () => {
      const own = (run.task?.confirmRiskyActions ?? run.conversation?.confirmRiskyActions ?? false) || app?.confirmPurchases === true;
      // A card was typed and the pay button is not pressed yet (E37.7): the click is gated, so the approval for the card is what lets it through.
      const cardTyped = memory.savedCards?.approval?.typed === true && memory.savedCards.approval.pay !== 'done';
      return own || cardTyped || (used.logins.length > 0 && unattended && (run.task?.unattendedPayments ?? 'ask') !== 'allow');
    },
    sensitiveParams: () => [...(readRunInputs(run.inputs)?.sensitive ?? []), ...(flags.savedIdentity ? [] : identityParams.map((p) => ({ key: p.key, label: p.label })))],
    masking,
    hooks,
    // What this run must return (E39.5): the task's outputs as they were when the run started.
    outputs: outputsHandle(readOutputs(run.outputsSpec)),
    d,
    db,
    fabric: { session, sessionId },
    run: { task: run.task, inputs: run.inputs, origin: run.origin, clientName: run.clientName },
    clientLabel: app?.clientName ?? 'Hexactra',
    unattended,
    appConfirmsPurchases: app?.confirmPurchases === true,
    used,
    flags,
  };
  // Routing steps (#405) take a `seq` but are not actions: the sequence runs ahead of `stepCount` by their number.
  const newest = await store.newestSeq();
  const loop = createRunLoop<HostContext['memory'], HostExt>(ports, {
    run: { id: run.id, userId, orgId, goal: run.goal, trigger: run.trigger, taskId: run.taskId ?? null, conversationId: run.conversationId ?? null },
    memory,
    state: {
      stepCount: run.stepCount,
      seq: Math.max(run.stepCount, newest),
    },
    tracker,
    stall,
    tier: s.tier,
    startTier: snapshot.spec.models.startTier,
    active: s.active,
    prices: await priceTable(d),
    // This job hands the run on a little before its lease runs out.
    hopAfterMs: GOAL_RUN_MAX_RUNTIME_MS - GOAL_RUN_HOP_MARGIN_MS,
    startedAt: s.jobStartedAt,
    ext,
  });
  const ctx: HostContext = loop.context;

  // The saved cards' own context: the rules of a card are in saved-card-tools; this hands them the run's helpers.
  const cardCtx: SavedCardToolsContext = buildSavedCardContext(ctx);
  Object.assign(hooks, {
    covers: (target) => cardCovers(memory.savedCards, target as never),
    payBegin: (target) => beginCardPay(cardCtx, target as never),
    payEnd: (ok) => endCardPay(cardCtx, ok),
    savedApprovalBlocked: () => app?.confirmPurchases === true || Boolean(memory.savedCards?.paymentUnknown),
    secretTyped: async ({ handoffId }) => {
      // The owner's own sign-in was typed (E37.4b): remember which one and the page it was typed on, as the browser host reports it (never
      // the model's words), so `propose_saving_login` can offer to save exactly it.
      if (memory.saveLogin?.offerable?.includes(handoffId)) {
        const origin = originOf(await currentUrl(ctx));
        if (origin) memory.saveLogin.signIn = { handoffId, origin, offered: false };
      }
    },
  } satisfies BrowserHooks);

  // The tools, in the order the model has always been offered them.
  const registry = new ToolRegistry<HostContext>();
  registry.registerAll(browserTools.core as unknown as RunnerTool<HostContext>[]);
  if (d.proposals) registry.register(proposeMemory);
  if (flags.saveLogin) registry.register(proposeSavingLogin);
  registry.register(browserTools.typeSecret as unknown as RunnerTool<HostContext>);
  if (flags.savedLogins) registry.registerAll(savedLoginTools);
  if (flags.savedIdentity) registry.registerAll(savedIdentityTools);
  if (flags.savedCards) registry.registerAll(buildSavedCardTools(cardCtx));
  registry.register(browserTools.finish as unknown as RunnerTool<HostContext>);

  const profile: LoopProfile<HostContext> = {
    // The shared instructions, then (for a task with outputs) the list of what to return: the same text every round (the stable prefix, #406).
    instructions: instructionsWithOutputs(browserInstructions(ASK_TOPICS, registry.usageNotes(ctx)), readOutputs(run.outputsSpec)),
    registry,
    pipeline: new GatePipeline<HostContext>([siteGate as never, riskGate as never]),
    visionNotes: VISION_NOTES,
    observe: (c) => observeRound(c as never),
    assembleInput: assembleRoundInput,
    contextLines: (c) => [sitesLine(c as never)],
    summarizeGuidance: guidanceSummary,
    aboutOwner: await aboutOwner(d, userId, run, memory.context),
    beforeImplicitFinish: (c) => outputsNudge(c.ext.outputs, c.memory),
    wrapUpNote: (c) => outputsWrapUpNote(c.ext.outputs),
  };
  return { loop, ctx, profile };
}
