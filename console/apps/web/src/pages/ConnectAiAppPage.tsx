import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlineOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { Alert, Box, Button, IconButton, Link, Paper, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';

import type { AppPreflight, ConnectClientId, PreflightStatus } from '../aiApps/types';
import { AGENT_FRAMEWORKS_DOC_URL, CONNECT_GUIDES, stepsFor } from '../content/connect-ai-apps';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, toast } from '../ui';

const STATUS_ICON: Record<PreflightStatus, { Icon: typeof CheckCircleOutlineIcon; color: 'success' | 'warning' | 'error' | 'disabled'; word: string }> = {
  pass: { Icon: CheckCircleOutlineIcon, color: 'success', word: 'Ready' },
  warn: { Icon: WarningAmberOutlinedIcon, color: 'warning', word: 'Check' },
  fail: { Icon: ErrorOutlineIcon, color: 'error', word: 'Blocked' },
  skip: { Icon: RemoveCircleOutlineIcon, color: 'disabled', word: 'Not checked yet' },
};

/** The console's MCP URL, with a copy button. */
function CopyField({ value, label }: { value: string; label: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied');
    } catch {
      toast('Select the text and copy it');
    }
  };
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, bgcolor: 'action.hover', borderRadius: 1, px: 1.5, py: 0.5 }}>
      <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere', flexGrow: 1, minWidth: 0 }} data-testid="copy-value">
        {value}
      </Typography>
      <Tooltip title={`Copy ${label}`}>
        <IconButton onClick={() => void copy()} aria-label={`Copy ${label}`} sx={{ minWidth: 44, minHeight: 44 }}>
          <ContentCopyOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

/** The preflight: can an app connect, and who fixes what. */
function Preflight({ preflight }: { preflight: AppPreflight }) {
  return (
    <Paper variant="outlined" component="section" aria-labelledby="preflight-title" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }} data-testid="preflight">
      <Typography id="preflight-title" variant="h6" component="h2" sx={{ mb: 1 }}>
        {preflight.ready ? 'Your console is ready for AI apps' : 'Before you connect'}
      </Typography>
      <Stack spacing={1.5} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {preflight.checks.map((c) => {
          const s = STATUS_ICON[c.status];
          return (
            <Stack key={c.id} component="li" direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }} data-testid={`preflight-${c.id}`} data-status={c.status}>
              <s.Icon color={s.color} aria-label={s.word} sx={{ mt: 0.25 }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500 }}>{c.title}</Typography>
                {c.status !== 'pass' && (
                  <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {c.detail}
                  </Typography>
                )}
                {c.fix && (
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    {c.fix.path ? (
                      <Link component={RouterLink} to={c.fix.path}>
                        {c.fix.text}
                      </Link>
                    ) : (
                      c.fix.text
                    )}
                  </Typography>
                )}
              </Box>
            </Stack>
          );
        })}
      </Stack>
    </Paper>
  );
}

/**
 * `/settings/ai-apps/connect` (#464): how to connect ChatGPT, Claude, Claude
 * Code or any other MCP client to this console. The preflight says whether an
 * app can connect yet (sign-in for AI apps on, a public HTTPS address, the
 * app's host allowed) and who can fix what. One tab per client: parallel
 * content of one destination. The steps live in src/content/connect-ai-apps.ts.
 */
export function ConnectAiAppPage() {
  const { api } = usePlatformHost();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('app');
  const tab: ConnectClientId = CONNECT_GUIDES.some((g) => g.id === tabParam) ? (tabParam as ConnectClientId) : 'chatgpt';
  const [preflight, setPreflight] = useState<AppPreflight | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPreflight(await api.get<AppPreflight>('/connected-apps/preflight'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the console');
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const guide = CONNECT_GUIDES.find((g) => g.id === tab)!;
  const url = preflight?.mcpUrl ?? `${window.location.origin}/api/mcp`;
  const client = preflight?.clients.find((c) => c.id === tab);

  return (
    <PageContainer>
      <PageHeader title="Connect an AI app" subtitle="Use your Hexactra agent from ChatGPT, Claude or another AI app." back={{ to: '/settings/ai-apps', label: 'AI apps' }} />
      <ErrorBanner error={error} onRetry={() => void load()} />
      {preflight ? <Preflight preflight={preflight} /> : !error && <CardSkeleton />}

      <Paper variant="outlined" sx={{ mb: 3, minWidth: 0 }}>
        <Tabs value={tab} onChange={(_, v: ConnectClientId) => setParams((p) => ({ ...Object.fromEntries(p), app: v }), { replace: true })} variant="scrollable" allowScrollButtonsMobile aria-label="AI app">
          {CONNECT_GUIDES.map((g) => (
            <Tab key={g.id} value={g.id} label={g.label} id={`tab-${g.id}`} aria-controls={`panel-${g.id}`} sx={{ minHeight: 48 }} />
          ))}
        </Tabs>
        <Box role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} sx={{ p: { xs: 2, sm: 3 } }} data-testid={`guide-${tab}`}>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            {guide.intro}
          </Typography>
          {client && client.allowed === false && (
            <Alert severity="warning" sx={{ mb: 2 }} data-testid="client-blocked">
              {client.detail}
            </Alert>
          )}
          <Typography variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
            Your console&apos;s MCP URL
          </Typography>
          <CopyField value={url} label="the MCP URL" />
          {guide.command && (
            <>
              <Typography variant="subtitle2" component="h3" sx={{ mt: 2, mb: 0.5 }}>
                Command
              </Typography>
              <CopyField value={guide.command.replaceAll('{url}', url)} label="the command" />
            </>
          )}
          <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
            Steps
          </Typography>
          <Box component="ol" sx={{ pl: 3, my: 1 }}>
            {stepsFor(guide, url).map((step) => (
              <Typography key={step} component="li" sx={{ mb: 0.75, overflowWrap: 'anywhere' }}>
                {step}
              </Typography>
            ))}
          </Box>
          {guide.id === 'other' && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
              <Button component={RouterLink} to="/settings/tokens" variant="outlined" sx={{ minHeight: 44 }}>
                Access tokens
              </Button>
              <Button component="a" href={AGENT_FRAMEWORKS_DOC_URL} target="_blank" rel="noopener noreferrer" sx={{ minHeight: 44 }}>
                Agent framework recipes
              </Button>
            </Stack>
          )}
          <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
            What your console will ask
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {guide.consent}
          </Typography>
          <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
            Try it
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {guide.tryFirst}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            Signs in from: {guide.signsInFrom}
          </Typography>
        </Box>
      </Paper>
    </PageContainer>
  );
}
