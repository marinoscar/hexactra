// @vitest-environment jsdom
//
// Hexactra passkeys (E47.4, #942; E47.6, #944): the page functions that hold ONE WebAuthn request of an armed tab for the control
// plane, run here in jsdom as they run in the page's own world.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STATE_KEY, pageWebauthnArm, pageWebauthnPending, pageWebauthnResolve } from '../src/webauthn';

let native: { get: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
const bytes = (...b: number[]) => new Uint8Array(b).buffer;

beforeEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>)[STATE_KEY];
  native = { get: vi.fn(async () => 'native-get'), create: vi.fn(async () => 'native-create') };
  Object.defineProperty(navigator, 'credentials', { value: { ...native }, configurable: true });
});

const creds = () => navigator.credentials as unknown as { get: (o?: unknown) => Promise<unknown>; create: (o?: unknown) => Promise<unknown> };
const getOptions = (extra: Record<string, unknown> = {}) => ({ publicKey: { challenge: bytes(1, 2, 3), rpId: 'example.com', allowCredentials: [{ type: 'public-key', id: bytes(9, 9) }], ...extra } });

describe('the WebAuthn hook of an armed tab', () => {
  it('runs the browser\'s own code when the tab is not armed', async () => {
    pageWebauthnArm('get', 15_000);
    // Armed for get: a create is not held.
    await expect(creds().create({ publicKey: { challenge: bytes(1), rp: { id: 'example.com' }, user: { id: bytes(1), name: 'a' } } })).resolves.toBe('native-create');
    // Used up by one call: the next get is the browser's.
    const held = creds().get(getOptions());
    expect(pageWebauthnPending()).not.toBeNull();
    pageWebauthnResolve(String(pageWebauthnPending()!.id), null, true);
    await expect(held).resolves.toBe('native-get');
    await expect(creds().get(getOptions())).resolves.toBe('native-get');
    expect(native.get).toHaveBeenCalledTimes(2);
  });

  it('holds an armed get, reports its facts (never an origin) and answers it with the built credential', async () => {
    pageWebauthnArm('get', 15_000);
    const held = creds().get(getOptions());
    const facts = pageWebauthnPending()!;
    expect(facts).toMatchObject({ kind: 'get', rp_id: 'example.com', challenge: 'AQID', allow_credentials: ['CQk'], payment: false });
    expect(facts).not.toHaveProperty('origin');
    expect(pageWebauthnResolve('wrong-id', null, true)).toEqual({ resolved: false });
    const out = pageWebauthnResolve(String(facts.id), { id: 'CQk', type: 'public-key', response: { client_data_json: 'e30', authenticator_data: 'AAE', signature: 'MEU', user_handle: 'dXNlcg' } }, false);
    expect(out).toEqual({ resolved: true });
    const cred = (await held) as { id: string; type: string; rawId: ArrayBuffer; response: { clientDataJSON: ArrayBuffer; signature: ArrayBuffer; userHandle: ArrayBuffer }; getClientExtensionResults: () => unknown };
    expect(cred.id).toBe('CQk');
    expect(cred.type).toBe('public-key');
    expect(new Uint8Array(cred.rawId)).toEqual(new Uint8Array([9, 9]));
    expect(new TextDecoder().decode(cred.response.clientDataJSON)).toBe('{}');
    expect(new TextDecoder().decode(cred.response.userHandle)).toBe('user');
    expect(cred.getClientExtensionResults()).toEqual({});
    expect(native.get).not.toHaveBeenCalled();
    expect(pageWebauthnPending()).toBeNull();
  });

  it('never holds a payment approval, a conditional request or a non-publicKey call (E47.6)', async () => {
    pageWebauthnArm('get', 15_000);
    await expect(creds().get(getOptions({ extensions: { payment: { isPayment: true } } }))).resolves.toBe('native-get');
    await expect(creds().get({ ...getOptions(), mediation: 'conditional' })).resolves.toBe('native-get');
    await expect(creds().get({ password: true })).resolves.toBe('native-get');
    expect(pageWebauthnPending()).toBeNull();
  });

  it('gives a held request to the browser when nobody answers in time', async () => {
    vi.useFakeTimers();
    pageWebauthnArm('get', 1_000);
    const held = creds().get(getOptions());
    expect(pageWebauthnPending()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(held).resolves.toBe('native-get');
    expect(pageWebauthnPending()).toBeNull();
  });

  it('does not hold a call made after the arming window', async () => {
    vi.useFakeTimers();
    pageWebauthnArm('get', 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(creds().get(getOptions())).resolves.toBe('native-get');
  });

  it('holds an armed create with its user and algorithms, and answers it with an attestation', async () => {
    pageWebauthnArm('create', 15_000);
    const held = creds().create({ publicKey: { challenge: bytes(7), rp: { id: 'example.com', name: 'Ex' }, user: { id: bytes(5), name: 'person-a', displayName: 'A' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], excludeCredentials: [{ id: bytes(4) }] } });
    const facts = pageWebauthnPending()!;
    expect(facts).toMatchObject({ kind: 'create', rp_id: 'example.com', challenge: 'Bw', user: { id: 'BQ', name: 'person-a' }, algorithms: [-7, -257], exclude_credentials: ['BA'] });
    pageWebauthnResolve(String(facts.id), { id: 'AAAA', type: 'public-key', response: { client_data_json: 'e30', authenticator_data: 'AAE', attestation_object: 'oA', public_key: 'MFk', public_key_algorithm: -7, transports: ['internal'] } }, false);
    const cred = (await held) as { response: { attestationObject: ArrayBuffer; getPublicKeyAlgorithm: () => number; getTransports: () => string[]; getAuthenticatorData: () => ArrayBuffer } };
    expect(new Uint8Array(cred.response.attestationObject)).toEqual(new Uint8Array([0xa0]));
    expect(cred.response.getPublicKeyAlgorithm()).toBe(-7);
    expect(cred.response.getTransports()).toEqual(['internal']);
    expect(new Uint8Array(cred.response.getAuthenticatorData())).toEqual(new Uint8Array([0, 1]));
    expect(native.create).not.toHaveBeenCalled();
  });

  // E47.6 (#944): a payment approval is the owner's. Secure Payment Confirmation through PaymentRequest is never wrapped, armed or not.
  it('never touches PaymentRequest, and never holds a payment request even when armed', async () => {
    class FakePaymentRequest {}
    (globalThis as Record<string, unknown>).PaymentRequest = FakePaymentRequest;
    pageWebauthnArm('get', 15_000);
    pageWebauthnArm('create', 15_000);
    expect((globalThis as Record<string, unknown>).PaymentRequest).toBe(FakePaymentRequest);
    pageWebauthnArm('get', 15_000);
    await expect(creds().get(getOptions({ extensions: { payment: { isPayment: true, rpId: 'bank.example.com' } } }))).resolves.toBe('native-get');
    expect(pageWebauthnPending()).toBeNull();
    // The arming is still there for a sign-in: a payment request did not use it up, and was never seen.
    const held = creds().get(getOptions());
    expect(pageWebauthnPending()).toMatchObject({ kind: 'get', payment: false });
    pageWebauthnResolve(String(pageWebauthnPending()!.id), null, true);
    await held;
  });
});
