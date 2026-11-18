# Runbook: putting the console on the public internet for ChatGPT and Claude

ChatGPT and Claude call MCP servers **from their vendors' servers**, not from your browser. A console that only your LAN or tailnet can reach works for the CLI, the Android app, Claude Code and agent frameworks on your own machines, but a hosted assistant cannot reach it. This runbook makes the console reachable for them while exposing as little as possible, and keeps you in control: the per-address limits at the edge, the API's rate limits, a kill switch, approval of sensitive browser actions, and an audit trail of every call ([docs/security-hosted-clients.md](../security-hosted-clients.md) is the threat model behind each).

In the examples the console is `https://console.example.test`; use your own name. This runbook is the detail behind steps 1, 2 and 5 of the administrator's checklist, [Enable it](../../README.md#enable-it-deployment-owner-or-administrator) in the console README.

## 1. What must be public, and what need not be

| Path | Why it must be reachable from the internet |
|---|---|
| `POST /api/mcp` | The MCP endpoint itself |
| `/api/oauth/*` | The OAuth server: authorize, token, register, revoke |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/api/mcp` (and the rest of `/.well-known/oauth-*`) | Discovery: the client finds the sign-in from the first `401` |
| `/oauth/consent`, `/oauth/error` | The consent page the user signs in on, and its error page (web routes) |
| `/login`, `/api/auth/*` (the provider's start and callback, `/api/auth/refresh`, `/api/auth/me`) | Signing in to see the consent page |
| `/`, `/assets/*`, the web app's static files | The consent page is part of the web app |

Everything else (the console's own pages, `/api/*` for the console, `/fabric/*`, `/viewer/*`, `/api/docs`) is used by **you**, not by ChatGPT or Claude. It may stay public (the VPS stack does: every route needs a session or a token) or stay private (shape c below).

The browser a hosted assistant signs you in with is **yours**: the consent page, the login and its provider callback must work from wherever you use ChatGPT or Claude (your phone included).

## 2. Three supported shapes

### (a) The VPS stack, already public

The [VPS stack](vps-stack.md) is public through the shared host proxy, with TLS from `hexactra deploy`. To let AI apps in:

1. Check `APP_URL` in `infra/compose/.env` is the public address exactly (`https://console.example.test`, no trailing slash): the OAuth `issuer` and the `resource` of every token derive from it.
2. `hexactra deploy update` once after upgrading to 1.45.0: the host proxy's vhost then gives `/api/mcp` a 300 s timeout (the CLI declares it, `apps/cli/src/app.ts`); without it the host proxy cuts a tool that waits longer than 60 s.
3. Administration → Access → **OAuth clients**: switch on **Let other apps connect with OAuth** and, under **Allowed client hosts**, allow `chatgpt.com` and `claude.ai`.
4. Administration → **Doctor**: `mcp.endpoint`, `mcp.public_reachability`, `mcp.exposure`, `oauth.public_url` and `oauth.well_known` should pass.
5. Check the headers from outside: `curl -sI https://console.example.test/` shows `Strict-Transport-Security`, and `curl -s -X POST https://console.example.test/api/mcp -H 'content-type: application/json' -H 'accept: application/json' -d '{}' -i` answers `401` with `WWW-Authenticate: Bearer resource_metadata="https://console.example.test/.well-known/oauth-protected-resource/api/mcp"`.

### (b) A home console behind a tunnel

A console on a machine at home (no public address) can be published through a tunnel service such as Cloudflare Tunnel, or a similar reverse tunnel. The tunnel's connector runs next to the console and connects **out**; nothing is opened on your router.

1. **One hostname**, for example `console.example.test`, routed to the console's nginx (`http://localhost:3535` in the dev stack, or the stack's nginx port). Route the **whole host** to it; nginx sorts the paths.
2. **No caching of `/api/*`** on the tunnel's edge: a cache rule "bypass" for `console.example.test/api/*` and for `/.well-known/*`. The console sends `Cache-Control: no-store` on the answers that matter, but an edge configured to cache everything ignores it.
3. **No interactive access policy in front of `/api/mcp`, `/api/oauth/*` and `/.well-known/*`.** The vendor's servers cannot pass a login page, a one-time code or a browser challenge: an access application (single sign-on, one-time PIN) on those paths breaks every AI app. You may put one on everything else (the console's pages), as long as you can pass it from your own browser, including the consent page `/oauth/consent` (or exclude `/oauth/*` too).
4. **No bot challenge or "managed challenge" on `/.well-known/*`**: a challenge page answers HTML with a `200` or `403`, and the client gives up on discovery. Turn bot fighting off for those paths or allow the vendors' ranges (section 3).
5. Set `APP_URL=https://console.example.test` in `infra/compose/.env` and restart the API; then steps 3 and 4 of shape (a).

Long waits: the tunnel must allow a request to last 300 s (some tunnels cut at 100 s by default; then tools that wait answer "still working" earlier and the app follows up, which still works).

### (c) Split: only the MCP and OAuth paths public

Keep the console private (LAN or tailnet) and publish a small public reverse proxy that forwards only the paths of section 1. Your own browser reaches the console privately; the consent page must still be reachable from where you use the AI app, so either publish `/oauth/*`, the login and the static files too (as below), or use the AI app only from devices on your private network.

```nginx
# On the public proxy (TLS terminated here; the console is at 10.0.0.5:3535 on the private network).
server {
    listen 443 ssl;
    server_name console.example.test;
    # ssl_certificate / ssl_certificate_key: your certificate

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    client_max_body_size 1m;

    # The MCP endpoint: long waits.
    location = /api/mcp {
        proxy_pass http://10.0.0.5:3535;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
    # OAuth, discovery, sign-in.
    location ~ ^/(api/oauth/|\.well-known/oauth-|api/auth/|oauth/|login|assets/) {
        proxy_pass http://10.0.0.5:3535;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    # The web app's shell for /oauth/consent and /login.
    location = / { proxy_pass http://10.0.0.5:3535; proxy_set_header Host $host; }
    # Nothing else.
    location / { return 404; }
}
```

`APP_URL` is the **public** address (`https://console.example.test`) even though you use the console privately: the OAuth issuer and resource must be the address the AI apps see. Use the same host name privately (split DNS) so the console's own links work.

## 3. Firewalls and WAFs

- **Anthropic** publishes the address range Claude's servers call from: `160.79.104.0/21` (Anthropic's documentation, "IP addresses"; re-check it there before you rely on it, it can change).
- **OpenAI** publishes the egress ranges of ChatGPT's connectors on its own documentation; use the list there. This runbook does not copy it (it was not reachable when this was written, and copies go stale).
- An allowlist of those ranges is a sensible extra fence on `/api/mcp` and `/api/oauth/token`, never on `/oauth/consent` or the login (your own browser uses those).
- **A WAF or bot challenge on `/.well-known/*` breaks discovery**: the client gets a challenge page instead of JSON and stops. Exempt `/.well-known/oauth-*` and `/api/oauth/*` from challenges.

## 4. The limits that apply

| Where | What | Default |
|---|---|---|
| nginx (`infra/nginx/app.d/`) | per address: `/api/mcp` 1,200 per minute (burst 300), `/api/oauth/` and `/.well-known/` 120 per minute (burst 60); `/api/mcp` bodies up to 1 MiB, waits up to 300 s | |
| API, per connection | an OAuth grant, a personal access token or a console session: requests per minute | 120 |
| API, per app | `tools/call` of a tool that changes something, per OAuth grant per minute | 30 |
| API, per user | across all of a user's credentials, per minute | 600 |
| API, unauthenticated | `401` answers per source address per minute, then `429` | 30 |

The API limits are in Administration → **External AI apps** (`mcp` system settings; each with a deployment ceiling). A refusal is `429` with `Retry-After` and a JSON-RPC error naming the wait; the metric `app.mcp.rate_limited` counts refusals by key kind and client.

**Several API replicas: one shared limit.** By default each API process counts the limits in its own memory, so with N replicas a caller gets N times every API limit above (and N times the platform OAuth server's limits). Set `MCP_RATE_LIMIT_STORE=postgres` in `infra/compose/.env` and restart the API: every replica then counts in the database table `rate_limit_windows` (a sliding window counter, one row per key and minute), the MCP limits and the OAuth server's limits alike, and the hourly job `mcp.rate_limit.purge` (Administration → Jobs) deletes old windows. Keep the replicas' clocks synchronised (NTP). Failure: if the database cannot count, authenticated MCP callers are let through and unauthenticated ones (the `401` probes, the OAuth endpoints) are refused with `429`, as with the in-memory store; the warning `the MCP rate limiter failed` (or `the OAuth rate limiter failed`) is logged at most once a minute per process. No Redis is needed. Details: [mcp.md, Rate limits](../mcp.md#rate-limits).

**Rate limits behind a proxy (`TRUST_PROXY`).** nginx and the API key their per-address limits (the unauthenticated MCP limit, the OAuth server's authorize and register limits) on the address they see. The API always sits behind the stack's own nginx, so it reads the caller's address from `X-Forwarded-For`, trusting only the proxies `TRUST_PROXY` names (`infra/compose/.env`, read at boot; restart the API after changing it; #530):

| `TRUST_PROXY` | The API trusts | Per-address limits |
|---|---|---|
| empty (the default) | loopback, link-local and private ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`): the stack's nginx, and a tunnel or proxy on the same private network | one bucket per caller |
| `false` | no proxy | **every caller shares nginx's bucket**: a ceiling on everyone's unauthenticated traffic together (Doctor `mcp.trust_proxy` warns when the console is public) |
| a comma-separated list of IPs or CIDRs, e.g. `172.18.0.0/16` | only those addresses (narrow it to the stack network's subnet when other machines on your private network can reach the API directly) | one bucket per caller |

`true` and a hop count are refused (the API stops at boot with a message naming the value, as for any malformed entry): `true` would let any caller choose its bucket with `X-Forwarded-For`, and Fastify 5 ignores a hop count. The forwarded chain is walked from the right and stops at the first address that is not trusted, so a caller cannot move itself into another bucket by sending its own `X-Forwarded-For`; any machine whose address is trusted can, which is why the default trusts only private ranges. Behind the VPS host proxy or a public tunnel, nginx itself sees only the proxy's address: for per-caller limits, trust the forwarded address there too, in a server-level nginx overlay `infra/nginx/app.d/server/real-ip.conf` with `set_real_ip_from <the proxy's address>;` and `real_ip_header X-Forwarded-For;` (never trust `X-Forwarded-For` from anywhere else). A shared Postgres store (above) does not change any of this; it only makes the replicas agree on the count. nginx's per-address `limit_req` stays the coarse per-caller fence in front.

## 5. Hardening checklist

- [ ] HTTPS only; `http://` redirects; `Strict-Transport-Security` is sent (the platform's nginx sends it; check a tunnel or proxy in front does not strip it).
- [ ] `APP_URL` equals the public URL exactly (scheme, host, no path, no trailing slash). The OAuth `issuer` and every token's `resource` derive from it.
- [ ] Administration → OAuth clients: only the client hosts you use are allowed (`chatgpt.com`, `claude.ai`), **Allow apps from any host** is off.
- [ ] Users connect with the **default scopes** unless they need more; `browser:drive`, `browser:evaluate`, `desktop:control` and `policies:write` are opt-ins for a reason. Doctor `mcp.high_risk_grants` counts them.
- [ ] Every user's AI apps keep **Ask me before its sensitive browser actions** on (Settings → AI apps → the app); add your banks and payment providers to Administration → External AI apps → **Sensitive sites**.
- [ ] Review Settings → **AI apps** (each user) and Administration → External AI apps → **Connected apps** (every user) **monthly**; disconnect what is not used.
- [ ] More than one API replica: `MCP_RATE_LIMIT_STORE=postgres`, so the rate limits are one count, not one per replica ([section 4](#4-the-limits-that-apply)).
- [ ] `TRUST_PROXY` is empty (the default) or lists the stack's nginx, not `false`, so the per-address limits count each caller apart ([section 4](#4-the-limits-that-apply)).
- [ ] Know where the kill switch is: Administration → External AI apps, or `hexactra mcp disable` on the box ([operations runbook](operations.md#9-external-ai-apps)).
- [ ] Doctor is green: `mcp.endpoint`, `mcp.public_reachability`, `mcp.exposure`, `mcp.trust_proxy`, `oauth.public_url`, `oauth.well_known`.

**After an incident, rotate:** disconnect every app (Administration → External AI apps → Connected apps → Disconnect each, or delete the OAuth client in OAuth clients, which revokes all its grants and tokens), revoke personal access tokens that may have leaked (Settings → Personal access tokens), and rotate `JWT_SECRET` only if console sessions themselves are suspected (it signs everyone out).

## 6. Incident: "an app is doing something I did not ask for"

1. **Stop the run.** Runs → the run → Stop (or `hexactra runs cancel <id>`). A browser session the app drives is a run too.
2. **Pause the app.** Settings → AI apps → the app → **Paused** (or `hexactra apps pause <app>`): no new runs or sessions; it stays connected so you can look.
3. **Disconnect it** if you did not start it, or it keeps going: Settings → AI apps → Disconnect (or `hexactra apps disconnect <app>`). Its next call is `401`.
4. **Read its Activity**: Settings → AI apps → the app → **Activity** (or `hexactra apps activity <app>`): every tool call, its target, and what was refused, newest first. Never what was typed, a script or a result: for those, open the run's steps.
5. If more than one user may be affected: `hexactra mcp disable` (or Administration → External AI apps → the switch) refuses **every** app signed in with OAuth within a few seconds; personal access tokens and the console keep working. `hexactra mcp disable --pat` does the same for tokens over MCP.
