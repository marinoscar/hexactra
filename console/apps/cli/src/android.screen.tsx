import { androidTuiScreen } from '@marinoscar/platform-cli/android';
import { textColor, useTuiTheme, type TuiScreenProps } from '@marinoscar/platform-cli/tui';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';

import { applyAndroidCheckout, missingDependenciesMessage, nestedCheckoutNote, noCheckoutMessage } from './android-checkout.js';

/** What the folder check found, as the notice to show before the platform's screen (#478). */
export function androidScreenNotice(ctx: Parameters<typeof applyAndroidCheckout>[0] = {}): { problem?: string; note?: string } {
  const checkout = applyAndroidCheckout(ctx);
  if (checkout.root === undefined) return { problem: noCheckoutMessage(checkout, ctx.cwd ?? process.cwd()) };
  const problem = missingDependenciesMessage(checkout.root, ctx);
  return {
    ...(problem !== undefined ? { problem } : {}),
    ...(checkout.nested && !checkout.explicit ? { note: nestedCheckoutNote(checkout.root) } : {}),
  };
}

/**
 * The platform's Android screen behind the folder check: a wrong folder or a
 * checkout without its dependencies is said first, because a release would
 * otherwise bump the version and fail a minute into Gradle. Enter goes on (the
 * releases list and the keystore need no checkout); Esc returns to the menu.
 */
export function AndroidGateScreen(props: TuiScreenProps): ReactNode {
  const theme = useTuiTheme();
  // Before the platform's screen mounts: it reads the checkout once, on mount.
  const [notice] = useState(() => androidScreenNotice());
  const [accepted, setAccepted] = useState(notice.problem === undefined);
  const [Screen, setScreen] = useState<ComponentType<TuiScreenProps> | null>(null);

  useEffect(() => {
    let mounted = true;
    void androidTuiScreen.load?.().then((loaded) => {
      if (mounted) setScreen(() => loaded);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useInput(
    (_input, key) => {
      if (key.escape) props.onDone();
      else if (key.return) setAccepted(true);
    },
    { isActive: !accepted },
  );

  if (!accepted) {
    return (
      <Box flexDirection="column">
        <Text bold {...textColor(theme.warning)}>
          Android app: this folder is not ready to build
        </Text>
        <Text>{notice.problem}</Text>
        <Text dimColor>enter continue anyway · esc back</Text>
      </Box>
    );
  }
  if (Screen === null) return <Text dimColor>Loading…</Text>;
  return (
    <Box flexDirection="column">
      {notice.note !== undefined ? <Text dimColor>{notice.note}</Text> : null}
      <Screen {...props} />
    </Box>
  );
}
