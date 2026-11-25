// The Fleet page's per-profile Google sign-in status (E48.3, #929).
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  ATTENDED_HINT,
  NO_DESKTOP_ACCESS_HINT,
  NO_DESKTOP_HINT,
  ProfileSigninStatus,
  signinAction,
  signinNeededCount,
  signinNeededLabel,
} from '../components/fleet/ProfileSigninStatus';
import { FleetPage } from '../pages/FleetPage';
import type { FleetHost, FleetProfile } from '../types/fleet';
import { ConfirmProvider } from '../ui';

const LONG_EMAIL = 'a.very.long.address.for.the.owner.of.this.machine.with.many.parts@subdomain.example-company.test';
const CHECKED = new Date(Date.now() - 5 * 60_000).toISOString();

const profile = (name: string, signin: FleetProfile['signin'], email?: string): FleetProfile => ({
  name,
  running: false,
  signin,
  accounts: email ? [{ provider: 'google', email, state: signin }] : [],
  checkedAt: signin === 'unknown' ? null : CHECKED,
});

const node: FleetHost = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'mini-pc',
  version: '1.0.0',
  online: true,
  browserConnected: true,
  onDemand: true,
  draining: false,
  viewerUrl: null,
  mode: 'unattended',
  desktop: true,
  profiles: [
    profile('default', 'signed_in', LONG_EMAIL),
    profile('work', 'signed_out'),
    profile('shop', 'expired', 'shop.owner@example.test'),
    profile('new', 'unknown'),
  ],
  lastSeen: '2026-11-25T10:00:00Z',
};
const attended: FleetHost = { ...node, id: '33333333-3333-4333-8333-333333333333', name: 'laptop', mode: 'attended', desktop: false, profiles: [profile('default', 'signed_out')] };
const browserOnly: FleetHost = { ...node, id: '44444444-4444-4444-8444-444444444444', name: 'vps', desktop: false, profiles: [profile('default', 'expired', 'vps@example.test')] };
const healthy: FleetHost = { ...node, id: '55555555-5555-4555-8555-555555555555', name: 'all-good', profiles: [profile('default', 'signed_in', 'ok@example.test')] };

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

function renderPage(permissions: string[], hosts: FleetHost[]) {
  const host = createTestPlatformHost({ permissions, responses: { 'GET /fleet/hosts': hosts } });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/fleet']}>
          <Routes>
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

const rowOf = (card: HTMLElement, name: string) => within(card).getByText(name, { selector: 'p' }).closest('li') as HTMLElement;

describe('Fleet sign-in status (E48.3)', () => {
  it('renders each state with its chip text, the full email and a "checked" tooltip', async () => {
    renderPage(['fleet:read'], [node]);
    const card = await screen.findByLabelText('Host mini-pc');

    const signedIn = rowOf(card, 'default');
    expect(within(signedIn).getByText('Signed in')).toBeInTheDocument();
    expect(within(signedIn).getByText('Signed in').closest('[data-signin]')).toHaveAttribute('data-signin', 'signed_in');
    expect(within(signedIn).getByText('Signed in').closest('.MuiChip-root')).toHaveClass('MuiChip-colorSuccess');
    // The full email, never masked; it wraps anywhere so a long one cannot overflow a phone.
    const email = within(signedIn).getByText(`Signed in as ${LONG_EMAIL}`);
    expect(email).toHaveStyle({ overflowWrap: 'anywhere' });

    const out = rowOf(card, 'work');
    expect(within(out).getByText('Not signed in to Google').closest('.MuiChip-root')).toHaveClass('MuiChip-colorWarning');

    const expired = rowOf(card, 'shop');
    expect(within(expired).getByText('Google session expired').closest('.MuiChip-root')).toHaveClass('MuiChip-colorWarning');
    expect(within(expired).getByText('Last signed in as shop.owner@example.test')).toBeInTheDocument();

    const unknown = rowOf(card, 'new');
    expect(within(unknown).getByText('Sign-in not checked').closest('.MuiChip-root')).toHaveClass('MuiChip-colorDefault');

    // Chips carry an icon and words, not colour only.
    for (const row of [signedIn, out, expired, unknown]) expect(row.querySelector('.MuiChip-icon')).not.toBeNull();

    fireEvent.mouseOver(within(signedIn).getByText('Signed in'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('checked 5 min ago');
  });

  it('says "never checked" for a profile the node has not checked', async () => {
    renderPage(['fleet:read'], [node]);
    const card = await screen.findByLabelText('Host mini-pc');
    fireEvent.mouseOver(within(rowOf(card, 'new')).getByText('Sign-in not checked'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('never checked');
  });

  it('counts the profiles that need sign-in on each host card (singular for one, nothing for none)', async () => {
    renderPage(['fleet:read'], [node, attended, healthy]);
    const card = await screen.findByLabelText('Host mini-pc');
    expect(within(card).getByTestId('host-signin-needed')).toHaveTextContent('2 profiles need sign-in');
    expect(within(screen.getByLabelText('Host laptop')).getByTestId('host-signin-needed')).toHaveTextContent('1 profile needs sign-in');
    expect(within(screen.getByLabelText('Host all-good')).queryByTestId('host-signin-needed')).toBeNull();
    expect(signinNeededCount(node)).toBe(2);
    expect(signinNeededLabel(1)).toBe('1 profile needs sign-in');
    expect(signinNeededLabel(4)).toBe('4 profiles need sign-in');
  });

  it('filters to the hosts and profiles that need sign-in', async () => {
    renderPage(['fleet:read'], [node, attended, healthy]);
    await screen.findByLabelText('Host mini-pc');
    const filter = screen.getByRole('button', { name: 'Needs sign-in (3)' });
    expect(filter).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(filter);
    expect(filter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Host all-good')).not.toBeInTheDocument();
    const card = screen.getByLabelText('Host mini-pc');
    expect(within(within(card).getByRole('list', { name: 'Profiles on mini-pc' })).getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).queryByText(`Signed in as ${LONG_EMAIL}`)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Host laptop')).toBeInTheDocument();
    fireEvent.click(filter);
    expect(screen.getByLabelText('Host all-good')).toBeInTheDocument();
  });

  it('says so when the filter matches nothing', async () => {
    renderPage(['fleet:read'], [healthy]);
    fireEvent.click(await screen.findByRole('button', { name: 'Needs sign-in (0)' }));
    expect(screen.getByText('Every profile is signed in or not yet checked.')).toBeInTheDocument();
  });

  it('offers Sign in only on an unattended host with a desktop, for fleet:desktop, opening the desktop with the profile preselected', async () => {
    renderPage(['fleet:read', 'fleet:desktop'], [node, attended, browserOnly]);
    const card = await screen.findByLabelText('Host mini-pc');
    // Only the profiles that need sign-in carry the button.
    expect(within(card).getAllByRole('button', { name: /^Sign in / })).toHaveLength(2);
    expect(within(rowOf(card, 'default')).queryByRole('button', { name: /^Sign in / })).toBeNull();
    expect(within(rowOf(card, 'new')).queryByRole('button', { name: /^Sign in / })).toBeNull();
    // Attended and browser-only hosts show their hint instead.
    const laptop = screen.getByLabelText('Host laptop');
    expect(within(laptop).queryByRole('button', { name: /^Sign in / })).toBeNull();
    expect(within(laptop).getByText(ATTENDED_HINT)).toBeInTheDocument();
    const vps = screen.getByLabelText('Host vps');
    expect(within(vps).queryByRole('button', { name: /^Sign in / })).toBeNull();
    expect(within(vps).getByText(NO_DESKTOP_HINT)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Sign in work on mini-pc' }));
    expect(await screen.findByTestId('where')).toHaveTextContent(`/fleet/hosts/${node.id}/desktop?profile=work&signin=1`);
  });

  it('shows no Sign in button without fleet:desktop', async () => {
    renderPage(['fleet:read'], [node]);
    const card = await screen.findByLabelText('Host mini-pc');
    expect(within(card).queryByRole('button', { name: /^Sign in / })).toBeNull();
    expect(within(card).getAllByText(NO_DESKTOP_ACCESS_HINT)).toHaveLength(2);
  });

  it('keeps an offline host\'s last known status, greyed, "as of" its last contact, with Sign in disabled', async () => {
    renderPage(['fleet:read', 'fleet:desktop'], [{ ...node, online: false }]);
    const card = await screen.findByLabelText('Host mini-pc');
    expect(within(card).getByText(/^Sign-in status as of /)).toBeInTheDocument();
    expect(within(card).getByRole('list', { name: 'Profiles on mini-pc' })).toHaveStyle({ opacity: '0.6' });
    expect(within(card).getByText('Not signed in to Google')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Sign in work on mini-pc' })).toBeDisabled();
  });

  it('decides the action from the mode, the desktop and the permission', () => {
    expect(signinAction({ mode: 'unattended', desktop: true }, true)).toEqual({ kind: 'button' });
    expect(signinAction({ mode: 'unattended', desktop: true }, false)).toEqual({ kind: 'hint', text: NO_DESKTOP_ACCESS_HINT });
    expect(signinAction({ mode: 'unattended', desktop: false }, true)).toEqual({ kind: 'hint', text: NO_DESKTOP_HINT });
    expect(signinAction({ mode: 'attended', desktop: true }, true)).toEqual({ kind: 'hint', text: ATTENDED_HINT });
    expect(signinAction({ mode: null, desktop: false }, true)).toEqual({ kind: 'hint', text: NO_DESKTOP_HINT });
  });

  it('calls the action it is given, so E48.4 can rewire it', () => {
    const onSignIn = vi.fn();
    const p = profile('work', 'signed_out');
    render(<ProfileSigninStatus host={node} profile={p} canDesktop onSignIn={onSignIn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in work on mini-pc' }));
    expect(onSignIn).toHaveBeenCalledWith(p);
  });
});
