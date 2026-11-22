import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const taskKgraphSchema = z.object({
  taskId: z.string().uuid(),
  mode: z.enum(['off', 'learn', 'reuse']).describe('`off`: AI only, nothing captured. `learn`: the AI runs as before and a procedure is compiled, never executed. `reuse`: compiled steps run without the model; the AI repairs.'),
  available: z.boolean().describe('Both the deployment and your own switch are on. While false, the stored mode is kept and unused.'),
});
export const putTaskKgraphSchema = z.object({ mode: z.enum(['off', 'learn', 'reuse']) }).strict();
export const kgraphStatusSchema = z.object({
  deployment: z.boolean().describe('Your administrator allows the Knowledge Graph (system setting `kgraph.enabled`).'),
  user: z.boolean().describe('You turned it on (your setting `kgraph.enabled`).'),
  available: z.boolean().describe('Both are on.'),
});
export const kgraphPurgeSchema = z.object({
  deleted: z.object({ procedures: z.number(), versions: z.number(), nodes: z.number(), edges: z.number(), tasks: z.number(), runs: z.number(), reviews: z.number(), evidence: z.number() }),
});

export class TaskKgraphResponseDto extends createZodDto(taskKgraphSchema) {}
export class PutTaskKgraphDto extends createZodDto(putTaskKgraphSchema) {}
export class KgraphStatusResponseDto extends createZodDto(kgraphStatusSchema) {}
export class KgraphPurgeResponseDto extends createZodDto(kgraphPurgeSchema) {}
