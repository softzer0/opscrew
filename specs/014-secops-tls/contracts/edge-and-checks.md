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
- Lynis's container mounts the host with `--mount type=bind,src=/,dst=/hostfs,readonly,bind-recursive=readonly`
  (Docker refuses where it cannot make submounts read-only, and the audit skips), with `/tmp` as a tmpfs. Nothing it writes outlives
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

## `vercel.json` translation (`@opscrew/iac-templates`, T1417b)

```ts
translateVercelRouting(routing: PlatformRouting, ctx: { proxy: "caddy" | "nginx"; hostnames: string[]; upstream: string }):
  { text: string; skipped: { rule: string; reason: string }[] };
```

- The output is an additions file for `ctx.proxy` that passes `scanProxyAdditions` and the
  proxy's checker.
- The order is headers, then redirects, then rewrites. Rewrites to an internal path are fallbacks
  that apply when the app answers 404 for the original path.
- `rule` names the property and index (`rewrites[3]`), and `reason` is a plain sentence.

## The additions rules (`@opscrew/secops`)

```ts
scanProxyAdditions(text: string, ctx: { proxy: "caddy" | "nginx"; hostnames: string[]; upstream: string }):
  { line: number; rule: string; message: string }[];
```

**An allow-list first** (lead decision, 2026-10-21, after T1408's reviews). A list of what is forbidden can always miss a directive, so a directive not listed here is refused with the rule `not-allowed`: "`<name>` is not supported in additions yet; tell OpsCrew if you need it". The rules below then apply to the allowed directives' arguments.

| Where | Allowed directives |
|---|---|
| nginx, anywhere | `location`, `if`, `add_header`, `proxy_set_header`, `proxy_hide_header`, `proxy_redirect`, `proxy_pass` (the upstream rule), `proxy_intercept_errors`, `proxy_read_timeout`, `proxy_send_timeout`, `proxy_connect_timeout`, `proxy_buffering`, `proxy_request_buffering`, `error_page`, `return`, `rewrite`, `break`, `internal`, `limit_req` (only `zone=opscrew_…`), `limit_req_status`, `allow`, `deny`, `client_max_body_size`, `expires`, `etag`, `charset`, `gzip`, `gzip_types`, `gzip_min_length`, `gzip_vary`, `gzip_proxied` |
| Caddy, top level and inside `handle`, `handle_path`, `route`, `handle_response` | `header`, `request_header`, `redir`, `rewrite`, `uri`, `respond`, `error`, `abort`, `handle`, `handle_path`, `route`, `encode`, `basic_auth`, `basicauth`, `request_body`, `reverse_proxy` (the upstream rule), `copy_response`, `copy_response_headers`, and `@name` request matchers |
| Caddy request matchers (`@name …`, `@name { … }`, `not`) | `path`, `path_regexp`, `header`, `header_regexp`, `method`, `query`, `host`, `remote_ip`, `client_ip`, `protocol`, `not` |
| Caddy, inside `reverse_proxy` | `to`, `header_up`, `header_down`, `handle_response`, `lb_try_duration`, `lb_try_interval`, `flush_interval`, `stream_timeout`, and `@name` response matchers (`status`, `header`) |
| Caddy, other blocks | `request_body`: `max_size`; `encode`: `gzip`, `zstd`, `minimum_length`, `match` (with `status`, `header`); `copy_response_headers`: `include` or `exclude` |
| Caddy blocks whose lines are values | `header`, `request_header`, `basic_auth`, `basicauth`: only the placeholder rule applies inside them |

Not allowed, so refused by the list: for example `include`, `import`, `file_server`, `templates`, `root`, `alias`, `try_files`, `autoindex`, `sub_filter`, `mirror`, `proxy_store`, `*_temp_path`, `ssl_*`, `tls`, `log`, `access_log`, `error_log`, `set`, `map`, `vars`, `handle_errors`, `invoke`, `php_fastcgi`, `forward_auth`, `expression` matchers, and Lua or njs. Snippet definitions (`(name) { … }`) and site blocks are refused too. Names are compared byte for byte, so a look-alike Unicode name is simply not on the list. Control characters other than tab, CR and LF are refused (`characters`).

The table below now applies to the arguments of the allowed directives:

Each rule refuses, with its line and what to do:

| Rule | Refuses |
|---|---|
| `tls` | every nginx `ssl_*` directive and Caddy's `tls` directive: TLS is managed by OpsCrew |
| `admin-endpoint` | Caddy's `admin`, `metrics`; nginx's `stub_status`, `api`, `status` |
| `upstream` | `proxy_pass`, `reverse_proxy`, `fastcgi_pass`, `grpc_pass`, `uwsgi_pass`, `scgi_pass`, `memcached_pass`, `php_fastcgi`, `forward_auth` to anything but exactly `ctx.upstream` (no variable after it); `transport` inside `reverse_proxy` |
| `hostname` | `server_name` and `host` matchers naming a host outside `ctx.hostnames`; `bind`, `listen`; an unquoted `}` that closes no block (an imported Caddy file could otherwise define other sites) |
| `filesystem` | `root`, `alias`, `autoindex`, `file_server`, `auth_basic_user_file`: the edge serves no files of its own |
| `includes` | `include`, `import` |
| `scripting` | `*_by_lua*`, `js_*`, `perl` |
| `placeholder` | any word, quoted or not, containing Caddy's `{file.`, `{env.` or `{$`: they read files or the environment, which can hold secrets |
| `logs` | Caddy `log` with `output net`, and nginx `access_log`/`error_log` to `syslog:`: request data leaves the server |
| `size` | a file over 64 KiB |
