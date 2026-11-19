// ModelPort over the platform's AI service: the harness's tools become the platform's tools, and a provider that cannot be reached becomes
// `ModelUnavailable` so the loop may fall back to the tier's other model.
import { AiError, defineTool, type AiService } from '@marinoscar/platform-api/ai';

import { ModelUnavailable, type ModelPort, type ModelRequest, type ModelResult } from '../harness';
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
    const tools = req.tools.map((t) => defineTool({ name: t.name, description: t.description, parameters: t.parameters, execute: (args: never) => t.execute(args) }));
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
          onStep: (step) => req.onStep(step as never),
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
