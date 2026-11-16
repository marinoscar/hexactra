import type { TuiMenuSlotContext, TuiMenuSlots, TuiThemeOverrides } from '@marinoscar/platform-cli/tui';

import { TRACE_MARK } from './brand-mark.js';
import { ROOT_MENU_FOOTNOTE } from './menu.js';

/**
 * The hexactra brand in the terminal (docs/brand/README.md). Terminals are
 * mostly dark, so the TUI takes the brand's dark-scheme tokens: the indigo
 * `#8C8CFF` and the coral `#FF8A6E`, both readable on a black background.
 * Status colours stay the terminal's named green, yellow and red, which every
 * palette tunes for legibility. Plain data only: no ink at import (the `tui`
 * conformance suite checks it).
 */
export const BRAND_COLORS = {
  primary: '#8c8cff',
  primaryLight: '#b3b3ff',
  accent: '#ff8a6e',
} as const;

/** The TUI theme overrides: `createCli({ tuiTheme })`. Colour still turns off under `NO_COLOR` and `--no-color`. */
export const BRAND_TUI_THEME: TuiThemeOverrides = {
  primary: BRAND_COLORS.primary,
  accent: BRAND_COLORS.accent,
  banner: BRAND_COLORS.primary,
  info: BRAND_COLORS.primaryLight,
  brand: [BRAND_COLORS.primary, BRAND_COLORS.accent],
};

export const WORDMARK = 'hexactra';
export const TAGLINE = ['AI agents that operate real browsers,', 'the way a person does.'] as const;

/** Terminal widths (columns) at which the banner changes form. */
export const BANNER_BREAKPOINTS = { full: 60, compact: 26 } as const;

const pad = (lines: readonly string[]) => {
  const width = Math.max(...lines.map((line) => line.length));
  return lines.map((line) => line.padEnd(width, ' '));
};

/**
 * The banner for a terminal `columns` wide:
 * - full (60+): the large Trace mark beside the wordmark and the tagline;
 * - compact (26+): the small mark beside the wordmark;
 * - narrow: one line.
 */
export function brandBanner(columns: number): string[] {
  if (columns >= BANNER_BREAKPOINTS.full) {
    const mark = pad(TRACE_MARK.large);
    const text = ['', '', WORDMARK, TAGLINE[0], TAGLINE[1]];
    return mark.map((line, i) => `${line}   ${text[i] ?? ''}`.trimEnd());
  }
  if (columns >= BANNER_BREAKPOINTS.compact) {
    const mark = pad(TRACE_MARK.small);
    const middle = Math.floor(mark.length / 2);
    return mark.map((line, i) => (i === middle ? `${line}  ${WORDMARK}` : line).trimEnd());
  }
  return [`⬡ ${WORDMARK}`];
}

/** The TUI root menu's banner, and the logged-out footnote (#357): `createCli({ tuiMenuRoot })`. */
export const BRAND_TUI_MENU_ROOT: TuiMenuSlots = {
  banner: { content: ({ columns }: TuiMenuSlotContext) => brandBanner(columns), color: 'banner' },
  footnote: ROOT_MENU_FOOTNOTE,
};

// --- `hexactra --help` --------------------------------------------------------

/** Whether `argv` (arguments only) asks for the top-level help, not a command's. */
export function isTopLevelHelp(argv: readonly string[]): boolean {
  const args = argv.filter((arg) => arg !== '--no-color');
  return args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help');
}

/** What decides whether the help banner is coloured. */
export interface BannerOutput {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

/** Colour on only for a terminal, never under `NO_COLOR`, `--no-color` or `TERM=dumb` (as the TUI decides). */
export function bannerColorEnabled(output: BannerOutput, env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  if (!output.isTTY) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb' || argv.includes('--no-color')) return false;
  return true;
}

const hex = (value: string) => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));

/** `text` in a brand colour: 24-bit where the terminal says it supports it, else the nearest of the 256 colours. */
function paint(text: string, color: string, env: NodeJS.ProcessEnv, bold = false): string {
  const [r, g, b] = hex(color) as [number, number, number];
  const trueColor = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit';
  const fg = trueColor ? `38;2;${r};${g};${b}` : `38;5;${16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)}`;
  return `\u001b[${bold ? '1;' : ''}${fg}m${text}\u001b[0m`;
}

/**
 * The banner printed above `hexactra --help`, ending with a blank line. Plain
 * text when piped or with colour off; the mark in indigo and the wordmark in
 * bold otherwise.
 */
export function helpBanner(output: BannerOutput, env: NodeJS.ProcessEnv, argv: readonly string[]): string {
  const lines = brandBanner(output.columns ?? 80);
  if (!bannerColorEnabled(output, env, argv)) return `${lines.join('\n')}\n\n`;
  const colored = lines.map((line) =>
    line
      .replace(/^([⠀-⣿⬡ ]+)/, (mark) => paint(mark, BRAND_COLORS.primary, env))
      .replace(WORDMARK, paint(WORDMARK, BRAND_COLORS.primary, env, true)),
  );
  return `${colored.join('\n')}\n\n`;
}
