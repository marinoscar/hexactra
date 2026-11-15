import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardActions, CardContent, Chip, Container, Link, Stack, TextField, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

/** `GET /api/inbox`. */
export interface InboxItem {
  runId: string;
  goal: string;
  handoffId: string;
  kind: string;
  prompt: string;
  input: 'none' | 'text' | 'secret' | 'choice';
  choices: string[];
  pageTitle: string | null;
  viewerUrl: string | null;
  createdAt: string;
  expiresAt: string;
}

const KIND_LABEL: Record<string, string> = {
  captcha: 'CAPTCHA',
  code: 'Code',
  passkey: 'Passkey',
  login: 'Sign-in',
  confirmation: 'Confirm',
  other: 'Help',
};

/** `/inbox`: what your agents are waiting for. Answers go to the agent at once. */
export function InboxPage() {
  const { api, viewer } = usePlatformHost();
  const canAnswer = viewer.hasPermission('runs:write');
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.get<InboxItem[]>('/inbox'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the inbox');
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const respond = async (item: InboxItem, outcome: 'completed' | 'cancelled', value?: string) => {
    setBusy(item.runId);
    setError(null);
    try {
      await api.post(`/inbox/${item.runId}/respond`, value !== undefined ? { outcome, value } : { outcome });
      setValues((v) => ({ ...v, [item.runId]: '' }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer');
    } finally {
      setBusy(null);
    }
  };

  const openViewer = async (item: InboxItem) => {
    if (!item.viewerUrl) return;
    if (!item.viewerUrl.includes('/viewer/local/')) return void window.open(item.viewerUrl, '_blank', 'noopener');
    const tab = window.open('', '_blank');
    try {
      const { url } = await api.post<{ url: string }>('/fleet/viewer-ticket', {});
      if (tab) tab.location.href = url;
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : 'Could not open the viewer');
    }
  };

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Inbox
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {items?.length === 0 && <Alert severity="success">Nothing is waiting for you.</Alert>}
      <Stack spacing={2} aria-label="Requests">
        {items?.map((item) => {
          const value = values[item.runId] ?? '';
          const disabled = !canAnswer || busy === item.runId;
          return (
            <Card key={item.runId} variant="outlined" aria-label={`Request: ${item.prompt}`}>
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
                  <Chip size="small" color="warning" label={KIND_LABEL[item.kind] ?? item.kind} />
                  <Typography variant="caption" color="text.secondary">
                    expires {new Date(item.expiresAt).toLocaleTimeString()}
                  </Typography>
                </Stack>
                <Typography sx={{ whiteSpace: 'pre-wrap' }}>{item.prompt}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  For:{' '}
                  <Link component={RouterLink} to={`/runs/${item.runId}`}>
                    {item.goal}
                  </Link>
                  {item.pageTitle ? ` · on “${item.pageTitle}”` : ''}
                </Typography>
                {(item.input === 'text' || item.input === 'secret') && (
                  <TextField
                    sx={{ mt: 2 }}
                    fullWidth
                    size="small"
                    type={item.input === 'secret' ? 'password' : 'text'}
                    autoComplete={item.input === 'secret' ? 'one-time-code' : 'off'}
                    label={item.input === 'secret' ? 'Code or secret (goes to the agent, never stored)' : 'Your answer'}
                    value={value}
                    onChange={(e) => setValues((v) => ({ ...v, [item.runId]: e.target.value }))}
                    disabled={disabled}
                  />
                )}
              </CardContent>
              <CardActions sx={{ flexWrap: 'wrap' }}>
                {item.input === 'choice' ? (
                  item.choices.map((c) => (
                    <Button key={c} variant="contained" disabled={disabled} onClick={() => void respond(item, 'completed', c)}>
                      {c}
                    </Button>
                  ))
                ) : item.input === 'none' ? (
                  <Button variant="contained" disabled={disabled} onClick={() => void respond(item, 'completed')}>
                    {item.kind === 'confirmation' ? 'Approve' : "I've done it"}
                  </Button>
                ) : (
                  <Button variant="contained" disabled={disabled || !value} onClick={() => void respond(item, 'completed', value)}>
                    Send
                  </Button>
                )}
                <Button color="error" disabled={disabled} onClick={() => void respond(item, 'cancelled')}>
                  {item.kind === 'confirmation' ? 'Decline' : "Can't help"}
                </Button>
                {item.viewerUrl && <Button onClick={() => void openViewer(item)}>Open the browser</Button>}
              </CardActions>
            </Card>
          );
        })}
      </Stack>
    </Container>
  );
}
