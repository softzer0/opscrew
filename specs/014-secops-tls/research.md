# Research: SecOps and TLS (014)

**Date**: 2026-10-21. **Method**: four Sonnet research agents on official sources (projects' docs, GitHub
releases, Cloudflare docs and API reference, Docker Hub) and a Haiku code map. The raw notes are in
`.tools/scratch/014-{checks,secrets,cloudflare,proxy,codemap}.md`. Facts marked *(verify)* are from
an agent's own knowledge or an ambiguous page, and are confirmed in the spike (T1402) or the live
runs before anything relies on them.

## Today (code map)

- **`opscrew secure`** (`packages/agents/src/secure/run.ts`):
  - steps: the repo scan, plan policies, host checks over SSH as `deploy` (`HOST_CHECKS`, own-server and service checks), outside probes (22/80/443, IPv6), then `opscrew/SECURITY_REPORT.md`;
  - types: `CheckResult` (contracts/secops.ts) and `Finding` with `SEVERITIES` (contracts/common.ts).
- **External scanners** (gitleaks, osv-scanner, trivy) are found on `PATH` and run unpinned as local binaries. A missing one is reported with install hints. There is no Docker and no version pin.
- **TLS:**
  - The shared edge is Caddy plus kamal-proxy (`iac-templates/src/edge`).
  - The site modes are `tunnel` (http), `proxy` (:80 behind the user's proxy) and `direct` (ACME, Let's Encrypt by default; only the e-mail is set).
  - Caddy sets HSTS (`max-age=31536000; includeSubDomains`) and removes `Server`.
  - Full (strict) is the shared Cloudflare configuration rule `opscrew-strict-tls` (011).
  - The web filter limits the origin to Cloudflare's IP ranges (DOCKER-USER).
- **The Cloudflare adapter** (`connectors/cloudflare/src/client.ts`):
  - calls: DNS, rulesets, IP ranges, Zero Trust, tunnels, registrar, zone, DNSSEC;
  - **no zone settings and no certificates;**
  - CAA exists only as a record type;
  - token permissions: Zone Read, DNS Edit, Config Rules Edit, Zone WAF Edit.
- **Generated secrets** live only in `<projectHomeDir>/generated_values.json` (0600) and in GitHub Actions secrets (write-only), with no backup.
- **Valkey** is `internal-only` with no password. Redis 8 and Dragonfly set `requirepass` through a file.

## R1. Deeper checks: Lynis, ssh-audit, testssl.sh

- **Decision:** `opscrew secure --deep` adds three audits. Each is pinned, read-only, and mapped to OpsCrew's severities, with a noise list kept as data.
  - **Lynis 3.1.7** (GPL-3.0, maintained, yearly releases) runs **on the server**, as root, through Docker, because the `deploy` user has no sudo on Hetzner and DigitalOcean servers (cloud-init gives it none, and root login is off) but is in the docker group on every OpsCrew server.
    - OpsCrew starts a throwaway container from a pinned minimal image with the host's root filesystem mounted **read-only** at `/hostfs`, `--pid=host --net=host`, a tmpfs at `/hostfs/tmp` and `no-new-privileges`.
    - It streams the pinned tarball in on stdin, checks its SHA-256, and runs `chroot /hostfs /tmp/lynis/lynis audit system --quick --no-colors --report-file /tmp/report.dat`. Lynis then sees the host's own `/etc`, packages, processes and kernel.
    - It reads the key=value report (`hardening_index`, `warning[]=ID|text|details|solution`, `suggestion[]`), and the container goes with its tmpfs. Nothing is written to the host.
    - Lynis has no Docker image of its own, and it needs the host's real filesystem. The read-only mount, the tmpfs and the absence of host detection under chroot are *(verify in the spike)*.
  - **ssh-audit v3.9.0** (MIT) runs **from the user's machine** in `positronsecurity/ssh-audit` pinned by digest, against port 22:
    - JSON output (`-jj`);
    - the built-in Ubuntu 24.04 server policy (`-P`) for a clean pass or fail;
    - 1–3 connections. `--dheat` and `-g` are never used.
  - **testssl.sh v3.2.4** (GPL-2.0) runs **from the user's machine** in `ghcr.io/testssl/testssl.sh` pinned by digest, with `--quiet --warnings batch --connect-timeout 10 --jsonfile-pretty -p -S -h host:443`:
    - it takes 20–60 s;
    - its severities run OK, INFO, LOW, MEDIUM, HIGH, CRITICAL;
    - a proxied host is tested at **Cloudflare's edge**, and the report says so.
- **The origin behind Cloudflare** is checked **from the server itself** (`openssl s_client` to 127.0.0.1 with the hostname's SNI): without the client certificate it is refused, and it serves the expected Origin CA certificate. The outside `--ip` route is blocked by the Cloudflare-only firewall.
- **Without Docker,** ssh-audit and testssl.sh are skipped with how to enable them, and Lynis still runs. **On Portainer,** only testssl.sh runs (no SSH).
- **Noise,** to suppress and explain *(verify on a real server)*:
  - **Lynis:** separate partitions (FILE-6310), the GRUB password (BOOT-5122), AIDE, malware scanners, USB and firewire, compilers.
  - **ssh-audit:** NIST curves, non-ETM MACs, the group14 KEX on OpenSSH 9.6.
  - **testssl.sh:** OCSP stapling (Let's Encrypt has ended OCSP), CT, CAA (handled by R4), HSTS preload.
- **Licences:** Lynis and testssl.sh are GPL and only invoked as external tools, never linked (constitution, Technology constraints).
- **Rationale:** independent tools auditors recognise, with no install on the user's side beyond Docker, which is already needed for local builds.
- **Alternatives:** running them on the server (testssl.sh would test the origin, which the firewall blocks for outsiders anyway); native binaries (testssl.sh does not run on Windows).

## R2. The encrypted secrets copy: SOPS + age

- **Decision** (founder, 2026-10-21: SOPS + age, in the repository and optionally in a folder):
  - **sops v3.13.3** (MPL-2.0, CNCF Sandbox) is **fetched by OpsCrew**:
    - the release's raw binary for the platform (`sops-v3.13.3.linux.amd64`, `.darwin.arm64`, `.exe`, …), with no archive to unpack;
    - checked against the SHA-256 in `pins.ts` (taken from the release's checksums file by the pin script);
    - cached under `~/.opscrew/tools/sops/3.13.3/`. The user installs nothing.
  - **age** (BSD-3) is **not fetched**. sops embeds the age library for encryption and decryption. The key is an X25519 key pair written in age's Bech32 forms (`AGE-SECRET-KEY-1…` and `age1…`), which `node:crypto` and a small Bech32 encoder produce. Tests check the result against age's own test vectors and round-trip through sops where it is installed.
  - **The copy** is `opscrew/secrets.sops.json`. Values are AES-256-GCM-encrypted, key names stay readable and are authenticated, and a MAC covers it. It lists the age recipients, and `opscrew/.sops.yaml` holds the creation rule. `.gitattributes` keeps both LF.
  - **What the copy holds** (lead decision, 2026-10-21): every file OpsCrew keeps on the user's machine for the project that it cannot rebuild. Only the generated secrets is not enough, because a new machine also lacks the infrastructure state, its passphrase and the deploy key, so provision would try to create a new server.
    - The files: the generated values, the deploy key and known hosts, the state passphrase, the deploy-secrets record, Portainer's generated values, the server record, the Cloudflare record and the infrastructure state of each root.
    - Each file is one value under its relative path, so only file names are readable.
    - Not in the copy: what the user supplies (provider tokens, the app's `.env`, the storage key) and history (approvals, costs, saved plans).
  - **Updating needs no key.** OpsCrew encrypts the local files to the recipients in `.sops.yaml` again, whenever one of them changed since the last copy. The private key is needed only to restore.
  - **The key** is created the first time.
    - OpsCrew writes the `AGE-SECRET-KEY-1…` line once, 0600, to a file at a path the user picks, outside the repository and OpsCrew's folders, and says to move it into a password manager and delete the file. This is the same in the CLI, MCP, the plugin and CI.
    - It is never printed. Printing it would bypass the redactor that all terminal output passes through (constitution IV), as would returning it in an MCP response.
    - OpsCrew does not keep it. The user can add a backup recipient (`age1…`).
  - **Restore** takes the key from a file or a hidden paste. It reaches sops only through `SOPS_AGE_KEY` in the child's environment, never on a command line.
- **Rationale:** the founder's choice. SOPS keeps per-secret diffs and is a standard tool the user can run without OpsCrew, and fetching it keeps the no-install promise.
- **Alternatives:** plain age through the `age-encryption` npm package (typage 0.3.1; no binary, but an opaque blob), rejected by the founder; writing SOPS files ourselves (no formal spec, so not advised).
- **Facts that shape the UX:**
  - **A public repository:** SOPS leaves key names readable, here only the file names. Anyone can keep a copy of the file and try it later ("harvest now, decrypt later"), so OpsCrew warns before the first commit to a **public** repository.
  - **Rotation:** encrypt the local files again to the new recipients, which needs no `sops updatekeys`. Old commits stay readable with the old key, so a leaked key means changing the secrets themselves.
  - **stdin and stdout:** `sops encrypt` and `sops decrypt` with `--input-type json --output-type json` and `--filename-override`, through pipes, so plaintext never touches the disk *(verify)*.
  - **A lost key:** without it or the backup key, nothing can be recovered (GitHub secrets are write-only). The user resets the services through the normal flows.
  - **Post-quantum:** age 1.3 has hybrid keys (`age1pq1…`). Whether sops 3.13 accepts them is *(verify)*; v1 uses classical X25519.
- **Windows:** sops's default key path is `%AppData%\sops\age\keys.txt`. OpsCrew always passes the key file explicitly. `path_regex` is matched with `/` separators.

## R3. Origin protection behind Cloudflare

- **Decision:** per-hostname only. OpsCrew never touches zone-wide or global settings (011's rule).
  - **Origin CA certificate:** `POST /certificates` with OpsCrew's CSR (ECDSA P-256), `request_type: origin-ecc`, `requested_validity: 5475` (15 years, Cloudflare's longest and its dashboard default), and **exactly the app's proxied hostnames** (no wildcard, so DNS-only names keep ACME).
    - The private key is generated on the user's machine and reaches the server only through the deploy secrets path.
    - Cloudflare sends no expiry notice, so OpsCrew tracks expiry.
    - Revoke is `DELETE /certificates/{id}` *(verify)*.
    - The token needs **Zone → SSL and Certificates → Edit**. The legacy Origin CA Key is not needed *(verify token-only, live)*.
  - **Authenticated Origin Pulls, per hostname:**
    - a self-signed client certificate per app (ECDSA P-256, 15 years), uploaded with `POST /zones/{z}/origin_tls_client_auth/hostnames/certificates` (`certificate`, `private_key`, `bundle_method: ubiquitous`);
    - then enabled per hostname with `PUT /zones/{z}/origin_tls_client_auth/hostnames` (`config: [{hostname, cert_id, enabled}]`);
    - per-hostname overrides the zone-level and global modes. Every plan has it, Free included;
    - Cloudflare warns 30 and 14 days before a client certificate expires.
  - **Lifetimes** (lead decision, 2026-10-21, after the analysis): 15 years for both. With one year, a user who stops using OpsCrew would have a site that breaks within a year, against constitution II ("a user who deletes OpsCrew keeps a working deployment"). The keys stay revocable, and only Cloudflare trusts the origin certificate. Provision still replaces a certificate when the hostnames change or fewer than 30 days remain.
    - The **global** shared certificate is never relied on, because any Cloudflare customer can present it.
  - **Caddy:**
    - per proxied site, `tls <cert> <key> { client_auth { mode require_and_verify; trust_pool file <client-cert.pem> } }`;
    - loaded certificates are shared by every site, so the certificate lists exact hostnames;
    - a catch-all site refuses unknown SNI.
  - **The order, with no failed request** (refined by the lead, 2026-10-21): the server only changes at the deploy, which runs after `provision` (the user merges its pull request, or provision starts it). So:
    1. provision uploads the client certificate and enables it for the hostnames;
    2. it waits until Cloudflare reports each hostname's setting `active` *(verify the status field)*;
    3. only then does it publish the origin certificate and the site that requires the client certificate, so the origin never requires before Cloudflare sends.

    The intermediate `request` mode is kept only as a fallback, if the live run shows `active` arriving before Cloudflare really sends.
  - **Leaving the proxy:** a hostname that leaves the proxy (to DNS-only) takes two runs.
    1. The first run's deploy gives the origin a public certificate (HTTP-01 works through Cloudflare's proxy) and drops the requirement, while the DNS record stays proxied.
    2. The next run switches the record and removes the per-hostname setting.

    Switching the record first would send visitors straight to an origin with a certificate browsers do not trust. Joining the proxy takes one run, because the origin keeps its public certificate until the deploy.
  - **Renewal:** provision issues the new origin certificate with fewer than 30 days left and starts a deploy (`dispatchWorkflow`, as retarget does) when nothing else changed. The next run revokes the old certificate once the server serves the new one, read over SSH or through Portainer's API, and destroy revokes the current one.
  - **Ownership:** the Cloudflare changes go through **011's shared-resources adapter**: typed calls, planned, approved by the plan's hash, and recorded per app in `.opscrew/cloudflare.json`. No Terraform for these, because Terraform's `cloudflare_authenticated_origin_pulls` holds every hostname in one list.
- **Key material without a new dependency:**
  - `node:crypto` generates P-256 keys, exports SPKI DER and signs.
  - A small DER writer in `packages/core` builds the PKCS#10 CSR (subject CN, the SAN extensionRequest) and the self-signed client certificate (v3; serial; one-year validity; basicConstraints CA:false; keyUsage digitalSignature; extKeyUsage clientAuth).
  - Tests parse the certificate with `node:crypto`'s `X509Certificate` and check its signature, and parse the CSR with `openssl req -verify` where it is installed.
- **Alternative rejected:** `@peculiar/x509` (MIT), with about 10 transitive dependencies (asn1-*, tsyringe, reflect-metadata) for two small structures (constitution X).

## R4. CAA and minimum TLS

- **CAA:**
  - **Where:** only at the app's own hostnames whose certificate comes from the server's proxy (DNS-only). Never at the zone apex or other names, because CAA is inherited down the tree, so an apex record would restrict every other app and the user's own sites.
  - **Values:**
    - with Caddy: `0 issue "letsencrypt.org"` and `0 issue "sectigo.com"` (ZeroSSL, Caddy's fallback) *(verify ZeroSSL's CAA name)*;
    - with nginx and certbot: `letsencrypt.org` only.
  - **Proxied hostnames** get no CAA. Cloudflare adds its own CAs' records automatically once any CAA exists in the zone (Let's Encrypt, Google Trust Services `pki.goog`, SSL.com).
  - **Records that are not OpsCrew's** at those names are reported, not replaced.
  - **Not in v1:** `accounturi`, `validationmethods`, `iodef`.
- **Minimum TLS:**
  - **The zone setting** (`GET`/`PATCH /zones/{z}/settings/min_tls_version`) is changed to `1.2` **only when** it is still the default (`1.0`) **and** every proxied hostname in the zone belongs to an OpsCrew app (from the DNS records and the apps' records). Otherwise `secure` advises it.
  - **Per-hostname min TLS** (`PUT /zones/{z}/hostnames/settings/min_tls_version/{host}`) needs Advanced Certificate Manager *(verify on Free)*. It is offered only if it works.
  - **A record of what OpsCrew set** in the zone (`.opscrew/cloudflare.json` and the zone's OpsCrew-owned record) means the value is never mistaken for someone else's.
  - **The origin** already offers TLS 1.2 and newer on Caddy, and the nginx template does the same.

## R5. The proxy choice: Caddy with additions, nginx with certbot

- **Decision** (founder, 2026-10-21: both): **Caddy stays the default**, **nginx is a managed alternative**, and **user additions** work with either. Apache and Traefik are only on request.
- **nginx:**
  - **Image:** `nginxinc/nginx-unprivileged` (Apache-2.0, non-root, listens on 8080 and 8443 internally, rebuilt weekly), stable 1.30.x, pinned by digest.
  - **Reload:** `nginx -s reload` keeps connections, and a bad config keeps the old one.
  - **HTTP/3** is not offered on nginx in v1 *(verify the module in the image)*.
- **Certbot** (`certbot/certbot`, pinned) runs as an edge service:
  - webroot HTTP-01, with `/.well-known/acme-challenge` served by nginx from a shared volume;
  - `certbot renew` twice a day with a random delay, with `renew_before_expiry = 45 days`, so a renewal that keeps failing is visible to `verify`, `status` and `secure` (which warn below 30 days) for more than two weeks first. Certbot's default is a third of the lifetime, 30 days for today's 90-day certificates. Let's Encrypt's planned shorter lifetimes will need these numbers revisited;
  - `--deploy-hook` touches a flag file that a small loop in the nginx container watches, then it runs `nginx -s reload`. There is no Docker socket in either container;
  - one certificate per app, `--cert-name <app>`;
  - `/etc/letsencrypt` on a named volume;
  - **the first certificate:** nginx starts the app's site on HTTP only (webroot plus a temporary redirect off), certbot issues, then OpsCrew writes the TLS site and reloads. This happens during the first deploy;
  - **rate limits:** 5 duplicate certificates a week and 5 failed validations an hour. The message names the limit.
- **The hardened nginx template** matches Caddy's posture:
  - Mozilla's intermediate profile: `ssl_protocols TLSv1.2 TLSv1.3`, the ECDHE AES-GCM and CHACHA20 suites, session tickets off *(read the current block at configurator.tlsref.org before pinning)*;
  - HSTS and baseline headers (`X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`) on every location, which avoids the `add_header` inheritance trap;
  - `server_tokens off`;
  - to kamal-proxy: `proxy_set_header Host $host` and `X-Forwarded-For/-Proto/-Host`, `proxy_http_version 1.1` with Upgrade and Connection for WebSockets;
  - `proxy_read_timeout 300s`, `client_max_body_size 100m` (a plan setting), buffering off for streaming;
  - an HTTP→HTTPS redirect, and a `default_server` returning 444.
  - Whether kamal-proxy honours the forwarded headers is *(verify, Docker)*.
- **Proxied hosts on nginx** use the Origin CA certificate and `ssl_verify_client on` with `ssl_client_certificate <client-cert.pem>`. certbot is not used for them.
- **Caddy gains** the same baseline headers, a catch-all that refuses unknown hostnames, and the Origin CA certificate with `client_auth` (R3).
- **User additions:** `opscrew/proxy/<app>.caddy` or `opscrew/proxy/<app>.nginx.conf`, included inside the app's own site block.
  - **Validation** happens in a throwaway container from the pinned image, against the full rendered config, with placeholder certificates: `caddy validate --adapter caddyfile`, or `nginx -t`.
  - **OpsCrew's rules** refuse:
    - a TLS version older than 1.2;
    - an admin API or metrics exposed;
    - `proxy_pass` or `reverse_proxy` to anything but OpsCrew's upstream;
    - a server name or host that is not the app's;
    - `autoindex`, and `root`/`alias` outside the app's static folder.
  - **gixy-ng** (MPL-2.0, PyPI) runs optionally for nginx when the user has it *(verify the release)*.
- **Rate limits and basic authentication in additions:**
  - nginx's template defines one request zone per app (`limit_req_zone … zone=opscrew_<app>`), so an addition can use `limit_req zone=opscrew_<app>`.
  - Caddy's standard build has no rate limiter, so the guide points to Cloudflare's rate-limiting rules.
  - For basic authentication, `basic_auth` with bcrypt hashes works in Caddy. nginx's `auth_basic_user_file` is refused in v1 (a file outside the site), and the guide suggests Cloudflare Access.
- **One proxy per server:** every app on a server shares the edge's proxy. A conflicting choice is refused. In v1 a switch is offered only while the server holds one OpsCrew app: each app's deploy writes only its own site file, so the other apps' sites would stay in the old proxy's syntax. The switch stops one proxy and starts the other: a few seconds for proxied hostnames, whose origin certificates are already files, and under a minute for DNS-only ones while certbot obtains their first certificates.
- **Portainer** stacks keep Caddy in v1. Their stack proxy gets R3's protection when OpsCrew runs it.

## R6. A password for Valkey

- **Decision:** like Redis 8. `requirepass` is written to a config file from the service's env at start (never on the command line), with a generated `hex32` password. The app's address becomes `redis://:<password>@<name>:6379`, and every alias follows through `urlService`. `secure` checks that a connection without the password is refused.
- **Existing deployments:** the next provision adds the password. Valkey restarts once with its data (AOF/RDB) kept, and queued jobs survive, because the volume is unchanged.
- **Kafka, Redpanda, OpenSearch** stay `internal-only` until 017's split placement adds logins for services that cross servers.

## Open items for the spike (T1402) and the live runs

1. A Cloudflare token with **SSL and Certificates: Edit** creates an Origin CA certificate (no Origin CA Key), and `DELETE /certificates/{id}` revokes it.
2. Per-hostname AOP on the Free plan: the certificate upload, enabling it, listing, deleting; and Cloudflare presenting the certificate to the origin.
3. Per-hostname minimum TLS on Free (or only with ACM), and the zone setting's read and write.
4. The Free plan's configuration-rule count (011 recorded 10) is unchanged by 014, which adds no rule.
5. nginx-unprivileged's `nginx -V` (HTTP/3 module), and kamal-proxy behind nginx (Host, X-Forwarded-*, WebSockets).
6. The current Mozilla intermediate nginx block (configurator.tlsref.org).
7. ssh-audit's JSON layout and the Ubuntu 24.04 policy name; testssl.sh's JSON and grade; Lynis's report keys and run time on a cx22/cx23.
8. sops: encrypt and decrypt through pipes (`--filename-override`), age 1.3 hybrid recipients, and the asset names and checksums per platform.
9. ZeroSSL's CAA issuer name.
10. Lynis through Docker: chroot into the read-only host filesystem with a tmpfs `/tmp`, run time, and that Lynis does not take itself for a container.
11. Cloudflare's per-hostname AOP `status` values, and how long `active` takes.
12. nginx-unprivileged running as the deploy user's uid (so it can read the 0600 origin key), and the reload loop's zombies under `init: true`.
13. The Docker pass's ACME server: Pebble (Let's Encrypt's test CA) for certbot's first certificate and renewal, and for Caddy.
14. `openssl s_client` from the server to its own published port 443 under the web filter (DOCKER-USER), for the origin check.
15. Cloudflare accepting a 15-year self-signed client certificate for per-hostname AOP, and a 15-year Origin CA certificate (`requested_validity: 5475`) with a token only.
16. Portainer CE's Git redeploy (webhook, image re-pull): whether it recreates services whose definition did not change, and Caddy's `lb_try_duration` holding requests while the app restarts. Also how the deploy's version check (today `X-OpsCrew-Image`, from a variable in Caddy's service) can stay without changing Caddy's service on each deploy (T1416).
