// Build every MCP Apps widget (#467): vite-plugin-singlefile inlines one
// entry per build, so each widget is a build of its own (vite.config.ts reads
// MCP_UI_WIDGET). dist/ is emptied once, first.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WIDGETS = ['run-card', 'question-card', 'tasks-card'];

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
for (const w of WIDGETS) {
  const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, MCP_UI_WIDGET: w }, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
