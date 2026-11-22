// Host-neutral MCP tool descriptors and handlers over the ports (`@marinoscar/hexactra-kgraph/mcp`, E46.22): `procedures_list`,
// `procedure_get` and `procedure_run`. No MCP SDK is imported: a host maps a descriptor to its own server (docs/mcp.md).
export {
  PROCEDURE_TOOL_DESCRIPTORS,
  procedureGetDescriptor,
  procedureGetOutput,
  procedureParameterSchema,
  procedureRunDescriptor,
  procedureRunOutput,
  proceduresListDescriptor,
  proceduresListOutput,
  procedureStepSchema,
  procedureSummarySchema,
  type ProcedureSummary,
  type ProcedureToolDescriptor,
  type ProcedureToolEffect,
  type ProcedureToolName,
} from './descriptors';
export { procedureSummary, procedureToolHandlers, shownVersion, type ProcedureRunPort, type ProcedureToolHandlers, type ProcedureToolResult, type ProcedureToolsHost } from './handlers';
