// One rule decides which connections a run and a chat get (E50.17, #987): `runConnections`, from the owner's own switches. The deprecated
// per-task and per-chat lists (`task_connections`, `conversation_connections`) are never READ in `src/`: the only code that still touches
// them deletes old rows (the Disconnect clean-up in `connections/agent-connections.ts`). A read that comes back fails here, with the file
// named. The rule is a function over (file, source) pairs, so this spec also proves that it FIRES.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '../../src');
const posix = (p: string) => p.split(sep).join('/');
/** Any use of the two delegates other than deleting rows. */
const READ = /\.(taskConnection|conversationConnection)\s*\.\s*(?!deleteMany\b)[A-Za-z]+\s*\(/g;
/** Raw SQL on the two tables. */
const RAW = /\b(task_connections|conversation_connections)\b/;
const CLEANUP_HOME = 'connections/agent-connections.ts';

/** Every violation in one file (`rel` is its path under src/, forward slashes). */
export function violations(rel: string, source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(READ)) out.push(`${rel}: ${m[0]} reads a deprecated connection list; availability is decided by runConnections (E50.17)`);
  if (RAW.test(source.replace(/^\s*(\/\/|\*).*$/gm, ''))) out.push(`${rel}: raw SQL on a deprecated connection list`);
  if (/\.(taskConnection|conversationConnection)\s*\.\s*deleteMany\s*\(/.test(source) && rel !== CLEANUP_HOME) out.push(`${rel}: only ${CLEANUP_HOME} clears the deprecated lists`);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('no code path reads a task or chat connection list (E50.17)', () => {
  it('holds in every file of src/', () => {
    const found = walk(SRC).flatMap((p) => violations(posix(relative(SRC, p)), readFileSync(p, 'utf8')));
    expect(found).toEqual([]);
  });

  it('fails when a read of either list comes back', () => {
    expect(violations('runner/host/connections/run-connections.ts', 'await d.prisma.taskConnection.findMany({ where: { taskId } });')).toHaveLength(1);
    expect(violations('chat/chat.service.ts', 'await this.prisma.conversationConnection.findFirst({ where: {} });')).toHaveLength(1);
    expect(violations('tasks/x.ts', 'await tx.taskConnection.count();')).toHaveLength(1);
    expect(violations('tasks/x.ts', 'await prisma.$queryRaw`SELECT * FROM task_connections`;')).toHaveLength(1);
    expect(violations('tasks/x.ts', 'await prisma.taskConnection.deleteMany({});')).toHaveLength(1);
    expect(violations(CLEANUP_HOME, 'await prisma.taskConnection.deleteMany({ where: { connectionId } });')).toEqual([]);
  });
});
