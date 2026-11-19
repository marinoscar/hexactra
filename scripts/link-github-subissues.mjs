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
  [173, [174, 175, 176, 177, 178]],
  [285, [286, 287, 288, 289, 290, 291, 292, 293]],
  [333, [334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344]],
  [378, [379, 380, 381, 382]],
  [458, [459, 460, 461, 462, 463, 464, 465, 466, 467, 468, 469]],
  [536, [537, 540, 538, 539, 541, 542, 543, 544, 545]],
  [549, [550, 551, 553, 554, 555, 552, 556, 557]],
  // E37 secrets the agent can use but never see. Sequence order, then #621 (the "Save this login?" card split out of #593)
  // and the follow-ups filed by the close-out: #624 acceptance run, #625 hardening, #626 migration, #627 built-in identity,
  // #628 other password managers, #629 rotation, #630 contract package and conformance kit.
  [579, [590, 591, 592, 593, 594, 595, 596, 597, 621, 624, 625, 626, 627, 628, 629, 630]],
  // E38 a harness you can stop, pause and trust. Sequence order (E38.1 to E38.8), then #614 (E38.9, the agent packages),
  // the fabric idempotency key #633, the follow-up #643 (E38.10, packages) and those filed by the close-out: #650 the
  // acceptance run on the deployed stack, #651 nightly live replay, #652 the flaky VPS stack job, #653 tidy after the
  // split, #654 further console packages.
  [580, [582, 583, 584, 585, 586, 587, 588, 589, 614, 633, 643, 650, 651, 652, 653, 654]],
  // E39 connections: Google and Microsoft accounts for email, calendar and documents, and deliveries after a run. Sequence order
  // (E39.1 to E39.11): #598 the auth decision record, #599 connections, #601 the Google provider, #602 the Microsoft provider,
  // #600 task outputs, #603 deliveries, #604 agent tools, #605 email triggers, #606 generic MCP servers, #607 the console UI and
  // #608 this close-out. Follow-ups filed by the acceptance run are added here when they exist.
  [581, [598, 599, 601, 602, 600, 603, 604, 605, 606, 607, 608, 661, 662, 663, 664, 665, 666]],
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
