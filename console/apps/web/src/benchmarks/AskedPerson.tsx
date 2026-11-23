// The trials that ended because the agent asked a person (#884): which challenge, which configuration, which attempt, and the question
// the benchmark's scripted owner could not answer (the grader keeps it, masked, as the failed `asked-person` check). Nothing is computed
// here beyond picking those trials out of the list the page already has.
import { Box, Link, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import type { BenchmarkTrial } from '../types/benchmarks';

/** The check that carries the question (`ASKED_PERSON_CHECK` on the API). */
export const ASKED_PERSON_CHECK = 'asked-person';

/** The trials that ended as asked_person, in run order, each with its question when the console recorded one. */
export function askedPersonTrials(trials: readonly BenchmarkTrial[]): { trial: BenchmarkTrial; question: string | null }[] {
  return trials
    .filter((t) => t.failureReason === 'asked_person')
    .map((t) => ({ trial: t, question: t.checks?.find((c) => c.name === ASKED_PERSON_CHECK)?.detail ?? null }));
}

/** `kind: prompt` → the kind as a word and the prompt. */
function split(question: string): { kind: string | null; prompt: string } {
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(question);
  return m ? { kind: m[1]!.replace(/_/g, ' '), prompt: m[2]! } : { kind: null, prompt: question };
}

export function AskedPersonSection({ trials }: { trials: readonly BenchmarkTrial[] }) {
  const rows = askedPersonTrials(trials);
  if (rows.length === 0) return null;
  return (
    <Paper variant="outlined" component="section" aria-label="Asked a person" data-testid="asked-person" sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
      <Typography variant="h6" component="h2">
        Asked a person
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {rows.length} trial{rows.length === 1 ? '' : 's'} ended because the agent asked a question the benchmark&apos;s scripted owner could not answer. Each counts as a fail.
      </Typography>
      <Stack component="ol" spacing={0} sx={{ p: 0, m: 0 }}>
        {rows.map(({ trial: t, question }) => {
          const q = question ? split(question) : null;
          return (
            <Box
              component="li"
              key={t.id}
              data-testid="asked-person-row"
              sx={{ listStyle: 'none', py: 1.25, borderTop: 1, borderColor: 'divider', display: 'grid', gap: { xs: 0.5, md: 2 }, gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 2fr) auto' }, alignItems: 'start' }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {t.challengeTitle}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {t.policyLabel} · attempt {t.trialIndex + 1}
                  {t.questions !== null && t.questions !== undefined ? ` · ${t.questions} question${t.questions === 1 ? '' : 's'} asked` : ''}
                </Typography>
              </Box>
              <Box sx={{ minWidth: 0 }}>
                {q ? (
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                    {q.kind && (
                      <Box component="span" sx={{ color: 'text.secondary', mr: 0.75 }}>
                        {q.kind}:
                      </Box>
                    )}
                    “{q.prompt}”
                  </Typography>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    The question is not recorded (graded before the console kept it).
                  </Typography>
                )}
              </Box>
              <Box>
                {t.runId ? (
                  <Link component={RouterLink} to={`/runs/${t.runId}`} sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>
                    Open run
                  </Link>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    run removed
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })}
      </Stack>
    </Paper>
  );
}
