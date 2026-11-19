// The agent harness (E38.5): a loop, a tool registry, one wrapper around every tool call, gates, checkpoints and crash recovery,
// budgets, stall detection and tiers, over ports. It imports nothing from the framework, the database, the fabric or the console
// (`runner/__tests__/layering.spec.ts` enforces it), so extracting it into a package (#614) is a move.
export * from './activity';
export * from './active-time';
export * from './budget';
export * from './budget-errors';
export * from './cost';
export * from './create-context';
export * from './execute-tool';
export * from './gate-pipeline';
export * from './input-builder';
export * from './instructions';
export * from './loop-profile';
export * from './model-call';
export * from './moments';
export * from './outcomes';
export * from './outcome-text';
export type * from './ports';
export { ModelUnavailable } from './ports';
export * from './reconcile';
export * from './redact';
export * from './registry';
export * from './run-context';
export * from './run-loop';
export * from './stall';
export * from './stall-policy';
export * from './steps';
export * from './text';
export * from './tiers';
export * from './tool-def';
export * from './types';
export { inCommitTool, mutatingAction, describeIntent, runAsCommit } from './intent';
