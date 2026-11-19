#!/usr/bin/env node
// Copies the console's LICENSE into the package being packed (the `prepack` script of every @marinoscar/hexactra-* package), so a tarball
// ships a LICENSE next to package.json while the repository keeps one copy. The copy is git-ignored. Run from the package folder.
// Exit: 0 copied, 1 no LICENSE at console/LICENSE.
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(ROOT, 'LICENSE');
if (!existsSync(source)) {
  console.error(`copy-license: no LICENSE at ${source}; a published package must ship one`);
  process.exit(1);
}
copyFileSync(source, join(resolve(process.argv[2] ?? process.cwd()), 'LICENSE'));
