#!/usr/bin/env node
// Fails when git tracks a `node_modules` path (a directory, a file or a symlink) anywhere in the repository (#920).
// A tracked `console/apps/web/node_modules` symlink once broke the web image build on the VPS ("cannot replace to
// directory .../node_modules with file"): the Dockerfile's deps stage puts a real directory where COPY then lands the link.
import { execFileSync } from 'node:child_process';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((p) => p.split('/').includes('node_modules'));

if (tracked.length > 0) {
  console.error(`git tracks ${tracked.length} node_modules path(s); remove them with \`git rm --cached\`:`);
  for (const p of tracked.slice(0, 20)) console.error(`  ${p}`);
  process.exit(1);
}
console.log('no node_modules path is tracked');
