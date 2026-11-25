// The tools a run is offered, in the order the model has always been offered them (E41.1, #698). One function, called by the host
// (`build-context.ts`) and by the scenario kit (`test/replay/run-scenario.ts`), so what a scenario measures is what a run gets.
import { browserFamilies } from '@marinoscar/hexactra-browser-agent/families';
import { browserTools } from '@marinoscar/hexactra-browser-agent/tools';
import { ToolRegistry, type AnyContext, type RunnerTool, type ToolFamily } from '@marinoscar/hexactra-agent';
import { accountsFamily, connectionTools } from './tools/connections';

export interface RunToolsOptions<C extends AnyContext> {
  /** A task that never opens a browser (E39.7) is offered no browser tool: only the question tool, the connections and `finish`. */
  needsBrowser: 'auto' | 'always' | 'never';
  /** `propose_memory` (when the deployment has memory proposals). */
  proposeMemory?: RunnerTool<C> | null;
  /** `propose_saving_login` (when the run may offer to save a sign-in). */
  proposeSavingLogin?: RunnerTool<C> | null;
  savedLogins?: readonly RunnerTool<C>[] | null;
  savedIdentity?: readonly RunnerTool<C>[] | null;
  savedCards?: readonly RunnerTool<C>[] | null;
  /** Hexactra passkeys (E47.5): offered only when saved sign-ins are on and the owner's provider keeps passkeys. */
  passkeys?: readonly RunnerTool<C>[] | null;
  /** The run lists a connection and the deployment has the connections module (E39.7). */
  connections: boolean;
  /** The tools of the owner's MCP servers the run lists (E39.9), already built, and one family per server (E41.2). */
  mcp: readonly RunnerTool<C>[];
  mcpFamilies?: readonly ToolFamily<C>[];
  /**
   * The owner's learned procedures (E46.22): given ONLY when the run's Knowledge Graph mode is `reuse`, and registered after every other tool,
   * so a run with the feature off is offered exactly the tools, in the order, it was before.
   */
  procedures?: { tools: readonly RunnerTool<C>[]; family: ToolFamily<C> } | null;
  /**
   * The agent's site fact proposals (E46.31): given ONLY when the run's Knowledge Graph mode is `learn` or `reuse` (or `everyday`, #850),
   * and registered after every other tool, the procedures included, so a run with the feature off is offered exactly what it was before.
   */
  siteFacts?: { tools: readonly RunnerTool<C>[]; family: ToolFamily<C> } | null;
}

/**
 * Registers the run's tools on a new registry, in the fixed order (part of the stable prefix the provider caches), and the tool families that
 * describe them (E41.2): the owner's accounts, each MCP server, the browser and the desktop. Only a family with a tool offered is shown.
 */
export function registerRunTools<C extends AnyContext>(o: RunToolsOptions<C>): ToolRegistry<C> {
  const registry = new ToolRegistry<C>();
  const noBrowser = o.needsBrowser === 'never';
  const core = browserTools.core as unknown as RunnerTool<C>[];
  registry.registerAll(noBrowser ? core.filter((t) => t.name === 'request_human') : core);
  if (o.proposeMemory) registry.register(o.proposeMemory);
  if (o.proposeSavingLogin && !noBrowser) registry.register(o.proposeSavingLogin);
  if (!noBrowser) registry.register(browserTools.typeSecret as unknown as RunnerTool<C>);
  if (o.savedLogins && !noBrowser) registry.registerAll(o.savedLogins);
  if (o.savedIdentity && !noBrowser) registry.registerAll(o.savedIdentity);
  if (o.savedCards && !noBrowser) registry.registerAll(o.savedCards);
  if (o.passkeys && !noBrowser) registry.registerAll(o.passkeys);
  // The owner's connections (E39.7): offered only when the run has one with the capability switched on (`available`).
  if (o.connections) registry.registerAll(connectionTools as unknown as RunnerTool<C>[]);
  // The tools of the owner's MCP servers (E39.9): the ones the owner enabled on the connections the run lists, namespaced by the connection.
  registry.registerAll(o.mcp);
  registry.register(browserTools.finish as unknown as RunnerTool<C>);
  if (o.procedures) registry.registerAll(o.procedures.tools);
  const siteFacts = o.siteFacts && !noBrowser ? o.siteFacts : null;
  if (siteFacts) registry.registerAll(siteFacts.tools);
  registry.registerFamilies([accountsFamily as unknown as ToolFamily<C>, ...(o.mcpFamilies ?? []), ...(browserFamilies as unknown as ToolFamily<C>[]), ...(o.procedures ? [o.procedures.family] : []), ...(siteFacts ? [siteFacts.family] : [])]);
  return registry;
}
