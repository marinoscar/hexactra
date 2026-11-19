// QuestionPort over the fabric's handoffs and the question broker: a question is a handoff in the browser host, mirrored into the inbox.
import { withAppOrigin } from '../../connected-apps/app-origin';
import { questionSpecSchema, type QuestionSpec as BrokerSpec } from '../../questions/questions.contract';
import type { FabricSession } from '../fabric-session';
import type { QuestionPort, QuestionSpec } from '../harness';
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

/** Whether answering the question needs the run's browser: a secret typed into a page, a sign-in, a takeover, a CAPTCHA or a passkey. */
function needsBrowser(spec: BrokerSpec): boolean {
  return spec.input === 'secret' || spec.input === 'credentials' || spec.input === 'takeover' || spec.kind === 'captcha' || spec.kind === 'passkey' || spec.kind === 'login';
}

export function questionPort(c: QuestionContext): QuestionPort {
  return {
    parse(raw) {
      const parsed = questionSpecSchema.safeParse(raw);
      if (parsed.success) return { ok: true, spec: parsed.data as unknown as QuestionSpec };
      return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'question'}: ${i.message}`).join('; ') };
    },
    prepare: (spec) => withAppOrigin(spec as unknown as BrokerSpec, c.run) as unknown as QuestionSpec,
    async open(asked) {
      const spec = asked as unknown as BrokerSpec;
      // A question that needs no browser is asked in the owner's inbox with no handoff (E39.7): a call through a connection they are asked to
      // approve, or any question of a run that has no browser yet. The run waits on it, and its answer resumes the run through its own id.
      if (!needsBrowser(spec) && (spec.action || !c.sessionId())) {
        if (!c.d.questions) throw new Error('questions are not available here');
        const q = await c.d.questions.create({ id: c.userId }, spec.action ? { ...spec, timeoutMs: QUESTION_TIMEOUT.maxMs } : spec, { askedBy: `run:${c.runId}`, runId: c.runId });
        return { handoffId: null, expiresAt: new Date(q.expiresAt), questionId: q.id };
      }
      if (!c.sessionId() && c.ensureSession) await c.ensureSession();
      const created = await c.session.openHandoff(c.sessionId(), {
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
