/** Web search (E50.5, #975). The exact strings the controllers enforce and the clients declare. A user only ever sees and uses their own. */
export const WEB_SEARCH_PERMISSIONS = {
  WEB_SEARCH_READ: { id: 'web_search:read', description: 'See whether web search is on for you, which provider answers, from which key tier, and what remains of today\'s limit', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  WEB_SEARCH_WRITE: { id: 'web_search:write', description: 'Run a web search for yourself (the Test button, the CLI), counted and limited', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
