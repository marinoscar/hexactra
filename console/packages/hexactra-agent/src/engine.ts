// The engine of the agent harness (E38.5): the chunk loop, the one wrapper around every tool call, the context factory and the ways a run
// ends or waits. A host builds a run with these; a tool or a gate never imports them (`test/runner-layering.spec.ts` enforces it).
export * from './create-context';
export * from './execute-tool';
export * from './model-call';
export * from './outcomes';
export * from './run-loop';
export * from './create-run-loop';
