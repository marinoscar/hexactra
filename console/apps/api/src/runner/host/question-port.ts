// QuestionPort over the fabric's handoffs and the question broker: a question is a handoff in the browser host, mirrored into the inbox.
import { withAppOrigin } from '../../connected-apps/app-origin';
import { questionSpecSchema, type QuestionSpec as BrokerSpec } from '../../questions/questions.contract';
import type { FabricSession } from '../fabric-session';
import type { QuestionPort, QuestionSpec } from '../harness';
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
  /** A Vault that can save a typed sign-in is connected (E37.4b): the browser host keeps the typed password for a few minutes. */
  saveLoginOn: boolean;
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
