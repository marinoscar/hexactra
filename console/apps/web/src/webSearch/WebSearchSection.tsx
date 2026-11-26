// The Web search block of the Connections and tools page (E50.14, #984; was `/settings/web-search`, E50.5): whether search works for
// you and with whose key, today's count, the switch, your own key (write-only), Test (the diagnostics panel) and "Try a search".
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import { Alert, Box, Button, Chip, FormControlLabel, Link, MenuItem, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel';
import type { DiagnosticTarget } from '../diagnostics/api';
import { ErrorBanner, ListSkeleton, useApiAction } from '../ui';
import { getStatus, listCredentials, listProviders, removeOwnKey, saveOwnKey, search, SERVICE, type SearchResult, type ServiceCredential, type WebSearchProvider, type WebSearchStatus } from './api';
import { KeyField } from './KeyField';
import { REASON_TEXT, SEARCH_TEST_NOTE, TIER_TEXT, estimate, keptWords, todayWords } from './webSearchWords';

/** A result's address as a link only when it is http(s): never `javascript:` or `data:` from a search result. */
export function webHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const box = { p: { xs: 2, sm: 3 } } as const;

export function WebSearchSection() {
  const { api, viewer } = usePlatformHost();
  const canSearch = viewer.hasPermission('web_search:write');
  const canKey = viewer.hasPermission('connections:write');
  const action = useApiAction('Could not change web search');
  const [status, setStatus] = useState<WebSearchStatus | null>(null);
  const [providers, setProviders] = useState<WebSearchProvider[]>([]);
  const [creds, setCreds] = useState<ServiceCredential[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [keyFor, setKeyFor] = useState<string>('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [testing, setTesting] = useState<DiagnosticTarget | null>(null);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const [s, p, settings, c] = await Promise.all([
        getStatus(api),
        listProviders(api),
        api.get<{ webSearch?: { enabled?: boolean } }>('/user-settings').catch(() => ({}) as { webSearch?: { enabled?: boolean } }),
        listCredentials(api).catch(() => [] as ServiceCredential[]),
      ]);
      setStatus(s);
      setProviders(p);
      setEnabled(settings.webSearch?.enabled ?? true);
      setCreds(c.filter((x) => x.service === SERVICE));
      setKeyFor((k) => k || p.find((x) => x.needsKey)?.id || '');
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load web search');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (on: boolean) => {
    setEnabled(on);
    await action.run('switch', () => api.patch('/user-settings', { webSearch: { enabled: on } }));
    await load();
  };

  if (!status) return action.error ? <ErrorBanner error={action.error} onRetry={() => void load()} /> : <ListSkeleton rows={1} />;
  const keyed = providers.filter((p) => p.needsKey);
  const chosen = keyed.find((p) => p.id === keyFor) ?? null;
  const cred = creds.find((c) => c.name === chosen?.id);
  const testId = status.provider?.id ?? providers.find((p) => p.enabled && p.listed)?.id ?? null;
  const testName = providers.find((p) => p.id === testId)?.label ?? status.provider?.label ?? 'web search';

  return (
    <Stack spacing={2}>
      <ErrorBanner error={action.error} onClose={action.clearError} />
      <Paper variant="outlined" sx={box}>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip size="small" variant="outlined" color={status.enabled ? 'success' : 'default'} label={status.enabled ? 'On' : 'Off'} />
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }} data-testid="web-search-status">
              {status.enabled && status.provider
                ? `${status.provider.label} answers, with ${status.provider.tier ? TIER_TEXT[status.provider.tier] : 'no key needed'}.`
                : status.provider
                  ? `${status.provider.label} would answer.`
                  : 'No provider answers yet.'}
            </Typography>
          </Stack>
          {status.reason && <Alert severity="info">{REASON_TEXT[status.reason]}</Alert>}
          <Typography variant="body2" color="text.secondary">
            {todayWords(status)}
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
            <FormControlLabel control={<Switch checked={enabled} disabled={action.busy === 'switch'} onChange={(e) => void toggle(e.target.checked)} />} label="Let the agent search the web" sx={{ minHeight: 44 }} />
            {canSearch && testId && (
              <Button variant="outlined" size="small" startIcon={<FactCheckOutlinedIcon />} onClick={() => setTesting({ kind: 'search_provider', id: testId, scope: 'user', name: testName })} sx={{ minHeight: 44, alignSelf: { xs: 'flex-start', sm: 'auto' } }}>
                Test
              </Button>
            )}
          </Stack>
        </Stack>
      </Paper>

      {keyed.length > 0 && (
        <Paper variant="outlined" sx={box}>
          <Stack spacing={1.5}>
            <Typography variant="subtitle1" component="h3">
              Your own key
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Optional. Searches use your own key first, while your administrator lets users add one. {chosen ? `Cost: ${estimate(chosen.estimatedCostPerCallUsd)}.` : ''}
            </Typography>
            {keyed.length > 1 && (
              <TextField select size="small" label="Provider" value={keyFor} onChange={(e) => setKeyFor(e.target.value)} sx={{ maxWidth: 320 }}>
                {keyed.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.label}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {chosen && (
              <KeyField
                key={chosen.id}
                label={`Your own ${chosen.label} API key`}
                hasKey={chosen.keys.user}
                setAt={cred?.tiers.user.setAt ?? null}
                kept={keptWords(cred?.binding)}
                busy={action.busy === `key:${chosen.id}`}
                disabled={!canKey}
                onSave={async (v) => {
                  const ok = await action.run(`key:${chosen.id}`, async () => {
                    await saveOwnKey(api, chosen.id, v);
                    return true;
                  });
                  await load();
                  return ok === true;
                }}
                onRemove={async () => {
                  await action.run(`key:${chosen.id}`, () => removeOwnKey(api, chosen.id));
                  await load();
                }}
              />
            )}
          </Stack>
        </Paper>
      )}

      {canSearch && (
        <Paper variant="outlined" sx={box}>
          <Stack spacing={1.5} component="form" onSubmit={(e) => e.preventDefault()}>
            <Typography variant="subtitle1" component="h3">
              Try a search
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField size="small" label="Search for" value={query} onChange={(e) => setQuery(e.target.value)} sx={{ flex: 1 }} />
              <Button
                type="submit"
                variant="outlined"
                sx={{ minHeight: 40 }}
                disabled={!status.enabled || query.trim().length === 0 || action.busy === 'search'}
                onClick={async () => {
                  setResult(null);
                  const r = await action.run('search', () => search(api, query.trim()));
                  if (r) setResult(r);
                  await load();
                }}
              >
                Search
              </Button>
            </Stack>
            {result && (
              <Box component="ol" sx={{ m: 0, pl: 3 }} aria-label="Results">
                {result.hits.length === 0 && <Typography variant="body2">No results.</Typography>}
                {result.hits.map((h, i) => (
                  <li key={`${i}-${h.url}`}>
                    {webHref(h.url) ? (
                      <Link href={webHref(h.url)!} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ wordBreak: 'break-word' }}>
                        {h.title || h.url}
                      </Link>
                    ) : (
                      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                        {h.title || h.url}
                      </Typography>
                    )}
                    <Typography variant="caption" component="p" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                      {h.url}
                    </Typography>
                  </li>
                ))}
              </Box>
            )}
          </Stack>
        </Paper>
      )}
      <DiagnosticsPanel target={testing} onClose={() => setTesting(null)} note={SEARCH_TEST_NOTE} />
    </Stack>
  );
}
