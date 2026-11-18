/** Chat (#482). The exact strings the controller enforces and the web declares. */
export const CHAT_PERMISSIONS = {
  CHAT_READ: { id: 'chat:read', description: 'See own chats and their messages', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  CHAT_WRITE: { id: 'chat:write', description: 'Start chats, send messages, rename, archive and delete own chats', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
