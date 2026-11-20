// Starting or resuming a job of a run (E38.3, E38.2): load it, recover from an interrupted job, take the policy snapshot, fold the person's
// answer into the memory, open or reuse the browser, and decide which saved-secret tools this run may offer. Everything before the loop.
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { FabricSession, handoffOutcome } from '../fabric-session';
import type { RunLease } from '../lease';
import { readAppLimits, readSnapshotConnections, type RunPolicySnapshot, type SnapshotConnection } from '../../policies/policy-snapshot';
import { tierHasVision, tierProblem } from '../tier-request';
import type { QuestionConstraints, QuestionGate, QuestionInputType, QuestionOption, QuestionResponse } from '../../questions/questions.contract';
import { askedKey } from '../saved-identity';
import { approvalFromAsk, reconcileCardsOnStart } from '../saved-card-tools';
import { clearUnknown, readStallState, reconcileSteps, resetStall, runActivity, type RunOutcome, type StallState, type Tier } from '@marinoscar/hexactra-agent';
import type { GateTarget } from '@marinoscar/hexactra-browser-agent/policy';
import { PrismaRunStore } from './prisma-run-store';
import type { AgentTrace } from '../agent-trace';
import type { RunStopSignal } from '../stop-signal';
import type { HostDeps } from './deps';
import { finishRun, pauseEarly, recordAnswer } from './finish-run';
import { answerLine } from '@marinoscar/hexactra-browser-agent/request-human-spec';
import { foldConnectionAnswer, handoffOfQuestion } from './connections/answer';
import { pausedFor } from './paused-for';
import { openFabricSession } from './browser-session';
import { readNeedsBrowser, type NeedsBrowser } from './connections/run-connections';
import { policySnapshot } from './policy-snapshot';
import type { RunMemory } from './run-memory';

    
/** The job's run, ready for the loop. */
export interface RunStart {
  run: NonNullable<Awaited<ReturnType<typeof loadRun>>>;
  db: ReturnType<HostDeps['prisma']['forUser']>;
  userId: string;
  orgId: string | null;
  lease: RunLease;
  tr: AgentTrace;
  stop: RunStopSignal;
  session: FabricSession;
  sessionId: string;
  memory: RunMemory;
  snapshot: RunPolicySnapshot;
  tier: Tier;
  stall: StallState;
  active: { activeMs: number; activeSince: Date | null };
  jobStartedAt: number;
  /** The connections the run may use and whether its browser opens at the first browser tool (E39.7). */
  connections: { list: SnapshotConnection[]; needsBrowser: NeedsBrowser; lazyBrowser: boolean };
  /** Which saved-secret tool families this run may be offered. */
  flags: { savedLogins: boolean; savedIdentity: boolean; savedCards: boolean; saveLogin: boolean };
}

/** The run row with what the runner reads. */
export function loadRun(d: HostDeps, userId: string, runId: string) {
  return d.prisma.forUser({ userId }).run.findFirst({ where: { id: runId }, include: { task: true, conversation: { select: { allowedDomains: true, confirmRiskyActions: true, useSavedLogins: true, useSavedIdentity: true, useSavedCards: true } } } });
}

export async function startRun(d: HostDeps, runId: string, userId: string, orgId: string | null, lease: RunLease, tr: AgentTrace, stop: RunStopSignal): Promise<RunOutcome | RunStart> {
  const jobStartedAt = d.clock();
    const db = d.prisma.forUser({ userId });
    const run = await loadRun(d, userId, runId);
    if (!run) return 'failed';
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return run.status;
    // A paused run waits for its owner (E38.2): a job that finds it paused (a late handoff check) does nothing.
    if (run.status === 'paused') return 'paused';
    await tr.beginRun(run, (data) => db.run.updateMany({ where: { id: run.id }, data }));
    const session = new FabricSession(d.fabric);
    // The run row as last written: its active-time fields drive the time budget (#399).
    let current: { activeMs: number; activeSince: Date | null } = run;
    const memory: RunMemory = (run.transcript as unknown as RunMemory | null) ?? { log: [], chunks: 0 };
    // A transcript written before #550 held a bare approval: it covers the next risky click, as it did then.
    if (memory.confirmationGranted) {
      memory.confirmedTarget ??= { category: null, label: null, host: null };
      delete memory.confirmationGranted;
    }

    // A retried job (E38.3): the step rows are the truth. What the memory lacks is appended, a step still in `intent` is `unknown`,
    // and the model is told the run was interrupted. Saved at once: a second crash must find the same state, not repeat the work.
    const recovery = await reconcileSteps(new PrismaRunStore(d, userId, run.id, lease, { run, session, sessionId: () => run.sessionId }), { memory, stepCount: run.stepCount, interrupted: run.status === 'running' && lease.previous !== null });
    if (recovery.recovered || recovery.unknown.length > 0) {
      run.stepCount += recovery.appended;
      // The owner's approval was for a call that may have happened: it is spent (the gate asks again).
      if (recovery.unknown.length > 0 && memory.connections) memory.connections.approved = null;
      await db.run.updateMany({ where: { id: run.id, ...lease.guard }, data: { transcript: memory as never, stepCount: run.stepCount, recoveries: { increment: 1 } } });
      d.tasks.metrics.recovered(recovery.unknown.length);
      d.log.warn(`run ${run.id}: recovered after an interruption, ${recovery.appended} step(s) reconciled, ${recovery.unknown.length} unknown`);
    }

    // A sign-in cut off between two fields (the job crashed or was retried, E37.3): what was typed is known from the phases, never retyped blindly.
    const interrupted = memory.savedLogins?.attempt;
    if (interrupted && (interrupted.username === 'typing' || interrupted.password === 'typing' || interrupted.code === 'typing')) {
      if (interrupted.username === 'typing') interrupted.username = undefined;
      memory.log.push('(A sign-in from a saved login was cut off while it was typing. Look at the page and read each field before typing again. A password that may already have been typed is not typed a second time: if you are not signed in, ask the owner.)');
    }

    // A saved card cut off between two fields, or around the pay click (E37.7): what was typed is known from the phases, a payment that
    // may have happened is never repeated.
    for (const line of reconcileCardsOnStart(memory.savedCards)) memory.log.push(line);

    if (run.cancelRequested) {
      await finishRun(d, userId, run.id, run.sessionId, session, 'cancelled', { error: 'Cancelled by the user', stopReason: 'cancelled' });
      return 'cancelled';
    }

    // The owner pressed Pause (E38.2) before this job began (it was queued, or the last job handed the run on): pause now, with no action
    // and no model call. A run waiting for a person pauses below, once the answer is in the memory.
    if (run.pauseRequested && run.status !== 'waiting_human') return pauseEarly(d, userId, run.id, memory, lease);

    // The policy snapshot, written once at the first advance (resolved apart from the run's own state).
    const snapshot = await policySnapshot(d, db, run, memory);
    // The tier the run is on: the start tier, moved up on a stall and back down after progress (#405). Kept in the memory, so it survives chunks, jobs and handoffs.
    const startTier = snapshot.spec.models.startTier;
    let tier: Tier = memory.tier ?? startTier;
    memory.tier = tier;
    tr.setTier(tier);
    tr.setPolicy(snapshot.ref);
    const stall = (memory.stall = readStallState(memory.stall));
    if (run.currentTier !== tier) await db.run.updateMany({ where: { id: run.id }, data: { currentTier: tier } });
    // A tier with no usable model fails the run now, before a browser is allocated (#403).
    const tierError = d.modelTiers ? tierProblem(snapshot, tier) : null;
    if (tierError) {
      await finishRun(d, userId, run.id, run.sessionId, session, 'failed', { error: tierError });
      return 'failed';
    }
    // A model without image input starts the run without screenshots, instead of finding out from a refused call.
    if (!memory.visionOff && tierHasVision(snapshot, tier) === false) {
      memory.visionOff = true;
      memory.visionOffByTier = true;
      memory.log.push('(Screenshots are off: the model of this tier does not accept images. Use observe_elements and read_text.)');
    }

    // Resume after a handoff: fold the person's answer into the memory.
    if (run.status === 'waiting_human') {
      // A task run waiting for its parameter values (#552) waits on a form, with no browser yet: nothing to do until it is answered.
      if (!run.handoffId && (await db.question.count({ where: { runId: run.id, input: 'form', status: 'pending' } })) > 0) return 'waiting_human';
      // A question that needs no browser (E39.7) is asked with no handoff: its answer is read back from the broker.
      const free = !run.handoffId ? await db.question.findFirst({ where: { runId: run.id, blocking: true, handoffId: null, input: { notIn: ['form', 'memory', 'save_login'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, input: true, kind: true, prompt: true, action: true, response: true } }) : null;
      if (!run.handoffId && !free) {
        await d.tasks.transition(userId, run.id, 'failed', { error: 'Waiting for a person without a handoff', stopReason: 'error' });
        return 'failed';
      }
      if (free?.status === 'pending') return 'waiting_human';
      const h = free ? handoffOfQuestion(free) : await session.getHandoff(run.handoffId!);
      if (h.status === 'pending') return 'waiting_human';
      if (!free) await d.questions?.reconcileHandoff(h);
      // The answer as the broker recorded it (labels of choices), else as the fabric reports it.
      const q = await db.question.findFirst({ where: free ? { id: free.id } : { handoffId: h.id }, select: { id: true, response: true, options: true, constraints: true, input: true, rememberLabel: true, prompt: true, gate: true, action: true } });
      const resp = (q?.response as unknown as QuestionResponse | null) ?? null;
      const outcome = resp?.outcome ?? handoffOutcome(h);
      tr.answered({ kind: h.kind, input: (q?.input as string | undefined) ?? h.input, channel: resp?.channel ?? h.response?.channel ?? null, outcome: outcome ?? h.status, waitedMs: run.waitingSince ? d.clock() - run.waitingSince.getTime() : null });
      if (h.status === 'completed' && outcome === 'completed') {
        const line = answerLine({
          input: (q?.input as QuestionInputType | undefined) ?? h.input,
          kind: h.kind,
          value: resp?.value ?? h.response?.value,
          values: resp?.values ?? h.response?.values,
          options: (q?.options as unknown as QuestionOption[] | null) ?? null,
          unit: (q?.constraints as unknown as QuestionConstraints | null)?.unit ?? null,
          rememberLabel: q?.rememberLabel ?? h.remember?.label ?? null,
          remember: resp?.remember ?? h.response?.remember,
        });
        // The owner picked one of several saved logins for this address (E37.3): only that reference may be used.
        const picked = q?.input === 'choice' ? (resp?.value ?? h.response?.value) : undefined;
        const asked = memory.savedLogins?.lookup;
        if (asked?.ambiguous && picked && asked.logins.some((l) => l.exact && l.ref === picked)) {
          asked.chosen = picked;
          memory.log.push(`The owner chose the saved login ${picked}: sign in with sign_in_with_saved_login(ref "${picked}").`);
        }
        // The owner answered the card about a saved detail this site may not have (E37.6).
        const askedDetail = memory.savedIdentity?.asked;
        if (askedDetail && q?.input === 'choice') {
          const choice = resp?.value ?? h.response?.value;
          memory.savedIdentity!.asked = null;
          if (choice === 'allow_site') {
            // The lookup is older than the owner's change: the next fill asks the provider, which decides.
            const k = askedKey(askedDetail.itemId, askedDetail.key, askedDetail.origin);
            memory.savedIdentity!.tryAnyway = [...new Set([...(memory.savedIdentity!.tryAnyway ?? []), k])];
            memory.log.push(`The owner says they allowed this site for ${askedDetail.label}. Call fill_from_identity for it again (call saved_identity first if you need the references).`);
          } else if (choice === 'type_now') {
            memory.savedIdentity!.typeNow = { label: askedDetail.label, origin: askedDetail.origin, selector: askedDetail.selector };
          }
        }
        // A sensitive task parameter's value (#552) is kept for its own parameter; any other secret is the next one to type.
        if (h.input === 'secret' && memory.askingParam) memory.paramSecrets = { ...(memory.paramSecrets ?? {}), [memory.askingParam]: h.id };
        else if (h.input === 'secret' || h.input === 'credentials') memory.secretHandoffId = h.id;
        const approved = h.kind === 'confirmation' && (h.input !== 'confirm' || (resp?.value ?? h.response?.value) === 'approve');
        // A call through a connection the owner was asked to approve (E39.7): the approval lets exactly that call through once.
        const connectionLine = q?.action ? foldConnectionAnswer(memory, q, approved) : null;
        // The owner answered the card question (E37.7): an approval lets exactly this card, shop and amount through, once.
        const askedCard = memory.savedCards?.asking ?? null;
        const cardAnswered = Boolean(askedCard && q?.input === 'confirm' && h.kind === 'confirmation');
        if (cardAnswered && askedCard) {
          memory.savedCards!.asking = null;
          if (approved) {
            memory.savedCards!.approval = approvalFromAsk(askedCard);
            memory.savedCards!.fields = {};
            d.tasks.metrics.cardUse('approved');
            memory.log.push(`The owner allowed paying ${askedCard.amount} ${askedCard.currency} at ${askedCard.site}. Call pay_with_saved_card again for the same card.`);
          } else {
            d.tasks.metrics.cardUse('declined');
            memory.log.push('The owner declined the payment. Do not pay, do not try another card or amount: finish and say that the payment was not made.');
          }
        }
        // The approval covers the target the gate stopped (#550), never any later risky click; without a gate, the next one.
        const gate = (q?.gate as unknown as QuestionGate | null) ?? null;
        // A confirmation the model asked on its own names no target: it lets nothing through the gate.
        if (approved && gate) {
          memory.confirmedTarget = { category: gate.category as GateTarget['category'], label: gate.label, host: gate.host };
          // The owner decided again about a step that may have happened (E38.3): it is no longer unknown.
          clearUnknown(memory, memory.confirmedTarget);
        }
        // The step the person allowed (#540): the next successful action is recorded as carried out.
        // The card question's approval is recorded when the card is typed (`confirmedAction`), not on the next action.
        if (approved && !cardAnswered && !connectionLine) memory.pendingConfirmation = { prompt: q?.prompt ?? memory.askedPrompt ?? '', tries: 0 };
        memory.log.push(connectionLine ?? line);
      } else if (memory.askingParam) {
        // A sensitive task parameter was not provided (#552): the run cannot do its job.
        memory.askingParam = null;
        await finishRun(d, userId, run.id, run.sessionId, session, 'cancelled', { error: 'The values were not provided.', stopReason: 'cancelled' });
        return 'cancelled';
      } else {
        memory.log.push((q?.action ? foldConnectionAnswer(memory, q, false) : null) ?? `The person did not help (handoff ${h.status}${outcome === 'cancelled' ? ', declined' : ''}). Do not retry the same request; finish if you cannot continue.`);
      }
      memory.askingParam = null;
      // The answer is a step of the trace (#541): what the owner said, masked; never a secret or a withheld value. Not an action.
      await recordAnswer(d, run.id, q?.id ?? null, {
        kind: h.kind,
        input: (q?.input as string | undefined) ?? h.input,
        completed: h.status === 'completed' && outcome === 'completed',
        outcome,
        value: resp?.value ?? h.response?.value ?? null,
        values: resp?.values ?? h.response?.values ?? null,
        options: (q?.options as unknown as QuestionOption[] | null) ?? null,
        withheld: resp?.valueWithheld ?? h.response?.value_withheld ?? null,
      });
      // A person helped (or did not): every stall counter starts over (#405).
      resetStall(stall);
      memory.stallsHere = 0;
      memory.progressStreak = 0;
      // The owner pressed Pause while the run waited (E38.2): the answer is in the memory, and nothing has been done with it. The run pauses
      // here, before the agent acts on it; Resume continues from this memory.
      if (run.pauseRequested) {
        return pauseEarly(d, userId, run.id, memory, lease, { handoffId: null });
      }
      current = await d.tasks.transition(userId, run.id, 'running', { handoffId: null, transcript: memory as never, activity: runActivity('starting') as never });
    } else if (run.status === 'running') {
      // A continuation of this run in a new job (the last one neared its runtime limit): no status change, so its active time stays continuous.
      d.log.log(`run ${run.id}: continuing in a new job`);
    } else {
      // Resumed after a pause (E38.2): the page may have changed while the run was frozen. The model is told how long, looks at the page
      // again before it acts, and the browser session is checked (a session that ended while paused is replaced below).
      const pausedMs = run.pausedAt ? Math.max(0, d.clock() - run.pausedAt.getTime()) : null;
      if (pausedMs !== null) {
        memory.log.push(`The owner paused the run and resumed it after ${pausedFor(pausedMs)}. Look at the page again before acting.`);
        memory.look = 'page';
      }
      try {
        current = await d.tasks.transition(userId, run.id, 'running', { activity: runActivity('starting') as never, ...(pausedMs !== null ? { transcript: memory as never } : {}) });
        if (pausedMs === null) await d.notifier?.started?.(userId, run);
      } catch (e) {
        // Another job started the run between this read and this write (E38.3): carry on as its continuation.
        if (!(e instanceof ConflictException)) throw e;
        current = await db.run.findFirstOrThrow({ where: { id: run.id } });
      }
    }

    // Saved logins (E37.3): on only when the task or chat opted in, the app (if an AI app started the run) allows it, both
    // switches are on and a provider is connected. Anything else: the tools are not offered and the run asks as before.
    const appAtStart = readAppLimits(run.appLimits);
    const optedIn = (run.task ? run.task.useSavedLogins : (run.conversation?.useSavedLogins ?? false)) && (appAtStart ? appAtStart.allowSavedLogins : true);
    let savedLoginsOn = false;
    if (optedIn && d.secrets) {
      const prepared = await d.secrets.prepare(userId);
      savedLoginsOn = prepared === 'registered';
      if (!savedLoginsOn && !memory.savedLogins?.stopped && (memory.chunks ?? 0) === 0) memory.log.push(`(Saved logins are not available for this run (${prepared.replace(/_/g, ' ')}): sign in by asking the owner.)`);
    }

    // Saved identity details (E37.6): a sub-switch of saved logins. On only when the task or chat opted in, the app (if an AI
    // app started the run) allows it, saved logins are on and the connected provider holds identity details.
    const identityOptedIn = (run.task ? run.task.useSavedIdentity : (run.conversation?.useSavedIdentity ?? false)) && (appAtStart ? appAtStart.allowSavedIdentity : true);
    let savedIdentityOn = false;
    if (savedLoginsOn && identityOptedIn && d.secrets) {
      savedIdentityOn = await d.secrets.identitySupported(userId);
      if (!savedIdentityOn && (memory.chunks ?? 0) === 0) memory.log.push('(Saved identity details are not available for this run: ask the owner for the details a form needs.)');
    }

    // Saved cards (E37.7): a sub-switch of saved logins like identity. On only when the task or chat opted in, the app (if an AI app
    // started the run) allows it (`allowSavedCards`, default off), saved logins are on and the provider's grant holds the card scopes.
    const cardsOptedIn = (run.task ? run.task.useSavedCards : (run.conversation?.useSavedCards ?? false)) && (appAtStart ? appAtStart.allowSavedCards : true);
    let savedCardsOn = false;
    if (savedLoginsOn && cardsOptedIn && d.secrets) {
      savedCardsOn = await d.secrets.cardsSupported(userId);
      if (!savedCardsOn && (memory.chunks ?? 0) === 0) memory.log.push('(Saved cards are not available for this run: the owner pays or enters a card themselves, so ask them.)');
    }

    // Offering to save a sign-in the owner types by hand (E37.4b): on only with saved logins on and a Vault that can save one (the
    // write scope, contract 1.3). The `credentials` cards then ask the fabric to keep the typed password, and `propose_saving_login` exists.
    const saveLoginOn = savedLoginsOn && d.secrets ? await d.secrets.saveLoginSupported(userId) : false;

    let sessionId = run.sessionId;
    // A paused run keeps its browser (E38.2). The fabric has no idle limit for sessions, but a session can still be gone (the host restarted,
    // the session was ended): the run carries on in a new one on the same profile, and says so in its log.
    if (sessionId && run.pausedAt && !(await session.isAlive(sessionId))) {
      memory.log.push('The browser session was restarted while paused. The browser is on the start page of the same profile: open the page again.');
      d.log.warn(`run ${run.id}: the browser session ended while the run was paused: opening a new one`);
      sessionId = null;
      await db.run.updateMany({ where: { id: run.id }, data: { sessionId: null } });
    }
    // A run with connections opens its browser when the first browser tool is called (E39.7): a job that needs only mail, a calendar or
    // documents never allocates a node. A run with none is a browser job and opens it now, as before. `never` opens none.
    const connections = readSnapshotConnections(snapshot);
    const needsBrowser = readNeedsBrowser(run.task?.needsBrowser);
    const lazy = needsBrowser === 'never' || (needsBrowser === 'auto' && connections.length > 0);
    if (!sessionId && !lazy) {
      const opened = await openFabricSession(d, session, run, { ...(savedLoginsOn ? { ownerId: userId } : {}), resumed: Boolean(run.pausedAt) || (memory.chunks ?? 0) > 0 });
      if (opened.kind === 'fail') {
        await finishRun(d, userId, run.id, null, session, 'failed', { error: opened.error, stopReason: 'error' });
        return 'failed';
      }
      if (opened.note) memory.log.push(opened.note);
      sessionId = opened.sessionId;
      await db.run.updateMany({ where: { id: run.id }, data: { sessionId } });
    }
  return { run, db, userId, orgId, lease, tr, stop, session, sessionId: sessionId ?? '', memory, snapshot, tier, stall, active: current, jobStartedAt, connections: { list: connections, needsBrowser, lazyBrowser: lazy }, flags: { savedLogins: savedLoginsOn, savedIdentity: savedIdentityOn, savedCards: savedCardsOn, saveLogin: saveLoginOn } };
}
