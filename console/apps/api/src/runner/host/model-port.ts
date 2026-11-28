// ModelPort over the platform's AI service: the harness's tools become the platform's tools, and a provider that cannot be reached becomes
// `ModelUnavailable` so the loop may fall back to the tier's other model.
import { AiError, defineTool, type AiService } from '@marinoscar/platform-api/ai';

import { ModelUnavailable, type ModelPort, type ModelRequest, type ModelResult } from '@marinoscar/hexactra-agent';
import { BROWSER_AGENT_FEATURE_ID } from '../browser-agent.feature';

/** AI error codes that send a chunk to the tier's fallback model (#405). */
const FALLBACK_CODES: ReadonlySet<string> = new Set(['AI_PROVIDER_UNAVAILABLE', 'AI_RATE_LIMITED', 'AI_MODEL_NOT_REACHABLE']);

export class AiModelPort implements ModelPort {
  constructor(
    private readonly ai: AiService,
    private readonly userId: string,
    private readonly orgId: string | null,
  ) {}

  async runTools(req: ModelRequest): Promise<ModelResult> {
    const provider = this.ai.forUser(this.userId, { feature: BROWSER_AGENT_FEATURE_ID, ...(this.orgId ? { orgId: this.orgId } : {}) });
    const tools = req.tools.map((t) => defineTool({ name: t.name, description: t.description, parameters: t.parameters, ...(t.strict === false ? { strict: false } : {}), execute: (args: never) => t.execute(args) }));
    // How long the model took for each round trip (E54.0): the platform's tool loop calls `onStep` after it ran that step's tools, and asks the
    // model again at once, so a step's model time is the time since the previous step (or the start) less the tools it ran.
    let mark = Date.now();
    try {
      const result = await provider.runTools(
        {
          // The model, effort and output cap of the tier (#403), then what this call adds.
          ...req.route.params,
          instructions: req.instructions,
          input: req.input as never,
          tools,
          maxSteps: req.maxSteps,
          ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
          onStep: (step) => {
            const now = Date.now();
            const toolsMs = (step.calls ?? []).reduce((sum, c) => sum + (Number.isFinite(c.durationMs) ? c.durationMs : 0), 0);
            const latencyMs = Math.max(0, now - mark - toolsMs);
            mark = now;
            req.onStep({ ...(step as never as object), latencyMs } as never);
          },
        },
        { signal: req.signal },
      );
      return { stopReason: result.stopReason, outputText: result.final.outputText };
    } catch (e) {
      if (e instanceof AiError && FALLBACK_CODES.has(e.code)) throw new ModelUnavailable(e.code, e);
      throw e;
    }
  }
}
