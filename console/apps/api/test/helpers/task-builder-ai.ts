// A scripted model for the task builder's tests (E42.3, E42.5): per `runTools` call it makes the scripted tool
// calls (a tool that is not offered answers "no such tool: <name>"), says a sentence, or fails. `respond` (the
// draft's goal writer) answers `draftAnswer`.
import type { AiService } from '@marinoscar/platform-api/ai';

export type BuilderCall = [name: string, args: Record<string, unknown>];
export type BuilderRound = BuilderCall[] | { say: string } | { fail: Error };
export interface BuilderToolRequest {
  instructions: string;
  input: string;
  tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[];
  onStep?: (s: unknown) => void;
}

export function scriptedBuilderAi(rounds: BuilderRound[], draftAnswer = '') {
  const outputs: string[] = [];
  const requests: BuilderToolRequest[] = [];
  const features: unknown[] = [];
  const runTools = jest.fn(async (req: BuilderToolRequest) => {
    requests.push(req);
    const round = rounds.shift() ?? [];
    if ('fail' in round) throw round.fail;
    if ('say' in round) return { final: { outputText: round.say }, steps: [], stopReason: 'done' };
    let step = 0;
    for (const [name, args] of round) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (!t) {
        outputs.push(`no such tool: ${name}`);
        continue;
      }
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      try {
        req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
      } catch {
        break;
      }
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  const respond = jest.fn(async () => ({ outputText: draftAnswer }));
  const ai = { forUser: (_u: string, opts: unknown) => (features.push(opts), { runTools, respond }) } as unknown as AiService;
  return { ai, outputs, requests, features };
}
