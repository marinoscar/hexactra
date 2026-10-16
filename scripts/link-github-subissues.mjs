/**
 * Convert Hexactra's existing Markdown-linked epics into native GitHub sub-issues.
 *
 * Run once (or repeatedly; it is idempotent) with an Issues:write token:
 *   GITHUB_TOKEN=... node scripts/link-github-subissues.mjs
 *
 * Existing issue bodies, numbers, and content remain unchanged. Dry-run:
 *   GITHUB_TOKEN=... node scripts/link-github-subissues.mjs --check
 */
const repo = process.env.GITHUB_REPOSITORY || "marinoscar/hexactra";
if (repo !== "marinoscar/hexactra") {
  throw new Error("Refusing to modify issues outside marinoscar/hexactra");
}
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) throw new Error("An Issues:write GITHUB_TOKEN or GH_TOKEN is required");
const dryRun = process.argv.includes("--check");

const epicChildren = new Map([
  [1, [2, 3, 4, 5, 6]],
  [7, [8, 9, 10, 11, 12]],
  [13, [14, 15, 16, 17, 18, 19]],
  [20, [21, 22, 23, 24, 25]],
  [26, [27, 28, 29, 30, 31]],
  [32, [33, 34, 35, 36, 37, 38]],
  [39, [40, 41, 42, 43, 44]],
  [45, [46, 47, 48, 49, 50, 51]],
  [52, [53, 54, 55, 56, 57]],
  [58, [59, 60, 61, 62, 63]],
  [64, [65, 66, 67, 68, 69]],
  [70, [71, 72, 73, 74, 75]],
  [76, [77, 78, 79, 80, 81]],
  [82, [83, 84, 85, 86, 87]],
  [88, [89, 90, 91, 92, 93]],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, method = "GET", data) {
  const url = "https://api.github.com/repos/" + repo + path;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hexactra-subissue-backfill",
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (res.ok) return res.json();
    const raw = (await res.text()).slice(0, 600);
    const retryable = res.status === 429 || res.status >= 500 ||
      (res.status === 403 && (/rate limit|secondary rate/i).test(raw));
    if (!retryable || attempt === 4) {
      throw new Error(method + " " + path + " failed HTTP " + res.status + ": " + raw);
    }
    await sleep(2000 * (attempt + 1));
  }
}

let linked = 0, existing = 0;
for (const [parent, children] of epicChildren) {
  const current = await api("/issues/" + parent + "/sub_issues?per_page=100");
  const currentNumbers = new Set(current.map((x) => x.number));
  for (const number of children) {
    if (currentNumbers.has(number)) {
      existing++;
      continue;
    }
    if (dryRun) {
      console.log("[check] would attach #" + number + " under epic #" + parent);
      continue;
    }
    const child = await api("/issues/" + number);
    if (!child.id || child.number !== number || child.pull_request) {
      throw new Error("Invalid candidate sub-issue #" + number);
    }
    await api("/issues/" + parent + "/sub_issues", "POST", {
      sub_issue_id: child.id,
    });
    console.log("Attached #" + number + " under epic #" + parent);
    linked++;
    // Avoid GitHub API secondary rate limits from bulk relationship writes.
    await sleep(900);
  }
  if (!dryRun) {
    const after = await api("/issues/" + parent + "/sub_issues?per_page=100");
    const actual = new Set(after.map((x) => x.number));
    const absent = children.filter((n) => !actual.has(n));
    if (absent.length) {
      throw new Error("Epic #" + parent + " missing sub-issues: " + absent.join(", "));
    }
    console.log("Verified epic #" + parent + ": " + children.length + "/" + children.length + " children");
  }
}
console.log((dryRun ? "Dry run." : "Completed.") + " Newly linked: " +
            linked + "; previously linked: " + existing + ".");
