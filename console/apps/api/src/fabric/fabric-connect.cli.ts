/**
 * `node dist/fabric/fabric-connect.cli.js status | set --url <url>` (issue #309):
 * run by `hexactra deploy` inside the api container.
 *
 * - `status` prints the connection state.
 * - `set` reads an `hxs_` service token from STDIN (piped straight from the
 *   fabric's `admin service-token-create`, so it never appears in an argv, a
 *   log or the deploy journal), stores it with the URL in the encrypted
 *   credential store, then prints the resulting state; exit 1 unless connected.
 *
 * Output: exactly one line `FABRIC_CONNECT {"state":...}` on stdout, never the
 * token. The application context boots with the job worker off.
 */
import 'reflect-metadata';

import type { FabricConnectStatus } from './fabric-connect.service';

export const RESULT_PREFIX = 'FABRIC_CONNECT ';

/** The first `hxs_` token in the text piped to `set`. */
export function tokenFrom(input: string): string | null {
  return /hxs_[A-Za-z0-9_-]{8,}/.exec(input)?.[0] ?? null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const urlAt = rest.indexOf('--url');
  if (command !== 'status' && !(command === 'set' && urlAt >= 0 && rest[urlAt + 1])) {
    process.stderr.write('usage: fabric-connect.cli.js status | set --url <url>  (token on stdin)\n');
    return 2;
  }
  const token = command === 'set' ? tokenFrom(await readStdin()) : null;
  if (command === 'set' && !token) {
    process.stderr.write('fabric-connect: no hxs_ service token on stdin\n');
    return 1;
  }

  // Before the application module loads: a one-shot process takes no jobs.
  process.env.JOBS_WORKER_MODE = 'off';
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NestFactory } = require('@nestjs/core') as typeof import('@nestjs/core');
  const { AppModule } = require('../app.module') as typeof import('../app.module');
  const { FabricConnectService } = require('./fabric-connect.service') as typeof import('./fabric-connect.service');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const service = app.get(FabricConnectService, { strict: false });
    const result: FabricConnectStatus =
      command === 'set' ? await service.connect(rest[urlAt + 1]!, token!) : await service.status();
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
    return command === 'set' && result.state !== 'connected' ? 1 : 0;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`fabric-connect: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
