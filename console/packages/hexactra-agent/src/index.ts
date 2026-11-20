// The agent harness (E38.5): the part a tool, a gate or a toolset may import: types, the context, tool definitions, the registry, the gate
// interface, the ports and the pure helpers. The engine (the loop, the wrapper, the context factory) is `./engine`: only a host imports it.
// Nothing here imports NestJS, Prisma, the platform, the fabric or the console (`test/runner-layering.spec.ts`), so extracting the harness
// into a package (#614) is a move.
export * from './activity';
export * from './active-time';
export * from './budget';
export * from './budget-errors';
export * from './cost';
export * from './gate-pipeline';
export * from './input-builder';
export * from './instructions';
export * from './loop-profile';
export * from './moments';
export * from './outcome-text';
export type * from './ports';
export { ModelUnavailable } from './ports';
export * from './reconcile';
export * from './redact';
export * from './registry';
export * from './run-context';
export * from './stall';
export * from './stall-policy';
export * from './steps';
export * from './text';
export * from './tiers';
export * from './tool-def';
export * from './tool-family-of';
export * from './tool-family';
export * from './types';
export { inCommitTool, mutatingAction, describeIntent, runAsCommit } from './intent';
export * from './time';
export * from './noop-telemetry';
