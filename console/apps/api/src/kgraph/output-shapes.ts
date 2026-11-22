// The shapes of a version's verified outputs (E46.11): statistics only (an order of magnitude, a year, a character class, a length band),
// never a value, and none for a sensitive output. Kept as kg_nodes rows of type `OutputShape`, keyed `<versionId>:<outputKey>`.
import type { Prisma } from '@prisma/client';
import { learnShape, type DeclaredOutput, type OutputShape } from '@marinoscar/hexactra-kgraph';

import type { PrismaService } from '../prisma/prisma.service';
import { readOutputs } from '../tasks/task-outputs.schemas';

export function declaredOutputs(outputsSpec: unknown): DeclaredOutput[] {
  return readOutputs(outputsSpec).map((o) => {
    const x = o as { key?: string; label: string; type?: string; required?: boolean; options?: string[]; sensitive?: boolean };
    return { key: x.key ?? x.label, type: (x.type ?? 'text') as DeclaredOutput['type'], required: x.required !== false, ...(x.options ? { options: x.options } : {}), sensitive: x.sensitive === true };
  });
}

export async function readShapes(prisma: PrismaService, userId: string, versionId: string): Promise<Record<string, OutputShape>> {
  const rows = await prisma.forUser({ userId }).kgNode.findMany({ where: { userId, type: 'OutputShape', key: { startsWith: `${versionId}:` } } });
  return Object.fromEntries(rows.map((r) => [r.key.slice(versionId.length + 1), r.props as unknown as OutputShape]));
}

export async function learnShapes(prisma: PrismaService, userId: string, versionId: string, declared: readonly DeclaredOutput[], outputs: Record<string, unknown>): Promise<void> {
  const shapes = await readShapes(prisma, userId, versionId);
  for (const o of declared) {
    const next = learnShape(o, shapes[o.key], outputs[o.key]);
    if (!next) continue;
    const key = `${versionId}:${o.key}`.slice(0, 500);
    await prisma.forUser({ userId }).kgNode.upsert({ where: { userId_type_key: { userId, type: 'OutputShape', key } }, create: { id: `kgs-${versionId}-${o.key}`.slice(0, 200), userId, type: 'OutputShape', key, label: o.key.slice(0, 200), props: next as unknown as Prisma.InputJsonValue }, update: { props: next as unknown as Prisma.InputJsonValue } });
  }
}
