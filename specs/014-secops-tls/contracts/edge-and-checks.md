# Contract: the edge's proxies, additions and the deeper checks (014)

Owners:
- `packages/iac-templates`: the edge, the sites and the deploy steps (T1406, T1407), the checker
  step (T1408);
- `packages/secops`: the additions rules (T1408) and the deeper checks (T1405).

Consumer: `packages/agents`.

## `CheckResult` (packages/contracts, T1401a)

```ts
export interface CheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "warn" | "skip";
  severity: Severity;
  message: string;
  remediation?: string;
  target?: string;
  /** The external tool that produced it (`lynis`, `ssh-audit`, `testssl`); absent for OpsCrew's own checks. */
  source?: string;
  /** Known noise: why it is set apart. Such a result is listed separately and not counted. */
  noise?: string;
}
```

## Deeper checks (`@opscrew/secops`)

```ts
runLynis(ssh: SshRunner, pins): Promise<DeepToolResult>;          // through Docker on the server
runSshAudit(docker: LocalDocker, host: string, port: number, pins): Promise<DeepToolResult>;
runTestssl(docker: LocalDocker, host: string, pins, opts: { edge: boolean }): Promise<DeepToolResult>;
parseLynisReport(text: string): { hardeningIndex?: number; warnings: LynisItem[]; suggestions: LynisItem[] };
parseSshAudit(json: unknown): SshAuditResult;                      // zod-checked
parseTestssl(json: unknown): TestsslItem[];                        // zod-checked
markNoise(results: CheckResult[], tool: DeepTool): CheckResult[];

interface DeepToolResult { tool: DeepTool; version: string; results: CheckResult[]; hardeningIndex?: number }
```

**Severity mapping:**

| Tool | Item | OpsCrew |
|---|---|---|
| Lynis | `warning[]` | medium, `warn` |
| Lynis | `suggestion[]` | low, `warn` |
| Lynis | `hardening_index` below 65 | medium, `warn` |
| ssh-audit | policy failed | high, `fail` |
| ssh-audit | a failing algorithm or option | low, `warn` |
| testssl.sh | CRITICAL, HIGH, MEDIUM, LOW | critical, high, medium, low |
| testssl.sh | OK, INFO | dropped |

**Guarantees:**
- Every tool runs from a pin: the image digest, or the tarball's SHA-256 checked in the container.
- Lynis's container mounts the host read-only, with `/tmp` as a tmpfs. Nothing it writes outlives
  the container, and its image is removed afterwards when it was not on the server before.
- A tool that cannot run gives one `skip` result with the reason and how to enable it. A refused
  or timed-out connection says so and never passes.
- Each run has a time limit: Lynis 4 minutes, ssh-audit 1, testssl.sh 2 per hostname.

## The edge on the server

| Item | Caddy | nginx |
|---|---|---|
| Services | `caddy`, `kamal-proxy` | `nginx` (nginx-unprivileged, `user: <deploy uid>`, `init: true`), `certbot`, `kamal-proxy` |
| Site file | `sites/<app>.caddy` | `sites/<app>.conf` |
| Additions | `sites/<app>.additions`, `import`ed in the site | `sites/<app>.additions`, `include`d in the TLS `server` |
| Proxied hostnames | `tls /etc/caddy/tls/<app>/origin.pem …key { client_auth { mode require_and_verify; trust_pool file …/pull.pem } }` | `ssl_certificate`, `ssl_certificate_key`, `ssl_verify_client on`, `ssl_client_certificate …/pull.pem` |
| DNS-only hostnames | Caddy's ACME (Let's Encrypt, ZeroSSL) | certbot webroot, `--cert-name <app>` |
| Unknown hostnames | catch-all site that aborts | `default_server` returning 444 on 80 and 443 |
| Reload | `caddy reload` (keeps the old config on error) | `nginx -t && nginx -s reload`; certbot's deploy hook touches `reload/flag` |
| Stamp | `x-opscrew-edge-proxy: caddy` | `x-opscrew-edge-proxy: nginx` |

**Visitors get the same on both proxies:**
- TLS 1.2 and 1.3 only;
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- no `Server` version;
- HTTP redirected to HTTPS for known hosts;
- WebSockets and long requests (300 s);
- uploads up to `app.maxBodyMb` on nginx, with no limit on Caddy.

**The deploy:**
- The deploy secret `OPSCREW_ORIGIN_TLS` (the certificate's PEM, then the key's) is written through
  SSH's stdin to `/srv/edge/tls/<app>/origin.pem` and `origin.key`, under `umask 077`, before the
  site switch.
- `pull.pem` and the additions are uploaded with the runtime files.
- The checker step runs on the runner first: `caddy validate` or `nginx -t` in the pinned image,
  against the whole rendered edge with placeholder certificates. A failure ends the job before the
  upload, with the checker's message.

## The additions rules (`@opscrew/secops`)

```ts
scanProxyAdditions(text: string, ctx: { proxy: "caddy" | "nginx"; hostnames: string[]; upstream: string }):
  { line: number; rule: string; message: string }[];
```

Each rule refuses, with its line and what to do:

| Rule | Refuses |
|---|---|
| `tls-version` | `ssl_protocols` or `protocols` naming TLS 1.0 or 1.1, or SSLv3 |
| `admin-endpoint` | Caddy's `admin`, `metrics`; nginx's `stub_status`, `api`, `status` |
| `upstream` | `proxy_pass`, `reverse_proxy`, `fastcgi_pass`, `grpc_pass`, `uwsgi_pass` to anything but `ctx.upstream` |
| `hostname` | `server_name`, `host` matchers, `bind`, `listen` |
| `filesystem` | `root`, `alias`, `autoindex`, `file_server`, `auth_basic_user_file`: the edge serves no files of its own |
| `includes` | `include`, `import` |
| `scripting` | `*_by_lua*`, `js_*`, `perl` |
| `size` | a file over 64 KiB |
