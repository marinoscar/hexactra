// "Try a tool" (E50.12, #982): the owner calls ONE of their `read` tools from the tools screen, with arguments they typed, and reads the
// answer as plain text. It is a call the owner already allowed (they set the tool to `read`): it grants nothing, is not a run, and goes
// through the same checks a run's call does (`McpRunService.call`: the switch, the connection is theirs and active, the stored hash and
// mode, redaction of every credential out and back, the result's cleaning and cap). A `write` tool is refused: trying it would be a real
// change with no approval card. The audit names the connection and the tool, never an argument's value or the result; the result is
// content, so it is not kept in the diagnostics history or anywhere else.
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { registerErrorCode } from '@marinoscar/platform-api/core';

import { PrismaService } from '../../prisma/prisma.service';
import { notFound } from '../connections.errors';
import { CONNECTION_AUDIT, ConnectionEvents } from '../connections.events';
import { McpConnector, disabledError } from './mcp-connector.service';
import { McpRunService } from './mcp-run.service';
import { checkArguments } from './mcp-validate';

/** The most characters of a tried tool's answer the screen shows. */
export const TRY_MAX_CHARS = 4_000;
/** At most this many tries a minute for one connection. */
export const TRY_RATE_LIMIT = 6;

registerErrorCode({ code: 'TRY_READ_ONLY', status: 409, description: 'Only a tool you set to `read` can be tried: trying a `write` tool would change something with no approval card.' });
registerErrorCode({ code: 'TRY_TOOL_OFF', status: 409, description: 'The tool is off (or waits for your review): switch it to `read` first.' });
registerErrorCode({ code: 'TRY_INVALID_ARGUMENTS', status: 422, description: "The arguments do not satisfy the tool's own schema. `details.issues` names the first problems (paths and rules, never values). Nothing was sent." });
registerErrorCode({ code: 'TRY_RATE_LIMITED', status: 429, description: `At most ${TRY_RATE_LIMIT} tries a minute for one connection. \`details.retryAfterS\` says how long to wait.` });

const tryError = (code: string, message: string, status: HttpStatus, details?: Record<string, unknown>) => new HttpException({ code, message, ...(details ? { details } : {}) }, status);
export const tryRateLimited = (retryAfterS: number) => tryError('TRY_RATE_LIMITED', `At most ${TRY_RATE_LIMIT} tries a minute for one connection. Wait ${retryAfterS} seconds.`, HttpStatus.TOO_MANY_REQUESTS, { retryAfterS });

export interface TryResult {
  /** The server answered and did not report an error. */
  ok: boolean;
  /** Null when ok. `TOOL_ERROR` (the server reported one), `REFUSED` (nothing was sent), or the failure's kind in upper case (`TIMEOUT`, `UNAVAILABLE`, ...). */
  code: string | null;
  ms: number;
  /** What a run's model would read, cleaned, redacted and capped at {@link TRY_MAX_CHARS}: shown as plain text. */
  text: string;
  truncated: boolean;
}

// Control characters other than a tab and a line break go: the screen shows plain text.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

@Injectable()
export class McpTryService {
  clock: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: McpConnector,
    private readonly run: McpRunService,
    private readonly events: ConnectionEvents,
  ) {}

  async try(userId: string, connectionId: string, toolId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<TryResult> {
    const row = await this.connector.mine(userId, connectionId);
    if (!row) throw notFound();
    const tool = await this.prisma.connectionMcpTool.findFirst({ where: { id: toolId, connectionId } });
    if (!tool) throw notFound();
    if (!(await this.connector.enabled())) throw disabledError();
    if (tool.mode === 'write') throw tryError('TRY_READ_ONLY', 'Only a tool set to Read can be tried here: a Write tool would change something.', HttpStatus.CONFLICT);
    // Changed since the owner decided (a refresh normally switches it off): the version they allowed is not the one that would be called.
    if (tool.mode !== 'read' || tool.review !== null || (tool.approvedHash !== null && tool.approvedHash !== tool.hash)) throw tryError('TRY_TOOL_OFF', 'This tool is off. Set it to Read to try it.', HttpStatus.CONFLICT);
    const check = checkArguments(tool.hash, tool.inputSchema as Record<string, unknown>, args);
    if (!check.ok) throw tryError('TRY_INVALID_ARGUMENTS', "The arguments do not fit the tool's parameters. Nothing was sent.", HttpStatus.UNPROCESSABLE_ENTITY, { issues: check.issues });

    const started = this.clock();
    const out = await this.run.call(userId, connectionId, tool.name, args, { expect: { hash: tool.hash, mode: 'read' }, maxChars: TRY_MAX_CHARS, ...(signal ? { signal } : {}) });
    const ms = Math.max(0, this.clock() - started);
    const result: TryResult =
      out.kind === 'ok'
        ? { ok: !out.isError, code: out.isError ? 'TOOL_ERROR' : null, ms, text: out.text.replace(CONTROL, '').slice(0, TRY_MAX_CHARS), truncated: out.truncated }
        : { ok: false, code: out.kind === 'refused' ? 'REFUSED' : out.code.toUpperCase().replace(/[^A-Z_]/g, '_').slice(0, 40), ms, text: out.text.replace(CONTROL, '').slice(0, TRY_MAX_CHARS), truncated: false };
    await this.events.audit(userId, CONNECTION_AUDIT.mcpToolTried, connectionId, { provider: 'mcp', tool: tool.name, toolId: tool.id, ok: result.ok, code: result.code, ms });
    return result;
  }
}
