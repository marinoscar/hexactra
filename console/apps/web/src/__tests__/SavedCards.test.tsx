// Payment cards (E37.7, #596) in the web app: the approval card with its required amount limit, the sub-switch of saved logins on
// the task form, the Secrets page (the consent, "Check a shop", the shops Hexactra remembers), the run page's payment lines and the
// card rule on the Saved approvals words. No value of a card is ever on a page: only a brand, the last four digits and amounts.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import type { AskedQuestion, Rememberable } from '../components/questions';
import { amountError, NO_REMEMBER, rememberRuleOf } from '../components/RememberRuleField';
import { UsedSavedCards, cardWords } from '../components/UsedSavedCards';
import { cardCurrency, categoryLabel, limitsText, type ApprovalRule } from '../approvals/types';
import { SecretsSettingsPage } from '../pages/SecretsSettingsPage';
import { TaskCreatePage } from '../pages/TaskCreatePage';
import { cardsReason, hasCardScopes } from '../secrets/useSavedLoginsAvailability';
import { hasCardsScope, outcomeWords, permissionWords, whatWords } from '../secrets/words';
import type { CardListing, SecretsStatus, VaultStatus } from '../secrets/api';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const CARD_SCOPES = ['vault:items_read', 'vault:items_fill', 'vault:cards_read', 'vault:cards_fill'];
const VAULT: VaultStatus = {
  provider: 'vault', status: 'connected', configured: true, source: 'user', baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true, redirectUri: 'x', scopes: ['vault:items_read', 'vault:items_fill'], vaultUserId: 'v1', agentAccess: 'on', connectedAt: null, lastUsedAt: null, lastSuccessAt: null, lastErrorCode: null, connecting: false,
};
const status = (scopes: string[] = VAULT.scopes): SecretsStatus => ({ agentUse: { deployment: true, user: true, effective: true }, providers: { vault: { ...VAULT, scopes } } });
const PERMS = ['tasks:read', 'tasks:write', 'runs:write', 'agent_policies:read', 'secrets:read', 'secrets:write', 'approvals:read'];
const NEW_ID = '55555555-5555-4555-8555-555555555555';

afterEach(() => {
  dismissToast();
  cleanup();
});

const CARD_Q: Rememberable = { kind: 'gate', host: 'example.com', category: 'payment', matchKey: 'saved card usd', summary: 'Pay with Visa ending 4242 on example.com', scopes: ['everywhere', 'this_chat'], requiresLimit: true, currency: 'USD', amount: '42.50' };
const base: AskedQuestion = { kind: 'confirmation', input: 'confirm', options: null, constraints: null, confirmLabel: 'Allow this payment', denyLabel: 'Do not pay', risk: 'low', viewerUrl: null };

function setupQuestion(q: Partial<AskedQuestion> = {}) {
  const onSubmit = vi.fn();
  render(<QuestionAnswerForm question={{ ...base, rememberable: CARD_Q, ...q }} onSubmit={onSubmit} />);
  return onSubmit;
}

describe('the approval card for a card', () => {
  it('"Don\'t ask again" is off by default and Allow this payment sends a plain approval', () => {
    const onSubmit = setupQuestion();
    expect(screen.getByRole('checkbox', { name: "Don't ask again: Pay with Visa ending 4242 on example.com" })).not.toBeChecked();
    expect(screen.queryByTestId('card-limit')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow this payment' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'approve' });
  });

  it('ticked: the limit is REQUIRED, shown at once (not hidden under "Limit it"), in the currency, and the approval waits for it', () => {
    const onSubmit = setupQuestion();
    fireEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    const limit = screen.getByTestId('card-limit');
    expect(screen.getByLabelText(/Pay without asking up to \(USD\)/)).toBe(limit);
    expect(limit).toBeRequired();
    expect(screen.getByText(/The agent will pay this shop with this card, up to the limit, without asking/)).toBeInTheDocument();
    // Empty: refused in words, the approval is held.
    expect(screen.getByText('A limit is required for a card: enter the most it may pay without asking')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow this payment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Do not pay' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'completed', value: 'deny' });
    // A bad amount is refused too; a good one is sent.
    fireEvent.change(limit, { target: { value: 'lots' } });
    expect(screen.getByText('Enter an amount, like 50 or 49.99')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow this payment' })).toBeDisabled();
    fireEvent.change(limit, { target: { value: '100' } });
    expect(screen.getByRole('button', { name: 'Allow this payment' })).toBeEnabled();
    expect(limit).toHaveAccessibleDescription(/Required for a card.*This purchase is 42.50 USD/);
  });

  it('sends the limit with the rule, and the optional scope and duration under "Limit it"', () => {
    const onSubmit = setupQuestion();
    fireEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    fireEvent.change(screen.getByTestId('card-limit'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Limit it' }));
    // The optional amount field of other approvals is not shown twice.
    expect(screen.queryByLabelText(/Up to an amount \(optional\)/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Only in this chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow this payment' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'approve', rememberRule: { enabled: true, scope: 'this_chat', maxAmount: 100 } });
  });

  it('the rule body of a card needs the limit, and other approvals still do not', () => {
    const ticked = { ...NO_REMEMBER, ticked: true };
    expect(rememberRuleOf(CARD_Q, ticked)).toBeUndefined();
    expect(rememberRuleOf(CARD_Q, { ...ticked, amount: '75.5' })).toEqual({ enabled: true, maxAmount: 75.5 });
    expect(amountError('', true)).toMatch(/required for a card/);
    expect(amountError('', false)).toBeNull();
    expect(rememberRuleOf({ ...CARD_Q, requiresLimit: undefined }, ticked)).toEqual({ enabled: true });
  });
});

describe('the words', () => {
  it('reads the grant and the card fields in plain words, with the amount and the frame', () => {
    expect(hasCardsScope(CARD_SCOPES)).toBe(true);
    expect(hasCardsScope(['vault:cards_read'])).toBe(false);
    expect(hasCardScopes(CARD_SCOPES)).toBe(true);
    expect(cardsReason(status())).toMatch(/Allow .Let the agent pay with a saved card. on the Secrets page first/);
    expect(cardsReason(status(CARD_SCOPES))).toBeNull();
    expect(permissionWords(CARD_SCOPES)).toEqual(['Find your logins', 'Type them for you', 'See which cards you allowed at a shop', 'Pay with them for you, within your limits']);
    expect(whatWords({ event: 'release', field: 'number', matches: null, outcome: 'typed', amount: '42.50', currency: 'USD' })).toBe('Typed the card number for 42.50 USD');
    expect(whatWords({ event: 'release', field: 'security_code', matches: null, outcome: 'typed', amount: '42.50', currency: 'USD', frameSite: 'pay.processor.example.net' })).toBe('Typed the card security code for 42.50 USD in the payment frame of pay.processor.example.net');
    expect(whatWords({ event: 'release', field: 'password', matches: null, outcome: 'typed' })).toBe('Typed the password');
    for (const o of ['amount_exceeded', 'currency_mismatch', 'security_code_not_granted', 'grant_expired', 'limit_reached', 'cards_disabled', 'frame_unknown']) expect(outcomeWords(o)).toMatch(/^Refused/);
  });

  it('words a card rule: the chip, the limit with its currency', () => {
    const rule = { id: 'r1', kind: 'gate', host: 'example.com', category: 'payment', matchKey: 'saved card usd', cardRef: 'vault:card-1', maxAmount: 100, taskId: null, taskName: null, conversationId: null, expiresAt: null } as unknown as ApprovalRule;
    expect(categoryLabel(rule)).toBe('Card payment');
    expect(cardCurrency(rule)).toBe('USD');
    expect(limitsText(rule)).toBe('up to 100.00 USD');
    expect(limitsText({ ...rule, cardRef: null })).toBe('up to $100.00');
    expect(cardCurrency({ ...rule, cardRef: null })).toBeNull();
  });
});

describe('the run page lines', () => {
  const paid = { provider: 'vault', itemName: 'Everyday card', brand: 'visa', last4: '4242', merchant: 'checkout.shop.example.com', origin: 'https://checkout.shop.example.com', currency: 'USD', declaredAmount: '42.50', confirmedAmount: '42.50', mismatch: false, at: '2026-11-19T10:00:00.000Z' };

  it('says what was paid with, where and how much; the declared and the confirmed amount; nothing else of the card', () => {
    render(<UsedSavedCards cards={[paid]} />);
    const line = screen.getByTestId('used-saved-cards');
    expect(line).toHaveTextContent('Paid with Visa ending 4242 at checkout.shop.example.com: 42.50 USD (the confirmation page says 42.50 USD)');
    expect(screen.queryByTestId('card-mismatch')).not.toBeInTheDocument();
    expect(line.textContent).not.toMatch(/Everyday card|vault/);
    expect(cardWords({ brand: null, last4: null })).toBe('Card');
  });

  it('warns when the confirmed amount differs, and says when it was not read', () => {
    render(<UsedSavedCards cards={[{ ...paid, confirmedAmount: '49.99', mismatch: true }, { ...paid, merchant: 'other.example.net', confirmedAmount: null }]} />);
    const warn = screen.getByTestId('card-mismatch');
    expect(warn).toHaveTextContent('The amount charged at checkout.shop.example.com (49.99 USD) differs from the 42.50 USD the agent declared');
    expect(screen.getByTestId('used-saved-cards')).toHaveTextContent('Paid with Visa ending 4242 at other.example.net: 42.50 USD (the amount on the confirmation page was not read)');
  });

  it('renders nothing for a run that paid with none', () => {
    expect(render(<UsedSavedCards cards={[]} />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<UsedSavedCards cards={undefined} />).container).toBeEmptyDOMElement();
  });
});

function mountTaskForm(scopes: string[]) {
  const host = createTestPlatformHost({
    permissions: PERMS,
    responses: { ...POLICY_READS, 'GET /fleet/hosts': [], 'GET /secrets/status': status(scopes), 'GET /user-settings': {}, 'POST /tasks': { id: NEW_ID, name: 'Buy', goal: 'x', profile: 'default', hostFallback: true, allowedDomains: [], confirmRiskyActions: false, policyId: null } },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/tasks/new']}>
          <Routes>
            <Route path="/tasks/new" element={<TaskCreatePage />} />
            <Route path="/tasks/:id" element={<div>task page</div>} />
            <Route path="/tasks" element={<div>tasks list</div>} />
            <Route path="/settings/secrets" element={<div>secrets page</div>} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the task form', () => {
  it('has the card sub-switch under the saved-logins one: off, disabled with a reason until logins are on and the card permissions granted', async () => {
    mountTaskForm(['vault:items_read', 'vault:items_fill']);
    await screen.findByRole('form', { name: 'New task' });
    const logins = () => screen.getByRole('switch', { name: 'Use my saved logins and details' });
    const cards = () => screen.getByRole('switch', { name: 'Also pay with my saved cards' });
    await waitFor(() => expect(logins()).toBeEnabled());
    expect(cards()).toBeDisabled();
    expect(screen.getByTestId('saved-cards-help')).toHaveTextContent('Turn on saved logins first.');
    fireEvent.click(logins());
    await waitFor(() => expect(screen.getByTestId('saved-cards-help')).toHaveTextContent(/Allow .Let the agent pay with a saved card. on the Secrets page first/));
    expect(cards()).toBeDisabled();
    expect(cards()).not.toBeChecked();
  });

  it('with the permissions: the switch works, says what protects the owner, and the task is created with useSavedCards (and turning logins off turns it off)', async () => {
    const host = mountTaskForm(CARD_SCOPES);
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Buy' } });
    fireEvent.change(screen.getByLabelText(/^Goal/), { target: { value: 'Buy the books' } });
    const logins = () => screen.getByRole('switch', { name: 'Use my saved logins and details' });
    const cards = () => screen.getByRole('switch', { name: 'Also pay with my saved cards' });
    await waitFor(() => expect(logins()).toBeEnabled());
    fireEvent.click(logins());
    await waitFor(() => expect(cards()).toBeEnabled());
    expect(cards()).toHaveAccessibleDescription(/never sees the card number, the expiry or the code/);
    expect(cards()).toHaveAccessibleDescription(/You are asked the first time at each shop/);
    fireEvent.click(cards());
    expect(cards()).toBeChecked();
    fireEvent.click(logins());
    await waitFor(() => expect(cards()).toBeDisabled());
    fireEvent.click(logins());
    fireEvent.click(cards());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('task page');
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/tasks')!.body).toMatchObject({ useSavedLogins: true, useSavedCards: true });
  });
});

const GRANTED: CardListing = {
  available: true,
  reason: 'ok',
  merchant: 'https://shop.example.com',
  manageUrl: 'https://vault.example.test',
  cards: [
    { name: 'Everyday card', brand: 'visa', last4: '4242', expires: '09/2031', limit: { maxAmount: '500.00', currency: 'USD', includesSecurityCode: false, expiresAt: null } },
    { name: 'Virtual card', brand: 'mastercard', last4: '4444', expires: null, limit: { maxAmount: '20.00', currency: 'USD', includesSecurityCode: true, expiresAt: null } },
  ],
};
const RULE: ApprovalRule = { id: 'rule-1', kind: 'gate', host: 'example.com', category: 'payment', matchKey: 'saved card usd', summary: 'Pay with Visa ending 4242 on example.com', taskId: null, taskName: null, conversationId: null, maxAmount: 100, cardRef: 'vault:card-1', expiresAt: null, enabled: true, createdFromQuestionId: null, useCount: 2, lastUsedAt: null, lastUsedRunId: null, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z' };

function mountSecrets(scopes: string[], extra: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({
    permissions: PERMS,
    responses: {
      'GET /secrets/status': status(scopes),
      'GET /secrets/activity': { items: [{ id: 'a1', at: new Date().toISOString(), event: 'release', runId: null, site: 'checkout.shop.example.com', loginName: null, field: 'number', outcome: 'typed', refused: false, matches: null, amount: '42.50', currency: 'USD', frameSite: 'pay.processor.example.net' }], providerActivityUrl: null },
      'GET /secrets/reach': { listing: 'per_origin', items: [] },
      'GET /secrets/identity': { available: false, reason: 'needs_scope', items: [], manageUrl: null },
      'GET /secrets/cards': GRANTED,
      'GET /approval-rules': { paused: false, rules: [RULE, { ...RULE, id: 'rule-2', cardRef: null, matchKey: 'pay', summary: "Press 'Pay' on example.com" }] },
      'GET /secrets/store/status': undefined,
      'GET /user-settings': {},
      ...extra,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/settings/secrets']}>
          <Routes>
            <Route path="/settings/secrets" element={<SecretsSettingsPage />} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the Secrets page', () => {
  it('says the safest path first, what protects the owner, and lists the cards granted for a shop, read-only, linking to the provider', async () => {
    const host = mountSecrets(CARD_SCOPES);
    const section = await screen.findByTestId('cards-section');
    expect(within(section).getByText(/The safest way is no stored card at all/)).toBeInTheDocument();
    expect(within(section).getByText(/virtual card/)).toBeInTheDocument();
    expect(within(section).getByText(/not a payment service/)).toBeInTheDocument();
    fireEvent.change(within(section).getByLabelText('Shop to check'), { target: { value: 'shop.example.com' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Check' }));
    const result = await within(section).findByTestId('cards-result');
    await waitFor(() => expect(within(result).getByText('Everyday card')).toBeInTheDocument());
    expect(within(result).getByText('Visa · ending 4242 · expires 09/2031')).toBeInTheDocument();
    expect(within(result).getByText('Up to 500.00 USD')).toBeInTheDocument();
    expect(within(result).getByText('Security code allowed')).toBeInTheDocument();
    expect(within(result).getByText('No security code')).toBeInTheDocument();
    expect(within(result).getByRole('link', { name: /Manage Everyday card and its shops in Vault/ })).toHaveAttribute('href', 'https://vault.example.test');
    expect(host.requests.find((r) => r.method === 'GET' && r.path.startsWith('/secrets/cards'))!.path).toBe('/secrets/cards?merchant=shop.example.com');
    // Read-only: the only inputs are the shop to check.
    expect(within(result).queryByRole('textbox')).toBeNull();
    expect(within(result).queryByRole('button')).toBeNull();
  });

  it('lists the shops Hexactra remembers (the card rules only), linking to Saved approvals', async () => {
    mountSecrets(CARD_SCOPES);
    const section = await screen.findByTestId('cards-section');
    const list = await within(section).findByRole('list', { name: 'Remembered card approvals' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Pay with Visa ending 4242 on example.com')).toBeInTheDocument();
    expect(within(list).getByText(/up to 100.00 USD/)).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Open in Saved approvals' })).toHaveAttribute('href', '/settings/approvals#rule-rule-1');
  });

  it('says why there is no list: no permission, an empty shop, and a provider that is off', async () => {
    mountSecrets(['vault:items_read', 'vault:items_fill']);
    const section = await screen.findByTestId('cards-section');
    expect(within(section).getByText(/Turn on .Let the agent pay with a saved card. above to see which cards you allowed/)).toBeInTheDocument();
    expect(within(section).queryByLabelText('Shop to check')).toBeNull();
    cleanup();

    mountSecrets(CARD_SCOPES, { 'GET /secrets/cards': { available: true, reason: 'ok', merchant: 'https://nowhere.example.net', cards: [], manageUrl: null } });
    const s2 = await screen.findByTestId('cards-section');
    fireEvent.change(within(s2).getByLabelText('Shop to check'), { target: { value: 'nowhere.example.net' } });
    fireEvent.click(within(s2).getByRole('button', { name: 'Check' }));
    expect(await within(s2).findByText(/No card is allowed at nowhere.example.net/)).toBeInTheDocument();
    cleanup();

    mountSecrets(CARD_SCOPES, { 'GET /secrets/cards': { available: false, reason: 'provider_off', merchant: 'https://shop.example.com', cards: [], manageUrl: null } });
    const s3 = await screen.findByTestId('cards-section');
    fireEvent.change(within(s3).getByLabelText('Shop to check'), { target: { value: 'shop.example.com' } });
    fireEvent.click(within(s3).getByRole('button', { name: 'Check' }));
    expect(await within(s3).findByText(/Card payments are switched off in your provider/)).toBeInTheDocument();
  });

  it('the card switch starts a new consent with allowCards, keeping the write and identity permissions', async () => {
    const host = mountSecrets(['vault:items_read', 'vault:items_fill', 'vault:items_write', 'vault:identity_read', 'vault:identity_fill'], { 'POST /secrets/vault/connect': { authorizeUrl: 'https://vault.example.test/consent', expiresAt: 'x' } });
    const sw = await screen.findByRole('switch', { name: 'Let the agent pay with a saved card' });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).not.toBeChecked();
    expect(sw).toHaveAccessibleDescription(/never sees the number, the expiry or the code/);
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
    fireEvent.click(sw);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'POST' && r.path === '/secrets/vault/connect')).toBeTruthy());
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/secrets/vault/connect')!.body).toEqual({ allowWrite: true, allowIdentity: true, allowCards: true, returnTo: '/settings/secrets' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://vault.example.test/consent'));
  });

  it('shows the switch on when the permissions were granted, and the Activity row in words with the amount and the frame', async () => {
    mountSecrets(CARD_SCOPES);
    const sw = await screen.findByRole('switch', { name: 'Let the agent pay with a saved card' });
    await waitFor(() => expect(sw).toBeChecked());
    expect(await screen.findByText(/Typed the card number for 42.50 USD in the payment frame of pay.processor.example.net/)).toBeInTheDocument();
  });
});
