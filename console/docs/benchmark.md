# Benchmarks

A benchmark runs the same challenges under several agent policies on a real node and grades each trial from the challenge site's own state. The design and the reasons are in the [decision record](decisions/benchmark.md). This page is the working reference. It grows with the epic (E44, #738): the challenge site and the first ten challenges are here; starting a benchmark, the scorecard, the pages, the exports and the CLI arrive with the issues that build them.

## The challenge site

The console API serves a small fake web application for each trial. A real Chrome on a node opens it like any other site.

| | |
|---|---|
| Address | `https://<console>/benchmark/t/<token>/` |
| Served by | the API, `apps/api/src/benchmark/site/`, at `/api/benchmark-site/` |
| Published by | the nginx overlay `infra/nginx/app.d/locations/benchmark.conf`: `/benchmark/` proxies to `/api/benchmark-site/` |
| In development | `http://localhost:<port>/api/benchmark-site/t/<token>/`, through the Vite proxy or the API's own port |
| Base URL | the system setting `benchmark.siteBaseUrl`; empty means the console's public URL plus `/benchmark` |
| Static files | `/benchmark/assets/<file>`: the scripts and the stylesheet in `apps/api/assets/benchmark-site/` |

A node's browser must reach the base URL. A node on another network reaches the console's public name, so the default works wherever the console itself is reachable from the node.

### What a page is

- Server-rendered HTML in one layout (`assets/benchmark-site/layout.html`), plus scripts and one stylesheet from the same origin.
- No inline script, no inline event handler and no inline style. The site sends its own `Content-Security-Policy` (`script-src 'self'; style-src 'self'`), and nginx adds the platform's. A browser enforces both.
- No console code, no cookie and no session. The token in the address is the only authority.
- Every link, form action, redirect and script call is relative. The same page works at `/benchmark/...` and at `/api/benchmark-site/...`.
- A page changes the trial's state the way a real site does: a form post, or a small JSON call made by the page's own script.

### The token and the state

| | |
|---|---|
| Token | 32 random bytes, base64url. Made by `TrialStateService.issueToken(trialId)`, returned once, and written into the trial's goal as part of the start URL. |
| Stored | only its SHA-256, in `BenchmarkTrial.tokenHash`. |
| Valid | while the trial's status is `running` and the site is open. `closeToken(trialId)` closes it. |
| State | plain JSON in `BenchmarkTrial.siteState`. `issueToken` sets it to the challenge's `setup(seed)`. |
| Writes | optimistic: a write names the version it read (`siteStateVersion`). A request that lost re-runs. A write on a closed trial is refused. |

An unknown, malformed or closed token answers the same 404 page on every route, and so does a page the challenge does not have.

### Limits and logging

- 600 requests a minute for one trial (the shared rate limiter, keyed by the trial's id). Over it: `429` with `Retry-After`.
- A posted body is at most 64 KB. nginx refuses a larger one first.
- The request log sees every page of a trial as `/api/benchmark-site/t/redacted`: no token, no page address, no query. No span is made for the site's paths, and the nginx location writes no access log.
- A refused write is logged with the trial's id only. No token, seed, expected answer or state is written to a log, a span or a metric.

### Check it on a deployed stack

```bash
curl -si https://<console>/benchmark/assets/site.css | head -n 1          # 200, text/css
curl -si https://<console>/benchmark/t/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/ | grep -iE '^(HTTP|content-security-policy|x-frame-options|x-content-type-options|strict-transport-security)'
```

The second command answers `404` with the platform's security headers and two `Content-Security-Policy` headers (the platform's and the site's). `scripts/stack-smoke.sh` asserts both in CI.

In a deployment whose public proxy forwards only chosen paths ([public-exposure.md](runbooks/public-exposure.md), shape (c)), the nodes must still reach `/benchmark/`. Either forward that path too, or set `benchmark.siteBaseUrl` to an address the nodes can reach.

## The challenges (suite `core`, version 1)

| Id | Category | The agent must | Graded on |
|---|---|---|---|
| `nav-lookup` | Navigation | follow three pages (customers, a customer, an order) to an order's status | the reported status |
| `nav-spa` | Navigation | reach a setting through client-side routes, change it and save | the stored setting; nothing else changed |
| `nav-pagination` | Navigation | find one product across six pages of results | the reported price |
| `nav-new-tab` | Navigation | open a document that opens in a new tab and read its access code | the reported code |
| `form-multistep` | Forms | complete a three-step registration; the phone number in the goal has a dash and the form wants digits | the stored record, field by field |
| `form-select-date` | Forms | choose a service in a custom dropdown and a date in a calendar | the stored booking |
| `extract-table` | Extraction | find the largest amount of one region in a table that sorts and filters | the reported amount |
| `extract-infinite-scroll` | Extraction | scroll a feed of 120 entries to one shipment | the reported pickup code |
| `dyn-delayed` | Dynamic pages | wait for a figure that arrives seconds after the page opens, next to an out-of-date one | the reported total; the figure reached the page |
| `dyn-modal` | Dynamic pages | answer a dialog that covers the page, then switch on a preference and save | the stored preference; the dialog was answered |

### How a trial is graded

- A grader returns named checks. A trial passes only when every check passes.
- A grader reads the site's stored state and, where the task is to report something, the agent's final answer. It never trusts the agent's claim of success.
- A reported value passes when the answer names the expected value and none of the other candidates the site showed. An answer that lists every status, or every price, is not an answer. Case, spacing and currency format are ignored (`$1,234.50`, `1234.5` and `USD 1,234.50` are the same amount).
- Every name, price, code and expected answer derives from the trial's seed. Two trials never share an answer by design, and a grader recomputes the expected values from the seed.

## How to add a challenge

A challenge is one file in `apps/api/src/benchmark/suite/challenges/`. It owns its data, its pages, its endpoints and its grader. Nothing else changes except the list it is added to.

1. **Write the plan.** A function of the seed that returns everything seeded: the data the pages show and the expected answer. Use `seeded(seed, '<id>')` and `distinct(...)` (`challenges/shared.ts`) for lists a person searches. Export it (`myChallengePlan`); the tests use it.
2. **Write `setup(seed)`.** The state at the start: only what the agent's actions change. Keep it small. Data that never changes stays in the plan.
3. **Write `goal(seed, baseUrl)`.** One or two sentences that start with `Open ${baseUrl}/`. Name the values the agent needs. Give no instruction about tools or how to solve it.
4. **Write `site.handle(request)`.** It receives the method, the path below the trial's root, the query, the posted body, the seed and the state, and returns `page(...)`, `json(...)`, `redirect(...)` or `notFound()` (`suite/pages.ts`).
   - Build markup with the `html` tag. It escapes every value.
   - Build every address from `request.root`: `${request.root}orders/${id}`.
   - To change the state, return the new state: `redirect('done', { state })`. Never change `request.state` in place. The handler may run again for the same request, so it must depend only on its input.
   - Change the state only on a completed interaction. A script error must never be able to mark a challenge passed.
   - Validate everything posted. Use `field(body, name)` for text.
5. **Add a page script only if the page needs one.** Put it in `apps/api/assets/benchmark-site/<id>.js` and name it in the page's `scripts`. Use `window.BenchmarkSite` (`site.js`) for calls: `get(path)`, `post(path, body)`, `el(tag, attrs, children)`. No `innerHTML`, no absolute address. Styles go in `site.css` as classes; a page has no inline style. Canvas drawing, shadow roots and same-origin frames are allowed by the site's policy (`frame-src 'self'`).
6. **Write `grade(input)`.** Return named checks (`kebab-case`; `safety:<name>` for a check that guards an invariant). Recompute the expected values from `input.seed`. Use `reportedValue`, `reportedAmount` and `storedField` (`suite/compare.ts`).
7. **Register it** in `challenges/index.ts`. Set `requires` when the agent needs a capability beyond a browser.
8. **Test it.**
   - Add a solver to `apps/api/test/support/benchmark-solvers.ts`. It completes the challenge through `SiteBrowser`, knowing only what the goal says and what the pages show. `test/benchmark-site.spec.ts` and `test/benchmark-site.db.spec.ts` then run it for every challenge: solved and graded, an untouched trial fails, two seeds differ, no page has inline script.
   - Add the wrong cases to `test/benchmark-site.spec.ts`: a wrong reported value, a wrong stored value.
   - Open the page once in a real browser. The solver tests exercise the endpoints, not the page's script.
9. **Bump `SUITE.version`** (`suite/registry.ts`) when a released suite changes: a challenge added, removed, or changed in a way that changes its results. Two benchmarks compare only within one version.

```bash
cd console/apps/api
npx jest --config ./test/jest.config.js benchmark-site                              # the unit tier
npx jest --config ./test/jest.config.js --testRegex 'benchmark-site\.db\.spec\.ts$' --runInBand   # over HTTP, real Postgres
```
