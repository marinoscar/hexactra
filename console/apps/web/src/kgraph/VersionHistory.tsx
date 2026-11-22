import { Box, Button, Collapse, List, ListItem, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { getVersionDiff, listVersions, type KgDiff, type KgVersionItem } from './api';
import { HealthChip, StateChip, versionSource } from './labels';
import { ErrorBanner, ListSkeleton, formatDateTime } from '../ui';

/** One version's readable diff against the one before it, loaded when opened. */
function VersionDiff({ procedureId, version }: { procedureId: string; version: number }) {
  const { api } = usePlatformHost();
  const [diff, setDiff] = useState<KgDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getVersionDiff(api, procedureId, version).then(setDiff, (e: unknown) => setError(e instanceof Error && e.message ? e.message : 'Could not load the changes'));
  }, [api, procedureId, version]);
  if (error) return <ErrorBanner error={error} />;
  if (!diff) return <Typography variant="body2" color="text.secondary">Loading the changes…</Typography>;
  if (diff.from === null) return <Typography variant="body2" color="text.secondary">The first version: nothing to compare with.</Typography>;
  const changed = diff.changes.filter((c) => c.change !== 'unchanged');
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        Against version {diff.from}: {changed.length === 0 ? 'no step changed.' : `${changed.length} change${changed.length === 1 ? '' : 's'}.`}
      </Typography>
      {changed.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }} aria-label={`Changes in version ${diff.to}`}>
          {changed.map((c, i) => (
            <li key={i}>
              <Typography variant="body2" component="span" sx={{ overflowWrap: 'anywhere' }}>
                {c.text}
              </Typography>
            </li>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * A procedure's versions, newest first (E46.20 "History"): state, source (learned, repaired, restored), date, health, and a readable
 * diff against the previous one. `onRestore` adds "Restore this version" to a retired or suspended one.
 */
export function VersionHistory({ procedureId, onRestore, refreshKey }: { procedureId: string; onRestore?: (v: KgVersionItem) => void; refreshKey?: number }) {
  const { api } = usePlatformHost();
  const [versions, setVersions] = useState<KgVersionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const load = useCallback(async () => {
    try {
      setVersions((await listVersions(api, procedureId)).versions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the versions');
      setVersions([]);
    }
  }, [api, procedureId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (versions === null) return <ListSkeleton />;
  return (
    <>
      <ErrorBanner error={error} />
      {versions.length === 0 && !error && <Typography color="text.secondary">No version yet.</Typography>}
      {versions.length > 0 && (
        <Paper variant="outlined">
          <List disablePadding aria-label="Versions">
            {versions.map((v) => (
              <ListItem key={v.id} divider sx={{ display: 'block' }} aria-label={`Version ${v.number}`}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <Typography component="span" sx={{ fontWeight: 500 }}>
                    Version {v.number}
                  </Typography>
                  <StateChip state={v.state} />
                  <HealthChip health={v.health} />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {versionSource(v, versions)} · {formatDateTime(v.createdAt)} · {v.steps} step{v.steps === 1 ? '' : 's'} · {v.counts.successes} succeeded, {v.counts.failures} failed, {v.counts.repairs} repaired
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
                  <Button size="small" sx={{ minHeight: 44 }} aria-expanded={open.has(v.id)} onClick={() => toggle(v.id)}>
                    {open.has(v.id) ? 'Hide the changes' : 'What changed'}
                  </Button>
                  {onRestore && (v.state === 'retired' || v.state === 'suspended') && (
                    <Button size="small" sx={{ minHeight: 44 }} onClick={() => onRestore(v)}>
                      Restore this version
                    </Button>
                  )}
                </Stack>
                <Collapse in={open.has(v.id)} unmountOnExit>
                  <Box sx={{ pt: 1 }}>
                    <VersionDiff procedureId={procedureId} version={v.number} />
                  </Box>
                </Collapse>
              </ListItem>
            ))}
          </List>
        </Paper>
      )}
    </>
  );
}
