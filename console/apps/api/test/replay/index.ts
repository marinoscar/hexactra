// The replay suite's test kit (E38.6, #587): the scenario format, the fake site, the scripted model, the owner, the invariants and
// `runScenario`, exported for the specs and the scripts. It lives in test/, not src/: it is test tooling, and the agent packages'
// architecture rules keep loop code, gates and test kits out of the app's production code (test/architecture/no-agent-logic.spec.ts).
// It builds on the packages' public entry points only (`@marinoscar/hexactra-agent`, `/engine`, `/testing`, and the browser toolset's
// subpaths), so the harness can move or be published without it noticing.
export * from './connections';
export * from './expectations';
export * from './fake-fabric';
export * from './invariants';
export * from './live';
export * from './owner';
export * from './report';
export * from './run-scenario';
export * from './scenario.schema';
export * from './scripted-model';
export * from './site';
