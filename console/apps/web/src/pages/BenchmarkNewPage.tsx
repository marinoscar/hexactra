import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  FormGroup,
  FormHelperText,
  InputAdornment,
  Link,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { getSuite, startBenchmark } from '../benchmarks/api';
import { BENCHMARKS_PATH, CAPABILITY_LABEL, benchmarkPath, budgetOf, money, newFormProblems, plannedRuns, type NewBenchmarkForm } from '../benchmarks/format';
import { useFleetHosts } from '../components/MachinePicker';
import { errorText, usePolicyCatalog } from '../policies/usePolicyCatalog';
import { machineState } from '../types/fleet';
import type { BenchmarkSuite, CreateBenchmarkInput } from '../types/benchmarks';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useConfirm } from '../ui';

function Section({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <Paper variant="outlined" component="section" aria-label={title} sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
      <Typography variant="h6" component="h2" sx={{ mb: help ? 0 : 1.5 }}>
        {title}
      </Typography>
      {help && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {help}
        </Typography>
      )}
      {children}
    </Paper>
  );
}

/** `/admin/settings/benchmarks/new` (#743): choose the challenges, the policies, the trials, the node and the cap, then start. */
export function BenchmarkNewPage() {
  const { api } = usePlatformHost();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const catalog = usePolicyCatalog({ withTiers: false });
  const hosts = useFleetHosts();
  const [suite, setSuite] = useState<BenchmarkSuite | null>(null);
  const [form, setForm] = useState<NewBenchmarkForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<{ id: string; name: string } | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSuite(api).then(
      (s) => {
        setSuite(s);
        // Every challenge the agent can attempt is chosen by default.
        setForm({ name: '', challengeIds: s.challenges.filter((c) => c.supported).map((c) => c.id), policies: [], trials: String(s.defaults.trials), hostId: null, profile: 'default', capUsd: String(s.defaults.capUsd), recordVideo: false });
      },
      (e) => setError(errorText(e, 'Could not load the benchmark suite')),
    );
  }, [api]);

  const problems = useMemo(() => (suite && form ? newFormProblems(form, suite) : {}), [suite, form]);
  const supportedChosen = suite && form ? form.challengeIds.filter((id) => suite.challenges.some((c) => c.id === id && c.supported)).length : 0;
  const runs = form ? plannedRuns(supportedChosen, form.policies.length, Number(form.trials) || 0) : 0;
  const host = form?.hostId ? hosts.find((h) => h.id === form.hostId) : undefined;
  // Empty or 0: no budget (#844).
  const budget = form ? budgetOf(form.capUsd) : undefined;

  if (!suite || !form) {
    return (
      <PageContainer width="narrow">
        <PageHeader title="New benchmark" back={{ to: BENCHMARKS_PATH, label: 'Benchmarks' }} />
        <ErrorBanner error={error} />
        {!error && <CardSkeleton />}
      </PageContainer>
    );
  }

  const update = (patch: Partial<NewBenchmarkForm>) => setForm({ ...form, ...patch });
  const toggleChallenge = (id: string) => update({ challengeIds: form.challengeIds.includes(id) ? form.challengeIds.filter((x) => x !== id) : [...form.challengeIds, id] });
  const togglePolicy = (ref: string, name: string) =>
    update({ policies: form.policies.some((p) => p.ref === ref) ? form.policies.filter((p) => p.ref !== ref) : [...form.policies, { ref, label: name }] });
  const show = (field: keyof typeof problems) => (touched ? problems[field] : undefined);
  const canSend = Object.keys(problems).length === 0 && suite.site.reachable;

  const submit = async () => {
    setTouched(true);
    setRunning(null);
    if (!canSend) return;
    const ok = await confirm({
      title: `Start ${runs.toLocaleString('en-US')} runs?`,
      body: (
        <>
          {supportedChosen} challenges × {form.policies.length} {form.policies.length === 1 ? 'policy' : 'policies'} × {form.trials} trials, one at a time on {host ? host.name : 'any available node'}. They spend on model calls;{' '}
          {budget ? <>no new trial starts once {money(budget)} is spent</> : <><strong>No budget</strong>: every trial runs, and each run stops only at its own policy budget</>}.
          {form.recordVideo ? ' Every run records a video of its browser tab (not masked).' : ''}
        </>
      ),
      confirmLabel: 'Start benchmark',
    });
    if (!ok) return;
    const input: CreateBenchmarkInput = {
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      challengeIds: form.challengeIds.filter((id) => suite.challenges.some((c) => c.id === id && c.supported)),
      policies: form.policies.map((p) => ({ ref: p.ref, label: p.label.trim() })),
      trials: Number(form.trials),
      hostId: form.hostId,
      profile: form.profile,
      capUsd: budget ?? null,
      ...(form.recordVideo ? { recordVideo: true } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const b = await startBenchmark(api, input);
      navigate(benchmarkPath(b.id));
    } catch (e) {
      if (isPlatformApiError(e) && e.status === 409 && e.code === 'BENCHMARK_RUNNING') {
        const d = (e.details ?? {}) as { benchmarkId?: string; name?: string };
        if (d.benchmarkId) setRunning({ id: d.benchmarkId, name: d.name ?? 'Another benchmark' });
      }
      setError(errorText(e, 'Could not start the benchmark'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title="New benchmark" subtitle={`Suite ${suite.key}, version ${suite.version}.`} back={{ to: BENCHMARKS_PATH, label: 'Benchmarks' }} />
      <Stack spacing={2}>
        <ErrorBanner error={error} onClose={() => setError(null)} />
        {running && (
          <Alert severity="info">
            <Link component={RouterLink} to={benchmarkPath(running.id)}>
              Open “{running.name}”
            </Link>{' '}
            to watch or cancel it.
          </Alert>
        )}
        {!suite.site.reachable && (
          <Alert severity="error">
            A node cannot reach the challenge site at {suite.site.baseUrl}
            {suite.site.problem ? `: ${suite.site.problem}` : ''}. Set the console's public address or the system setting benchmark.siteBaseUrl.
          </Alert>
        )}

        <Section title="Name">
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            helperText={show('name') ?? 'Optional: "Benchmark" and the date when empty.'}
            error={Boolean(show('name'))}
            fullWidth
          />
        </Section>

        <Section title="Challenges" help={`${supportedChosen} of ${suite.challenges.filter((c) => c.supported).length} challenges the agent can attempt are chosen.`}>
          {suite.categories.map((cat) => {
            const inCat = suite.challenges.filter((c) => c.category === cat.id);
            if (inCat.length === 0) return null;
            const runnable = inCat.filter((c) => c.supported);
            const chosen = runnable.filter((c) => form.challengeIds.includes(c.id)).length;
            return (
              <Box key={cat.id} role="group" aria-label={cat.label} sx={{ mt: 1.5, minWidth: 0 }}>
                <FormControlLabel
                  sx={{ m: 0 }}
                  control={
                    <Checkbox
                      checked={runnable.length > 0 && chosen === runnable.length}
                      indeterminate={chosen > 0 && chosen < runnable.length}
                      disabled={runnable.length === 0}
                      onChange={() => {
                        const ids = runnable.map((c) => c.id);
                        update({ challengeIds: chosen === runnable.length ? form.challengeIds.filter((x) => !ids.includes(x)) : [...new Set([...form.challengeIds, ...ids])] });
                      }}
                    />
                  }
                  label={<Typography component="span" sx={{ fontWeight: 600 }}>{cat.label}</Typography>}
                />
                <FormGroup sx={{ pl: { xs: 2, sm: 4 } }}>
                  {inCat.map((c) => {
                    const reason = c.supported ? null : `Needs ${c.missing.map((m) => CAPABILITY_LABEL[m] ?? m).join(' and ')}, which the agent does not have: reported unsupported, never run.`;
                    const row = (
                      <FormControlLabel
                        key={c.id}
                        sx={{ alignItems: 'flex-start', minWidth: 0, mr: 0 }}
                        control={<Checkbox checked={c.supported && form.challengeIds.includes(c.id)} disabled={!c.supported} onChange={() => toggleChallenge(c.id)} sx={{ pt: 0.5 }} />}
                        label={
                          <Box sx={{ minWidth: 0, pt: 0.75 }}>
                            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                              {c.title} <Typography component="span" variant="caption" color="text.secondary">· difficulty {c.difficulty}</Typography>
                            </Typography>
                            {reason && (
                              <Typography variant="caption" color="text.secondary" component="div">
                                {reason}
                              </Typography>
                            )}
                          </Box>
                        }
                      />
                    );
                    return reason ? (
                      <Tooltip key={c.id} title={reason}>
                        <span>{row}</span>
                      </Tooltip>
                    ) : (
                      row
                    );
                  })}
                </FormGroup>
              </Box>
            );
          })}
          {show('challenges') && <FormHelperText error>{show('challenges')}</FormHelperText>}
        </Section>

        <Section title="Agent policies" help={`1 to ${suite.limits.maxPolicies}. Each challenge runs under each of them; the label names its column in the scorecard.`}>
          <ErrorBanner error={catalog.error} />
          <FormGroup>
            {catalog.policies.map((p) => {
              const chosen = form.policies.find((x) => x.ref === p.id);
              return (
                <Stack key={p.id} direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, py: 0.5, minWidth: 0 }}>
                  <FormControlLabel
                    sx={{ flex: '1 1 auto', minWidth: 0, mr: 0 }}
                    control={<Checkbox checked={Boolean(chosen)} onChange={() => togglePolicy(p.id, p.name)} />}
                    label={
                      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                        {p.name}
                        {p.builtin && (
                          <Typography component="span" variant="caption" color="text.secondary">
                            {' '}
                            · built-in
                          </Typography>
                        )}
                      </Typography>
                    }
                  />
                  {chosen && (
                    <TextField
                      size="small"
                      label={`Label for ${p.name}`}
                      value={chosen.label}
                      onChange={(e) => update({ policies: form.policies.map((x) => (x.ref === p.id ? { ...x, label: e.target.value } : x)) })}
                      sx={{ flex: { sm: '0 1 240px' }, pl: { xs: 4, sm: 0 } }}
                    />
                  )}
                </Stack>
              );
            })}
          </FormGroup>
          {show('policies') && <FormHelperText error>{show('policies')}</FormHelperText>}
        </Section>

        <Section title="Trials, node and budget">
          <Stack spacing={2}>
            <TextField
              label="Trials per challenge and policy"
              value={form.trials}
              onChange={(e) => update({ trials: e.target.value })}
              error={Boolean(show('trials'))}
              helperText={show('trials') ?? `Repeated trials show how reliable a policy is (pass^k). 1 to ${suite.limits.maxTrials}.`}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            />
            <TextField
              select
              label="Node"
              value={form.hostId ?? ''}
              onChange={(e) => update({ hostId: e.target.value || null })}
              helperText="Every trial runs on this node; any available one by default."
              slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
            >
              <MenuItem value="">Any available node</MenuItem>
              {hosts.map((h) => (
                <MenuItem key={h.id} value={h.id}>
                  {h.name} ({machineState(h)})
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select={Boolean(host && host.profiles.length > 0)}
              label="Browser profile"
              value={form.profile}
              onChange={(e) => update({ profile: e.target.value })}
              error={Boolean(show('profile'))}
              helperText={show('profile') ?? 'The browser profile on the node.'}
            >
              {host?.profiles.map((p) => (
                <MenuItem key={p.name} value={p.name}>
                  {p.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Budget (USD)"
              value={form.capUsd}
              onChange={(e) => update({ capUsd: e.target.value })}
              error={Boolean(show('capUsd'))}
              helperText={
                show('capUsd') ??
                (budget
                  ? `Leave empty or 0 to run without a budget. No new trial starts once the benchmark has spent ${money(budget)} on model calls.`
                  : 'Leave empty or 0 to run without a budget. No budget: every trial runs, and each run stops only at its own agent policy budget.')
              }
              slotProps={{ input: { startAdornment: <InputAdornment position="start">$</InputAdornment> }, htmlInput: { inputMode: 'decimal' } }}
            />
          </Stack>
        </Section>

        <Section title="Recordings">
          <FormControlLabel
            control={<Switch checked={form.recordVideo} onChange={(e) => update({ recordVideo: e.target.checked })} />}
            label="Record a video of each run"
            data-testid="benchmark-record"
          />
          <FormHelperText sx={{ mt: 0 }}>
            Each trial's run records its browser tab, to watch on the run page. The video is not masked: whatever the page shows is visible. Only you can play it; it is kept for the
            recordings retention set in Administration and uses storage.
          </FormHelperText>
        </Section>

        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }} data-testid="benchmark-plan">
          <Typography variant="body1">
            This starts <strong>{runs.toLocaleString('en-US')}</strong> {runs === 1 ? 'run' : 'runs'}: {supportedChosen} challenges × {form.policies.length} {form.policies.length === 1 ? 'policy' : 'policies'} × {Number(form.trials) || 0} trials
            {budget ? `, with a budget of ${money(budget)}` : budget === null ? ', with no budget' : ''}.
          </Typography>
          <Stack direction="row" sx={{ justifyContent: 'flex-end', mt: 1.5 }}>
            <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={() => void submit()} disabled={busy || !suite.site.reachable} sx={{ minHeight: 44 }}>
              Start benchmark
            </Button>
          </Stack>
        </Paper>
      </Stack>
    </PageContainer>
  );
}
