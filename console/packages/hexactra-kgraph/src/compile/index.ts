// The compiler's inputs (E46.5): the neutral trace of a run. The compiler itself arrives in E46.7.
export { bindArguments, bindValue, flattenArgs, hostAndPath, resultShapeOf, shapeOf, type BindContext, type EarlierResult, type PostState, type TraceBinding, type TraceEvent, type TraceParameter } from './trace';
export { cleanTrace, compileTrace, elementId, findLoop, type LoopBlock, notCompilableReason, OBSERVE_TOOLS, pathPattern, registrableDomain, shapeKeys, type CompileInput, type CompileResult } from './compile';
export { mergeBranches } from './branch';
