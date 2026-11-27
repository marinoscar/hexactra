// The diagnostics panel (E50.14, #984): one component for a connection, a provider app and a search provider. A side drawer on wide
// screens and a full-screen sheet under 768 px; a labelled dialog that traps focus and gives it back. While the one request runs, the
// expected stages appear in order with a spinner on the current one; the report then fills them in, the first failing stage open and
// scrolled into view, with one sentence at the top. Run again, History (the last five) and Copy report. Everything is plain text.
import CloseIcon from '@mui/icons-material/Close';
import { Alert, Box, Button, Checkbox, Dialog, DialogContent, DialogTitle, FormControlLabel, IconButton, List, ListItemButton, ListItemText, Stack, Typography } from '@mui/material';
import useMediaQuery from '@mui/material/useMediaQuery';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { RelativeTime, toast } from '../ui';
import { diagnose, historyOf, type DiagnosticReport, type DiagnosticTarget } from './api';
import { hasHost, reportText } from './report';
import { PendingStageItem, StageItem, type StageActions } from './StageItem';
import { OVERALL_WORDS, expectedStages, firstProblem, summarySentence } from './words';

export interface DiagnosticsPanelProps {
  /** What to check; null closes the panel. */
  target: DiagnosticTarget | null;
  onClose: () => void;
  /** Run a report when the panel opens (Test). Off: show the last report, with Run again. */
  runOnOpen?: boolean;
  /** A sentence under the title (a search test makes one real search that counts against the limit). */
  note?: string;
  actions?: StageActions;
  /** Called with each new report (the page refreshes its health chips). */
  onReport?: (r: DiagnosticReport) => void;
}

/** The panel's sheet is full-screen under 768 px, a drawer on the right from there up. */
const SHEET = '(max-width:767.95px)';
/** How fast the spinner moves down the expected stages while the one request runs. */
const STEP_MS = 600;

export function DiagnosticsPanel({ target, onClose, runOnOpen = true, note, actions = {}, onReport }: DiagnosticsPanelProps) {
  const { api } = usePlatformHost();
  const sheet = useMediaQuery(SHEET);
  const titleId = useId();
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<DiagnosticReport[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [includeHost, setIncludeHost] = useState(false);
  const [announce, setAnnounce] = useState('');
  const problemRef = useRef<HTMLLIElement | null>(null);
  const seq = useRef(0);

  const loadHistory = useCallback(
    async (t: DiagnosticTarget) => {
      try {
        setHistory(await historyOf(api, t));
      } catch {
        setHistory([]);
      }
    },
    [api],
  );

  const show = (r: DiagnosticReport) => {
    setReport(r);
    const p = firstProblem(r);
    setExpanded(new Set(p ? [p.id] : []));
  };

  const run = useCallback(
    async (t: DiagnosticTarget) => {
      const mine = ++seq.current;
      setRunning(true);
      setError(null);
      setReport(null);
      setCurrent(0);
      setAnnounce('');
      try {
        const r = await diagnose(api, t);
        if (mine !== seq.current) return;
        show(r);
        setAnnounce(`Finished: ${OVERALL_WORDS[r.overall]}. ${summarySentence(r)}`);
        onReport?.(r);
        void loadHistory(t);
      } catch (e) {
        if (mine !== seq.current) return;
        const message = e instanceof Error && e.message ? e.message : 'The check could not run';
        setError(message);
        setAnnounce(message);
      } finally {
        if (mine === seq.current) setRunning(false);
      }
    },
    [api, loadHistory, onReport],
  );

  // A new target: start fresh (and run, for Test).
  const key = target ? `${target.kind}:${'id' in target ? target.id : target.provider}` : null;
  useEffect(() => {
    if (!target) {
      seq.current += 1;
      setReport(null);
      setRunning(false);
      setShowHistory(false);
      setIncludeHost(false);
      setError(null);
      return;
    }
    void loadHistory(target);
    if (runOnOpen) void run(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per target
  }, [key]);

  // The last report, when the panel opens without running.
  useEffect(() => {
    if (target && !runOnOpen && !report && !running && history[0]) show(history[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the history arrives
  }, [history]);

  const expected = target ? expectedStages(target) : [];
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setCurrent((c) => Math.min(c + 1, Math.max(0, expected.length - 1))), STEP_MS);
    return () => clearInterval(timer);
  }, [running, expected.length]);

  // The first failing stage is scrolled into view once it is shown.
  useEffect(() => {
    problemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [report]);

  const copy = async () => {
    if (!report || !target) return;
    try {
      await navigator.clipboard.writeText(reportText(report, target, { includeHost }));
      toast('Report copied');
    } catch {
      toast('The report could not be copied', 'warning');
    }
  };

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const problem = report ? firstProblem(report) : null;
  const viewingOld = report !== null && history[0] !== undefined && report.id !== history[0].id && !running;

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      fullScreen={sheet}
      aria-labelledby={titleId}
      sx={sheet ? undefined : { '& .MuiDialog-container': { justifyContent: 'flex-end' }, '& .MuiDialog-paper': { m: 0, height: '100%', maxHeight: '100%', width: 480, maxWidth: '100%', borderRadius: 0 } }}
    >
      <DialogTitle id={titleId} sx={{ pr: 7, overflowWrap: 'anywhere' }}>
        Test of {target?.name ?? ''}
        <IconButton aria-label="Close" onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8, minWidth: 44, minHeight: 44 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {note && (
            <Typography variant="body2" color="text.secondary">
              {note}
            </Typography>
          )}
          <Box role="status" aria-live="polite" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {announce}
          </Box>
          {running && <Typography variant="body2">Checking… this takes up to 20 seconds.</Typography>}
          {error && <Alert severity="error">{error}</Alert>}
          {report && !running && (
            <Alert severity={report.overall === 'fail' ? 'error' : report.overall === 'warn' ? 'warning' : report.overall === 'pass' ? 'success' : 'info'} data-testid="diagnostics-summary">
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {OVERALL_WORDS[report.overall]} · <RelativeTime iso={report.finishedAt} prefix="checked " />
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {summarySentence(report)}
              </Typography>
            </Alert>
          )}
          {viewingOld && <Typography variant="body2" color="text.secondary">You are looking at an earlier report.</Typography>}
          {!running && !report && !error && history.length === 0 && target && !runOnOpen && (
            <Typography variant="body2" color="text.secondary">
              Not checked yet. Run a test to see each step.
            </Typography>
          )}
          {(running || report) && (
            <List aria-label="Steps of the test" disablePadding>
              {running
                ? expected.map((id, i) => <PendingStageItem key={id} id={id} current={i === current} />)
                : report!.stages.map((s) => (
                    <StageItem key={s.id} ref={problem?.id === s.id ? problemRef : undefined} stage={s} expanded={expanded.has(s.id)} onToggle={() => toggle(s.id)} actions={actions} />
                  ))}
            </List>
          )}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button variant="contained" onClick={() => target && void run(target)} disabled={running || !target} sx={{ minHeight: 44 }}>
              {report || error || history.length > 0 ? 'Run again' : 'Run a test'}
            </Button>
            <Button variant="outlined" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory} disabled={history.length === 0} sx={{ minHeight: 44 }}>
              History
            </Button>
            <Button variant="outlined" onClick={() => void copy()} disabled={!report || running} sx={{ minHeight: 44 }}>
              Copy report
            </Button>
          </Stack>
          {target && hasHost(target, report) && (
            <FormControlLabel control={<Checkbox checked={includeHost} onChange={(e) => setIncludeHost(e.target.checked)} />} label="Include the server's address in the copied report" sx={{ minHeight: 44 }} />
          )}
          {showHistory && history.length > 0 && (
            <Box>
              <Typography variant="subtitle2" component="h3">
                Last reports
              </Typography>
              <List aria-label="Last reports" dense>
                {history.map((h) => (
                  <ListItemButton key={h.id} selected={report?.id === h.id} onClick={() => show(h)} sx={{ minHeight: 44 }}>
                    <ListItemText primary={OVERALL_WORDS[h.overall]} secondary={<RelativeTime iso={h.finishedAt} />} />
                  </ListItemButton>
                ))}
              </List>
            </Box>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
