// QuestionPort over the fabric's handoffs and the question broker: a question is a handoff in the browser host, mirrored into the inbox.
import { withAppOrigin } from '../../connected-apps/app-origin';
import { questionSpecSchema, type QuestionSpec as BrokerSpec } from '../../questions/questions.contract';
import type { FabricSession } from '../fabric-session';
import type { QuestionPort, QuestionSpec } from '@marinoscar/hexactra-agent';
import { QUESTION_TIMEOUT } from '../../questions/questions.contract';
import type { HostDeps } from './deps';
import { mirror } from './finish-run';
import type { RunMemory } from './run-memory';

export interface QuestionContext {
  d: HostDeps;
  userId: string;
  runId: string;
  /** The run row: an AI app that started it is named on a confirmation (#465). */
  run: { origin?: string | null; clientName?: string | null };
  session: FabricSession;
  sessionId: () => string;
  memory: RunMemory;
  /** Opens the run's browser when a question needs one and there is none yet (E39.7). */
  ensureSession?: () => Promise<void>;
  /** A Vault that can save a typed sign-in is connected (E37.4b): the browser host keeps the typed password for a few minutes. */
  saveLoginOn: boolean;
}

/** Whether answering the question needs the run's browser: a secret typed into a page, a sign-in, a takeover, a scan, a CAPTCHA or a passkey. */
function needsBrowser(spec: BrokerSpec): boolean {
  return spec.input === 'secret' || spec.input === 'credentials' || spec.input === 'takeover' || spec.input === 'scan' || spec.kind === 'captcha' || spec.kind === 'passkey' || spec.kind === 'login';
}

/** What the model reads instead of a desktop scan on a machine with no Bluetooth (#924): Chrome's "use a phone" code cannot reach the phone there. */
export const NO_BLUETOOTH_SCAN =
  'This computer has no Bluetooth, so a phone cannot answer Chrome\'s "use a phone or tablet" passkey code here. Do not ask for a scan of it: ask for a takeover (kind passkey) instead.';

export function questionPort(c: QuestionContext): QuestionPort {
  return {
    parse(raw) {
      const parsed = questionSpecSchema.safeParse(raw);
      if (parsed.success) return { ok: true, spec: parsed.data as unknown as QuestionSpec };
      return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'question'}: ${i.message}`).join('; ') };
    },
    prepare: (spec) => withAppOrigin(spec as unknown as BrokerSpec, c.run) as unknown as QuestionSpec,
    async scanCheck(source) {
      // Only Chrome's own passkey code needs the phone near the machine (#924); a code the page draws is scanned from anywhere.
      if (source !== 'desktop' || !c.sessionId()) return null;
      const s = await c.d.fabric.request<{ host_id?: string }>('GET', `/v1/sessions/${encodeURIComponent(c.sessionId())}`);
      if (!s.host_id) return null;
      const host = (await c.d.fabric.hosts()).find((h) => h.id === s.host_id);
      // Only a machine that said it has none: an older agent, or one that cannot tell, is asked as usual (the card warns).
      return host?.bluetooth === false ? NO_BLUETOOTH_SCAN : null;
    },
    async open(asked) {
      const spec = asked as unknown as BrokerSpec;
      // A question that needs no browser is asked in the owner's inbox with no handoff (E39.7): a call through a connection they are asked to
      // approve, or any question of a run that has no browser yet. The run waits on it, and its answer resumes the run through its own id.
      if (!needsBrowser(spec) && (spec.action || !c.sessionId())) {
        if (!c.d.questions) throw new Error('questions are not available here');
        const q = await c.d.questions.create({ id: c.userId }, spec.action ? { ...spec, timeoutMs: QUESTION_TIMEOUT.maxMs, timeoutDefaulted: false } : spec, { askedBy: `run:${c.runId}`, runId: c.runId });
        return { handoffId: null, expiresAt: new Date(q.expiresAt), questionId: q.id };
      }
      if (!c.sessionId() && c.ensureSession) await c.ensureSession();
      // The fabric's handoff lives as long as the question waits (E40.4): the agent's own time, or the administrator's default.
      const timeoutMs = c.d.questions ? await c.d.questions.resolveTimeoutMs(spec) : spec.timeoutMs;
      const created = await c.session.openHandoff(c.sessionId(), {
        timeoutMs,
        kind: spec.kind,
        prompt: spec.prompt,
        input: spec.input,
        choices: spec.options ?? [],
        constraints: spec.constraints,
        confirmLabel: spec.confirmLabel,
        denyLabel: spec.denyLabel,
        risk: spec.risk,
        rememberLabel: spec.rememberLabel,
        // The browser host keeps the typed password for ten minutes after the answer, so the owner can be offered to save it (E37.4b).
        ...(spec.input === 'credentials' && c.saveLoginOn ? { offerSave: true } : {}),
      });
      if (spec.input === 'credentials' && c.saveLoginOn) {
        const sv = (c.memory.saveLogin ??= {});
        sv.offerable = [...(sv.offerable ?? []), created.id].slice(-5);
      }
      const questionId = await mirror(c.d, c.userId, c.runId, c.sessionId(), created, spec);
      return { handoffId: created.id, expiresAt: created.expiresAt, questionId };
    },
  };
}
