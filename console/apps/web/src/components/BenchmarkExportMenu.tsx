// Export a benchmark report (E44.6, #744): the PDF report, the CSV of trials or the JSON report, downloaded with the session
// (`GET /benchmarks/{id}/export`) and handed to the browser under the server's name. Self-contained so the benchmark page (E44.5, #743)
// mounts it as `<BenchmarkExportButton benchmarkId={id} live={…} baselineId={…} />`. Every format is masked by the server; a benchmark
// still running exports as in progress.
import DataObjectIcon from '@mui/icons-material/DataObject';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import { Box, Button, CircularProgress, ListItemIcon, ListItemText, Menu, MenuItem, Typography, type ButtonProps } from '@mui/material';
import { useCallback, useId, useState, type ReactElement } from 'react';
import { useOptionalPlatformHost, type PlatformApiClient } from '@marinoscar/platform-web/core';

import { defaultPaper, filenameFromDisposition, saveDownload, type DownloadedFile } from '../api';
import { ErrorBanner } from '../ui';

export type BenchmarkExportFormat = 'pdf' | 'csv' | 'json';

export interface BenchmarkExportOptions {
  format: BenchmarkExportFormat;
  /** The PDF's paper; ignored otherwise. Default: from the browser's locale. */
  paper?: 'a4' | 'letter';
  /** An earlier benchmark on the same suite version: the report adds the comparison with it. */
  baseline?: string | null;
  /** The PDF leaderboard's weighting (#872); the server's default (accuracy first) when absent. Ignored otherwise. */
  preset?: string | null;
}

/** What the menu items say, in menu order. */
export const BENCHMARK_EXPORT_LABEL: Record<BenchmarkExportFormat, string> = { pdf: 'PDF report', csv: 'CSV of trials', json: 'JSON report' };

/** The note the menu carries. */
export const BENCHMARK_EXPORT_NOTE = 'Sensitive data is masked in every format. Tokens and cost are included per trial, per policy and for the whole benchmark.';

/** `GET /benchmarks/{id}/export`'s path and query. */
export function benchmarkExportPath(id: string, { format, paper, baseline, preset }: BenchmarkExportOptions): string {
  const q = new URLSearchParams({ format });
  if (format === 'pdf') q.set('paper', paper ?? defaultPaper());
  if (format === 'pdf' && preset) q.set('preset', preset);
  if (baseline) q.set('baseline', baseline);
  return `/benchmarks/${encodeURIComponent(id)}/export?${q.toString()}`;
}

/** Download a benchmark's report through the signed-in client, under the server's `Content-Disposition` name. */
export async function exportBenchmark(client: PlatformApiClient, id: string, options: BenchmarkExportOptions): Promise<DownloadedFile> {
  if (!client.getBlob) throw new Error('This client cannot download files');
  const res = await client.getBlob(benchmarkExportPath(id, options));
  return { blob: res.blob, filename: filenameFromDisposition(res.headers.get('content-disposition')) ?? `hexactra-benchmark-${id.slice(0, 8)}.${options.format}` };
}

export interface BenchmarkExportButtonProps {
  benchmarkId: string;
  /** The benchmark is still running: the files are marked in progress. */
  live?: boolean;
  /** Add the comparison with this baseline to the report. */
  baselineId?: string | null;
  /** The weighting the PDF's leaderboard leads with (#872): the one chosen on the page's leaderboard. */
  preset?: { id: string; label: string } | null;
  variant?: ButtonProps['variant'];
  sx?: ButtonProps['sx'];
}

/** "Export" with its menu (PDF, CSV, JSON); "Preparing…" and disabled while a file is made. Hidden without `benchmarks:read`. */
export function BenchmarkExportButton({ benchmarkId, live = false, baselineId = null, preset = null, variant = 'outlined', sx }: BenchmarkExportButtonProps) {
  const host = useOptionalPlatformHost();
  const client = host?.api ?? null;
  const canExport = Boolean(host?.viewer.hasPermission('benchmarks:read') && client?.getBlob);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState<BenchmarkExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuId = useId();
  const start = useCallback(
    async (format: BenchmarkExportFormat) => {
      if (!client || busy) return;
      setBusy(format);
      setError(null);
      try {
        saveDownload(await exportBenchmark(client, benchmarkId, { format, baseline: baselineId, preset: preset?.id ?? null }));
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : 'Could not export the benchmark');
      } finally {
        setBusy(null);
      }
    },
    [client, busy, benchmarkId, baselineId, preset],
  );
  if (!canExport) return null;
  const choose = (format: BenchmarkExportFormat) => {
    setAnchor(null);
    void start(format);
  };
  const icon: Record<BenchmarkExportFormat, ReactElement> = { pdf: <PictureAsPdfOutlinedIcon fontSize="small" />, csv: <TableChartOutlinedIcon fontSize="small" />, json: <DataObjectIcon fontSize="small" /> };
  return (
    <>
      <Button
        variant={variant}
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? 'true' : undefined}
        aria-busy={busy !== null || undefined}
        disabled={busy !== null}
        startIcon={busy ? <CircularProgress size={16} color="inherit" aria-hidden /> : <FileDownloadOutlinedIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={sx}
      >
        {busy ? 'Preparing…' : 'Export'}
      </Button>
      <Menu id={menuId} anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { maxWidth: 340 } } }}>
        {(Object.keys(BENCHMARK_EXPORT_LABEL) as BenchmarkExportFormat[]).map((format) => (
          <MenuItem key={format} onClick={() => choose(format)} sx={{ minHeight: 44 }}>
            <ListItemIcon>{icon[format]}</ListItemIcon>
            <ListItemText>{BENCHMARK_EXPORT_LABEL[format]}</ListItemText>
          </MenuItem>
        ))}
        <Box sx={{ px: 2, pt: 1, pb: 0.5 }}>
          <Typography variant="caption" component="p" color="text.secondary" sx={{ whiteSpace: 'normal' }}>
            {BENCHMARK_EXPORT_NOTE}
          </Typography>
          {preset && (
            <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'normal' }} data-testid="export-preset">
              The PDF opens with the leaderboard weighted “{preset.label}”.
            </Typography>
          )}
          {baselineId && (
            <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'normal' }}>
              The report includes the comparison with the baseline.
            </Typography>
          )}
          {live && (
            <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'normal' }}>
              The benchmark is still running: the files are marked in progress.
            </Typography>
          )}
        </Box>
      </Menu>
      {error && (
        <Box sx={{ flexBasis: '100%', mt: 1 }}>
          <ErrorBanner error={error} onClose={() => setError(null)} />
        </Box>
      )}
    </>
  );
}
