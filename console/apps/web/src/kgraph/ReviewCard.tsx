import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { answerReview, listReviews, type KgReview } from './api';
import { ErrorBanner, RelativeTime, toast, useApiAction } from '../ui';

/** Why a change needs the owner, in words (the reasons of `@marinoscar/hexactra-kgraph`'s classifier). */
const REASON_LABEL: Record<string, string> = {
  commit_step: 'A send or payment',
  commit_args: 'What a send or payment uses',
  recipient: 'A recipient',
  new_site: 'A new site',
  account: 'An account',
  secret_ref: 'A saved login',
  judge_feeds_commit: 'An AI decision feeding a send or payment',
};

/**
 * One pending sensitive change of a procedure (E46.17): what changes in plain words (masked by the API) and Approve / Decline.
 * The API answers only a signed-in browser session; the buttons need `kgraph:write`.
 */
export function KgReviewCard({ review, onAnswered }: { review: KgReview; onAnswered: (r: KgReview) => void }) {
  const { api, viewer } = usePlatformHost();
  const canAnswer = viewer.hasPermission('kgraph:write');
  const action = useApiAction('Could not answer the review');
  const answer = async (approve: boolean) => {
    const r = await action.run(approve ? 'approve' : 'decline', () => answerReview(api, review.id, approve));
    if (!r) return;
    toast(approve ? 'Change approved: its next run checks it with you' : 'Change declined');
    onAnswered(r);
  };
  return (
    <Paper variant="outlined" component="article" aria-label="Knowledge Graph change to review" sx={{ p: 2, mb: 1.5, minWidth: 0 }}>
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500 }}>
        A learned procedure wants to change
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        A repair would change what it sends, pays, or where and as whom it acts. Runs go on with the agent until you answer. <RelativeTime iso={review.createdAt} prefix="Proposed " />
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5, mb: 1.5 }}>
        {review.changes.map((c, i) => (
          <li key={i}>
            <Typography variant="body2" component="span" sx={{ overflowWrap: 'anywhere' }}>
              <strong>{REASON_LABEL[c.reason] ?? c.reason}:</strong> {c.text}
            </Typography>
          </li>
        ))}
      </Box>
      <ErrorBanner error={action.error} onClose={action.clearError} />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {canAnswer && (
          <>
            <Button variant="contained" sx={{ minHeight: 44 }} disabled={action.busy !== null} onClick={() => void answer(true)}>
              Approve
            </Button>
            <Button variant="outlined" color="error" sx={{ minHeight: 44 }} disabled={action.busy !== null} onClick={() => void answer(false)}>
              Decline
            </Button>
          </>
        )}
        {review.procedureId && (
          <Button component={RouterLink} to={`/kgraph/procedures/${encodeURIComponent(review.procedureId)}`} sx={{ minHeight: 44 }}>
            See the procedure
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

/** The pending reviews, for a viewer who may read them (`kgraph:read`); empty otherwise, with no request. */
export function usePendingKgReviews(): { reviews: KgReview[] | null; error: string | null; reload: () => Promise<void>; drop: (id: string) => void } {
  const { api, viewer } = usePlatformHost();
  const canRead = viewer.hasPermission('kgraph:read');
  const [reviews, setReviews] = useState<KgReview[] | null>(canRead ? null : []);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!canRead) return;
    try {
      setReviews(await listReviews(api, 'pending'));
      setError(null);
    } catch (e) {
      setReviews([]);
      setError(e instanceof Error && e.message ? e.message : 'Could not load the reviews');
    }
  }, [api, canRead]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const drop = useCallback((id: string) => setReviews((rs) => (rs ?? []).filter((r) => r.id !== id)), []);
  return { reviews, error, reload, drop };
}
