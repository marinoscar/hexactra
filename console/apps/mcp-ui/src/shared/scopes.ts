// The scopes a connection holds, as a tool result names them
// (`granted_scopes`, #467). A widget shows an action only when the scope it
// needs is held; the server checks every call regardless.

export type Scope = 'runs:read' | 'runs:write' | 'tasks:write' | 'inbox:read' | 'inbox:write' | string;

/** The scopes of a structured result, or `null` when it names none (an older server: show every action and let the server decide). */
export function scopesOf(s: Record<string, unknown> | undefined): string[] | null {
  const v = s?.granted_scopes;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}

/** Whether `scope` is held (`null`: unknown, so assumed held). */
export function holds(scopes: readonly string[] | null, scope: Scope): boolean {
  return scopes === null || scopes.includes(scope);
}
