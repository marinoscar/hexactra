// A site fact proposal in Reviews (E46.33, #855): its kind, site and text, the evidence (the run, and how many of its steps when derived),
// and Approve, Edit then approve, and Decline. The API answers only a signed-in browser session; the buttons need `kgraph:write`.
import { Box, Button, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { answerSiteFactReview, listSiteFactReviews, sitesTabPath, type KgSiteFact, type KgSiteFactKind } from './api';
import { FactFields, factKindLabel, factRefusal, factSourceLabel } from './siteFacts';
import { ErrorBanner, RelativeTime, toast } from '../ui';

/** "From 3 steps of a run", or "From a run", or nothing for a fact without a run. */
function evidenceText(f: KgSiteFact): string | null {
  if (!f.evidence.runId) return null;
  if (f.source === 'derived' && f.evidence.steps > 0) return `Learned from ${f.evidence.steps} step${f.evidence.steps === 1 ? '' : 's'} of a run`;
  return f.source === 'agent_proposed' ? 'Proposed by the agent during a run' : 'From a run';
}

export function SiteFactReviewCard({ fact, onAnswered }: { fact: KgSiteFact; onAnswered: (f: KgSiteFact) => void }) {
  const { api, viewer } = usePlatformHost();
  const canAnswer = viewer.hasPermission('kgraph:write');
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<KgSiteFactKind>(fact.kind);
  const [text, setText] = useState(fact.text);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const evidence = evidenceText(fact);

  const answer = async (approve: boolean, edit: boolean) => {
    setBusy(true);
    setRefusal(null);
    setError(null);
    try {
      const body: { approve: boolean; kind?: KgSiteFactKind; text?: string } = { approve };
      if (approve && edit) {
        if (kind !== fact.kind) body.kind = kind;
        if (text.trim() !== fact.text) body.text = text.trim();
      }
      const r = await answerSiteFactReview(api, fact.id, body);
      toast(approve ? 'Fact approved: runs on this site read it from now on' : 'Fact declined: it is not proposed again for 30 days');
      onAnswered(r);
    } catch (e) {
      const r = factRefusal(e);
      if (r && editing) setRefusal(r.message);
      else setError(r?.message ?? (e instanceof Error && e.message ? e.message : 'Could not answer the review'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper variant="outlined" component="article" aria-label="Site fact to review" sx={{ p: 2, mb: 1.5, minWidth: 0 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.5 }}>
        <Chip size="small" color="info" variant="outlined" label={factKindLabel(fact.kind)} />
        <Chip size="small" variant="outlined" label={factSourceLabel(fact.source)} />
      </Stack>
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
        A fact about {fact.site}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Runs on this site read it only once you approve it. It is information, never an instruction or a permission. <RelativeTime iso={fact.createdAt} prefix="Proposed " />
      </Typography>
      {editing ? (
        <Box sx={{ mb: 1.5 }}>
          <FactFields idPrefix={`kg-review-${fact.id}`} kind={kind} text={text} onKind={setKind} onText={setText} error={refusal} disabled={busy} autoFocus />
        </Box>
      ) : (
        <Typography variant="body1" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', mb: 1 }} data-testid="site-fact-text">
          {fact.text}
        </Typography>
      )}
      {evidence && fact.evidence.runId && (
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {evidence}:{' '}
          <Link component={RouterLink} to={`/runs/${encodeURIComponent(fact.evidence.runId)}`}>
            open the run
          </Link>
        </Typography>
      )}
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {canAnswer && !editing && (
          <>
            <Button variant="contained" sx={{ minHeight: 44 }} disabled={busy} onClick={() => void answer(true, false)}>
              Approve
            </Button>
            <Button variant="outlined" sx={{ minHeight: 44 }} disabled={busy} onClick={() => setEditing(true)}>
              Edit then approve
            </Button>
            <Button variant="outlined" color="error" sx={{ minHeight: 44 }} disabled={busy} onClick={() => void answer(false, false)}>
              Decline
            </Button>
          </>
        )}
        {canAnswer && editing && (
          <>
            <Button variant="contained" sx={{ minHeight: 44 }} disabled={busy || !text.trim()} onClick={() => void answer(true, true)}>
              Approve with my edit
            </Button>
            <Button
              sx={{ minHeight: 44 }}
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setKind(fact.kind);
                setText(fact.text);
                setRefusal(null);
              }}
            >
              Cancel
            </Button>
          </>
        )}
        <Button component={RouterLink} to={sitesTabPath(fact.site)} sx={{ minHeight: 44 }}>
          The site’s facts
        </Button>
      </Stack>
    </Paper>
  );
}

/** The site fact proposals, for a viewer who may read them (`kgraph:read`); empty otherwise, with no request. */
export function usePendingSiteFactReviews(): { facts: KgSiteFact[] | null; error: string | null; drop: (id: string) => void } {
  const { api, viewer } = usePlatformHost();
  const canRead = viewer.hasPermission('kgraph:read');
  const [facts, setFacts] = useState<KgSiteFact[] | null>(canRead ? null : []);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!canRead) return;
    let live = true;
    listSiteFactReviews(api).then(
      (fs) => {
        if (!live) return;
        setFacts(fs);
        setError(null);
      },
      (e: unknown) => {
        if (!live) return;
        setFacts([]);
        setError(e instanceof Error && e.message ? e.message : 'Could not load the site fact reviews');
      },
    );
    return () => {
      live = false;
    };
  }, [api, canRead]);
  const drop = useCallback((id: string) => setFacts((fs) => (fs ?? []).filter((f) => f.id !== id)), []);
  return { facts, error, drop };
}
