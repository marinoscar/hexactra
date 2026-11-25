// Hexactra passkeys (E47.4, #942): the page functions that let the control plane answer ONE WebAuthn request of an armed tab.
//
// They run in the page's own JavaScript world (chrome.scripting, world MAIN), injected only when the control plane arms a tab:
// no content script, no hook on any other tab. Each function is self-contained (executeScript sends its source, not its closure).
//
// - pageWebauthnArm(kind, holdMs): wraps navigator.credentials.get/create once per page, and arms it for the next call of `kind`
//   within holdMs. A call that is not armed, not `publicKey`, conditional (autofill), or carries the `payment` extension (Secure
//   Payment Confirmation, E47.6) runs the browser's own code untouched. An armed call is held; if nobody answers within holdMs it
//   goes to the browser.
// - pageWebauthnPending(): the held request's facts (never the origin: the extension reads that from the tab), or null.
// - pageWebauthnResolve(id, credential, passthrough): answers the held request with the credential the control plane built, or
//   hands it to the browser.

/** The facts of a held request, as the page asked (the extension adds the tab's origin). */
export interface HeldWebauthn {
  id: string;
  kind: 'get' | 'create';
  rp_id: string;
  challenge: string;
  allow_credentials: string[];
  exclude_credentials: string[];
  user: { id: string; name: string } | null;
  algorithms: number[];
  payment: boolean;
}

/** The credential the control plane built (base64url fields). */
export interface BuiltCredential {
  id: string;
  type: 'public-key';
  authenticator_attachment?: string;
  response: {
    client_data_json: string;
    authenticator_data: string;
    signature?: string;
    user_handle?: string | null;
    attestation_object?: string;
    public_key?: string;
    public_key_algorithm?: number;
    transports?: string[];
  };
}

/** Where the state lives on the page's window: one per page. */
const STATE_KEY = '__hexactra_webauthn_v1__';

export function pageWebauthnArm(kind: 'get' | 'create', holdMs: number): { armed: true } {
  const KEY = '__hexactra_webauthn_v1__';
  type Pending = { facts: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; fallback: () => void; timer: ReturnType<typeof setTimeout> };
  type State = { armed: { kind: string; until: number } | null; pending: Pending | null; seq: number };
  const w = window as unknown as Record<string, State | undefined>;
  const creds = navigator.credentials as unknown as Record<string, (o?: unknown) => Promise<unknown>> | undefined;
  if (!w[KEY]) {
    const state: State = { armed: null, pending: null, seq: 0 };
    Object.defineProperty(window, KEY, { value: state, enumerable: false, configurable: true, writable: false });
    if (creds) {
      const b64 = (src: unknown): string => {
        let bytes: Uint8Array;
        if (src instanceof ArrayBuffer) bytes = new Uint8Array(src);
        else if (ArrayBuffer.isView(src)) bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
        else return '';
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      };
      const wrap = (which: 'get' | 'create') => {
        const original = creds[which]!.bind(navigator.credentials);
        creds[which] = (options?: unknown) => {
          const o = (options ?? {}) as Record<string, unknown>;
          const pk = o.publicKey as Record<string, unknown> | undefined;
          const armed = state.armed;
          const ext = (pk?.extensions ?? {}) as Record<string, unknown>;
          if (!pk || o.mediation === 'conditional' || !armed || armed.kind !== which || Date.now() > armed.until || ext.payment !== undefined || state.pending) {
            return original(options);
          }
          state.armed = null;
          const rp = pk.rp as Record<string, unknown> | undefined;
          const user = pk.user as Record<string, unknown> | undefined;
          const ids = (list: unknown) => (Array.isArray(list) ? list.map((c) => b64((c as { id?: unknown }).id)).filter(Boolean) : []);
          const facts = {
            id: `wa-${Date.now().toString(36)}-${(state.seq += 1)}`,
            kind: which,
            rp_id: String((which === 'get' ? pk.rpId : rp?.id) ?? location.hostname),
            challenge: b64(pk.challenge),
            allow_credentials: ids(pk.allowCredentials),
            exclude_credentials: ids(pk.excludeCredentials),
            user: user ? { id: b64(user.id), name: String(user.name ?? '') } : null,
            algorithms: Array.isArray(pk.pubKeyCredParams) ? (pk.pubKeyCredParams as { alg?: unknown }[]).map((p) => Number(p.alg)).filter((n) => Number.isFinite(n)) : [],
            payment: false,
          };
          return new Promise((resolve, reject) => {
            const fallback = () => {
              original(options).then(resolve, reject);
            };
            const timer = setTimeout(() => {
              if (state.pending && state.pending.facts.id === facts.id) {
                state.pending = null;
                fallback();
              }
            }, Math.max(0, holdMs));
            state.pending = { facts, resolve, reject, fallback, timer };
          });
        };
      };
      if (typeof creds.get === 'function') wrap('get');
      if (typeof creds.create === 'function') wrap('create');
    }
  }
  w[KEY]!.armed = { kind, until: Date.now() + Math.max(0, holdMs) };
  return { armed: true };
}

export function pageWebauthnPending(): Record<string, unknown> | null {
  const w = window as unknown as Record<string, { pending: { facts: Record<string, unknown> } | null } | undefined>;
  return w['__hexactra_webauthn_v1__']?.pending?.facts ?? null;
}

export function pageWebauthnResolve(id: string, credential: BuiltCredential | null, passthrough: boolean): { resolved: boolean } {
  type Pending = { facts: Record<string, unknown>; resolve: (v: unknown) => void; fallback: () => void; timer: ReturnType<typeof setTimeout> };
  const w = window as unknown as Record<string, { pending: Pending | null } | undefined>;
  const state = w['__hexactra_webauthn_v1__'];
  const p = state?.pending;
  if (!state || !p || p.facts.id !== id) return { resolved: false };
  state.pending = null;
  clearTimeout(p.timer);
  if (passthrough || !credential) {
    p.fallback();
    return { resolved: true };
  }
  const buf = (s: string | null | undefined): ArrayBuffer | null => {
    if (s === null || s === undefined) return null;
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const proto = (name: string): object => {
    const c = (globalThis as Record<string, unknown>)[name] as { prototype?: object } | undefined;
    return c?.prototype ?? Object.prototype;
  };
  const r = credential.response;
  const kind = p.facts.kind;
  const response = Object.create(proto(kind === 'get' ? 'AuthenticatorAssertionResponse' : 'AuthenticatorAttestationResponse')) as Record<string, unknown>;
  const own = (o: object, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true });
  own(response, 'clientDataJSON', buf(r.client_data_json));
  if (kind === 'get') {
    own(response, 'authenticatorData', buf(r.authenticator_data));
    own(response, 'signature', buf(r.signature));
    own(response, 'userHandle', buf(r.user_handle ?? null));
  } else {
    own(response, 'attestationObject', buf(r.attestation_object));
    own(response, 'getAuthenticatorData', () => buf(r.authenticator_data));
    own(response, 'getPublicKey', () => buf(r.public_key));
    own(response, 'getPublicKeyAlgorithm', () => r.public_key_algorithm ?? -7);
    own(response, 'getTransports', () => r.transports ?? ['internal']);
  }
  const rawId = buf(credential.id);
  const cred = Object.create(proto('PublicKeyCredential')) as Record<string, unknown>;
  own(cred, 'id', credential.id);
  own(cred, 'rawId', rawId);
  own(cred, 'type', 'public-key');
  own(cred, 'authenticatorAttachment', credential.authenticator_attachment ?? 'platform');
  own(cred, 'response', response);
  own(cred, 'getClientExtensionResults', () => ({}));
  own(cred, 'toJSON', () => ({
    id: credential.id,
    rawId: credential.id,
    type: 'public-key',
    authenticatorAttachment: credential.authenticator_attachment ?? 'platform',
    clientExtensionResults: {},
    response:
      kind === 'get'
        ? { clientDataJSON: r.client_data_json, authenticatorData: r.authenticator_data, signature: r.signature, userHandle: r.user_handle ?? null }
        : { clientDataJSON: r.client_data_json, attestationObject: r.attestation_object, authenticatorData: r.authenticator_data, publicKey: r.public_key, publicKeyAlgorithm: r.public_key_algorithm ?? -7, transports: r.transports ?? ['internal'] },
  }));
  p.resolve(cred);
  return { resolved: true };
}

export { STATE_KEY };
