// "Signed in with: Shop login" on the run page (E37.3, #592): the saved logins a run used, by name and site.
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { UsedSavedLogins } from '../pages/RunDetailPage';

vi.mock('../live', () => ({ fetchRunScreenshot: async () => null }));

describe('a run says which saved logins it used (E37.3)', () => {
  it('"Signed in with: …" names each login and its site, and nothing else', () => {
    render(
      <UsedSavedLogins
        logins={[
          { provider: 'vault', itemName: 'Shop login', origin: 'https://shop.example.test', at: '2030-01-01T00:00:00Z' },
          { provider: 'vault', itemName: 'Work login', origin: 'https://work.example.test:8443', at: '2030-01-01T00:01:00Z' },
        ]}
      />,
    );
    expect(screen.getByTestId('used-saved-logins')).toHaveTextContent('Signed in with: Shop login (shop.example.test), Work login (work.example.test:8443)');
  });

  it('renders nothing for a run that used none', () => {
    const { container } = render(<UsedSavedLogins logins={[]} />);
    expect(container).toBeEmptyDOMElement();
    const missing = render(<UsedSavedLogins logins={undefined} />);
    expect(missing.container).toBeEmptyDOMElement();
  });
});
