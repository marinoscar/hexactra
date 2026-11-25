// "This profile is not signed in to Google" (E48.5, #931): the one link builder, which machine and profile a warning
// names, the chat's machine picker, and a takeover's question card linking to the guided sign-in.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ChatOptions } from '../components/ChatOptions';
import { profileNeedingSignin, signinHref } from '../components/ProfileSigninWarning';
import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import type { AskedQuestion } from '../components/questions';
import type { FleetHost, FleetSigninState } from '../types/fleet';
import { POLICY_READS } from './policyFixtures';

const HOME = '55555555-5555-4555-8555-555555555555';
const CLOUD = '66666666-6666-4666-8666-666666666667';
const profile = (name: string, signin: FleetSigninState) => ({ name, running: false, signin, accounts: [], checkedAt: null });
const host = (id: string, name: string, profiles: FleetHost['profiles'], over: Partial<FleetHost> = {}): FleetHost => ({
  id,
  name,
  version: '1.0.0',
  online: true,
  browserConnected: true,
  onDemand: true,
  draining: false,
  viewerUrl: null,
  mode: 'unattended',
  desktop: true,
  profiles,
  lastSeen: '2026-11-25T00:00:00Z',
  ...over,
});

describe('the sign-in link and which profile needs it', () => {
  it('builds the guided sign-in link in one place', () => {
    expect(signinHref(HOME, 'work')).toBe(`/fleet/hosts/${HOME}/desktop?profile=work&signin=1`);
  });

  it('the chosen machine, or every online machine with the profile; unknown and signed in never', () => {
    const hosts = [host(HOME, 'home', [profile('default', 'signed_out'), profile('work', 'unknown')]), host(CLOUD, 'cloud', [profile('default', 'signed_in'), profile('shop', 'expired')])];
    expect(profileNeedingSignin(hosts, HOME, 'default')).toMatchObject({ host: { id: HOME }, profile: 'default', state: 'signed_out' });
    expect(profileNeedingSignin(hosts, HOME, 'work')).toBeNull();
    expect(profileNeedingSignin(hosts, CLOUD, 'default')).toBeNull();
    // Any machine: cloud has "default" signed in, so a run can still get a signed-in browser.
    expect(profileNeedingSignin(hosts, null, 'default')).toBeNull();
    expect(profileNeedingSignin(hosts, null, 'shop')).toMatchObject({ host: { id: CLOUD }, state: 'expired' });
    // An offline machine is not a candidate for "any machine".
    expect(profileNeedingSignin([host(HOME, 'home', [profile('default', 'signed_out')], { online: false })], null, 'default')).toBeNull();
    expect(profileNeedingSignin([], null, 'default')).toBeNull();
  });
});

describe('the chat host picker', () => {
  function mount(hosts: FleetHost[], props: Partial<Parameters<typeof ChatOptions>[0]> = {}, permissions = ['fleet:read', 'agent_policies:read']) {
    const platform = createTestPlatformHost({ permissions, responses: { ...POLICY_READS, 'GET /fleet/hosts': hosts } });
    render(
      <PlatformHostProvider host={platform}>
        <MemoryRouter>
          <ChatOptions policyId={null} hostId={HOME} hostFallback onChange={vi.fn()} {...props} />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
  }

  it("warns when the chat's profile is not signed in to Google on its machine, with a Sign in link", async () => {
    mount([host(HOME, 'home-pc', [profile('default', 'signed_in'), profile('work', 'signed_out')])], { profile: 'work' });
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    const warning = await screen.findByTestId('profile-signin-warning');
    expect(warning).toHaveTextContent('This profile is not signed in to Google');
    expect(within(warning).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/fleet/hosts/${HOME}/desktop?profile=work&signin=1`);
    // The machine list shows it too.
    fireEvent.click(screen.getByRole('button', { name: /Machine/ }));
    expect(await screen.findByTestId('profile-signin-warning')).toBeInTheDocument();
  });

  it('says nothing for a signed-in profile', async () => {
    mount([host(HOME, 'home-pc', [profile('default', 'signed_in')])]);
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    await screen.findByRole('button', { name: /Machine/ });
    expect(screen.queryByTestId('profile-signin-warning')).not.toBeInTheDocument();
  });

  it('without fleet:read the fleet is not read, so nothing shows', async () => {
    mount([host(HOME, 'home-pc', [profile('default', 'signed_out')])], {}, ['agent_policies:read']);
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    await screen.findByRole('button', { name: /Machine/ });
    expect(screen.queryByTestId('profile-signin-warning')).not.toBeInTheDocument();
  });
});

describe('a takeover on Google\'s sign-in page', () => {
  const base: AskedQuestion = { kind: 'login', input: 'takeover', options: null, constraints: null, confirmLabel: null, denyLabel: null, risk: null, viewerUrl: null };
  const mount = (q: Partial<AskedQuestion>) =>
    render(
      <MemoryRouter>
        <QuestionAnswerForm question={{ ...base, ...q }} onSubmit={vi.fn()} />
      </MemoryRouter>,
    );

  it("the question card links to the guided sign-in of the run's machine and profile", () => {
    mount({ signin: { hostId: HOME, profile: 'work' } });
    const line = screen.getByTestId('question-signin-link');
    expect(within(line).getByRole('link', { name: /Sign in “work” to Google/ })).toHaveAttribute('href', `/fleet/hosts/${HOME}/desktop?profile=work&signin=1`);
    // Done still answers the takeover as before.
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('any other takeover has no such link', () => {
    mount({ signin: null });
    expect(screen.queryByTestId('question-signin-link')).not.toBeInTheDocument();
  });
});
