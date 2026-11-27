// "Copy report" of the diagnostics panel (E50.14, #984): plain text an owner can paste into a support request. It holds the target
// kind, the provider, the time, each stage's status and code, and the console version. Never a label the owner typed, an account
// address or the host of the owner's own server, unless they tick "include the server's address". There is no secret in a report.
import { version as CONSOLE_VERSION } from '../../package.json';
import { providerOf, type DiagnosticReport, type DiagnosticTarget } from './api';
import { isHostKey } from './words';

export { CONSOLE_VERSION };

export function reportText(r: DiagnosticReport, target: DiagnosticTarget, opts: { includeHost?: boolean; version?: string } = {}): string {
  const lines = [
    'Hexactra diagnostic report',
    `Target: ${r.target.kind}`,
    `Provider: ${providerOf(target)}`,
    `Time: ${r.finishedAt}`,
    `Overall: ${r.overall}`,
    `Console version: ${opts.version ?? CONSOLE_VERSION}`,
  ];
  if (opts.includeHost && 'host' in target && target.host) lines.push(`Server address: ${target.host}`);
  lines.push('Stages:');
  for (const s of r.stages) {
    const hosts = opts.includeHost ? Object.entries(s.data ?? {}).filter(([k]) => isHostKey(k)).map(([k, v]) => `${k}=${v}`) : [];
    lines.push(`- ${s.id}: ${s.status}${s.code ? ` ${s.code}` : ''}${s.ms !== null ? ` (${s.ms} ms)` : ''}${hosts.length ? ` [${hosts.join(', ')}]` : ''}`);
  }
  return lines.join('\n');
}

/** Whether the target has an address the owner may choose to include (an MCP server's, a provider app's redirect host). */
export function hasHost(target: DiagnosticTarget, r: DiagnosticReport | null): boolean {
  return Boolean(('host' in target && target.host) || r?.stages.some((s) => Object.keys(s.data ?? {}).some(isHostKey)));
}
