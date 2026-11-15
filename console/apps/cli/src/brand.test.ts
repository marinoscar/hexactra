import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { getTuiRootMenuSlots, resolveTuiTheme, resolveTuiMenuSlot } from '@marinoscar/platform-cli/tui';
import { describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { BRAND_COLORS, TAGLINE, WORDMARK, brandBanner, helpBanner, isTopLevelHelp } from './brand.js';
import { TRACE_MARK } from './brand-mark.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

// The hexactra brand in the terminal (docs/brand/README.md, issue #295).
describe('the TUI theme', () => {
  it('draws with the brand colours', () => {
    const theme = resolveTuiTheme({ env: {}, noColor: false });
    expect(theme.primary).toBe(BRAND_COLORS.primary);
    expect(theme.accent).toBe(BRAND_COLORS.accent);
    expect(theme.banner).toBe(BRAND_COLORS.primary);
    expect(theme.brand).toEqual([BRAND_COLORS.primary, BRAND_COLORS.accent]);
  });

  it('turns colour off under NO_COLOR and --no-color', () => {
    expect(resolveTuiTheme({ env: { NO_COLOR: '1' } }).primary).toBeUndefined();
    expect(resolveTuiTheme({ env: {}, noColor: true }).banner).toBeUndefined();
  });
});

describe('the banner', () => {
  it('is the root menu banner', () => {
    const slot = getTuiRootMenuSlots().banner;
    expect(slot).toBeDefined();
    const lines = resolveTuiMenuSlot(slot, { loggedIn: false, columns: 80, sectionId: 'root', state: {} });
    expect(lines.join('\n')).toContain(WORDMARK);
  });

  it.each([120, 80, 60, 40, 26, 24, 12])('fits a %i-column terminal', (columns) => {
    for (const line of brandBanner(columns)) expect(line.length).toBeLessThanOrEqual(columns);
  });

  it('shows the large mark, the wordmark and the tagline when there is room', () => {
    const text = brandBanner(80).join('\n');
    expect(text).toContain(TRACE_MARK.large[0]!.trimEnd());
    expect(text).toContain(WORDMARK);
    expect(text).toContain(TAGLINE[0]);
  });

  it('falls back to the small mark, then to one line', () => {
    expect(brandBanner(40).join('\n')).toContain(TRACE_MARK.small[1]!.trimEnd());
    expect(brandBanner(24)).toEqual([`⬡ ${WORDMARK}`]);
  });

  it('writes the wordmark in lowercase only', () => {
    expect(brandBanner(80).join('\n')).not.toMatch(/Hexactra|HEXACTRA/);
  });
});

describe('the help banner', () => {
  it('prefixes only the top-level help', () => {
    expect(isTopLevelHelp(['--help'])).toBe(true);
    expect(isTopLevelHelp(['-h'])).toBe(true);
    expect(isTopLevelHelp(['help', '--no-color'])).toBe(true);
    expect(isTopLevelHelp(['runs', '--help'])).toBe(false);
    expect(isTopLevelHelp([])).toBe(false);
  });

  it('is plain text when piped or with colour off', () => {
    const esc = '\u001b[';
    expect(helpBanner({ isTTY: false, columns: 80 }, {}, ['--help'])).not.toContain(esc);
    expect(helpBanner({ isTTY: true, columns: 80 }, { NO_COLOR: '1' }, ['--help'])).not.toContain(esc);
    expect(helpBanner({ isTTY: true, columns: 80 }, {}, ['--help', '--no-color'])).not.toContain(esc);
  });

  it('paints the mark and the wordmark in the brand indigo on a terminal', () => {
    const truecolor = helpBanner({ isTTY: true, columns: 80 }, { COLORTERM: 'truecolor' }, ['--help']);
    expect(truecolor).toContain('\u001b[38;2;140;140;255m');
    expect(truecolor).toContain('\u001b[1;38;2;140;140;255mhexactra');
    const indexed = helpBanner({ isTTY: true, columns: 80 }, {}, ['--help']);
    expect(indexed).toMatch(/\u001b\[38;5;\d+m/);
  });
});
