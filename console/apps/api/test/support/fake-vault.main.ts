// Starts the fake Vault (test/support/fake-vault.ts) as a standalone process, for the Rust provider's tests and
// manual runs:
//
//   cd console/apps/api && npx ts-node --transpile-only test/support/fake-vault.main.ts [--port 8787] [--no-agent-access]
//
// Prints ONE JSON line when ready, then serves until killed:
//   { "baseUrl", "resource", "clientId", "clientSecret", "redirectUri", "logins": [ { id, name, username, password,
//     origins, open, totpSeed } ] }
// The login values are random canaries; the data is invented. Use `GET <baseUrl>/api/oauth/authorize?...` as the
// browser to obtain a code (it auto-consents), then POST it to `/api/oauth/token` (form body, client_secret_post),
// or ask for a ready-made grant: pass `--grant` to also print an `accessToken` and `refreshToken` for the seeded
// client with scopes `vault:items_read vault:items_fill offline_access`.
import { createHash, randomBytes } from 'node:crypto';

import { startFakeVault } from './fake-vault';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 0;
  const vault = await startFakeVault({ port, agentAccess: !args.includes('--no-agent-access') });
  const out: Record<string, unknown> = {
    baseUrl: vault.baseUrl,
    resource: vault.resource,
    clientId: vault.options.clientId,
    clientSecret: vault.options.clientSecret,
    redirectUri: vault.options.redirectUris[0],
    logins: vault.logins,
  };
  if (args.includes('--grant')) {
    const verifier = randomBytes(48).toString('base64url');
    const authorize = new URL(`${vault.baseUrl}/api/oauth/authorize`);
    const redirectUri = vault.options.redirectUris[0]!;
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: vault.options.clientId, redirect_uri: redirectUri, scope: 'vault:items_read vault:items_fill offline_access', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: vault.resource })) authorize.searchParams.set(k, v);
    const code = new URL(await vault.consent(authorize.toString())).searchParams.get('code')!;
    const res = await fetch(`${vault.baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: vault.options.clientId, client_secret: vault.options.clientSecret, resource: vault.resource }).toString(),
    });
    const tokens = (await res.json()) as { access_token: string; refresh_token: string };
    out.accessToken = tokens.access_token;
    out.refreshToken = tokens.refresh_token;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  const stop = () => void vault.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
