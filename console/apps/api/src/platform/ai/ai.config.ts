// The AI slice, configured once: core, the five providers, the catalogue,
// policy, keys, runtime, the `/api/ai` and `/api/admin/ai` routes and usage.
// Keys, models and limits are runtime configuration (the `ai` settings
// namespace and the credential stores), never an environment variable. Prices
// are the `agentPricing` namespace, bound through the `AI_PRICING` port.
// A feature imports this `AiModule`, injects `AiService` and calls
// `AiService.forUser(userId, { orgId, feature })`; it never builds an SDK client.
import { AiModule as PlatformAiModule } from '@marinoscar/platform-api/ai';

import { AiHostModule } from './ai-host.module';
import { ConsoleAiPricing } from './console-ai-pricing';

export const AiModule = PlatformAiModule.forRoot({ imports: [AiHostModule], pricing: { useClass: ConsoleAiPricing } });
