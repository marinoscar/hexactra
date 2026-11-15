import { APP_NAME, THEME_COLOR } from '@app/shared';
import { ThemeProvider } from '@mui/material/styles';
import { render, screen } from '@testing-library/react';

import { BrandLogo } from '../components/BrandLogo';
import { APP_THEMES, BRAND } from '../theme';

// The hexactra brand (docs/brand/README.md): one palette in light and dark,
// and the Trace mark with the lowercase wordmark in the app bar.
describe('the hexactra brand', () => {
  it('builds the light theme from identity.json and the brand tokens', () => {
    const { palette } = APP_THEMES.light;
    expect(palette.primary.main).toBe(THEME_COLOR);
    expect(palette.secondary.main).toBe(BRAND.light.accent);
    expect(palette.background.paper).toBe(BRAND.light.surface);
    expect(palette.text.primary).toBe(BRAND.light.text);
  });

  it('builds the dark theme from the dark tokens', () => {
    const { palette } = APP_THEMES.dark;
    expect(palette.mode).toBe('dark');
    expect(palette.primary.main).toBe(BRAND.dark.primary);
    expect(palette.secondary.main).toBe(BRAND.dark.accent);
    expect(palette.background.default).toBe(BRAND.dark.background);
  });

  it('sets headings in the display face', () => {
    expect(APP_THEMES.light.typography.h4.fontFamily).toContain('Space Grotesk');
  });

  it('renders the mark and the lowercase wordmark, named by the product name', () => {
    render(
      <ThemeProvider theme={APP_THEMES.light}>
        <BrandLogo label={APP_NAME} />
      </ThemeProvider>,
    );
    const logo = screen.getByRole('img', { name: APP_NAME });
    expect(logo).toHaveTextContent('hexactra');
    expect(logo.textContent).toBe(logo.textContent?.toLowerCase());
    expect(logo.querySelector('path')?.getAttribute('stroke')).toBe(THEME_COLOR);
  });
});
