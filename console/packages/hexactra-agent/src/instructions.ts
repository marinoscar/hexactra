// The system instructions are composed from parts (E38.5; tool families E41.2): who the agent is, the families of tools it has and the rule
// for choosing between them, each offered family's own how-to, the toolset's general sections, then the usage notes of the tools offered.
// Everything here is deterministic: the same parts give the same bytes in every round, so the provider's prompt cache holds.
import { familiesBlock, ROUTING_RULE, type ToolFamily } from './tool-family';

export interface InstructionParts {
  /** Who the agent is: the first paragraph. */
  identity: string;
  /** The families offered this run, in rank order (`ToolRegistry.families`). None: no "Your tools" block and no routing rule. */
  families: readonly Pick<ToolFamily, 'title' | 'whenToUse' | 'sections'>[];
  /** The toolset's general sections (asking the person, values, the owner, when done), after the families' own. */
  sections: readonly string[];
  /** The usage notes of the tools offered, in registration order. */
  usageNotes?: readonly string[];
}

/**
 * The instructions, in this order: the identity; "Your tools" (one line per family) and the routing rule; each family's sections, in family
 * order; the general sections; "Tool notes".
 */
export function composeInstructions(parts: InstructionParts): string {
  const blocks = [
    parts.identity,
    ...(parts.families.length ? [familiesBlock(parts.families), ROUTING_RULE] : []),
    ...parts.families.flatMap((f) => f.sections ?? []),
    ...parts.sections,
  ];
  const body = blocks.join('\n\n');
  const notes = parts.usageNotes ?? [];
  if (notes.length === 0) return body;
  return `${body}\n\nTool notes:\n${notes.map((n) => `- ${n}`).join('\n')}`;
}
