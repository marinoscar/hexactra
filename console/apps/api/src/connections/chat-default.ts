// The accounts a NEW chat starts with (#680). The owner decides, once, in their own setting `connections.newChats`: `read_write` (the default),
// `read` or `off`. A chat created without saying which accounts (the web app's "new chat", `POST /api/chats` with no `connections`) takes the
// owner's Google and Microsoft accounts that are active, each at that access. A chat created WITH a list (even an empty one) gets exactly that.
//
// What this never does: it never lists an MCP server (a third party's tools are not granted by default), a paused or disconnected account, or
// another user's; it never changes a chat that exists; a task is unchanged (off until its owner lists the account); and a failed read of the
// setting is `off`, never "on". Writes still ask: a send or a change asks the owner the first time, whatever the access (approvals).
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

/** The selections a new chat of this owner starts with. Empty for `off`, for no account, and when anything cannot be read. */
export async function defaultChatSelections(prisma: Pick<PrismaService, 'userSettings' | 'connection'>, userId: string): Promise<ConnectionSelection[]> {
  const mode = await ownerNewChatAccounts(prisma, userId);
  if (mode === 'off') return [];
  try {
    const rows = await prisma.connection.findMany({
      where: { userId, status: 'active', provider: { in: ['google', 'microsoft'] } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_CONNECTIONS_PER_USER,
    });
    return rows.map((r) => ({ connectionId: r.id, access: mode }));
  } catch {
    return [];
  }
}
