import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configDirName, configFileName, envVar } from '@marinoscar/platform-cli';
import { ApiClient, AuthRequiredError, resolveApiBaseUrl, type FetchLike } from '@marinoscar/platform-cli/api-client';

/**
 * The console API as the logged-in user, for this app's commands and TUI
 * screens. Same precedence as the built-in `api` command: the
 * `<NAME>_SERVER_URL` / `<NAME>_TOKEN` pair, then what `login` stored.
 *
 * WORKAROUND for a missing platform seam (EnterpriseAppBase#1150): the
 * platform resolves credentials with `requireCredentials`, which no public
 * subpath exports yet. Replace this body with the platform helper once it
 * ships. The token stays inside the client; nothing here prints it.
 */
let factory: (() => ApiClient) | null = null;

/** Tests swap the client (a fake `fetch`, no real login). */
export function setConsoleApiFactory(next: (() => ApiClient) | null): void {
  factory = next;
}

interface Stored {
  serverUrl?: string;
  token?: string;
}

function stored(): Stored {
  try {
    return JSON.parse(readFileSync(join(homedir(), configDirName(), configFileName()), 'utf8')) as Stored;
  } catch {
    return {};
  }
}

export function consoleApi(fetch?: FetchLike): ApiClient {
  if (factory) return factory();
  const file = stored();
  const serverUrl = process.env[envVar('SERVER_URL')] || file.serverUrl;
  const token = process.env[envVar('TOKEN')] || file.token;
  if (!serverUrl || !token) {
    throw new AuthRequiredError('Not logged in. Run `hexactra login` first.');
  }
  return new ApiClient({ baseUrl: resolveApiBaseUrl(serverUrl), token, ...(fetch ? { fetch } : {}) });
}
