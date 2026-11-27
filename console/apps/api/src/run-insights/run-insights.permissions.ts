/**
 * Run insights (E53.2, #1070). The exact strings the controllers enforce. Statistics across every user are aggregates only, but they
 * still show how much each person uses the console: an organization administrator's alone by default.
 */
export const RUN_INSIGHTS_PERMISSIONS = {
  RUN_STATS_READ_ALL: { id: 'run_stats:read_all', description: "See run statistics across every user's runs (aggregates only: no goal, result or step)", scope: 'org', defaultGrants: ['org_admin'] },
} as const;
