// One search provider on the administrator's Web search card (E50.5; E50.14, #984): its place in the order (up and down buttons), its
// switch, its estimated cost per call (editable; an estimate, never a price), the deployment's key (write-only) and Test. Rendered from
// the API's list, so a new provider needs no web change.
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import { Button, FormControlLabel, IconButton, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import type { AdminSettings, ServiceCredential } from './api';
import { KeyField } from './KeyField';
import { estimate, keptWords } from './webSearchWords';

type Installed = AdminSettings['installed'][number];

export interface AdminProviderCardProps {
  provider: Installed;
  settings: AdminSettings;
  /** Its place among the providers in the order (0-based), or -1 when it is not in the order. */
  position: number;
  count: number;
  credential: ServiceCredential | undefined;
  canWrite: boolean;
  busy: string | null;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onMove: (delta: -1 | 1) => void;
  onTest: () => void;
  onSaveKey: (v: string) => Promise<boolean>;
  onRemoveKey: () => Promise<void>;
}

const costText = (v: string): number | null | 'bad' => (v.trim() === '' ? null : /^\d+(\.\d+)?$/.test(v.trim()) && Number(v) <= 10 ? Number(v) : 'bad');

export function AdminProviderCard({ provider: p, settings: s, position, count, credential, canWrite, busy, onSave, onMove, onTest, onSaveKey, onRemoveKey }: AdminProviderCardProps) {
  const ps = s.providers[p.id] ?? { enabled: true, costPerCallUsd: null, baseUrl: null };
  const [cost, setCost] = useState(ps.costPerCallUsd === null ? '' : String(ps.costPerCallUsd));
  useEffect(() => setCost(ps.costPerCallUsd === null ? '' : String(ps.costPerCallUsd)), [ps.costPerCallUsd]);
  const parsed = costText(cost);
  const on = ps.enabled && position >= 0;
  return (
    <Paper variant="outlined" component="section" aria-label={p.label} sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle1" component="h3" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            {position >= 0 ? `${position + 1}. ` : ''}
            {p.label}
          </Typography>
          {position >= 0 && canWrite && (
            <>
              <IconButton aria-label={`Move ${p.label} up`} disabled={position === 0 || busy !== null} onClick={() => onMove(-1)} sx={{ minWidth: 44, minHeight: 44 }}>
                <ArrowUpwardIcon />
              </IconButton>
              <IconButton aria-label={`Move ${p.label} down`} disabled={position === count - 1 || busy !== null} onClick={() => onMove(1)} sx={{ minWidth: 44, minHeight: 44 }}>
                <ArrowDownwardIcon />
              </IconButton>
            </>
          )}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          Calls {p.hosts.join(', ')}. Cost: {estimate(ps.costPerCallUsd ?? p.defaultEstimatedCostPerCallUsd)}
          {ps.costPerCallUsd !== null ? ', your figure' : ''}. Prices change: check the provider&apos;s own page.
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
          <FormControlLabel
            control={<Switch checked={on} disabled={!canWrite} onChange={(e) => void onSave({ providers: { [p.id]: { enabled: e.target.checked } }, order: e.target.checked ? [...new Set([...s.order, p.id])] : s.order })} />}
            label={`Use ${p.label}`}
            sx={{ minHeight: 44 }}
          />
          {canWrite && (
            <Button variant="outlined" size="small" startIcon={<FactCheckOutlinedIcon />} onClick={onTest} aria-label={`Test ${p.label}`} sx={{ minHeight: 44, alignSelf: { xs: 'flex-start', sm: 'auto' } }}>
              Test
            </Button>
          )}
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
          <TextField
            size="small"
            label="Estimated cost per search (USD)"
            value={cost}
            disabled={!canWrite}
            error={parsed === 'bad'}
            helperText={parsed === 'bad' ? 'A number from 0 to 10, such as 0.005' : `Empty: the built-in estimate (${p.defaultEstimatedCostPerCallUsd ?? 'none'})`}
            onChange={(e) => setCost(e.target.value)}
            slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          />
          {canWrite && (
            <Button variant="outlined" sx={{ minHeight: 40 }} disabled={parsed === 'bad' || busy !== null || parsed === ps.costPerCallUsd} onClick={() => void onSave({ providers: { [p.id]: { costPerCallUsd: parsed } } })}>
              Save estimate
            </Button>
          )}
        </Stack>
        {p.credential === 'api_key' && (
          <KeyField
            label={`The deployment's ${p.label} API key`}
            hasKey={credential?.tiers.system.set === true}
            setAt={credential?.tiers.system.setAt ?? null}
            kept={keptWords(credential?.binding)}
            busy={busy === `key:${p.id}`}
            disabled={!canWrite}
            onSave={onSaveKey}
            onRemove={onRemoveKey}
          />
        )}
      </Stack>
    </Paper>
  );
}
