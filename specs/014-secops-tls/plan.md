# Implementation Plan: SecOps and TLS

**Branch**: `main` | **Date**: 2026-10-21 | **Spec**: `specs/014-secops-tls/spec.md` |
**Research**: `specs/014-secops-tls/research.md` (R1–R6, the open items for the spike)

## Summary

**Only Cloudflare reaches the origin.** For every proxied hostname of an app whose proxy OpsCrew
runs:
- the origin serves a Cloudflare Origin CA certificate for exactly the app's proxied hostnames;
- it requires a client certificate of the app's own, which Cloudflare presents through per-hostname
  Authenticated Origin Pulls;
- a catch-all refuses every other hostname.

The keys are made on the user's machine. The Cloudflare side goes through feature 011's shared
plan, approved by its hash.

**A recovery copy.** `opscrew/secrets.sops.json` holds every local file OpsCrew cannot rebuild:
generated secrets, the deploy key, the infrastructure state and its passphrase, and the records.
SOPS encrypts it to the user's age key and an optional backup key. It is committed through
OpsCrew's pull requests and optionally copied to a folder. OpsCrew fetches a pinned sops itself, and
`opscrew secrets status|restore|rotate|folder` uses it.

**Deeper checks.** `opscrew secure --deep` adds three audits, each pinned, read-only and mapped to
OpsCrew's severities with the known noise set apart:
- Lynis, through Docker on the server;
- ssh-audit and testssl.sh, in containers on the user's machine.

**CAA and minimum TLS.** CAA records at the app's own DNS-only hostnames, in the IaC engine's DNS
module. The zone's minimum TLS goes to 1.2 only when OpsCrew may, through the shared plan.

**A choice of proxy.**
- `target.edge` is `caddy` (the default) or `nginx`, per server.
- nginx runs with certbot, which obtains the first certificate during the first deploy and renews
  twice a day, with a reload that drops nothing.
- Both proxies get the same hardened template.
- The user's additions per app are scanned by OpsCrew's rules and checked by the proxy itself
  before going live.

**Valkey** requires a generated password, like Redis 8.

## Technical Context

- **Stack:** the same as 000–013. **No new npm dependency.**
  - Key pairs, the CSR and the self-signed client certificate are built with `node:crypto` and a
    small DER writer in `packages/core`. Tests verify them with `node:crypto`'s `X509Certificate`
    and with `openssl` where it is installed.
  - Age keys are X25519 pairs in Bech32 (R2).
- **External tools, all pinned, none linked into the CLI:**
  - sops 3.13.3 (MPL-2.0): a binary OpsCrew fetches and checks by SHA-256;
  - Lynis 3.1.7 (GPL-3.0): a tarball checked by SHA-256 and run on the server;
  - ssh-audit 3.9.0 (MIT) and testssl.sh 3.2.4 (GPL-2.0): images pinned by digest, run on the
    user's machine;
  - nginx-unprivileged 1.30 and certbot: images pinned by digest, on the server;
  - gixy-ng: optional, used only when installed.
- **Cloudflare API calls** (R3, R4): Origin CA create, list and revoke; per-hostname AOP
  certificates (upload, list, delete); per-hostname AOP settings (put, list); the zone setting
  `min_tls_version` (get, patch). The token needs **SSL and Certificates: Edit** and **Zone
  Settings: Edit**, checked up front.
- **To verify in the spike** (T1402, research's open items 1–14): Cloudflare's token-only Origin
  CA, AOP on Free with its `active` status, sops through pipes, Lynis through Docker, nginx as the
  deploy user's uid, Pebble, and the origin check from the server.
- **Tests:**
  - fakes and snapshots, as before;
  - the Docker pass (T1412): both proxies with Pebble as the ACME server, a simulated renewal
    under load, the additions checker, and Lynis, ssh-audit and testssl.sh against a local
    container server;
  - gated live tests on Hetzner, an own server and Portainer with the real Cloudflare zone (T1413).

## Constitution Check

- **I (safety gate).** No new mutation path and no new approval kind:
  - **At Cloudflare:** origin certificates, client certificates, per-hostname settings and the
    zone's minimum TLS are new change kinds in **011's shared plan**, read first, approved by its
    hash and applied through the typed Cloudflare adapter. The plan carries certificate
    fingerprints and the CSR, never a private key; the apply reads the key from the generated
    values.
  - **CAA records:** in the IaC engine's DNS module, planned, checked and approved like the A
    records.
  - **On the server:** the edge's files (nginx or Caddy, certbot, sites, additions) and the origin
    certificate arrive with the deploy, as runtime files and env files do today.
  - **The deeper check** changes nothing (read-only mount, tmpfs).
  - **The repository copy:** provision's pull request carries it, and so do `rotate`'s and
    retarget's. The folder copy is a local file.
  - **Destroy** revokes and removes only the app's own certificates and settings.
- **II (user owns everything).**
  - The proxy templates and the user's additions are files in the repository.
  - The recovery copy opens with standard sops and the user's key, without OpsCrew.
  - The proxy choice is one field in `plan.yaml`.
  - Origin and client certificates last 15 years, so a user who stops using OpsCrew keeps a
    working site. certbot renews nginx's certificates on the server by itself.
- **III (dual engine).** The CAA records are `cloudflare_dns_record` resources in the common
  dialect, validated by both engines. Nothing else touches the IaC roots.
- **IV (secrets).**
  - **The origin key** lives in the generated values on the user's machine, which the recovery
    copy encrypts. It reaches the server only as a deploy secret written over SSH's stdin with
    `umask 077`, or as a Portainer stack variable through the API.
  - **The client key** lives in the generated values, and goes to Cloudflare once in the upload's
    body.
  - **The age private key** is never kept by OpsCrew. It is written once, 0600, to a file at a
    path the user picks, and never printed, logged or returned through MCP. Printing it would
    bypass the redactor that every terminal line passes through.
  - **The committed copy** is SOPS ciphertext only: AES-256-GCM values, with data keys wrapped to
    the user's age recipients, which the founder chose (2026-10-21). No plaintext secret ever
    enters a file, a commit or the history.
  - **sops** gets the key only through its child environment.
  - **No key or value** appears in a plan, the audit log, the report or IaC state. AOP stays out
    of Terraform, because its upload resource would put the private key in state.
- **V (deterministic first).** Every check, rule, certificate decision and parser is a pure
  function or a pinned tool. No model is involved.
- **VI (contracts first).** One serial task (T1401a) changes the contracts, recorded in ADR 0017:
  - `target.edge`;
  - `CheckResult.source` and `CheckResult.noise`;
  - the record fields;
  - the new `SharedChange` kinds.
- **VIII (typed adapters).** The Cloudflare adapter gains the certificate and setting calls. No
  shell call reaches Cloudflare.
- **IX (plain language).** Every refusal and warning says what to do: a missing permission, an
  unsafe addition, a proxy conflict, a rate limit, a lost key, a public repository.
- **X (simplicity).**
  - No new npm dependency (`@peculiar/x509` rejected, R3).
  - age is not fetched, because sops embeds it.
  - One shared plan for every Cloudflare change.
  - One check path for both proxies.
  - Lynis through Docker on every server, instead of sudo on some and Docker on others.

## Project Structure

| Package | Change |
|---|---|
| `packages/plan-schema`, `packages/contracts`, `packages/connectors/cloudflare/src/shared.ts` (types only) | `target.edge`, `app.maxBodyMb`; `CheckResult.source` and `.noise`; `SharedRecord.tls` and `.zoneSettings`; the new `SharedChange` and `SharedFinding` codes; every reader and writer of the changed types (T1401a) |
| `docs/adr/0017-origin-tls-and-recovery.md` | the ADR (lead, committed) |
| `packages/iac-templates` (pins, `scripts/update-pins.mjs`), `packages/core` (tools, crypto) | pins for sops per platform, the Lynis tarball, the ssh-audit, testssl.sh, nginx-unprivileged, certbot and Pebble images; the pinned-tools fetcher and the sops runner; P-256 keys, the CSR and the client certificate; age keys (T1401b) |
| — | the spike (T1402, lead) |
| `packages/connectors/cloudflare` | the certificate and setting calls; inspect, plan and apply of the new change kinds; the permission check (T1403) |
| `packages/agents/src/secrets` (new), the copy in `provision/publish.ts` and `retarget/finish.ts` | the recovery copy: collect, encrypt, write, restore, rotate, status, the public-repository check, and the copy in provision's and retarget's pull requests (T1404) |
| `packages/secops` (deep), `packages/agents/src/secure` (deep only) | Lynis through Docker, ssh-audit, testssl.sh, the parsers, the noise data, the report section (T1405) |
| `packages/iac-templates` (edge, runtime services, workflow switch and upload, portainer-target) | Caddy: origin certificate and `client_auth`, baseline headers, catch-all, additions import; the origin files in the deploy; Portainer's stack Caddy (T1406) |
| `packages/iac-templates` (edge nginx, certbot, workflow nginx switch, the checker step) | the nginx edge: template, certbot, first certificate, reload loop, switch between proxies; the proxy's own checker in the deploy job for both proxies (T1407) |
| `packages/secops` (proxy rules) | OpsCrew's rules for additions, a pure scan (T1408) |
| `packages/agents` (provision, destroy, retarget) | the origin TLS flow, CAA facts, minimum TLS, the proxy conflict and switch, the recovery copy in the pull requests, renewal (T1409a) |
| `packages/agents` (drift, status, secure, verify) | drift of the client-certificate requirement; expiries; the proxy; the copy's state; origin checks from the server; gaps (T1409b) |
| `packages/iac-templates` (catalog), `packages/iac-templates/src/infra` (CAA in the DNS module) | Valkey's password; CAA records (T1410) |
| `packages/plan-schema` (facts), `packages/detect` | `ProjectFacts.platformRouting` from `vercel.json` (T1417a) |
| `packages/iac-templates` (edge translation), `packages/agents/src/design` | `vercel.json` rules translated into the app's additions (T1417b) |
| `packages/cli`, `packages/mcp-server`, `plugin`, `docs/guide`, `packages/iac-templates/src/runbook` | `opscrew secrets …`, `secure --deep`, the token permissions in `init`, the runbook, the guide pages (T1411) |
| `examples/`, `packages/cli/test/e2e` | the Docker pass (T1412) |
| `packages/cli/test/live`, `docs/e2e*.md` | live tests (T1413), then the live runs (T1414, lead) |

## Design

### 1. Contracts, plan and records (T1401a, serial, lead-reviewed)

- **`plan.yaml`:**
  - `target.edge: "caddy" | "nginx"` on cloud and own targets, defaulting to `caddy`. Portainer
    stacks keep Caddy, so the field is absent there.
  - `app.maxBodyMb`, defaulting to 100, for nginx's upload limit.
- **`CheckResult`:**
  - `source?: string`: the tool (`lynis`, `ssh-audit`, `testssl`), absent for OpsCrew's own
    checks;
  - `noise?: string`: known noise, with the reason it is set apart.
- **`SharedRecord`** (`.opscrew/cloudflare.json`):
  - `tls?`: the origin certificate (Cloudflare id, hostnames, expiry, SHA-256 fingerprint) and the
    client certificate (id, expiry, fingerprint), with the hostnames it is enabled for and the
    hostnames waiting to be removed (`retiring`);
  - `zoneSettings?`: `{ minTlsVersion: { setAt, previous } }` when OpsCrew set it.
- **`SharedChange`** kinds: `create-origin-certificate` (hostnames, CSR),
  `revoke-origin-certificate` (id), `upload-client-certificate` (fingerprint),
  `enable-client-certificate` (hostnames, fingerprint), `disable-client-certificate` (hostnames),
  `delete-client-certificate` (id), `set-min-tls` (`1.2`, expected `1.0`).
- **`SharedFinding`** code `hostname-tls-claimed` (another app's certificate covers the
  hostname), which blocks the plan like 011's findings.
- **`SharedPlan.advice[]`** (local part, outside the hash), for what never blocks the plan:
  `tls-permission-missing` and `min-tls-advised`, each with a message and a hint.
- **`SharedRecord.tls.gap`**: `"permission"` while the token lacks the certificate permissions,
  so `secure` reports the gap (FR-1405).
- **ADR 0017** (lead, committed): origin TLS through the shared plan, the recovery copy and what
  it holds, Lynis through Docker, and `target.edge`.

### 2. Pins, tools and key material (T1401b)

- **Pins** (`pins.ts`, kept current by `update-pins.mjs`):
  - `LOCAL_TOOLS.sops`: version, and an asset and SHA-256 per platform (linux, darwin and windows,
    on amd64 and arm64), from the release's checksums file;
  - `TOOLS.lynis`: version, tarball URL and SHA-256;
  - `IMAGES`: ssh-audit, testssl.sh, nginx-unprivileged, certbot and Pebble (Pebble for tests
    only), each by digest.
- **`fetchPinnedTool(pin, deps)`** in `packages/core`:
  - downloads to a temporary file under `~/.opscrew/tools/<name>/<version>/`, checks the SHA-256,
    then moves the file into place with mode 0755, and returns its path;
  - a cached file is checked again before each use;
  - `OPSCREW_SOPS_BIN` overrides the download (tests, offline users);
  - errors say which URL failed and how to place the file by hand.
- **Key material** in `packages/core/src/crypto`:
  - `generateP256()`;
  - `buildCsr({ key, hostnames })`, PKCS#10 with the SAN extension request;
  - `selfSignedClientCertificate({ key, commonName, days })`, X.509 v3 with clientAuth;
  - `generateAgeIdentity()`, which returns `{ identity, recipient }`;
  - a minimal DER writer (SEQUENCE, SET, INTEGER, OID, BIT STRING, OCTET STRING, UTF8String,
    UTCTime, context tags).

### 3. The spike (T1402, lead)

With the e2e Cloudflare token and local Docker, settling research's open items. The results go in
research.md, and the tasks after it read them.

### 4. The Cloudflare adapter (T1403)

- **Calls** on `CloudflareClient`, each with zod-checked responses:
  - `createOriginCertificate`, `listOriginCertificates(zoneId)`, `revokeOriginCertificate`;
  - `uploadHostnameClientCertificate`, `listHostnameClientCertificates`,
    `deleteHostnameClientCertificate`;
  - `putHostnameAopSettings`, `listHostnameAopSettings`;
  - `getZoneSetting("min_tls_version")`, `patchZoneSetting`.
- **`inspectShared`** also reads, for the app's hostnames:
  - the zone's origin certificates;
  - the per-hostname AOP settings and certificates;
  - the zone's minimum TLS and its proxied DNS records, for the "only OpsCrew apps" test.

  A 403 on any of them becomes the `tls-permission-missing` advice.
- **`planShared`:**
  - It adds the origin TLS changes for the desired hostnames. The desired state carries the CSR
    and the client certificate's fingerprint.
  - It computes the minimum-TLS decision (R4). "Every proxied hostname is an OpsCrew app's" means
    every proxied A, AAAA or CNAME record in the zone carries the `Managed by OpsCrew` comment.
  - It refuses a hostname another app's certificate already covers.
- **`applyShared`:**
  - It applies in the contract's order: upload, then enable and wait for `active` (bounded, with
    a plain timeout message), then create the origin certificate, disable, delete, revoke, and
    finally `set-min-tls`, before 011's rule changes.
  - Each change's result goes into the record before the next one, so a failure part-way leaves
    a record the next plan continues from.
  - `upload-client-certificate` takes the PEM pair from a `keys` argument the caller passes, never
    from the plan.
- **The token's permissions:** `CLOUDFLARE_TOKEN_PERMISSIONS` gains SSL and Certificates: Edit and
  Zone Settings: Edit, and `init` lists them.

### 5. The recovery copy (T1404)

- **Files** (`agents/src/secrets/files.ts`): a fixed list, read if present.
  - From `projectHomeDir`: `generated_values.json`, `deploy_key`, `deploy_key.pub`,
    `known_hosts`, `state_passphrase`, `deploy_secrets.json`, `portainer-env.key`,
    `portainer-webhook` and `portainer_password`.
  - From `.opscrew`: `tfstate/*.tfstate`, `server.json` and `cloudflare.json`. Not `state.json`,
    which only records phase outcomes and would change the copy on every run.

  Each file becomes one string value under its relative path (`home/deploy_key`,
  `state/tfstate/prod.tfstate`).
- **`refreshRecoveryCopy(deps)`:**
  - It hashes the files and compares the hashes with `.opscrew/recovery.json` (hashes and the
    last copy's time, no values).
  - On a change, it runs `sops encrypt` through pipes to the recipients in `opscrew/.sops.yaml`,
    writes the folder copy at once, and returns the repository file for the caller's pull request.
  - It needs no private key.
  - It records the SHA-256 of the copy it last wrote. When the repository's copy differs from that
    (another machine updated it), it stops and says to run `opscrew secrets restore` first
    (FR-1417).
  - When sops cannot be fetched, it warns, leaves the local files as they are and lets the run
    go on, and `status` shows the copy as behind (FR-1416).
- **The first time** (no `.sops.yaml`):
  - It generates the key and writes it once, 0600, to a file at a path the user picks. The path
    is asked interactively, or given with `--key-out`, and must be outside the repository and
    OpsCrew's folders. OpsCrew says to move the key into a password manager and delete the file.
    It offers a backup recipient.
  - It writes `.sops.yaml` (the creation rule for `secrets.sops.json`, with the recipients) and
    `.gitattributes` lines.
  - For a public repository, it asks before committing. A non-interactive run writes only the
    folder copy and says why.
- **`restore`** (key file or hidden paste):
  - It runs `sops decrypt` through pipes, with `SOPS_AGE_KEY` in the child's environment.
  - It writes each file back with its mode (0600 for secrets).
  - A local file that differs stops the restore and lists the differing paths and generated value
    names. `--use-copy` or `--keep-local` decides.
  - A wrong key stops with nothing written.
- **`rotate`:** generates a new key, keeps or replaces the backup (`--backup <age1…>`,
  `--no-backup`), encrypts the local files again, and proposes the two files in a pull request
  through provision's publish step. It explains that old commits stay readable with the old key.
- **`status`:** the copy's `sops.lastmodified`, the number of recipients, whether the repository
  copy is behind the local files, and the folder copy's path.
- **The folder** is set with `opscrew secrets folder <path>` and kept in `.opscrew/secrets.json`.
  It is local, because a path belongs to one machine.

### 6. The deeper checks (T1405)

- **`secure --deep`** runs the three audits after today's checks. Without `--deep`, nothing
  changes (FR-1425).
- **Lynis** (R1):
  - `docker run --rm -i` over SSH as `deploy`, from the pinned minimal image, with
    `-v /:/hostfs:ro --tmpfs /hostfs/tmp --pid=host --net=host --security-opt no-new-privileges`;
  - the tarball goes in on stdin and is checked by SHA-256 in the container;
  - `chroot /hostfs` runs Lynis with `--quick --no-colors --report-file /tmp/report.dat`, and the
    report comes back on stdout;
  - the image is removed afterwards when it was not on the server before, so nothing stays
    (FR-1421);
  - the parser reads `hardening_index`, `warning[]` and `suggestion[]`. Warnings become `warn`
    results at medium, suggestions low, and an index below 65 becomes a medium finding.
- **ssh-audit:** `docker run --rm` of the pinned image with `-jj -P "<Ubuntu 24.04 policy>"` and
  the server's SSH port. A policy failure becomes high, and each failing algorithm low.
- **testssl.sh:** the pinned image with `--quiet --warnings batch --connect-timeout 10
  --jsonfile-pretty /dev/stdout -p -S -h` per public hostname. Its severities map one to one, and
  INFO and OK are dropped. A proxied hostname is labelled "Cloudflare's edge".
- **Noise** (`secops/src/deep/noise.ts`): per tool, an id with its reason, from R1. A matching
  result keeps its data and gets `noise`.
- **Skips:**
  - without Docker on the user's machine: ssh-audit and testssl.sh, with how to install Docker;
  - a blocked connection (refused, or fail2ban): the run says so instead of passing;
  - on Portainer: Lynis and ssh-audit, with the reason.
- **The report** gains a "Deeper checks" section per tool, with its version, results and noise.
  OpsCrew's own fixable items (an SSH option) name the plan that changes them.
- **OpsCrew's own SSH algorithms** (T1418, R8): the sshd drop-in that cloud-init writes and the
  own-server host plan applies gains ssh-audit's Ubuntu 24.04 algorithm lists, offers only the
  ED25519 and RSA host keys, and filters the moduli. So the policy passes on OpsCrew's servers
  apart from the RSA-size noise.

### 7. Caddy: origin TLS, headers, additions (T1406)

- **The site for proxied hostnames:**
  - `tls /etc/caddy/tls/<app>/origin.pem /etc/caddy/tls/<app>/origin.key { client_auth { mode
    require_and_verify; trust_pool file /etc/caddy/tls/<app>/pull.pem } }`;
  - with the exact hostnames;
  - no `auto_https` option. Caddy skips ACME for exactly the names a loaded certificate covers, so
    DNS-only names keep ACME, and `ignore_loaded_certs` would make it ask Let's Encrypt for the
    proxied names too (T1406).
- **Every site gets the baseline headers:** HSTS (as today), `X-Content-Type-Options nosniff`,
  `Referrer-Policy strict-origin-when-cross-origin`, `-Server`.
- **The edge's Caddyfile:** a catch-all `https://` site with `tls internal { on_demand }` and
  `abort`, plus `:80` redirects only for known hosts, so unknown SNI and Host are refused
  *(the exact form is checked in the Docker pass)*.
- **The deploy writes the origin files:**
  - the PEM bundle comes from the deploy secret `OPSCREW_ORIGIN_TLS`, through SSH's stdin, to
    `/srv/edge/tls/<app>/`, with `umask 077`;
  - `pull.pem` is a committed runtime file, because it is public.
  - The site file is switched only after the files are in place.
- **Additions:** `opscrew/proxy/additions.caddy` is uploaded as `/srv/edge/sites/<app>.additions`
  and imported inside the app's site block.
- **Portainer's stack Caddy** (`web: caddy`):
  - the PEM bundle, with `pull.pem`, reaches it as a stack variable;
  - a two-line entrypoint writes it to a tmpfs before `caddy run`;
  - the site is the same.

### 8. The nginx edge (T1407)

- **`edge: nginx`** renders `/srv/edge` with nginx-unprivileged, certbot and kamal-proxy.
  - **nginx:** `user:` set to the deploy user's uid, `init: true`, ports 80 and 443 to 8080 and
    8443, and `server_tokens off`.
  - **The template** (R5): TLS 1.2 and 1.3, Mozilla intermediate, HSTS and the baseline headers
    in every `server` (the `add_header` trap), WebSockets, `proxy_read_timeout 300s`, and
    `client_max_body_size` from the plan (`100m` by default). Host and `X-Forwarded-*` go to
    kamal-proxy, the HTTP to HTTPS redirect is per known host, and a `default_server` returns 444
    on both ports.
  - **Per app:** `sites/<app>.conf`, a request zone `opscrew_<app>`, and an
    `include sites/<app>.additions` inside the app's TLS server.
- **Proxied hostnames** use `/srv/edge/tls/<app>/` with `ssl_verify_client on` and
  `ssl_client_certificate pull.pem`.
- **DNS-only hostnames** use certbot:
  - webroot `/var/www/acme`, shared read-only with nginx;
  - `/etc/letsencrypt` on a named volume;
  - `--cert-name <app>`;
  - `certbot renew` every 12 hours with a random delay, and `renew_before_expiry = 45 days`;
  - the deploy hook touches `/var/www/reload/flag`, and a loop in the nginx container reloads
    when the flag appears. No container has the Docker socket.
- **The first certificate** (the deploy's edge step):
  1. With no certificate yet, the app's site is written for HTTP only, with the webroot, and
     nginx reloads.
  2. `docker compose run --rm certbot certonly --webroot …` obtains the certificate.
  3. The TLS site is written, `nginx -t` checks it, and nginx reloads.

  On failure (DNS not here yet, a rate limit), the site stays on HTTP, and the deploy ends with
  the reason and when to retry.
- **Switching proxies** (only while the server holds one OpsCrew app, because each app's deploy
  writes only its own site file):
  - the deploy stops the old edge's proxy and starts the other, then runs the first-certificate
    step for DNS-only hostnames;
  - the interruption is a few seconds for proxied hostnames, and under a minute for DNS-only ones
    while certbot obtains their first certificates (R5);
  - kamal-proxy and the apps stay up;
  - certbot's and Caddy's volumes are kept, so a switch back is quick.

### 9. Additions: rules (T1408) and checker (T1407)

- **OpsCrew's rules** (`secops/src/proxy-rules`) are a pure scan of the file. Each refusal gives
  its line and reason. They refuse:
  - `ssl_protocols` or `protocols` below TLS 1.2;
  - `admin`, metrics or status endpoints (`stub_status`, `metrics`);
  - `proxy_pass` or `reverse_proxy` to anything but the app's upstream;
  - `server_name` or a host matcher that is not one of the app's hostnames;
  - `root`, `alias`, `autoindex`, `file_server` and `auth_basic_user_file`, because the edge
    serves no files of its own;
  - `include` and `import`;
  - Lua and `js_` modules.
- **The checker:**
  - The deploy job runs the pinned proxy image on the runner against the full rendered edge
    configuration, with placeholder certificates: `caddy validate --adapter caddyfile` or
    `nginx -t`. It runs before anything is uploaded, so a failure leaves the server as it was.
  - provision runs the same check locally when Docker is there, and the rules always.
  - gixy-ng runs when the user has it, and its findings are shown, not enforced.

### 10. Agents: provision, destroy, retarget (T1409a)

- **provision:**
  1. Read the edge choice against what the server runs (the host record, or the edge stamp over
     SSH). With other OpsCrew apps on the server, a different choice is refused before any change,
     with the reason. With the app alone, the switch is planned, with its interruption stated.
  2. Origin TLS for the proxied hostnames:
     - keys and the CSR are created only when there is no valid certificate or it has fewer than
       30 days left;
     - the client certificate and its key are made the same way;
     - both keys go into the generated values;
     - the desired state goes into the shared plan, which is shown and approved by its hash, and
       applied (waiting for `active`);
     - the deploy secret `OPSCREW_ORIGIN_TLS` is set, and `pull.pem` is rendered.
  3. A missing permission keeps today's site (ACME, no client certificate), notes the gap, and
     goes on.
  4. CAA facts for the DNS module: the DNS-only A and AAAA names, and the proxy's CAs.
  5. The minimum-TLS decision, inside the same shared plan.
  6. A hostname leaving the proxy: the first run drops the requirement and keeps the record
     proxied, and says to run again (R3).
  7. "After the server shows it" (contracts/cloudflare-tls.md): read what the origin serves, over
     SSH as `deploy` or through Portainer's API. Superseded certificates and retiring hostnames
     are cleaned up once it has moved on.
  8. The recovery copy: `refreshRecoveryCopy`, with the file added to the pull request.
  9. With only a renewed certificate or a changed secret, start the deploy (`dispatchWorkflow`).
     The plan's approval text names that deploy before it is approved.
- **destroy:** after the app's site is gone, revoke the origin certificate, disable and delete the
  client certificate, and remove the CAA records with the DNS module. The minimum TLS stays.
- **retarget:**
  - the new server gets the same certificates (the files move with the deploy secrets);
  - the copy is refreshed in `--finish`'s pull request;
  - the edge choice carries over.

### 11. Agents: drift, status, secure, verify (T1409b)

- **drift:** for each proxied hostname, the per-hostname setting is still enabled with OpsCrew's
  certificate, and the origin certificate still exists at Cloudflare. A change is reported with
  how to restore it (run provision).
- **status:**
  - each certificate's expiry: the origin and client certificates from the record, and DNS-only
    hostnames from a TLS handshake;
  - the server's proxy;
  - the copy's last update, its recipients, and whether it is behind.
- **verify, status and secure** warn when fewer than 30 days remain on any certificate OpsCrew
  manages.
- **secure:**
  - from the server over SSH, `openssl s_client` to the app's hostnames on 127.0.0.1:443: without
    a client certificate the handshake is refused, the issuer is Cloudflare's Origin CA, and an
    unknown SNI is refused;
  - the permission gap;
  - CAA records that are not OpsCrew's at the app's names;
  - the minimum-TLS advice;
  - a repository that became public with the copy in it;
  - Valkey refusing a connection without its password.

### 12. Valkey and CAA (T1410)

- **Valkey:** the catalog entry gains a generated `hex32` password. It is written to
  `valkey.conf` at start from the service's env file, as Redis 8 does. `REDIS_URL` and every alias
  carry it through `urlService`. The volume is unchanged, so the AOF and RDB data survive the
  restart.
- **CAA in the DNS module** (`cloudflare-dns`): `cloudflare_dns_record` resources of type CAA with
  `for_each` over `var.caa_issuers`, at `var.domain` only, when `var.proxied` is false. The `www`
  name is a CNAME, so lookups follow it to the domain. Never at the zone apex: an app on the apex
  gets no CAA record, and `secure` advises one instead (FR-1430).

### 13. Surfaces and guide (T1411)

- **CLI:**
  - `opscrew secrets restore [--key-file] [--use-copy|--keep-local]`;
  - `opscrew secrets rotate [--backup <age1…>|--no-backup] [--key-out <path>]`;
  - `opscrew secrets status`;
  - `opscrew secrets folder <path>`;
  - `opscrew secure --deep`.
- **MCP:** the same. A new key goes to the `keyOut` file (required there; the CLI asks for the
  path), and restore reads only a key file.
- **The plugin's skills, `init`'s token permissions and the runbook** (the proxy, certificates
  and their renewal, the copy).
- **The guide:**
  - `origin-protection.md`;
  - `secrets-recovery.md`;
  - `deeper-checks.md`;
  - `tls-and-caa.md`;
  - `reverse-proxy.md` (the choice, additions, renewals);
  - updates to `security.md` and `own-server.md`.

### 14. The Docker pass (T1412)

- **Both proxies** behind a local DNS-less setup, with Pebble as the ACME server:
  - the first certificate;
  - a renewal forced with `certbot renew --force-renewal` under a steady request loop, with no
    failed request;
  - the proxy switch's interruption, measured.
- **Origin TLS:** a self-signed CA standing in for Cloudflare's. A client without the
  certificate is refused, a client with it passes, and an unknown SNI is refused.
- **Additions:** a valid header served, and an invalid or unsafe addition refused, with the live
  configuration unchanged.
- **The deeper check** against a container server: Lynis through Docker, ssh-audit and
  testssl.sh, and the files unchanged afterwards.
- **Valkey** refusing a connection without its password, and the queue example still working.

### 15. Portainer: Caddy holds requests during a redeploy (T1416)

The founder's choice (2026-10-21). Portainer's redeploy stops the app before starting the new
version, and in standalone Docker there is no start-first. If Caddy itself is not recreated, its
`reverse_proxy` can hold requests with `lb_try_duration` (about 30 s) and pass them on once the
new container answers.
- Caddy's service stops changing on each deploy. The deploy's version check moves to what the
  spike settles (item 16).
- Requests already in flight finish within the app's stop grace period.
- Visitors see a short pause, not an error. The guide (`zero-downtime.md`) says so.

A Docker Swarm environment would give true start-first updates. It is on the roadmap as later
work.

### 16. `vercel.json` routing rules (T1417a, T1417b)

The founder's choice (2026-10-21). This is for apps leaving Vercel whose routing lives in
`vercel.json`. Rules in `next.config.js` already work, because Next.js applies them itself.
- **Facts** (T1417a): `ProjectFacts.platformRouting`, parsed and zod-checked by detect:
  - the `redirects`, `rewrites`, `headers`, `cleanUrls` and `trailingSlash` properties, and the
    file's SHA-256;
  - the `routes` property (a PCRE form), `has` and `missing`, and malformed entries go to
    `unsupported`, with the reason.
- **Translation** (T1417b): `translateVercelRouting(routing, { proxy, hostnames, upstream })` in
  iac-templates returns `{ text, skipped }`.
  - Sources (path-to-regexp) become anchored regular expressions, and destinations' parameters
    become the proxy's capture placeholders (R7).
  - Vercel's order is kept: headers, then redirects (with `cleanUrls` and `trailingSlash`), then
    rewrites.
  - An internal rewrite applies the way Vercel applies it: only when the app answers 404 for the
    original path, because Vercel checks the filesystem first (R7). Caddy uses `handle_response`
    on a 404, and nginx `proxy_intercept_errors` with `error_page 404` and a named location.
  - Skipped and listed: rewrites to another site (the additions rules refuse traffic sent
    anywhere but the app), `has` and `missing` conditions in v1, and any pattern the proxy cannot
    express.
- **Design** writes `opscrew/proxy/additions.<proxy>` only when the app has none, with a header
  comment naming the source, `vercel.json`'s SHA-256, and that the file is the user's to edit. It
  shows the skipped list. When `vercel.json` changes later, design says so and does not
  overwrite the file.
- **The output** passes T1408's rules and T1407's checker like any addition, which the tests
  prove.

### 17. Live tests and runs (T1413, T1414)

- **Hetzner with Caddy:** a proxied app (direct origin refused, Cloudflare passing, the origin
  certificate's issuer), CAA on a DNS-only app, the minimum TLS in a zone of only OpsCrew apps,
  `secure --deep` (under 5 minutes, files unchanged), the recovery copy (a fresh clone, restore,
  provision with nothing regenerated), and destroy cleaning up.
- **Hetzner, an app already live:** origin protection turned on under a steady request loop, with
  no failed request (SC-1408).
- **Own server with nginx:** two apps, one DNS-only (a certbot certificate, a renewal under load)
  and one proxied; an addition served; testssl.sh with no high finding. Then, with one app left, a
  switch to Caddy and back.
- **Every pass** ends with the leak search: the run's logs, commits, plans, reports and audit
  entries are searched for the generated keys and the age identity (SC-1406).
- **Portainer:** the stack Caddy with origin TLS.

## Order

The exact waves are in tasks.md. In short:
1. T1401a (contracts) and T1401b (pins, tools, crypto), in parallel.
2. T1402 (the spike, lead).
3. T1403, T1404, T1405, T1406, T1408 and T1410, in parallel (their Owns are disjoint).
4. T1407 (after T1406: the same edge and switch files).
5. T1409a, then T1409b.
6. T1411 and T1412.
7. T1413, then T1414.

T1416 (Caddy holds requests on Portainer) can run any time after T1406, once the spike settles
item 16. T1417a runs after T1401a, and T1417b after T1417a, T1407 and T1408.

## Complexity Tracking

| Choice | Why | Simpler alternative rejected because |
|---|---|---|
| The copy holds the state and the records, not only secrets | A new machine needs the state to manage the deployment (US2's test) | Secrets alone restore nothing usable: provision would try to create a new server |
| Lynis through Docker with a read-only host mount | The `deploy` user has no sudo on cloud servers, and one path serves every server | sudo would need a host-plan change on cloud servers and a second code path |
| A DER writer in core | Two small structures, no new dependency (constitution X) | `@peculiar/x509` brings about 10 transitive packages |
| AOP through the shared plan, not Terraform | The upload would put the private key in state, and the zone-wide resource lists every app's hostnames | Terraform's `cloudflare_authenticated_origin_pulls` breaks per-app ownership and constitution IV |
| Leaving the proxy takes two runs | The origin must have a public certificate before visitors reach it directly | One run would break the site until the deploy lands |
| One proxy per server | Ports 80 and 443 open once per host (013's shared edge) | A proxy per app needs other ports |
| 15-year origin and client certificates | The site keeps working without OpsCrew (constitution II), and there is no yearly renewal to miss | One-year certificates break the site a year after the user stops using OpsCrew |
| Switching the proxy only with one app on the server | Each app's deploy writes only its own site file | Rendering every app's site in both syntaxes doubles every deploy's edge files for a rare change |
| The age key handed over as a file | Terminal output must pass through the redactor (constitution IV) | Printing it once would need a writer that bypasses the redactor |
