// The family of a tool (E41.1, #698; `family` E41.2): the one place that maps a tool to the family the scenario kit, the trace and the metrics name. Tool
// families (E41.2) add `RunnerTool.family`; until a tool sets one, its `group` decides: the owner's accounts are `connection`, an MCP server
// is `connection:<id>`, everything else is its group.

/** The family of a tool, from its `family` when set, else its group: 'connection' -> 'accounts', 'connection:<id>' -> 'mcp:<id>', otherwise the group. */
export function toolFamilyOf(tool: { group: string; family?: string }): string {
  if (tool.family) return tool.family;
  if (tool.group === 'connection') return 'accounts';
  if (tool.group.startsWith('connection:')) return `mcp:${tool.group.slice('connection:'.length)}`;
  return tool.group;
}

/** A family for a label of bounded cardinality: every MCP server is the literal `mcp`, never its connection id. */
export function familyLabel(family: string): string {
  return family.startsWith('mcp:') ? 'mcp' : family;
}
