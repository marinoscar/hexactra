#!/usr/bin/env node
import { createCli, EXIT, exitCodeFor, formatError } from '@marinoscar/platform-cli';

import { APP_CLI_OPTIONS } from './app.js';
import { helpBanner, isTopLevelHelp } from './brand.js';

// Set exitCode and return; never process.exit(), which truncates piped output.
async function main(): Promise<void> {
  let cli: ReturnType<typeof createCli>;
  try {
    cli = createCli(APP_CLI_OPTIONS);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = exitCodeFor(error);
    return;
  }
  const argv = process.argv.slice(2);
  // The brand banner above the top-level help (the platform builds the help text; this only prefixes it).
  if (isTopLevelHelp(argv)) process.stdout.write(helpBanner(process.stdout, process.env, argv));
  process.exitCode = await cli.run(argv);
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${formatError(reason)}\n`);
  process.exitCode = EXIT.FAILURE;
});

void main();
