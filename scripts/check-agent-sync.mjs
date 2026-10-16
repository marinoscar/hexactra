/**
 * Verify CLAUDE.md and AGENTS.md cannot drift apart.
 * AGENTS.md is the single source of truth; CLAUDE.md must import it
 * and must not duplicate its sections.
 *
 *   node scripts/check-agent-sync.mjs
 */
import { readFileSync } from "node:fs";

const claude = readFileSync("CLAUDE.md", "utf8");
const agents = readFileSync("AGENTS.md", "utf8");
const errors = [];

if (!claude.split("\n").some((l) => l.trim() === "@AGENTS.md")) {
  errors.push("CLAUDE.md must contain a line `@AGENTS.md` importing AGENTS.md");
}
const dupes = agents
  .split("\n")
  .filter((l) => l.startsWith("## "))
  .filter((h) => claude.split("\n").includes(h));
if (dupes.length) errors.push("CLAUDE.md duplicates AGENTS.md sections: " + dupes.join(", "));
if (!/^# AGENTS\.md/m.test(agents)) errors.push("AGENTS.md must start with `# AGENTS.md`");

if (errors.length) {
  for (const e of errors) console.error("FAIL: " + e);
  process.exit(1);
}
console.log("OK: CLAUDE.md imports AGENTS.md and does not duplicate it");
