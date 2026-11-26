// A banner per added tool (MCP server) whose tools are new or changed since the owner decided (E50.14, #984), linking to the review.
import { Alert, Button } from '@mui/material';

import type { Connection } from './api';

export function ToolsToReview({ servers, onReview }: { servers: readonly Connection[]; onReview: (c: Connection) => void }) {
  return (
    <>
      {servers
        .filter((c) => (c.mcp?.tools.needsReview ?? 0) > 0)
        .map((c) => {
          const n = c.mcp!.tools.needsReview;
          return (
            <Alert
              key={c.id}
              severity="warning"
              sx={{ mb: 2 }}
              data-testid="tools-to-review"
              action={
                <Button color="inherit" size="small" onClick={() => onReview(c)} sx={{ minHeight: 44 }} aria-label={`Review the tools of ${c.label}`}>
                  Review
                </Button>
              }
            >
              {c.label}: {n === 1 ? '1 tool is' : `${n} tools are`} new or changed. {n === 1 ? 'It stays' : 'They stay'} off until you choose.
            </Alert>
          );
        })}
    </>
  );
}
