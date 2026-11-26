// How a NEW chat starts (#680, #969). The owner decides, once, in their own setting `connections.newChats`: `read_write` (the default): the chat
// uses every active connection the owner has (Google, Microsoft, MCP), at what they switched on for each (`connectionsMode: all`); `read`: the
// owner's active Google and Microsoft accounts, read only (`listed`); `off`: none (`listed`, empty). A chat created WITH a list or a mode gets that.
//
// What this never does: it never lists a paused or disconnected account or another user's; it never changes a chat that exists; and a failed
// read of the setting is `off`, never "on". Writes still ask: a send or a change asks the owner the first time, whatever the access (approvals).
import type { PrismaService } from '../prisma/prisma.service';
import type { ConnectionSelection } from './agent-connections';
import { MAX_CONNECTIONS_PER_USER } from './connections.constants';
import { newChatAccountsOf, type NewChatAccounts } from './connections.settings';

/** The owner's setting for new chats; `off` when it cannot be read. */
export async function ownerNewChatAccounts(prisma: Pick<PrismaService, 'userSettings'>, userId: string): Promise<NewChatAccounts> {
  try {
    const row = await prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return newChatAccountsOf(row?.value);
  } catch {
    return 'off';
  }
}

/** How a new chat of this owner starts: everything (`all`), or a list (empty for `off`, for no account, and when anything cannot be read). */
export async function defaultChatConnections(prisma: Pick<PrismaService, 'userSettings' | 'connection'>, userId: string): Promise<{ mode: 'all' | 'listed'; selections: ConnectionSelection[] }> {
  const mode = await ownerNewChatAccounts(prisma, userId);
  if (mode === 'read_write') return { mode: 'all', selections: [] };
  return { mode: 'listed', selections: await readOnlyAccounts(prisma, userId, mode) };
}

async function readOnlyAccounts(prisma: Pick<PrismaService, 'connection'>, userId: string, mode: 'read' | 'off'): Promise<ConnectionSelection[]> {
  if (mode === 'off') return [];
  try {
    const rows = await prisma.connection.findMany({
      where: { userId, status: 'active', provider: { in: ['google', 'microsoft'] } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_CONNECTIONS_PER_USER,
    });
    return rows.map((r) => ({ connectionId: r.id, access: 'read' as const }));
  } catch {
    return [];
  }
}
