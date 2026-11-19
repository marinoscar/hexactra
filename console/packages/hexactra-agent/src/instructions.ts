// The system instructions are composed from sections, and tools may add a usage note each (E38.5). Everything here is deterministic: the
// same sections and notes give the same bytes in every round, so the provider's prompt cache holds.

/** Joins the toolset's sections, then the usage notes of the tools offered, in the order given. With no notes the result is the sections alone. */
export function composeInstructions(sections: readonly string[], usageNotes: readonly string[] = []): string {
  const body = sections.join('\n\n');
  if (usageNotes.length === 0) return body;
  return `${body}\n\nTool notes:\n${usageNotes.map((n) => `- ${n}`).join('\n')}`;
}
