// The Map tab (E46.21, #795), loaded lazily by the Knowledge Graph page. Below 768 px it is a short note and a link to the Procedures
// list; from 768 px up it loads the canvas (React Flow and the layout), which is a chunk of its own.
import HubIcon from '@mui/icons-material/Hub';
import { Alert, Box } from '@mui/material';
import useMediaQuery from '@mui/material/useMediaQuery';
import { lazy, Suspense } from 'react';

import type { KgProcedureItem, KgReview } from '../api';
import { EmptyState, ListSkeleton } from '../../ui';

const KgraphMap = lazy(() => import('./KgraphMap'));

/** The Map's heading help: what it shows and what it does not. */
export const MAP_HELP =
  'The map shows what the agent has learned to do reliably, not everything it can do: with your full powers the agent can use any site and any connected account, learned or not.';

export interface MapTabProps {
  procedures: KgProcedureItem[] | null;
  reviews: KgReview[] | null;
}

export default function MapTab({ procedures, reviews }: MapTabProps) {
  // Where `matchMedia` is missing (a jsdom test that did not mock it) the window reads as wide enough.
  const narrow = useMediaQuery('(max-width:767.95px)');
  return (
    <Box component="section" aria-label="Map">
      <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
        {MAP_HELP}
      </Alert>
      {narrow ? (
        <EmptyState
          Icon={HubIcon}
          title="The map needs a wider screen"
          body="Open it on a tablet or a computer (768 px or wider). The Procedures list shows the same tasks and their steps as text at any width."
          action={{ key: 'procedures', label: 'Open the Procedures list', to: '/kgraph' }}
        />
      ) : (
        <Suspense fallback={<ListSkeleton />}>
          <KgraphMap procedures={procedures ?? []} reviews={reviews ?? []} />
        </Suspense>
      )}
    </Box>
  );
}
