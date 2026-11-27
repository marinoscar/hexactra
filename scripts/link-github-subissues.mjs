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
  [579, [590, 591, 592, 593, 594, 595, 596, 597, 621, 624, 625, 626, 627, 628, 629, 630, 711, 712, 924]],
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
  [684, [685, 686, 687, 688, 689]],
  [697, [698, 699, 700, 701, 702, 703]],
  [717, [718, 719, 720, 721, 722, 723]],
  [730, [731, 732, 733, 734, 735, 736]],
  // E44 benchmarks: agent policies compared on a real node, graded from the challenge site's state (E44.1 to E44.9, in order; E44.9 is the acceptance run on the deployed stack).
  [738, [739, 740, 741, 742, 743, 744, 745, 746, 809, 829, 844, 845, 846, 863, 871, 872, 873, 883, 884]],
  // E45 run recordings: opt-in video of a run, playback, and an admin retention policy (E45.1 to E45.6, in order).
  [755, [756, 757, 758, 759, 760, 761]],
  [770, [771, 772, 773, 774, 847]],
  [771, [775, 776, 777, 778, 779, 780]],
  [772, [781, 782, 783, 784, 785, 786]],
  [773, [787, 788, 789, 790, 791, 792]],
  [774, [793, 794, 795, 796, 797, 798, 799]],
  // E46 phase 5 (owner's decision, 2026-11-22): reuse across goals and site knowledge, before the final merge (E46.25).
  [847, [848, 849, 850, 851, 852, 853, 854, 855, 856]],
  // E47 Hexactra as a passkey provider (post-v1): E47.1 to E47.7 in order; E47.3 (Vault) waits for marinoscar/vault.
  [925, [939, 940, 941, 942, 943, 944, 945]],
  // E48 profile sign-in health: warn on signed-out Chrome profiles and sign them in with one click (E48.1 to E48.7, in order).
  [926, [927, 928, 929, 930, 931, 932, 933, 990, 991]],
  // E49 verification codes in segmented fields: fill every box, keep the code from the model, don't give up early.
  [957, [958, 959, 960, 961, 963]],
  // E50 web search, extensible tools and diagnostics (E50.1 to E50.17; order in the epic body).
  [970, [971, 972, 973, 974, 975, 976, 977, 978, 979, 980, 981, 982, 983, 984, 985, 986, 987]],
  // E52 consistent runs (epic #1015): E52.1 to E52.11, then E52.12 (a real key press) and E52.13 (its form fix), then the follow-ups.
  [1015, [1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1030, 1046, 1047, 1048, 1049, 1050, 1051]],
  // E53 run analytics (epic #1068): stats, admin stats, dataset export, CLI/SDK/MCP, the pages, the analyze-runs skill, then the goal-search bug E53.1 found.
  [1068, [1069, 1070, 1071, 1072, 1073, 1074, 1075]],
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
