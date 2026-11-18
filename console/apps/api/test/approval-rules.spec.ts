// Saved approvals (#554): nothing but the owner's tick creates a rule. This
// enumerates every REST operation the API serves (packages/sdk/openapi.json,
// which sdk.db.spec.ts proves equal to the served document), every MCP tool and
// every CLI source file, and fails if any of them creates or widens a rule. The
// one creator is `ApprovalRulesService.createFromAnswer`, called by the question
// answer handler (#555).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CAPABILITIES } from '@app/shared';

import { APPROVALS_PERMISSIONS } from '../src/approvals/approvals.permissions';
import { patchApprovalRuleSchema } from '../src/approvals/approval-rules.schemas';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';

const ROOT = resolve(__dirname, '../../..');
const doc = JSON.parse(readFileSync(join(ROOT, 'packages/sdk/openapi.json'), 'utf8')) as { paths: Record<string, Record<string, { operationId?: string; summary?: string; description?: string }>> };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('nothing creates a saved approval but the owner answering a request', () => {
  it('the approval routes are exactly list, get, narrow, delete and pause', () => {
    const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
        .map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(ops.filter((o) => /approval/i.test(o)).sort()).toEqual([
      'DELETE /api/approval-rules/{id}',
      'GET /api/approval-rules',
      'GET /api/approval-rules/{id}',
      'PATCH /api/approval-rules/{id}',
      'PUT /api/approval-rules/paused',
    ]);
  });

  it('no REST operation anywhere creates one', () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!['post', 'put'].includes(method)) continue;
        const text = `${path} ${op.operationId ?? ''} ${op.summary ?? ''}`;
        if (method === 'put' && path === '/api/approval-rules/paused') continue;
        expect({ op: `${method.toUpperCase()} ${path}`, creates: /approval[-_ ]?rule|saved approval/i.test(text) }).toEqual({ op: `${method.toUpperCase()} ${path}`, creates: false });
      }
    }
  });

  it('the patch body cannot set what a rule matches on', () => {
    for (const field of ['host', 'kind', 'category', 'matchKey', 'summary', 'userId', 'useCount']) {
      expect(patchApprovalRuleSchema.safeParse({ [field]: 'x', enabled: false }).success).toBe(false);
    }
  });

  it('no MCP tool reads, creates or changes one', () => {
    for (const t of MCP_TOOLS) {
      expect({ tool: t.name, approvals: /approval[-_ ]?rule|saved approval/i.test(`${t.name} ${t.title} ${t.description}`) }).toEqual({ tool: t.name, approvals: false });
    }
    const caps = CAPABILITIES.filter((c) => c.id.startsWith('approvals.'));
    expect(caps.map((c) => c.id).sort()).toEqual(['approvals.list', 'approvals.manage']);
    for (const c of caps) expect(c.mcp).toHaveProperty('none');
  });

  it('no CLI command calls the approval routes', () => {
    const hits = files(join(ROOT, 'apps/cli/src')).filter((f) => /approval-rules/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the write permission is not granted to a viewer', () => {
    expect(APPROVALS_PERMISSIONS.APPROVALS_WRITE.defaultGrants).toEqual(['contributor', 'org_admin']);
    expect(APPROVALS_PERMISSIONS.APPROVALS_READ.defaultGrants).toContain('viewer');
  });
});
