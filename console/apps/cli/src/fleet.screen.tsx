import { textColor, useTuiTheme, type TuiScreenProps } from '@marinoscar/platform-cli/tui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { consoleApi, consoleWebUrl } from './console-api.js';
import { desktopUrl, hostLine, type FleetHost } from './fleet.js';

/**
 * Fleet: hosts and their profiles. Up/down selects a host; `d` drains or
 * undrains it, `r` refreshes, Esc returns to the menu. Changes need
 * `fleet:write`; the API says so when it is missing.
 */
export function FleetScreen({ onDone }: TuiScreenProps): ReactNode {
  const theme = useTuiTheme();
  const [hosts, setHosts] = useState<FleetHost[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHosts(await consoleApi().get<FleetHost[]>('/fleet/hosts'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useInput((input, key) => {
    if (key.escape || input === 'q') return onDone();
    if (!hosts?.length) {
      if (input === 'r') void load();
      return;
    }
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelected((i) => Math.min(hosts.length - 1, i + 1));
    if (input === 'r') void load();
    if (input === 'o') {
      const h = hosts[selected]!;
      try {
        setStatus(h.desktop ? `Open in a browser: ${desktopUrl(consoleWebUrl(), h.id)}` : `${h.name} does not share a desktop`);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    }
    if (input === 'd') {
      const h = hosts[selected]!;
      setStatus(`${h.draining ? 'Undraining' : 'Draining'} ${h.name}…`);
      void consoleApi()
        .post(`/fleet/hosts/${h.id}/drain`, { enabled: !h.draining })
        .then(() => {
          setStatus(`${h.name}: ${h.draining ? 'undrained' : 'draining'}`);
          return load();
        })
        .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold {...textColor(theme.primary)}>Fleet</Text>
      {error && <Text {...textColor(theme.error)}>{error}</Text>}
      {!hosts && !error && <Text dimColor>Loading…</Text>}
      {hosts?.length === 0 && <Text>No host is enrolled. Run `hexactra fleet enroll`.</Text>}
      <Box flexDirection="column">
        {hosts?.map((h, i) => (
          <Text key={h.id} inverse={i === selected} wrap="truncate">
            {i === selected ? '› ' : '  '}
            {hostLine(h)}
          </Text>
        ))}
      </Box>
      {status && <Text>{status}</Text>}
      <Text dimColor>↑/↓ select · o desktop link · d drain/undrain · r refresh · esc back</Text>
    </Box>
  );
}
