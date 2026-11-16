import { textColor, useTuiTheme, type TuiScreenProps } from '@marinoscar/platform-cli/tui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { consoleApi } from '../console-api.js';
import {
  agentLogs,
  agentStatus,
  defaultDeps,
  installAgent,
  serviceControl,
  uninstallAgent,
  updateAgent,
  type AgentDeps,
  type AgentStatus,
} from './agent.js';
import { statusLines } from './agent.command.js';

type Mode = 'status' | 'logs' | 'confirm-uninstall';

/**
 * Agent: this machine as a browser host. Every `hexactra agent` command has a
 * key here: i install (or repair), u update, s start/stop, r restart,
 * l logs, x uninstall, g refresh, esc back. The one step a screen cannot do
 * is type a sudo password: when Chrome's sandbox helper needs it, the screen
 * says to run `hexactra agent sandbox` in a terminal.
 */
export function AgentScreen({ onDone, deps }: TuiScreenProps & { deps?: (log: (l: string) => void) => AgentDeps }): ReactNode {
  const theme = useTuiTheme();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('status');
  const [logs, setLogs] = useState<string[]>([]);
  const mounted = useRef(true);

  const log = useCallback((l: string) => {
    if (mounted.current) setLines((prev) => [...prev.slice(-11), l]);
  }, []);
  const d = useCallback(() => (deps ? deps(log) : defaultDeps(log, () => consoleApi())), [deps, log]);

  const refresh = useCallback(async () => {
    try {
      const s = await agentStatus(d());
      if (mounted.current) setStatus(s);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [d]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const run = (label: string, work: () => Promise<unknown> | unknown) => {
    setBusy(label);
    setError(null);
    setLines([]);
    void Promise.resolve()
      .then(work)
      .catch((e: unknown) => mounted.current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (mounted.current) setBusy(null);
        void refresh();
      });
  };

  useInput((input, key) => {
    if (busy) return;
    if (mode === 'confirm-uninstall') {
      if (input === 'y') {
        setMode('status');
        run('Uninstalling', () => uninstallAgent(d(), {}));
      } else setMode('status');
      return;
    }
    if (mode === 'logs') {
      if (key.escape || input === 'q' || input === 'l') setMode('status');
      return;
    }
    if (key.escape || input === 'q') return onDone();
    const installed = !!status?.installed;
    if (input === 'g') void refresh();
    if (input === 'i') run(installed ? 'Repairing' : 'Installing', () => installAgent(d(), { interactiveSudo: false }));
    if (!installed) return;
    if (input === 'u') run('Updating', () => updateAgent(d(), {}));
    if (input === 'r') run('Restarting', () => serviceControl(d(), 'restart'));
    if (input === 's') {
      const active = status?.service?.active === 'active';
      run(active ? 'Stopping' : 'Starting', () => serviceControl(d(), active ? 'stop' : 'start'));
    }
    if (input === 'l') {
      const r = agentLogs(d(), 40, false);
      setLogs((r.stdout || r.stderr || 'No log yet.').trimEnd().split('\n'));
      setMode('logs');
    }
    if (input === 'x') setMode('confirm-uninstall');
  });

  if (mode === 'logs') {
    return (
      <Box flexDirection="column">
        <Text bold {...textColor(theme.primary)}>Agent log (last 40 lines)</Text>
        {logs.map((l, i) => (
          <Text key={i} wrap="truncate">{l}</Text>
        ))}
        <Text dimColor>l/esc back · `hexactra agent logs -f` follows it</Text>
      </Box>
    );
  }

  const installed = !!status?.installed;
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold {...textColor(theme.primary)}>Agent: this machine as a browser host</Text>
      {!status && !error && <Text dimColor>Reading…</Text>}
      {status && (
        <Box flexDirection="column">
          {statusLines(status).map((l) => (
            <Text key={l} wrap="truncate">{l}</Text>
          ))}
        </Box>
      )}
      {busy && <Text {...textColor(theme.primary)}>{busy}…</Text>}
      {lines.length > 0 && (
        <Box flexDirection="column">
          {lines.map((l, i) => (
            <Text key={i} dimColor wrap="truncate">{l}</Text>
          ))}
        </Box>
      )}
      {error && <Text {...textColor(theme.error)}>{error}</Text>}
      {mode === 'confirm-uninstall' && <Text {...textColor(theme.error)}>Uninstall the agent and revoke this host in Fleet? y to confirm, any other key to cancel</Text>}
      <Text dimColor wrap="truncate">
        {installed ? 'i repair · u update · s start/stop · r restart · l logs · x uninstall · g refresh · esc back' : 'i install · g refresh · esc back'}
      </Text>
    </Box>
  );
}
