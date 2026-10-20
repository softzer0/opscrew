# Data model: SecOps and TLS (014)

Entities from spec.md's Key Entities, with their fields, rules and where they live. Types are in
`contracts/`. No migration: OpsCrew is unreleased, so older records are rewritten as they are read
or simply refused (the no-backward-compatibility rule).

## plan.yaml

| Field | Type | Rule |
|---|---|---|
| `target.edge` | `"caddy" \| "nginx"` | Cloud and own targets only, defaulting to `caddy`; absent on Portainer. Every OpsCrew app on one server has the same value (checked by provision against the server, FR-1440). |
| `app.maxBodyMb` | int 1–2048, default 100 | nginx's `client_max_body_size`. Caddy has no limit by default and gets none. |

Nothing else in the plan changes: origin protection follows from `dns.proxied` and the target, and
CAA from the hostnames that are not proxied.

## Origin certificate

Per app, in `SharedRecord.tls.origin` (`.opscrew/cloudflare.json`):

| Field | Type | Rule |
|---|---|---|
| `id` | string | Cloudflare's certificate id. |
| `hostnames` | string[] | Exactly the app's proxied hostnames, sorted, lower-case; no wildcard. |
| `expiresAt` | ISO time | 15 years after issue (constitution II). Replaced by provision when the hostnames change or fewer than 30 days remain. |
| `sha256` | hex | The certificate's fingerprint, shown in plans. |

- **Its key** (P-256, PKCS#8 PEM) is the generated value `ORIGIN_TLS_KEY`, and the certificate's
  PEM is the generated value `ORIGIN_TLS_CERT`. Both reach the server as the deploy secret
  `OPSCREW_ORIGIN_TLS` (the certificate, then the key) and nowhere else.
- **`superseded`** lists the ids of replaced certificates, each revoked by the next run once the
  server serves the newer one.
- **States:** absent, then active (issued), then superseded (a new one issued), then revoked (by
  the next run after the server moved on, or by destroy).

## Client certificate (origin pulls)

Per app, in `SharedRecord.tls.client`:

| Field | Type | Rule |
|---|---|---|
| `id` | string | Cloudflare's id of the uploaded per-hostname certificate. |
| `expiresAt` | ISO time | 15 years after issue. Self-signed, CN `opscrew-<app>`, extKeyUsage clientAuth. |
| `sha256` | hex | Fingerprint, shown in plans. |
| `enabled` | string[] | Hostnames whose per-hostname AOP setting OpsCrew enabled with this certificate. |
| `gap` | `"permission"`, optional | Set while the token lacks the certificate permissions, so `secure` reports the gap (FR-1405); kept at `tls.gap`. |
| `retiring` | string[] | Hostnames that left the proxy. The next deploy drops the requirement, and the run after it, once the server shows that, disables the setting and switches the DNS record. |

- **Its key** is the generated value `ORIGIN_PULL_KEY`. It is sent to Cloudflare once, in the
  upload body.
- **Its certificate** (public) is committed as `opscrew/runtime/edge/tls/pull.pem`, the origin's
  trust pool.
- **A hostname's states:** absent, then uploaded, then enabled (wait for `active`), then required
  by the origin (deploy). Leaving the proxy goes back: no longer required (deploy), then disabled,
  then the certificate is deleted when no hostname is left.

## Zone settings record

In `SharedRecord.zoneSettings`:

| Field | Type | Rule |
|---|---|---|
| `minTlsVersion.setAt` | ISO time | When OpsCrew raised it. |
| `minTlsVersion.previous` | `"1.0"` | The only value OpsCrew changes it from. |

Set only when every proxied record in the zone carries `Managed by OpsCrew` and the value is
`1.0`. It is never lowered, and destroy leaves it.

## Recovery copy

| Item | Where | Content |
|---|---|---|
| The copy | `opscrew/secrets.sops.json` (committed) and `<folder>/<project>.sops.json` (optional) | SOPS JSON: `{ "files": { "<path>": "<content>" }, "sops": { … } }`. The paths are readable; the contents are encrypted. |
| The creation rule | `opscrew/.sops.yaml` (committed) | `creation_rules: [{ path_regex: "secrets\\.sops\\.json$", age: "<recipient>,<backup>" }]` |
| The local state | `.opscrew/recovery.json` (gitignored) | `{ hashes: { "<path>": "<sha256>" }, copySha256, copiedAt, repositoryCopyAt, publicConfirmed? }`, with no values. `copySha256` is the SHA-256 of the copy this machine last wrote: a different copy in the repository means another machine updated it. |
| The folder | `.opscrew/secrets.json` (gitignored) | `{ folder?: string }` |

- **Paths** start with `home/` (the project's folder under `~/.opscrew/projects/<id>/`) or
  `state/` (the project's `.opscrew/`). Restore refuses any other prefix, `..`, or an absolute
  path.
- **The files** are the fixed list in plan.md §5. A missing file is simply absent from the copy.
- **Recipients:** one or two age X25519 recipients (`age1…`, 62 characters). Post-quantum
  recipients are not used in v1.
- **States:**
  - none;
  - created: the key shown once, the folder copy written;
  - committed: in the merged pull request;
  - behind: a local file changed since the repository copy;
  - rotated: a new recipient set, in a pull request.

## Age key

Held only by the user: `AGE-SECRET-KEY-1…` (74 characters, upper-case Bech32). OpsCrew writes it
once, to a file at a path the user picks (0600, outside the repository and OpsCrew's folders), and
never prints it.
A child sops process gets it in `SOPS_AGE_KEY`, only during restore.

## Deeper-check result

`CheckResult` with `source: "lynis" | "ssh-audit" | "testssl"`, plus per tool:

| Field | Where | Rule |
|---|---|---|
| `version` | the report's section header | The pinned version that ran. |
| `results[]` | `CheckResult` | `id` is `<tool>:<tool's id>` (`lynis:SSH-7408`, `ssh-audit:kex.ecdh-sha2-nistp256`, `testssl:BREACH`); severity mapped (plan.md §6). |
| `noise` | `CheckResult.noise` | Reason text from `secops/src/deep/noise.ts`. Shown apart and not counted in the summary. |
| `skipped` | a `skip` result | With the reason and how to enable it. |
| `hardeningIndex` | Lynis only | 0–100. Below 65 is a medium finding. |

## Vercel routing (ProjectFacts)

`ProjectFacts.platformRouting`, optional, from detect (T1417a):

| Field | Type | Rule |
|---|---|---|
| `source` | `"vercel.json"` | The file it came from. |
| `sha256` | hex | The file's hash, written into the additions' header comment. |
| `redirects[]` | `{ source, destination, statusCode }` | `statusCode` is one of 301, 302, 303, 307, 308; `permanent: true` is 308 and `false` is 307 (R7). |
| `rewrites[]` | `{ source, destination }` | |
| `headers[]` | `{ source, headers: { key, value }[] }` | |
| `cleanUrls`, `trailingSlash` | boolean, optional | |
| `unsupported[]` | `{ property, index?, reason }` | `routes` (a PCRE form, not translated in v1), every `has` and `missing`, malformed entries. |

Each entry keeps its index in the file, so skipped rules can be named.

## Proxy choice

`target.edge` (above). On the server, the edge's Compose file carries `x-opscrew-edge-proxy:
caddy|nginx` next to 013's version stamp, so provision and the deploy can see what runs.

## User additions

| File | Proxy | Included |
|---|---|---|
| `opscrew/proxy/additions.caddy` | Caddy | `import` inside the app's site block |
| `opscrew/proxy/additions.nginx` | nginx | `include` inside the app's TLS `server` block |

- At most one of the two files exists, and it must match `target.edge`. The other is refused with
  how to convert it.
- The size limit is 64 KiB.
- On the server it is `/srv/edge/sites/<app>.additions`.

## Server layout (additions to 013's)

| Path | Owner, mode | Content |
|---|---|---|
| `/srv/edge/tls/<app>/origin.pem`, `origin.key` | deploy, 0600 (directory 0700) | From `OPSCREW_ORIGIN_TLS`. |
| `/srv/edge/tls/<app>/pull.pem` | deploy, 0644 | The client certificate (public). |
| `/srv/edge/sites/<app>.additions` | deploy, 0644 | The user's additions. |
| volume `letsencrypt`, `acme-webroot`, `reload` | nginx edge only | certbot's state, the HTTP-01 webroot, the reload flag. |
