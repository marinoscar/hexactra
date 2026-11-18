// The nginx overlay of external AI apps (#465): infra/nginx/app.d/{http,server,locations}/mcp*.conf.
// Pinned statically (the body limit, the long read timeout on /api/mcp only,
// the three per-address zones), and validated with `nginx -t` on the whole
// composed configuration, mounted as base.compose.yml mounts it, when an nginx
// binary is on this machine (CI's ubuntu runners have one). The upstream hosts
// are pointed at 127.0.0.1 so the config loads outside Compose.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NGINX_DIR = join(__dirname, '..', '..', '..', 'infra', 'nginx');
const read = (p: string) => readFileSync(join(NGINX_DIR, p), 'utf8');
const strip = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('the nginx overlay of /api/mcp (#465)', () => {
  it('the MCP location: 1 MiB body, a read timeout of at least 240 s, its own per-address limit', () => {
    const conf = strip(read('app.d/locations/mcp.conf'));
    expect(conf).toMatch(/location ~ \^\/api\/mcp\/\?\$ \{/);
    expect(conf).toMatch(/client_max_body_size 1m;/);
    const timeout = Number(/proxy_read_timeout (\d+)s;/.exec(conf)?.[1]);
    expect(timeout).toBeGreaterThanOrEqual(240);
    expect(conf).toMatch(/limit_req zone=hexactra_mcp /);
    // No add_header: the server-level security headers stay.
    expect(conf).not.toMatch(/add_header/);
    // The rest of the API keeps its timeout: the generated `location /api` is untouched.
    expect(strip(read('nginx.conf'))).toMatch(/location \/api \{[\s\S]*?proxy_read_timeout 60s;/);
  });

  it('zones for /api/mcp, /api/oauth/ and /.well-known/, applied at server level for the platform locations', () => {
    const http = strip(read('app.d/http/mcp-limits.conf'));
    for (const zone of ['hexactra_mcp', 'hexactra_oauth', 'hexactra_well_known']) expect(http).toContain(`zone=${zone}:`);
    expect(http).toMatch(/~\^\/api\/oauth\//);
    expect(http).toMatch(/~\^\/\\\.well-known\//);
    const server = strip(read('app.d/server/mcp-limits.conf'));
    expect(server).toMatch(/limit_req zone=hexactra_oauth /);
    expect(server).toMatch(/limit_req zone=hexactra_well_known /);
    expect(server).toMatch(/limit_req_status 429;/);
  });

  const nginx = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
  const haveNginx = nginx.status === 0 && existsSync('/etc/nginx/mime.types');
  (haveNginx ? it : it.skip)('nginx -t accepts the composed configuration with the overlay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hexactra-nginx-'));
    try {
      cpSync(NGINX_DIR, dir, { recursive: true });
      cpSync('/etc/nginx/mime.types', join(dir, 'mime.types'));
      const rewrite = (file: string) => {
        const text = readFileSync(file, 'utf8')
          .replaceAll('/etc/nginx/', `${dir}/`)
          .replace(/server api:3000;/g, 'server 127.0.0.1:3000;')
          .replace(/server web:5173;/g, 'server 127.0.0.1:5173;')
          .replace(/\/var\/log\/nginx\//g, `${dir}/`)
          .replace(/\/var\/run\/nginx\.pid/g, `${dir}/nginx.pid`);
        writeFileSync(file, text);
      };
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (p.endsWith('.conf')) rewrite(p);
        }
      };
      walk(dir);
      // A non-root runner cannot create nginx's default temp directories (/var/lib/nginx/*):
      // point them into the scratch directory, as `nginx -t` creates them while testing.
      const main = join(dir, 'nginx.conf');
      const temps = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((k) => `${k}_temp_path ${dir}/${k}_temp;`).join(' ');
      writeFileSync(main, readFileSync(main, 'utf8').replace(/\bhttp\s*\{/, (m) => `${m} ${temps}`));
      const r = spawnSync('nginx', ['-t', '-p', dir, '-c', join(dir, 'nginx.conf'), '-e', join(dir, 'error.log')], { encoding: 'utf8' });
      // stderr first, so a failure shows nginx's own message.
      expect(r.stderr).toMatch(/syntax is ok/);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
