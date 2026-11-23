// Repair and protection (`@marinoscar/hexactra-kgraph/repair`): the circuit breaker (E46.12); repair and promotion arrive with E46.17.
export { BREAKER, breaker, type BreakerVerdict, type RunVerdict } from './breaker';
export { diffVersions, type StepChange, type StepChangeKind } from './diff';
export { classifyRepair, RECIPIENT_ARG, type Classification, type SensitiveReason } from './classify';
