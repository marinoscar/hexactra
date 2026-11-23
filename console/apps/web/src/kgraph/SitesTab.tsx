// The Sites tab of the Knowledge Graph page (E46.33, #855): the owner's sites with their fact counts, and one site's facts grouped by kind,
// each with where it came from and when a run last used it. The owner adds (active at once), edits, archives, restores and deletes facts;
// a proposal is answered in Reviews, never here. Every string is rendered as text; a refusal names the rule, never the text.
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import { Box, Button, Chip, Link, Paper, Stack, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { createSiteFact, deleteSiteFact, listKgSites, listSiteFacts, SITE_FACT_KINDS, updateSiteFact, type KgSiteFact, type KgSiteFactKind, type KgSiteSummary } from './api';
import { AutoApprovedChip, FactFields, FactStatusChip, factKindLabel, factRefusal, factSourceLabel, type FactRefusal } from './siteFacts';
import { EmptyState, ErrorBanner, ListSkeleton, RelativeTime, ResponsiveList, toast, useApiAction, useConfirm, type Column } from '../ui';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const countsText = (s: KgSiteSummary) => [`${s.active} active`, s.proposed ? `${s.proposed} waiting for review` : null, s.archived ? `${s.archived} archived` : null].filter(Boolean).join(' · ');

/** Add a fact: the owner's own words, active at once. The site is fixed when the tab is on one site. */
function AddFactForm({ site, onAdded, onCancel }: { site: string | null; onAdded: (f: KgSiteFact) => void; onCancel: () => void }) {
  const { api } = usePlatformHost();
  const [siteText, setSiteText] = useState(site ?? '');
  const [kind, setKind] = useState<KgSiteFactKind>('navigation');
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<FactRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = (site ?? siteText).trim().toLowerCase();
  const save = async () => {
    setBusy(true);
    setRefusal(null);
    setError(null);
    try {
      const f = await createSiteFact(api, target, { kind, text: text.trim() });
      toast('Fact added: runs on this site read it from now on');
      onAdded(f);
    } catch (e) {
      const r = factRefusal(e);
      if (r) setRefusal(r);
      else setError(errText(e, 'Could not add the fact'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper variant="outlined" component="form" aria-label="Add a fact" sx={{ p: 2, mb: 2, minWidth: 0 }} onSubmit={(e) => (e.preventDefault(), void save())}>
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500, mb: 1 }}>
        {site ? `Add a fact about ${site}` : 'Add a fact about a site'}
      </Typography>
      <Stack spacing={1.5}>
        {!site && (
          <TextField
            id="kg-add-site"
            size="small"
            label="Site"
            placeholder="example.com"
            value={siteText}
            disabled={busy}
            onChange={(e) => setSiteText(e.target.value)}
            error={refusal?.field === 'site'}
            helperText={refusal?.field === 'site' ? refusal.message : 'The site’s domain, such as example.com'}
            sx={{ maxWidth: { sm: 360 } }}
          />
        )}
        <FactFields idPrefix="kg-add" kind={kind} text={text} onKind={setKind} onText={setText} error={refusal?.field === 'text' ? refusal.message : null} disabled={busy} />
        <ErrorBanner error={error} onClose={() => setError(null)} />
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button type="submit" variant="contained" sx={{ minHeight: 44 }} disabled={busy || !target || !text.trim()}>
            Add fact
          </Button>
          <Button sx={{ minHeight: 44 }} disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

/** One fact: its text, status, source and last use, and the owner's actions. */
function FactCard({ fact, canWrite, onChanged, onDeleted }: { fact: KgSiteFact; canWrite: boolean; onChanged: (f: KgSiteFact) => void; onDeleted: (id: string) => void }) {
  const { api } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction('Could not change the fact');
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<KgSiteFactKind>(fact.kind);
  const [text, setText] = useState(fact.text);
  const [refusal, setRefusal] = useState<string | null>(null);

  const saveEdit = async () => {
    setRefusal(null);
    action.clearError();
    try {
      const f = await updateSiteFact(api, fact.id, { kind, text: text.trim() });
      setEditing(false);
      toast('Fact saved');
      onChanged(f);
    } catch (e) {
      const r = factRefusal(e);
      if (r) setRefusal(r.message);
      else action.setError(errText(e, 'Could not save the fact'));
    }
  };
  const move = async (status: 'active' | 'archived') => {
    const f = await action.run(status, () => updateSiteFact(api, fact.id, { status }));
    if (!f) return;
    toast(status === 'archived' ? 'Fact archived: runs no longer read it' : 'Fact restored');
    onChanged(f);
  };
  const remove = async () => {
    const ok = await confirm({ title: 'Delete this fact?', body: 'It is removed for good. Runs on this site no longer read it.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    const done = await action.run('delete', async () => {
      await deleteSiteFact(api, fact.id);
      return true;
    });
    if (!done) return;
    toast('Fact deleted');
    onDeleted(fact.id);
  };

  return (
    <Paper variant="outlined" component="li" aria-label="Site fact" sx={{ p: 1.5, minWidth: 0, listStyle: 'none' }}>
      {editing ? (
        <Stack spacing={1.5}>
          <FactFields idPrefix={`kg-edit-${fact.id}`} kind={kind} text={text} onKind={setKind} onText={setText} error={refusal} disabled={action.busy !== null} autoFocus />
          <ErrorBanner error={action.error} onClose={action.clearError} />
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button variant="contained" sx={{ minHeight: 44 }} disabled={!text.trim()} onClick={() => void saveEdit()}>
              Save
            </Button>
            <Button
              sx={{ minHeight: 44 }}
              onClick={() => {
                setEditing(false);
                setKind(fact.kind);
                setText(fact.text);
                setRefusal(null);
              }}
            >
              Cancel
            </Button>
          </Stack>
        </Stack>
      ) : (
        <>
          <Typography variant="body1" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {fact.text}
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mt: 0.75 }}>
            <FactStatusChip status={fact.status} />
            {fact.status !== 'proposed' && <AutoApprovedChip approvedBy={fact.approvedBy} />}
            <Chip size="small" variant="outlined" label={factSourceLabel(fact.source)} />
            <Typography variant="caption" color="text.secondary">
              {fact.lastUsedAt ? <RelativeTime iso={fact.lastUsedAt} prefix="Last used " /> : 'Not used by a run yet'}
            </Typography>
            {fact.evidence.runId && (
              <Link component={RouterLink} to={`/runs/${encodeURIComponent(fact.evidence.runId)}`} variant="caption">
                The run it came from
              </Link>
            )}
          </Stack>
          <ErrorBanner error={action.error} onClose={action.clearError} />
          {canWrite && (
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
              {fact.status === 'active' && (
                <>
                  <Button size="small" sx={{ minHeight: 44 }} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                  <Button size="small" sx={{ minHeight: 44 }} disabled={action.busy !== null} onClick={() => void move('archived')}>
                    Archive
                  </Button>
                </>
              )}
              {fact.status === 'archived' && (
                <Button size="small" sx={{ minHeight: 44 }} disabled={action.busy !== null} onClick={() => void move('active')}>
                  Restore
                </Button>
              )}
              {fact.status === 'proposed' && (
                <Button size="small" component={RouterLink} to="/kgraph?tab=reviews" sx={{ minHeight: 44 }}>
                  Answer in Reviews
                </Button>
              )}
              <Button size="small" color="error" sx={{ minHeight: 44 }} disabled={action.busy !== null} onClick={() => void remove()}>
                Delete
              </Button>
            </Stack>
          )}
        </>
      )}
    </Paper>
  );
}

/** One site's facts, grouped by kind in a fixed order. */
function SiteFacts({ site, canWrite, adding, onAddDone, onCountsChanged }: { site: string; canWrite: boolean; adding: boolean; onAddDone: () => void; onCountsChanged: () => void }) {
  const { api } = usePlatformHost();
  const [facts, setFacts] = useState<KgSiteFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setFacts(await listSiteFacts(api, site));
      setError(null);
    } catch (e) {
      setFacts([]);
      setError(errText(e, 'Could not load the facts'));
    }
  }, [api, site]);
  useEffect(() => {
    setFacts(null);
    void load();
  }, [load]);
  const groups = useMemo(() => {
    const known = SITE_FACT_KINDS as readonly string[];
    const kinds = [...SITE_FACT_KINDS, ...new Set((facts ?? []).map((f) => f.kind).filter((k) => !known.includes(k)))];
    return kinds.map((k) => ({ kind: k, facts: (facts ?? []).filter((f) => f.kind === k) })).filter((g) => g.facts.length > 0);
  }, [facts]);
  const changed = (f: KgSiteFact) => {
    setFacts((fs) => (fs ?? []).map((x) => (x.id === f.id ? f : x)));
    onCountsChanged();
  };
  const deleted = (id: string) => {
    setFacts((fs) => (fs ?? []).filter((x) => x.id !== id));
    onCountsChanged();
  };
  return (
    <Box component="section" aria-label={`Facts about ${site}`}>
      {adding && (
        <AddFactForm
          site={site}
          onCancel={onAddDone}
          onAdded={(f) => {
            setFacts((fs) => [...(fs ?? []).filter((x) => x.id !== f.id), f]);
            onAddDone();
            onCountsChanged();
          }}
        />
      )}
      <ErrorBanner error={error} onRetry={() => void load()} />
      {facts === null && <ListSkeleton />}
      {facts?.length === 0 && !error && <EmptyState title="No facts about this site" body="Add one in your own words, or approve one a run proposed in Reviews." />}
      {groups.map((g) => (
        <Box key={g.kind} sx={{ mb: 2 }}>
          <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
            {factKindLabel(g.kind)}
          </Typography>
          <Stack component="ul" spacing={1} sx={{ m: 0, p: 0 }}>
            {g.facts.map((f) => (
              <FactCard key={f.id} fact={f} canWrite={canWrite} onChanged={changed} onDeleted={deleted} />
            ))}
          </Stack>
        </Box>
      ))}
    </Box>
  );
}

export interface SitesTabProps {
  /** The site the tab is on (`?site=`), or null for the list. */
  site: string | null;
  onSite: (site: string | null) => void;
}

/** The Sites tab. */
export function SitesTab({ site, onSite }: SitesTabProps) {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('kgraph:write');
  const [sites, setSites] = useState<KgSiteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try {
      setSites(await listKgSites(api));
      setError(null);
    } catch (e) {
      setSites([]);
      setError(errText(e, 'Could not load your sites'));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setAdding(false), [site]);

  const columns: Column<KgSiteSummary>[] = [
    { key: 'site', header: 'Site', grow: true, render: (s) => <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{s.site}</Typography> },
    { key: 'active', header: 'Active', align: 'right', width: 90, render: (s) => s.active },
    { key: 'proposed', header: 'Waiting for review', align: 'right', width: 160, render: (s) => s.proposed },
    { key: 'archived', header: 'Archived', align: 'right', width: 100, render: (s) => s.archived },
  ];

  return (
    <Box component="section" aria-label="Sites">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Short notes about a site that a later run reads as information, never as instructions or permission. A fact you write is used at once; one a run proposes waits in Reviews.
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
        {site && (
          <Button sx={{ minHeight: 44 }} onClick={() => onSite(null)}>
            All sites
          </Button>
        )}
        {site && (
          <Typography variant="h6" component="h2" sx={{ overflowWrap: 'anywhere', minWidth: 0, flex: '1 1 160px' }}>
            {site}
          </Typography>
        )}
        {canWrite && !adding && (
          <Button variant="contained" sx={{ minHeight: 44, ml: site ? 0 : 'auto' }} onClick={() => setAdding(true)}>
            Add a fact
          </Button>
        )}
      </Stack>
      <ErrorBanner error={error} onRetry={() => void load()} />
      {site ? (
        <SiteFacts site={site} canWrite={canWrite} adding={adding} onAddDone={() => setAdding(false)} onCountsChanged={() => void load()} />
      ) : (
        <>
          {adding && (
            <AddFactForm
              site={null}
              onCancel={() => setAdding(false)}
              onAdded={(f) => {
                setAdding(false);
                void load();
                onSite(f.site);
              }}
            />
          )}
          {sites === null && <ListSkeleton />}
          {sites?.length === 0 && !error && (
            <EmptyState Icon={PlaceOutlinedIcon} title="No site facts yet" body="Write what you know about a site (where the invoices are, how it signs in), or approve a fact a run proposed in Reviews." />
          )}
          {sites && sites.length > 0 && (
            <ResponsiveList
              aria-label="Sites with facts"
              items={sites}
              columns={columns}
              getKey={(s) => s.site}
              getLabel={(s) => s.site}
              onRowClick={(s) => onSite(s.site)}
              renderCard={(s) => (
                <Paper variant="outlined" component="article" aria-label={`Site ${s.site}`} onClick={() => onSite(s.site)} sx={{ p: 2, cursor: 'pointer', minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{s.site}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {countsText(s)}
                  </Typography>
                </Paper>
              )}
            />
          )}
        </>
      )}
    </Box>
  );
}
