import { useTuiTheme, type TuiScreenProps } from '@marinoscar/platform-cli/tui';
import { ErrorNotice, Field, Frame, toneProps, useTerminalSize } from '@marinoscar/platform-cli/tui/ui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { consoleApi } from '../console-api.js';
import {
  agentDoctor,
  agentLogs,
  agentStatus,
  defaultDeps,
  readState,
  serviceControl,
  unattendedControl,
  unattendedLogs,
  unattendedStatusWithRelease,
  type AgentDeps,
  type AgentStatus,
  type DoctorCheck,
  type UnattendedStatus,
} from './agent.js';
import { updateEverything } from './update.js';
import {
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  dependencyReport,
  desktopSession,
  installedModes,
  installMissing,
  modesOf,
  sudoAuthenticate,
  sudoReady,
  type DependencyRow,
  type InstallChoice,
  type InstallMode,
} from './dependencies.js';
import { chromeSetup } from './googleChrome.js';
import { installChoice, uninstallTarget, uninstallTargets, type UninstallTarget } from './lifecycle.js';
import { actions, checkLine, checkNameWidth, health, panels, type ActionId } from './screen/model.js';
import { CompactPanels, PanelView, SelectList, TextField, ToneLines, type ToneLine } from './screen/widgets.js';
import { readUnattended } from './unattended.js';

/** Work the screen runs, with its log shown live. `privileged` work asks for the sudo password first when sudo is not ready. */
interface Job {
  title: string;
  privileged: boolean;
  work: (d: AgentDeps) => Promise<string[] | void> | string[] | void;
}

type View =
  | { kind: 'dashboard' }
  | { kind: 'install'; step: 'mode' | 'review' | 'name' | 'resolution'; choice: InstallChoice; name: string; resolution: string }
  | { kind: 'uninstall'; step: 'target' | 'options' | 'confirm'; target: UninstallTarget; purgeProfiles: boolean; keepHost: boolean }
  | { kind: 'logs'; source: 'agent' | 'node'; follow: boolean }
  | { kind: 'doctor'; allModes: boolean }
  | { kind: 'sudo'; job: Job; attempts: number }
  | { kind: 'run'; job: Job; done: boolean; error: string | null; result: string[] };

const REFRESH_MS = 5_000;
/**
 * The doctor runs a moment after the first paint: its checks call system tools
 * synchronously (`google-chrome --version`, dpkg, systemctl), which must not
 * hold up opening the screen, nor run at all for a screen closed at once.
 */
const DOCTOR_DELAY_MS = 600;
const LOG_POLL_MS = 2_000;
const LOG_LINES = 300;

/** The tone of a journal line: errors red, warnings yellow. */
export function logTone(line: string): ToneLine['tone'] {
  if (/\b(error|fail(ed|ure)?|panic|fatal)\b/i.test(line)) return 'error';
  if (/\bwarn(ing)?\b/i.test(line)) return 'warning';
  return undefined;
}

/** A dependency row for display. */
export function dependencyLine(r: DependencyRow, nameWidth: number): ToneLine {
  const icon = r.installed ? '✓' : '○';
  const state = r.installed ? 'installed' : r.chrome ? 'missing (Chrome setup)' : 'missing';
  return { text: `${icon} ${r.name.padEnd(nameWidth)} ${state.padEnd(22)} ${r.purpose}  [${r.neededBy.join(', ')}]`, tone: r.installed ? 'success' : 'warning' };
}

/**
 * Agent: this machine as a browser host (#374). A dashboard of the agent, the
 * unattended node and Fleet, with a health line from the doctor, and an
 * action menu (arrows and enter, or the hotkeys) that opens:
 *
 * - Install: a wizard (mode, the packages it needs, name and resolution).
 * - Uninstall: a wizard (agent, node or both; keep profiles; keep the host).
 * - Logs: live, from the agent service or the unattended node.
 * - Doctor: every check with its fix, and every package, installing the
 *   missing ones.
 *
 * Work that needs root asks for the sudo password in a masked field first;
 * the password goes only to `sudo -S -v` and is never stored or shown.
 */
export function AgentScreen({ onDone, deps }: TuiScreenProps & { deps?: (log: (l: string) => void) => AgentDeps }): ReactNode {
  const theme = useTuiTheme();
  const { columns, rows } = useTerminalSize();
  const [view, setView] = useState<View>({ kind: 'dashboard' });
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [node, setNode] = useState<UnattendedStatus | null>(null);
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runLines, setRunLines] = useState<string[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [depRows, setDepRows] = useState<DependencyRow[]>([]);
  const [password, setPassword] = useState('');
  const mounted = useRef(true);
  const sink = useRef<(l: string) => void>(() => undefined);

  const d = useCallback((): AgentDeps => {
    const log = (l: string) => sink.current(l);
    return deps ? deps(log) : defaultDeps(log, () => consoleApi());
  }, [deps]);

  const refresh = useCallback(async (withDoctor = false) => {
    try {
      const deps = d();
      const [s, c, n] = await Promise.all([agentStatus(deps), withDoctor ? agentDoctor(deps) : Promise.resolve(null), unattendedStatusWithRelease(deps)]);
      if (!mounted.current) return;
      setStatus(s);
      setNode(n);
      if (c) setChecks(c);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [d]);

  useEffect(() => {
    mounted.current = true;
    void refresh(false);
    const doctor = setTimeout(() => void refresh(true), DOCTOR_DELAY_MS);
    return () => {
      clearTimeout(doctor);
      mounted.current = false;
    };
  }, [refresh]);

  // The dashboard refreshes itself while it is shown.
  useEffect(() => {
    if (view.kind !== 'dashboard') return;
    const t = setInterval(() => void refresh(false), REFRESH_MS);
    return () => clearInterval(t);
  }, [view.kind, refresh]);

  // Logs: read now, then poll while following.
  const readLogs = useCallback(
    (source: 'agent' | 'node') => {
      const r = source === 'node' ? unattendedLogs(d(), LOG_LINES, false) : agentLogs(d(), LOG_LINES, false);
      if (mounted.current) setLogLines((r.stdout || r.stderr || 'No log yet.').trimEnd().split('\n'));
    },
    [d],
  );
  useEffect(() => {
    if (view.kind !== 'logs') return;
    readLogs(view.source);
    if (!view.follow) return;
    const t = setInterval(() => readLogs(view.source), LOG_POLL_MS);
    return () => clearInterval(t);
  }, [view, readLogs]);

  const loadDeps = useCallback(
    (modes: InstallMode[]) => {
      try {
        setDepRows(dependencyReport(d(), modes));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [d],
  );

  const runJob = useCallback(
    (job: Job) => {
      setRunLines([]);
      sink.current = (l) => mounted.current && setRunLines((prev) => [...prev, l]);
      setView({ kind: 'run', job, done: false, error: null, result: [] });
      // Let the run view paint before synchronous steps (apt) hold the event loop.
      setTimeout(() => {
        void Promise.resolve()
          .then(() => job.work(d()))
          .then((result) => mounted.current && setView({ kind: 'run', job, done: true, error: null, result: result ?? [] }))
          .catch((e: unknown) => mounted.current && setView({ kind: 'run', job, done: true, error: e instanceof Error ? e.message : String(e), result: [] }))
          .finally(() => {
            sink.current = () => undefined;
            void refresh(true);
          });
      }, 30);
    },
    [d, refresh],
  );

  /** Runs a job, asking for the sudo password first when it may need root and sudo is not ready. */
  const start = useCallback(
    (job: Job) => {
      if (job.privileged && !sudoReady(d())) {
        setPassword('');
        setView({ kind: 'sudo', job, attempts: 0 });
      } else runJob(job);
    },
    [d, runJob],
  );

  const menu = useMemo(() => actions(status, node), [status, node]);

  const onAction = (id: ActionId) => {
    const hostname = d().hostname();
    switch (id) {
      case 'install': {
        const prev = readState(d().paths)?.name ?? readUnattended(d().paths.agentDir)?.name ?? hostname;
        setView({ kind: 'install', step: 'mode', choice: 'default', name: prev, resolution: readUnattended(d().paths.agentDir)?.resolution ?? '1920x1080' });
        return;
      }
      case 'update':
        return start({
          title: 'Updating',
          privileged: true,
          // The same routine as `hexactra agent update` (#902): the agent, Chrome and its extension, checked.
          work: (deps) => updateEverything(deps, { interactive: false }),
        });
      case 'service': {
        const active = status?.service?.active === 'active';
        return start({ title: active ? 'Stopping the agent' : 'Starting the agent', privileged: false, work: (deps) => serviceControl(deps, active ? 'stop' : 'start') });
      }
      case 'restart':
        return start({ title: 'Restarting the agent', privileged: false, work: (deps) => serviceControl(deps, 'restart') });
      case 'node-service': {
        const allActive = Object.values(node?.units ?? {}).every((u) => u === 'active');
        return start({ title: allActive ? 'Stopping the unattended node' : 'Starting the unattended node', privileged: true, work: (deps) => unattendedControl(deps, allActive ? 'stop' : 'start', false) });
      }
      case 'node-restart':
        return start({ title: 'Restarting the unattended node', privileged: true, work: (deps) => unattendedControl(deps, 'restart', false) });
      case 'logs':
        return setView({ kind: 'logs', source: status?.installed ? 'agent' : 'node', follow: true });
      case 'doctor':
        loadDeps(installedModes(d()));
        void refresh(true);
        return setView({ kind: 'doctor', allModes: false });
      case 'chrome':
        return start({ title: 'Setting up Google Chrome', privileged: true, work: async (deps) => void (await chromeSetup(deps, { interactive: false })) });
      case 'uninstall': {
        const targets = uninstallTargets(d());
        if (targets.length === 0) return setError('Nothing is installed here to uninstall.');
        return setView({ kind: 'uninstall', step: 'target', target: targets[0]!, purgeProfiles: false, keepHost: false });
      }
      case 'refresh':
        return void refresh(true);
      case 'back':
        return onDone();
    }
  };

  // Esc and q: back one level (the dashboard leaves the screen). Text fields handle their own Esc.
  useInput((input, key) => {
    const back = key.escape || input === 'q';
    if (view.kind === 'dashboard') {
      if (back) onDone();
      else if (input === 'g') void refresh(true);
      return;
    }
    if (view.kind === 'run') {
      if (view.done && (key.return || back)) setView({ kind: 'dashboard' });
      return;
    }
    if (view.kind === 'sudo' || (view.kind === 'install' && (view.step === 'name' || view.step === 'resolution'))) return;
    if (view.kind === 'install' && view.step === 'review' && back) return setView({ ...view, step: 'mode' });
    if (view.kind === 'uninstall' && view.step === 'confirm') {
      if (input === 'y') {
        const v = view;
        start({ title: 'Uninstalling', privileged: true, work: async (deps) => uninstallTarget(deps, v.target, { purgeProfiles: v.purgeProfiles, keepHost: v.keepHost, interactiveSudo: false }) });
      } else setView({ ...view, step: 'options' });
      return;
    }
    if (view.kind === 'uninstall' && view.step === 'options' && back) return setView({ ...view, step: 'target' });
    if (view.kind === 'logs') {
      if (input === 'f') return setView({ ...view, follow: !view.follow });
      if (input === 'a' && status?.installed) return setView({ ...view, source: 'agent' });
      if (input === 'n' && node?.state) return setView({ ...view, source: 'node' });
    }
    if (view.kind === 'doctor') {
      if (input === 'r') {
        loadDeps(view.allModes ? ['default', 'attended', 'unattended'] : installedModes(d()));
        return void refresh(true);
      }
      if (input === 'a') {
        const allModes = !view.allModes;
        loadDeps(allModes ? ['default', 'attended', 'unattended'] : installedModes(d()));
        return setView({ ...view, allModes });
      }
      if (input === 'm') {
        const rows = depRows;
        return start({ title: 'Installing missing packages', privileged: true, work: (deps) => {
          const r = installMissing(deps, rows, false);
          return [r.installed.length ? `Installed ${r.installed.join(', ')}.` : 'Nothing to install with apt.', ...(r.chromeMissing ? ['Google Chrome is still missing: run Google Chrome setup.'] : [])];
        } });
      }
    }
    if (back) setView({ kind: 'dashboard' });
  });

  // --- views -----------------------------------------------------------------

  if (view.kind === 'sudo') {
    const submit = (pw: string) => {
      setPassword('');
      if (pw && sudoAuthenticate(d(), pw)) runJob(view.job);
      else setView({ ...view, attempts: view.attempts + 1 });
    };
    return (
      <Frame title={`${view.job.title}: administrator rights`} hints={['enter continue', 'esc cancel']}>
        <Box flexDirection="column" gap={1}>
          <Text wrap="wrap">This needs sudo. Type your password for this computer. It goes only to sudo, to unlock it for this terminal for a few minutes, and is never stored or shown.</Text>
          <TextField label="Password" value={password} mask onChange={setPassword} onSubmit={submit} onCancel={() => setView({ kind: 'dashboard' })} />
          {view.attempts > 0 && <ErrorNotice message="sudo did not accept that password (or this account cannot use sudo)." hint="Try again, or esc to cancel." />}
        </Box>
      </Frame>
    );
  }

  if (view.kind === 'run') {
    const tail: ToneLine[] = runLines.map((l) => ({ text: l, tone: logTone(l) ?? 'dim' }));
    return (
      <Frame title={view.job.title} hints={view.done ? ['enter back'] : ['working: apt and downloads can take a few minutes']}>
        <Box flexDirection="column" gap={1}>
          <ToneLines lines={tail} follow reservedRows={view.done ? 12 : 8} />
          {!view.done && <Text {...toneProps(theme, 'primary')}>{view.job.title}…</Text>}
          {view.done && !view.error && (
            <Box flexDirection="column">
              <Text bold {...toneProps(theme, 'success')}>✓ Done</Text>
              {view.result.map((l, i) => (
                <Text key={i} wrap="wrap">{l}</Text>
              ))}
            </Box>
          )}
          {view.done && view.error && <ErrorNotice message={view.error} hint="Fix it and run it again, or open the Doctor." />}
        </Box>
      </Frame>
    );
  }

  if (view.kind === 'install') {
    const modes = modesOf(view.choice);
    const unattended = modes.includes('unattended');
    if (view.step === 'mode') {
      const session = desktopSession(d());
      const items = (['default', 'attended', 'unattended', 'both'] as const).map((c, i) => ({
        id: c,
        key: String(i + 1),
        label: MODE_LABELS[c],
        hint: MODE_DESCRIPTIONS[c] + ((c === 'attended' || c === 'both') && session !== 'x11' ? ' Needs an X11 desktop session: run the TUI from your desktop.' : ''),
      }));
      return (
        <Frame title="Install · 1 of 2 · choose how the agent runs" hints={['↑↓ move', 'enter choose', 'esc back']}>
          <SelectList
            items={items}
            initial={['default', 'attended', 'unattended', 'both'].indexOf(view.choice)}
            onSelect={(choice) => {
              loadDeps(modesOf(choice));
              setView({ ...view, choice, step: 'review' });
            }}
          />
        </Frame>
      );
    }
    if (view.step === 'name' || view.step === 'resolution') {
      const field = view.step;
      const [value, setValue] = [view[field], (v: string) => setView({ ...view, [field]: v })];
      return (
        <Frame title={`Install · ${field === 'name' ? 'host name' : 'desktop resolution'}`} hints={['enter save', 'esc cancel']}>
          <TextField
            label={field === 'name' ? 'Host name in Fleet' : 'Resolution (WxH)'}
            value={value}
            onChange={setValue}
            onSubmit={(v) => setView({ ...view, [field]: v.trim() || (field === 'name' ? d().hostname() : '1920x1080'), step: 'review' })}
            onCancel={() => setView({ ...view, step: 'review' })}
          />
        </Frame>
      );
    }
    const nameWidth = Math.max(10, ...depRows.map((r) => r.name.length));
    const missing = depRows.filter((r) => !r.installed);
    const badResolution = unattended && !/^\d{3,4}x\d{3,4}$/.test(view.resolution);
    return (
      <Frame title="Install · 2 of 2 · review" hints={['↑↓ move', 'enter choose', 'esc back']}>
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Field label="Mode" value={MODE_LABELS[view.choice]} />
            <Field label="Host name" value={view.name} />
            {unattended && <Field label="Resolution" value={view.resolution} {...(badResolution ? { color: 'red' } : {})} />}
            <Field label="Packages" value={missing.length ? `${missing.length} to install (sudo)` : 'all installed'} />
          </Box>
          <Box flexDirection="column">
            {depRows.map((r) => {
              const l = dependencyLine(r, nameWidth);
              return (
                <Text key={r.name} wrap="truncate" {...toneProps(theme, l.tone)}>
                  {l.text}
                </Text>
              );
            })}
          </Box>
          <SelectList
            items={[
              { id: 'go', label: 'Install now', key: 'i' },
              { id: 'name', label: 'Change the host name', key: 'n' },
              ...(unattended ? [{ id: 'resolution', label: 'Change the resolution', key: 'r' }] : []),
              { id: 'mode', label: 'Choose another mode', key: 'b' },
            ]}
            onSelect={(id) => {
              if (id === 'name' || id === 'resolution') return setView({ ...view, step: id });
              if (id === 'mode') return setView({ ...view, step: 'mode' });
              if (badResolution) return setError('The resolution must look like 1920x1080.');
              const v = view;
              start({
                title: `Installing (${v.choice})`,
                privileged: true,
                work: async (deps) => installChoice(deps, v.choice, { name: v.name, interactiveSudo: false, ...(modesOf(v.choice).includes('unattended') ? { resolution: v.resolution } : {}) }),
              });
            }}
          />
          {error && <ErrorNotice message={error} />}
        </Box>
      </Frame>
    );
  }

  if (view.kind === 'uninstall') {
    const labels: Record<UninstallTarget, string> = {
      agent: status?.state?.attended ? 'The attended agent (your Chrome)' : 'The agent (this user)',
      node: 'The unattended node (its desktop and user hexactra)',
      both: 'Both',
    };
    if (view.step === 'target') {
      return (
        <Frame title="Uninstall · what to remove" hints={['↑↓ move', 'enter choose', 'esc back']}>
          <SelectList items={uninstallTargets(d()).map((t) => ({ id: t, label: labels[t] }))} onSelect={(target) => setView({ ...view, target, step: 'options' })} />
        </Frame>
      );
    }
    if (view.step === 'options') {
      return (
        <Frame title={`Uninstall · ${labels[view.target]}`} hints={['↑↓ move', 'enter toggle or choose', 'esc back']}>
          <SelectList
            items={[
              { id: 'profiles', label: `${view.purgeProfiles ? '[ ]' : '[x]'} Keep the browser profiles (they hold your sign-ins)`, key: 'p' },
              { id: 'host', label: `${view.keepHost ? '[ ]' : '[x]'} Revoke the host in Fleet`, key: 'h' },
              { id: 'go', label: 'Uninstall…', key: 'x' },
            ]}
            onSelect={(id) => {
              if (id === 'profiles') return setView({ ...view, purgeProfiles: !view.purgeProfiles });
              if (id === 'host') return setView({ ...view, keepHost: !view.keepHost });
              setView({ ...view, step: 'confirm' });
            }}
          />
        </Frame>
      );
    }
    return (
      <Frame title="Uninstall · confirm" hints={['y uninstall', 'any other key: back']}>
        <Box flexDirection="column">
          <Text {...toneProps(theme, 'error')} wrap="wrap">
            Remove {labels[view.target].toLowerCase()}
            {view.keepHost ? '' : ', revoke the host in Fleet'}
            {view.purgeProfiles ? ' and DELETE its browser profiles and sign-ins' : ', keeping its browser profiles'}?
          </Text>
          <Text>Press y to uninstall.</Text>
        </Box>
      </Frame>
    );
  }

  if (view.kind === 'logs') {
    const lines: ToneLine[] = logLines.map((l) => ({ text: l, tone: logTone(l) }));
    const sources = [status?.installed ? 'a agent' : null, node?.state ? 'n unattended node' : null].filter(Boolean) as string[];
    return (
      <Frame title={`Logs · ${view.source === 'node' ? 'unattended node (agent and desktop units)' : 'agent service'}${view.follow ? ' · live' : ''}`} hints={[...sources, `f ${view.follow ? 'pause' : 'follow'}`, '↑↓ scroll', 'esc back']}>
        <ToneLines lines={lines} follow={view.follow} reservedRows={7} />
      </Frame>
    );
  }

  if (view.kind === 'doctor') {
    const h = health(checks);
    const nameWidth = Math.max(10, ...depRows.map((r) => r.name.length));
    const missing = depRows.filter((r) => !r.installed && !r.chrome).length;
    const lines: ToneLine[] = [
      { text: h ? `Checks · ${h.ok} ok · ${h.warn} warnings · ${h.fail} failing${missing ? ` · ${missing} ${missing === 1 ? 'package' : 'packages'} missing (below)` : ''}` : 'Checks · running…', bold: true },
      ...(checks ?? []).map((c) => checkLine(c, checkNameWidth(checks))),
      { text: '' },
      { text: `Dependencies · ${view.allModes ? 'every mode' : `for ${installedModes(d()).join(', ')}`}${missing ? ` · ${missing} missing` : ''}`, bold: true },
      ...depRows.map((r) => dependencyLine(r, nameWidth)),
    ];
    return (
      <Frame title="Doctor and dependencies" hints={[...(missing ? ['m install missing'] : []), `a ${view.allModes ? 'installed modes' : 'every mode'}`, 'r re-run', '↑↓ scroll', 'esc back']}>
        <ToneLines lines={lines} reservedRows={7} />
      </Frame>
    );
  }

  // --- dashboard ---------------------------------------------------------------
  const ps = panels(status, node);
  const h = health(checks);
  // Boxed side by side only when each panel gets room for its values and the
  // terminal is tall enough; otherwise one coloured line per panel.
  const boxed = columns >= 8 + 46 * ps.length && rows >= 36;
  const problemsShown = rows >= 30 ? 3 : 1;
  return (
    <Frame title="Agent · this machine as a browser host" hints={['↑↓ enter or a hotkey', 'g refresh', 'q/esc back']}>
      <Box flexDirection="column" gap={1}>
        {!status && !error && <Text dimColor>Reading…</Text>}
        {status && (
          boxed ? (
            <Box flexDirection="row" gap={1}>
              {ps.map((p) => (
                <PanelView key={p.title} panel={p} width={Math.floor((columns - 8) / ps.length)} />
              ))}
            </Box>
          ) : (
            <CompactPanels panels={ps} />
          )
        )}
        {!h && status && <Text dimColor>Health  checking…</Text>}
        {h && (
          <Box flexDirection="column">
            <Text>
              <Text bold>Health  </Text>
              <Text {...toneProps(theme, 'success')}>{h.ok} ok</Text>
              <Text dimColor> · </Text>
              <Text {...toneProps(theme, h.warn ? 'warning' : 'dim')}>{h.warn} warnings</Text>
              <Text dimColor> · </Text>
              <Text {...toneProps(theme, h.fail ? 'error' : 'dim')}>{h.fail} failing</Text>
            </Text>
            {h.problems.slice(0, problemsShown).map((c) => {
              const l = checkLine(c, checkNameWidth(h.problems.slice(0, problemsShown)));
              return (
                <Text key={c.name} wrap="truncate" {...toneProps(theme, l.tone)}>
                  {'  '}
                  {l.text}
                </Text>
              );
            })}
          </Box>
        )}
        <SelectList items={menu.map((a) => ({ id: a.id, key: a.key, label: a.label, ...(a.hint ? { hint: a.hint } : {}) }))} onSelect={onAction} />
        {error && <ErrorNotice message={error} />}
      </Box>
    </Frame>
  );
}
