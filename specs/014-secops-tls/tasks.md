---
description: "Tasks for 014-secops-tls"
---

# Tasks: SecOps and TLS

**Input**: `specs/014-secops-tls/` (spec.md, plan.md, research.md R1–R6 and the open items,
data-model.md, contracts/{cloudflare-tls,recovery-copy,edge-and-checks}.md, quickstart.md),
`docs/adr/0017-origin-tls-and-recovery.md`, and features 000–013.

**Numbering**: T1401–T1499.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`.

**Rules for every task:**
- Fixtures never contain secret-shaped literals. Use `fakeSecret()`, or `{{FAKE:…}}` with
  `materializeFixture()`. A PEM key or an age identity in a fixture is generated at test time,
  never committed.
- No test touches the network, a real cloud or a model. Tests that need `sops`, `openssl` or
  Docker skip with a clear message when the tool is absent.
- No private key, client key, age identity or secret value appears in a plan, a log, an audit
  entry, a report, a snapshot, an MCP response or infrastructure state (FR-1461). Every task's
  tests include a leak check for the values it handles.
- Every Cloudflare change goes through the shared plan approved by its hash. Every server change
  goes through the deploy or the host plan (FR-1460).
- Build only what Accept asks. Report anything else as a finding.

## Phase 1: Foundation

- [X] T1401a Contracts: `target.edge`, `app.maxBodyMb`, `CheckResult.source` and `.noise`, the record's `tls` and `zoneSettings`, and the new shared-plan kinds, in `packages/plan-schema/**`, `packages/contracts/src/secops.ts`, `packages/connectors/cloudflare/src/shared.ts` (types and schema only), and every reader and writer of the changed types
  - Owns:
    - `packages/plan-schema/**` (+ tests, fixtures, the generated JSON schemas);
    - `packages/contracts/src/secops.ts`;
    - `packages/connectors/cloudflare/src/shared.ts`, only the types, `SharedRecordSchema`, and the `applyShared` cases for the new kinds;
    - in `packages/agents`, `packages/iac-templates`, `packages/cli`, `packages/mcp-server` and `packages/secops`, only the code, fixtures and tests that build cloud or own targets or app sections (for the new fields), or that switch over `SharedChange` kinds.
  - Reads: data-model.md "plan.yaml", "Origin certificate", "Client certificate", "Zone settings record"; contracts/cloudflare-tls.md; contracts/edge-and-checks.md "CheckResult"; plan.md "1."
  - Depends: —
  - Accept:
    - **`plan.yaml`:**
      - `target.edge` is `"caddy" | "nginx"` on the cloud and own target schemas, `.default("caddy")`, and is absent from the Portainer target;
      - `app.maxBodyMb` is an int 1–2048, `.default(100)`;
      - the JSON schemas are regenerated.
    - **`CheckResult`** gains optional `source?: string` and `noise?: string`, with the doc comments of the contract.
    - **`SharedRecord`** gains optional `tls` and `zoneSettings`, exactly as in contracts/cloudflare-tls.md "Record", in the strict `SharedRecordSchema`:
      - hostnames are lower-case FQDNs;
      - ids are non-empty strings;
      - `sha256` is 64 lower-case hex;
      - `expiresAt` and `setAt` are ISO times;
      - `previous` is the literal `"1.0"`.

      A record without them stays valid.
    - **`SharedChange`** gains the seven kinds of the contract, and **`SharedFinding`** the code `hostname-tls-claimed`. `SharedDesired` gains the optional `tls` and `minTls`.
    - **`SharedPlan`** gains, in its local part next to `previous` and `record` and outside the hash:
      - `csr`;
      - `advice[]`: `{ code: "tls-permission-missing" | "min-tls-advised", message, hint }`, which never blocks the plan.
    - **The record's `tls`** has the optional `gap: "permission"`.
    - **`applyShared`** handles the new kinds with an `OpsCrewError("NOT_IMPLEMENTED", …)` until T1403. `planShared` produces none of them yet.
    - **Every place that renders or lists shared changes** (plan text in agents, MCP) has a plain-English line for each new kind. Example: "Create a Cloudflare origin certificate for app.example.com, www.app.example.com (15 years)". Each advice code also has a line.
    - **Every package keeps its behaviour** and passes its tests.
  - Verify: `pnpm turbo run typecheck test --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1401b [P] Pins, the pinned-tools fetcher, the sops runner, and key material, in `packages/iac-templates/src/pins.ts`, `packages/iac-templates/scripts/**`, `packages/core/src/{tools,crypto}/**`
  - Owns: those paths (+ tests); `packages/core/src/index.ts` and `packages/iac-templates/src/index.ts` for their new exports only
  - Reads: research.md R1, R2, R3 ("Key material"), R5; contracts/recovery-copy.md "Fetcher", "sops runner", "age keys"; plan.md "2."
  - Depends: —
  - Accept:
    - **Pins:**
      - `LOCAL_TOOLS.sops`: version `3.13.3`, with an asset URL and SHA-256 for `linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64` and `windows-amd64`, taken from the release's checksums file;
      - `TOOLS.lynis`: `3.1.7`, with its tarball URL and SHA-256;
      - `IMAGES`, by digest: `sshAudit` (`positronsecurity/ssh-audit:v3.9.0`), `testssl` (`ghcr.io/testssl/testssl.sh:3.2.4`), `nginx` (`nginxinc/nginx-unprivileged`, the current 1.30.x stable, alpine), `certbot` (`certbot/certbot`, current), and `pebble` (`ghcr.io/letsencrypt/pebble`, tests only).
      - Fill digests and checksums with `pnpm --filter @opscrew/iac-templates exec tsx scripts/update-pins.mjs`, which uses read-only registry and GitHub calls. Never invent one.
      - `update-pins.mjs` refreshes all of them, and checks sops's SHA-256 against the release's checksums file before writing.
    - **`fetchPinnedTool(pin, deps)`** as in the contract:
      - the cache path `<homeDir>/tools/<name>/<version>/`;
      - the download goes to a temporary file, is checked by SHA-256, and is renamed with mode 0755 (no chmod on Windows);
      - a cached file is checked again on every call;
      - `pin.envOverride` (`OPSCREW_SOPS_BIN`) is used as it is, with `source: "override"`;
      - plain errors for no asset for the platform, a failed download (with its URL), and a checksum mismatch.

      Fetch and fs are injected, so the tests use fakes.
    - **The sops runner** (`sopsEncrypt`, `sopsDecrypt`):
      - arguments exactly as in the contract;
      - plaintext only on stdin, and the identity only in the child's `SOPS_AGE_KEY`;
      - the identity and decrypted values registered with the redactor;
      - a rejected key mapped to `SECRETS_KEY_REJECTED`.

      Unit tests use a fake exec. One integration test runs real sops when `OPSCREW_SOPS_BIN` is set: an encrypt and decrypt round trip, and a wrong key.
    - **Key material** (`packages/core/src/crypto`):
      - a DER writer (SEQUENCE, SET, INTEGER, OID, BIT STRING, OCTET STRING, UTF8String, UTCTime/GeneralizedTime, context tags);
      - `generateP256()`, which returns PKCS#8 and SPKI PEM;
      - `buildCsr({ key, hostnames })`: PKCS#10, CN set to the first hostname, a SAN extension request with every hostname, signed with ecdsa-with-SHA256;
      - `selfSignedClientCertificate({ key, commonName, days })`: X.509 v3 with a random 16-byte positive serial, basicConstraints CA:false, keyUsage digitalSignature and extKeyUsage clientAuth;
      - `fingerprintSha256(pem)`.
    - **Tests for the key material:**
      - `new X509Certificate(pem)` parses the client certificate, `verify(publicKey)` is true, and the validity and extensions are as asked;
      - `openssl req -verify -noout` accepts the CSR and `openssl req -text` shows the SANs, when `openssl` is on `PATH`;
      - a CSR with no hostname, or with more than 100, is refused.
    - **Age keys:**
      - `generateAgeIdentity()` gives an X25519 pair in Bech32, upper-case `AGE-SECRET-KEY-1…` and `age1…`;
      - `ageRecipientOf()` and `isAgeRecipient()`;
      - tests match age's published test vectors, and round-trip through real sops when `OPSCREW_SOPS_BIN` is set.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/core --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: high

## Phase 2: Spike (lead)

- [X] T1402 The spike (lead; done 2026-10-21, with item 14 moved to the live run T1413), with local Docker and the e2e Cloudflare token (which needs SSL and Certificates: Edit and Zone Settings: Edit on the test zone). It settles research.md's open items 1–17. Item 16, Portainer's redeploy and the version check, decides T1416's mechanism, and item 17, the 404 fallback forms, decides T1417b's. The results go into research.md as "Spike results", with one line per item: what was run, and what was seen. It also records the fixtures the parsers need: a Lynis report, ssh-audit's JSON and testssl.sh's JSON, with any address replaced by a documentation one.

## Phase 3: Packages (parallel)

- [X] T1403 [P] [US1] [US4] The Cloudflare adapter: certificates, per-hostname origin pulls, the zone's minimum TLS, and their plan and apply, in `packages/connectors/cloudflare/**`
  - Owns: `packages/connectors/cloudflare/src/**` (+ tests, `testing/` fakes)
  - Reads: contracts/cloudflare-tls.md; research.md R3, R4, "Spike results" 1–4 and 11; plan.md "4."
  - Depends: T1401a, T1402
  - Accept:
    - **The calls of the contract** on `CloudflareClient`:
      - each response is parsed with zod;
      - a 403 gives the `permission` code;
      - the private key in `uploadHostnameClientCertificate` is registered with the redactor before the request and appears in no error;
      - the fake client in `testing/` implements them all.
    - **`inspectShared`** reads, for the desired TLS hostnames: the zone's origin certificates, the per-hostname AOP settings and certificates, the minimum TLS setting, and the zone's proxied A, AAAA and CNAME records (comment and name). A 403 on any of them gives the `tls-permission-missing` advice and leaves those facts out.
    - **`planShared`**, exactly as the contract's "Plan rules":
      - when a new origin certificate is wanted;
      - `superseded` and `retiring` cleaned up only against `served`;
      - `set-min-tls` only on `1.0`, editable, and every proxied record `Managed by OpsCrew`, otherwise the `min-tls-advised` advice;
      - the `hostname-tls-claimed` finding;
      - the `tls-permission-missing` advice, which leaves out the TLS changes without blocking 011's rules, and sets `tls.gap: "permission"` in the record;
      - an origin certificate requested for 15 years (`days: 5475`).

      The hash covers the CSR's SHA-256, never its text, and no key.
    - **`applyShared`** in the contract's order:
      - it waits for `active` with an injected clock, at most 5 minutes, then gives the plain "still deploying, run provision again" error;
      - the record is updated after each change, so a failure after the upload leaves a record whose next plan continues without uploading again;
      - the keys and the CSR come from the call's arguments.
    - **The record carries over:** `planShared` copies the earlier record's `tls` and `zoneSettings` into the new record, then applies the changes to them.
    - **No typed confirmation for cleanup** (lead decision, 2026-10-21): revoking a `superseded` origin certificate and deleting a client certificate no hostname uses happen only after the server shows it has moved on, so nothing live loses anything; `applyZonePlan` asks for the typed name only for 011's rule deletions, as today. Destroy keeps its own typed confirmation.
    - **Expiry times:** Cloudflare's two formats (`2041-10-16 23:53:00 +0000 UTC` from Origin CA, ISO `Z` from AOP) become ISO `Z` times before they go into the record ("Spike results").
    - **The stub goes:** the `INTERNAL` refusal T1401a added for the new kinds is replaced by their implementation.
    - **`CLOUDFLARE_TOKEN_PERMISSIONS`** gains "SSL and Certificates: Edit" and "Zone Settings: Edit".
    - **Tests:** every kind; the order; the wait and its timeout; a partial failure continued; a zone with a non-OpsCrew proxied record (advice only); a `1.2` zone (nothing); a hostname another app's certificate holds; a missing permission (advice, the plan still applies 011's rules); no key in any plan JSON or error.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare` and `pnpm lint`
  - Effort: xhigh

- [X] T1404 [P] [US2] The recovery copy, in `packages/agents/src/secrets/**` (new), and the copy in provision's and retarget's pull requests, in `packages/agents/src/provision/publish.ts`, `packages/agents/src/retarget/finish.ts`
  - Owns: those paths (+ tests); `packages/agents/src/index.ts` for the new exports only
  - Reads: contracts/recovery-copy.md; data-model.md "Recovery copy", "Age key"; research.md R2; plan.md "5."; spec US2, FR-1410–FR-1417
  - Depends: T1401b
  - Accept:
    - **The files** are exactly the list in plan.md "5.", with the `home/` and `state/` prefixes. A missing file is absent from the copy.
    - **`refreshRecoveryCopy`:**
      - it compares SHA-256 hashes with `.opscrew/recovery.json`, which holds hashes and times only;
      - on a change, it encrypts through the core sops runner to the recipients in `opscrew/.sops.yaml`;
      - it writes the folder copy (`<folder>/<app>.sops.json`) at once, and returns the repository files;
      - no private key is needed;
      - it records the written copy's SHA-256 (`copySha256`); when the repository's copy differs from it, it stops with `SECRETS_COPY_CHANGED_ELSEWHERE` and says to restore first (FR-1417);
      - when sops cannot be fetched, it returns `{ changed: false, warning }`, the local files stay as they are, and the caller goes on (FR-1416).
    - **The first time:**
      - a new key is written once to the file the caller names: 0600, exclusive create, refused inside the repository or `~/.opscrew`. It is never printed or logged, and never in a result except as the file's path;
      - a backup recipient is offered (validated with `isAgeRecipient`);
      - `.sops.yaml` and the `.gitattributes` lines are written;
      - for a public repository (from the GitHub connector), an interactive run asks first and records the answer; a non-interactive run writes only the folder copy and says how to commit the copy.
    - **`restoreRecoveryCopy`:**
      - only the allowed path prefixes are accepted, with no `..` and no absolute path;
      - files are written atomically with their modes, 0600 for `home/*` and `state/tfstate/*`;
      - a differing local file stops the restore before any write, listing the paths and the differing names inside `generated_values.json`, never values; `use-copy` and `keep-local` decide;
      - a wrong key writes nothing.
    - **`rotateRecoveryKey`:**
      - a new key, with the backup kept, replaced or dropped;
      - the local files encrypted again;
      - the two files returned for a pull request;
      - the old-commit sentence of FR-1414 in the result's message.
    - **The redactor:** after a decrypt or a read, every value inside `generated_values.json` is registered with the redactor by itself, not only the whole file (T1401b's review).
    - **`recoveryStatus`** as in the contract: `lastModified` from `sops.lastmodified`, the recipient count from `sops.age`, and `behind` from the hashes.
    - **The pull requests:** provision's publish step and retarget's `--finish` include `opscrew/secrets.sops.json`, `.sops.yaml` and `.gitattributes` whenever `refreshRecoveryCopy` returns `changed: true`.
    - **Tests:** a fake sops (stdin and stdout recorded), plus a real-sops round trip when `OPSCREW_SOPS_BIN` is set; every rule above; the identity and every file's content absent from logs, the audit, results and snapshots.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: xhigh

- [X] T1405 [P] [US3] The deeper checks, in `packages/secops/src/deep/**` (new), and `secure --deep` in `packages/agents/src/secure/{run.ts,report.ts}`
  - Owns: those paths (+ tests, fixtures, report snapshots); `packages/secops/src/index.ts` for the new exports only
  - Reads: contracts/edge-and-checks.md "CheckResult", "Deeper checks"; research.md R1, "Spike results" 7 and 10; plan.md "6."; spec US3, FR-1420–FR-1425
  - Depends: T1401a, T1401b, T1402 (its fixtures)
  - Accept:
    - **`runLynis`** over the injected SSH runner, as `deploy`:
      - one `docker run --rm -i` of the pinned minimal image chosen in the spike, with `-v /:/hostfs:ro`, a tmpfs at `/hostfs/tmp`, `--pid=host --net=host --security-opt no-new-privileges`;
      - the tarball on stdin, checked by SHA-256 inside the container;
      - `chroot /hostfs` running Lynis with `--quick --no-colors --report-file /tmp/report.dat`, and the report printed to stdout;
      - a 4-minute limit;
      - the image removed afterwards when `docker image inspect` showed it absent before (FR-1421).
    - **`runSshAudit` and `runTestssl`** through an injected local-Docker runner, with the pinned images and the arguments of plan.md "6.", and time limits of 1 and 2 minutes per host.
    - **The parsers** over the spike's fixtures are zod-checked, and map severities exactly as in the contract's table. testssl.sh's OK and INFO are dropped, and a proxied hostname's results are labelled "Cloudflare's edge".
    - **`markNoise`** from `deep/noise.ts`: per tool, ids with their reasons (research R1's lists).
    - **Skips**, each one `skip` result with the reason and how to enable it:
      - no Docker on the user's machine;
      - a refused or timed-out connection, which never passes;
      - on Portainer, Lynis and ssh-audit.
    - **`secure --deep`** runs them after today's checks. The report gains "Deeper checks", per tool: the version, the results, the noise apart, and the hardening index. Without `--deep`, the run and report are unchanged (a snapshot proves it).
    - **Tests:** a fake SSH runner and a fake Docker runner; the parsers; the mapping; noise; each skip; the report's section.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops --filter=@opscrew/agents` and `pnpm lint`
  - Effort: high

- [X] T1406 [P] [US1] [US5] Caddy: origin TLS, the baseline headers, the catch-all and the additions, and the origin files in the deploy, in `packages/iac-templates/src/{edge,runtime,workflow,portainer-target}/**`
  - Owns: those paths (+ tests, snapshots)
  - Reads: contracts/edge-and-checks.md "The edge on the server"; data-model.md "Server layout", "User additions"; research.md R3 (Caddy), R5; plan.md "7."
  - Depends: T1401a, T1402
  - Accept:
    - **A proxied app with origin TLS** (`RuntimeContext` gains `originTls: { hostnames } | undefined`):
      - its site uses `tls /etc/caddy/tls/<app>/origin.pem /etc/caddy/tls/<app>/origin.key { client_auth { mode require_and_verify; trust_pool file /etc/caddy/tls/<app>/pull.pem } }` for exactly those hostnames;
      - no `auto_https` option (Caddy skips ACME for the names a loaded certificate covers; T1406 found that `ignore_loaded_certs` requests them anyway);
      - the edge mounts `./tls:/etc/caddy/tls:ro`.
    - **Every site** sets HSTS, `X-Content-Type-Options nosniff` and `Referrer-Policy strict-origin-when-cross-origin`, and removes `Server`.
    - **The edge** refuses unknown hostnames on 80 and 443, in the form the spike settled.
    - **Additions:** when the runtime context has `additions`, the site imports `/etc/caddy/sites/<app>.additions` inside its block, and the deploy uploads the file.
    - **The deploy job:**
      - writes `OPSCREW_ORIGIN_TLS` through SSH's stdin into `/srv/edge/tls/<app>/origin.pem` and `origin.key`, under `umask 077`, in a 0700 folder;
      - uploads `opscrew/runtime/edge/tls/pull.pem`;
      - does both before the site switch;
      - the secret's value never appears in a command line.
    - **Portainer `web: caddy`:** the stack Caddy gets the bundle, with `pull.pem`, as a stack variable, which a two-line entrypoint writes to a tmpfs before `caddy run`, with the same site.
    - **Tunnel hostnames** get none of this (FR-1409).
    - **Tests:** snapshots for proxied, DNS-only, tunnel and Portainer; the upload steps; no secret in a rendered command.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: xhigh

- [X] T1408 [P] [US5] The additions rules, in `packages/secops/src/proxy-rules/**` (new)
  - Owns: that path (+ tests, fixtures); `packages/secops/src/index.ts` for the new export only
  - Reads: contracts/edge-and-checks.md "The additions rules"; plan.md "9."; spec FR-1443
  - Depends: T1401a
  - Accept:
    - **`scanProxyAdditions(text, ctx)`** implements every rule of the contract's table for both syntaxes. Comments and quoted strings do not trigger a rule. Each refusal has its line, the rule id, and a plain message saying what to do instead.
    - **gixy-ng:** `runGixy(file, exec)` runs it when it is on `PATH` and returns its findings as advice. It is never required.
    - **Tests:** good and bad fixtures per rule and per syntax, and a file over 64 KiB.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops` and `pnpm lint`
  - Effort: high

- [X] T1410 [P] [US6] [US4] Valkey's password, and CAA records in the DNS module, in `packages/iac-templates/src/catalog/**`, `packages/iac-templates/modules/cloudflare-dns/**`, `packages/iac-templates/src/infra/**`, `packages/iac-templates/src/generated/**`
  - Owns: those paths (+ tests, snapshots)
  - Reads: research.md R4, R6; plan.md "12."; spec FR-1430, FR-1431, FR-1450
  - Depends: T1401a
  - Accept:
    - **Valkey** (both cache and queue mode):
      - a generated `hex32` password;
      - `requirepass` written to a config file from the service's env file at start, never on the command line, as Redis 8 does;
      - `auth` is `password`;
      - `REDIS_URL` and every alias carry `:<password>@`;
      - the healthcheck authenticates;
      - the volume is unchanged.
    - **CAA in the `cloudflare-dns` module:**
      - a `caa_issuers` variable (a list of strings, defaulting to empty);
      - `cloudflare_dns_record` resources of type CAA (`flags 0`, `tag issue`, one per issuer) at `var.domain`, only when `var.proxied` is false, with the `Managed by OpsCrew` comment;
      - the infra renderer passes `["letsencrypt.org", "<ZeroSSL's name from the spike>"]` for Caddy and `["letsencrypt.org"]` for nginx;
      - never at the zone apex: an app on the apex gets an empty `caa_issuers`, and T1409b's `secure` advises the record instead (FR-1430).
    - **Validated** under both engines (the module tests), and the generated modules regenerated.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, the module validation (`PATH="$PWD/.tools/bin:$PATH"`), and `pnpm lint`
  - Effort: medium

## Phase 4: The nginx edge

- [X] T1407 [US5] [US1] The nginx edge with certbot, the proxy switch, and the proxy's own checker in the deploy job, in `packages/iac-templates/src/{edge,runtime,workflow}/**`
  - Owns: those paths (+ tests, snapshots)
  - Reads: contracts/edge-and-checks.md; data-model.md "Proxy choice", "Server layout"; research.md R5, "Spike results" 5, 6, 12, 13; plan.md "8.", "9."
  - Depends: T1406
  - Accept:
    - **`edge: nginx`** renders the edge with `nginx`, `certbot` and `kamal-proxy`, exactly as the contract's table:
      - nginx: `user:` the deploy uid, `init: true`, and ports 80 and 443 mapped to 8080 and 8443;
      - the stamp `x-opscrew-edge-proxy: nginx`;
      - the volumes `letsencrypt`, `acme-webroot` and `reload`.
    - **The template:**
      - Mozilla intermediate 6.0 ("Spike results" 6): TLS 1.2 and 1.3, its cipher and curve lists, `ssl_prefer_server_ciphers off`;
      - HTTP/3 (`listen 8443 quic reuseport`, 443/udp published, `Alt-Svc`), as Caddy serves it;
      - HSTS and the baseline headers repeated in every `server`;
      - `server_tokens off`;
      - WebSockets, `proxy_read_timeout 300s`, and `client_max_body_size <app.maxBodyMb>m`;
      - Host and `X-Forwarded-For/-Proto/-Host` to kamal-proxy;
      - an HTTP to HTTPS redirect per known host;
      - a `default_server` returning 444 on 80 and 443.
    - **Per app:**
      - `sites/<app>.conf` with `limit_req_zone … zone=opscrew_<app>`;
      - `include sites/<app>.additions` in its TLS server when present;
      - proxied hostnames use `/srv/edge/tls/<app>/` with `ssl_verify_client on`.
    - **certbot:**
      - webroot `/var/www/acme`, `--cert-name <app>`;
      - `renew` every 12 hours with a random delay, and `renew_before_expiry = 45 days` written at the top of `/etc/letsencrypt/renewal/<app>.conf`, since certbot has no flag for it ("Spike results" 13);
      - the deploy hook touches `/var/www/reload/flag`;
      - the nginx container's loop reloads when the flag appears, after `nginx -t`;
      - no Docker socket anywhere.
    - **The first certificate** in the deploy's edge step, as in plan.md "8.": HTTP-only site, then `certonly`, then the TLS site, `nginx -t` and a reload. On failure the site stays on HTTP, and the job ends with certbot's reason and the rate-limit wording.
    - **The proxy switch** (offered by T1409a only while the server holds one OpsCrew app):
      - the deploy sees the server's stamp;
      - it stops the old proxy and starts the other, with kamal-proxy and the apps left running;
      - it runs the first-certificate step;
      - both proxies' volumes are kept;
      - the job states the interruption: a few seconds for proxied hostnames, under a minute for DNS-only ones (R5).
    - **The checker step, for both proxies:** before any upload, the job runs the pinned image on the runner (`caddy validate --adapter caddyfile`, or `nginx -t`) against the whole rendered edge, with placeholder certificates. A failure ends the job, with the checker's output, before anything reaches the server.
    - **Tests:** snapshots of the nginx edge (proxied, DNS-only, two apps), of the switch, of the first-certificate step and of the checker step.
    - **From T1406:**
      - `renderDeployment`'s context in `packages/iac-templates/src/render.ts` is typed `RuntimeContext`;
      - nginx sends `X-Frame-Options: SAMEORIGIN` as Caddy does;
      - a deploy without additions removes the app's `/srv/edge/sites/<app>.additions` from the server, and a deploy without origin TLS removes `/srv/edge/tls/<app>/` (T1406's review);
      - the edge version number is after T1406's 2026102101.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: xhigh

## Phase 5: The agents

- [X] T1409a [US1] [US4] [US5] Origin TLS, CAA, minimum TLS and the proxy in provision, destroy and retarget, in `packages/agents/src/{provision,destroy,retarget}/**` (not the files T1404 owns)
  - Owns: those paths (+ tests), except `provision/publish.ts` and `retarget/finish.ts` beyond the calls this task adds
  - Reads: contracts/cloudflare-tls.md; data-model.md; research.md R3, R4, R5; plan.md "10."; spec US1, US4, US5
  - Depends: T1403, T1404, T1406, T1407, T1408, T1410
  - Accept:
    - **The edge choice:** provision reads what the server runs (the host record, or the edge stamp over SSH). With other OpsCrew apps on the server, a different `target.edge` is refused before any change. The message says the proxy is shared, and that it can be switched while the server holds one OpsCrew app. With the app alone, the switch is planned, with the interruption stated.
    - **Origin TLS** for proxied hostnames on cloud, own and Portainer (`web: caddy`) targets:
      - the keys and the CSR come from core, and only when a new certificate is needed (contract rules). The client certificate lasts 15 years, like the origin certificate;
      - provision always passes a fresh key and CSR, and keeps the key only when the applied plan created the certificate (T1403 creates one only when the rule wants it and a CSR is given);
      - a hostname leaving the proxy stays in `desired.tls.proxied` until `served` shows the origin no longer requires the client certificate for it; then it leaves `proxied`, and the planner disables it (T1403 does not use `retiring`);
      - client certificates are never replaced in v1 (T1403 refuses it); `status` and `secure` warn when one nears its expiry, with the manual steps;
      - `applyZonePlan` passes `keys`, `csr: plan.csr`, the clock and sleep to `applyShared`, and stores the returned `originCertificate` PEM as the generated value `ORIGIN_TLS_CERT`;
      - the keys are stored as generated values (`ORIGIN_TLS_KEY`, `ORIGIN_TLS_CERT`, `ORIGIN_PULL_KEY`);
      - `served` is read over SSH as `deploy`, or through Portainer's API;
      - the shared plan is shown, approved by its hash and applied with the keys and the CSR passed in;
      - the deploy secret `OPSCREW_ORIGIN_TLS` is set, or the stack variable on Portainer;
      - on Portainer the variable is base64 of the certificate, the key and `pull.pem` (one line, as Portainer writes stack variables); on servers the secret is plain PEM, the certificate then the key (T1406);
      - the renderer's context carries `originTls` and `additions` (`RuntimeContext`, T1406);
      - `pull.pem` and the additions go into the runtime files.
    - **A missing permission** keeps today's site, records the gap for `secure`, and the run goes on (FR-1405).
    - **A hostname leaving the proxy** takes two runs: the first keeps the record proxied and drops the requirement, and says to run again (R3).
    - **CAA:** the `caa_issuers` for the DNS module per `target.edge`. Existing non-OpsCrew CAA records at the app's names are reported, not replaced.
    - **The minimum TLS** decision is planned inside the same shared plan.
    - **The recovery copy in provision** (T1404's interface): the first provision asks for the key file's path interactively, or takes `--key-out` (T1411), or an existing recipient. It passes `recovery` to `publishDeploySetup`. `SECRETS_COPY_CHANGED_ELSEWHERE` is checked at the start of provision, before any plan or change, not only at the publish step.
    - **The additions:** `scanProxyAdditions` always, the proxy's checker locally when Docker is present, and gixy-ng when it is installed. Any refusal stops before any change. A file for the other proxy is refused with how to convert it.
    - **A renewed certificate or a changed secret alone** starts the deploy (`dispatchWorkflow`), and the plan's approval text names that deploy before it is approved.
    - **destroy**, after the app's site is gone: revokes the origin certificate and every `superseded` one, disables and deletes the client certificate, and removes the CAA records with the DNS module. The minimum TLS stays.
    - **retarget:** the certificates follow (same generated values and deploy secret), and `target.edge` carries over.
    - **From T1407:**
      - the ssh-host teardown (`packages/connectors/ssh-host/src/**`, the app-removal path only) removes the app's nginx site `<app>.conf` and `<app>.additions` and reloads nginx when the edge is nginx;
      - provision passes Cloudflare's IP ranges into the runtime context's `cloudflareRanges` for the real-IP settings, from the same `ctx.cloudflare.ipRanges` it reads for the web filter, so every app on a server passes the same ranges and the shared edge doesn't change between apps (T1407).
    - **Tests:** first provision, idempotent rerun (no new certificate), renewal at 29 days, a changed hostname set, permission missing, a hostname leaving the proxy, the edge conflict, Portainer, destroy and retarget. No key in any output, plan, audit entry or snapshot.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: xhigh

- [X] T1409b [US1] [US2] [US5] [US6] drift, status, verify and secure, in `packages/agents/src/{drift,status,verify,secure}/**` (not T1405's deep parts), `packages/secops/src/hardening/**`
  - Owns: those paths (+ tests, snapshots)
  - Reads: plan.md "11."; data-model.md; spec FR-1406, FR-1408, FR-1445, FR-1450, FR-1462
  - Depends: T1409a, T1405
  - Accept:
    - **drift:** a per-hostname setting disabled, or using another certificate, and a missing origin certificate at Cloudflare are reported, with "run provision".
    - **drift's site comparison** is done in T1409a, which renders it exactly as provision does.
    - **The ssh-host inspection** (`packages/connectors/ssh-host/src/**`, the inspection only) hashes the app's site for the server's proxy, `<app>.conf` on nginx as well as `<app>.caddy` on Caddy, so drift on an nginx server doesn't report its site as missing (T1409a's report).
    - **secure's origin check:** on nginx, a missing client certificate completes the handshake and answers HTTP 400; on Caddy, the handshake is refused. Both count as refused (T1407).
    - **status:**
      - each certificate's expiry (origin and client from the record, DNS-only hostnames from a TLS handshake through an injected connector);
      - the server's proxy;
      - the copy's last update, recipients and whether it is behind (`recoveryStatus`).
    - **verify, status and secure** warn below 30 days on any certificate OpsCrew manages, with the reason when certbot's last run failed (read from the server).
    - **secure:**
      - over SSH, `openssl s_client` to 127.0.0.1:443 with each proxied hostname's SNI: refused without a client certificate, the issuer is Cloudflare's Origin CA, and an unknown SNI is refused;
      - the permission gap;
      - non-OpsCrew CAA records at the app's names, and advice for a DNS-only app on the zone apex (no CAA written there);
      - the minimum-TLS advice;
      - a repository that became public with the copy in it;
      - Valkey refusing an unauthenticated `PING`.
    - **Tests** for each, with fakes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops` and `pnpm lint`
  - Effort: high

## Phase 6: Surfaces, the Docker pass and live tests

- [ ] T1411 [P] Surfaces and the guide, in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/**`, `README.md`, `packages/iac-templates/src/runbook/**`
  - Owns: those paths (+ tests)
  - Reads: contracts/recovery-copy.md "CLI and MCP"; plan.md "13."; spec FR-1462, FR-1463
  - Depends: T1409b
  - Accept:
    - **CLI:**
      - `opscrew secrets status|restore|rotate|folder` with the contract's flags;
      - `restore` without `--key-file` asks with a hidden prompt (CLI only);
      - the first provision and `rotate` write a new key to `--key-out`, or ask for the path, and never print it;
      - `opscrew status` and MCP `opscrew_status` show `tlsStatusReport(deps, plan)` (T1409b): the proxy, each certificate's expiry, and the recovery copy's update time, key count and whether it is behind;
      - `opscrew secure --deep`;
      - `init` lists the Cloudflare token's new permissions.
    - **MCP:** the same tools. A new key goes only to the required `keyOut` file, restore takes only `keyFile`, and no response contains a key.
    - **The plugin's skills** describe the copy, the deeper check and the proxy choice.
    - **The runbook** covers the proxy, the certificates and their renewal, and the copy with restore steps.
    - **`origin-protection.md` says** that an app moving to another Cloudflare zone leaves its origin and client certificates in the old zone, to be revoked there by hand, and that user additions are not yet used in a Portainer stack (provision warns) (T1409a).
    - **`reverse-proxy.md` says** what the `vercel.json` translation leaves out, and that only one fallback applies per request: with `cleanUrls` and an SPA catch-all together, an unknown path tries `<path>.html`, then gets the app's 404 (T1417b).
    - **The guide:** `origin-protection.md`, `secrets-recovery.md`, `deeper-checks.md`, `tls-and-caa.md` and `reverse-proxy.md`, plus updates to `security.md` and `own-server.md`. Each is written for users, one topic per page, linked from the guide's index. The README links to them and gains no detail.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server --filter=@opscrew/iac-templates`, `node plugin/validate.mjs` and `pnpm lint`
  - Effort: high

- [ ] T1412 [P] The Docker pass, in `packages/cli/test/e2e/**`, `examples/**`
  - Owns: those paths
  - Reads: quickstart.md "Local Docker pass"; research.md "Spike results"
  - Depends: T1409b
  - Accept:
    - **Every scenario of quickstart.md's Docker pass**, gated by `OPSCREW_DOCKER_TESTS=1`:
      - both proxies with Pebble: the first certificate, a forced renewal with no failed request, refusal of unknown hostnames, the same headers and TLS versions, the switch interruption measured;
      - origin TLS with a local CA;
      - additions;
      - the deeper check against a container server, with the files unchanged;
      - Valkey's password.
    - **Portainer redeploy under load (T1416's check), gated:** a local Portainer CE (`IMAGES.portainer`), a local registry and Git server bound to loopback, the stack in proxy mode; two webhook redeploys under a request loop give no failed request, and Caddy's container is the same before and after.
    - **certbot's renewal-failure log** (T1409b's parser in `secops/src/hardening/tls.ts`): a renewal that fails against Pebble writes what the parser expects ("Processing …/renewal/<app>.conf", "Failed to renew certificate <app> with error: …"), and `status` shows the reason; fix the parser if the real lines differ.
    - **Cleanup:** each test removes its own containers, networks, volumes and images, by id or label.
    - **gixy-ng once:** install it in a throwaway Python container (`pip install gixy-ng`) and run T1408's `runGixy` against a generated nginx additions file. Confirm the binary name, `-f json`, the report's fields and its exit code, and fix `runGixy` if they differ (T1408 took them from the original gixy).
  - Verify: `OPSCREW_DOCKER_TESTS=1 pnpm turbo run test --filter=opscrew -- test/e2e/<the new files>` and `pnpm lint`
  - Effort: high

- [ ] T1413 Live tests, in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: quickstart.md "Live"; `docs/e2e.md`
  - Depends: T1411, T1412
  - Accept:
    - **Every pass of quickstart.md's "Live"**, gated as in `docs/e2e.md`:
      - Hetzner proxied and DNS-only;
      - the recovery copy on a fresh clone;
      - own server with nginx;
      - Portainer.

      Each checks with the real tools: from the server, from Cloudflare's side, and through sops.
    - **Origin protection on a live app** is turned on under a steady request loop through Cloudflare, with no failed request (SC-1408).
    - **testssl.sh** gives no high finding for either proxy (SC-1407).
    - **The leak search** ends every pass: the run's logs, commits, plans, reports and audit entries contain none of the generated keys, the client key or the age identity (SC-1406).
    - **Teardown** revokes and removes every certificate, setting and record the run created, with a fallback through the API when destroy fails.
    - **`docs/e2e.md`** no longer mentions `X-OpsCrew-Image`; the Portainer check reads `/.well-known/opscrew-version` (T1416).
    - **The origin check from the server** (T1409b: `openssl s_client` to 127.0.0.1:443) works under OpsCrew's web filter on a real server; if it does not, add the fallback from a container on the edge's network (research "Spike results" 14).
    - **The coverage page** names every new scenario as not yet run live.
  - Verify: `pnpm turbo run typecheck --filter=opscrew` and `pnpm lint` (the live runs are T1414)
  - Effort: high

- [ ] T1414 Live runs (lead): the passes in `docs/e2e.md`. The results go in `docs/e2e.md` and `docs/e2e-coverage.md`.

## `vercel.json` routing (founder, 2026-10-21)

- [X] T1417a [P] [US5] `ProjectFacts.platformRouting` from `vercel.json`, in `packages/plan-schema/src/facts.ts` (+ the generated JSON schema), `packages/detect/src/**`
  - Owns: those paths (+ tests, fixtures)
  - Reads: data-model.md "Vercel routing (ProjectFacts)"; research.md R7; plan.md "16."; spec FR-1446
  - Depends: T1401a (it owns plan-schema until merged)
  - Accept:
    - **`ProjectFacts.platformRouting`** is optional, exactly as in data-model.md, with zod validation. `statusCode` is one of 301, 302, 303, 307 and 308, with `permanent: true` mapped to 308 and `false` to 307. Each entry keeps its index in the file.
    - **Detect** reads `vercel.json` (the file already found for `crons`):
      - `redirects`, `rewrites`, `headers`, `cleanUrls` and `trailingSlash`;
      - the `routes` property, every `has` and `missing`, and malformed entries go to `unsupported`, with the reason;
      - both source forms: path-to-regexp (`:param`, `:path*`, `(.*)`, custom groups) and the regex form (`^…$`), as R7 says;
      - nothing is set when the file has none of these.
    - **Tests:** fixtures for a Vite SPA (a catch-all rewrite to `/index.html`), a static site with redirects, headers and `cleanUrls`, a `routes` file, and a malformed one.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/detect` and `pnpm lint`
  - Effort: high

- [X] T1417b [US5] The translation into the app's additions, in `packages/iac-templates/src/edge/vercel-routing.ts` (new), and the file written by design, in `packages/agents/src/design/**`
  - Owns: those paths (+ tests, snapshots); `packages/iac-templates/src/index.ts` for the new export only
  - Reads: contracts/edge-and-checks.md "`vercel.json` translation"; research.md R7; plan.md "16."; spec US5 scenario 8, FR-1446
  - Depends: T1417a, T1407, T1408
  - Accept:
    - **`translateVercelRouting`** as in the contract, for both proxies:
      - sources become anchored, case-sensitive regular expressions, and destinations' parameters become the proxy's capture placeholders; unused parameters go to the query string (R7);
      - the order is headers, then redirects (including `cleanUrls` and `trailingSlash`), then rewrites;
      - an internal rewrite is a fallback that applies when the app answers 404 for the original path (Caddy `handle_response`, nginx `proxy_intercept_errors` with `error_page 404` and a named location, in the forms R7 settled);
      - on nginx, the locations it writes do **not** repeat OpsCrew's baseline headers: the edge sets `add_header_inherit merge;`, so they are inherited, and repeating them would send them twice (T1407);
      - `proxy_pass` and `reverse_proxy` name exactly the app's upstream with no variable after it (T1408's rules refuse `http://app:3000$request_uri`), and sources are checked with plan-schema's `VercelSourceSchema`;
      - skipped, each with its reason: rewrites to another site, `has` and `missing`, patterns the proxy cannot express, and everything in `unsupported`.
    - **The edge's memory per proxy** (from T1407; `EDGE_MEMORY_MB` is used in `design/{components,options,sizing}.ts`): sizing counts Caddy at 128 MB and nginx at 160 MB (nginx 64, certbot 64, kamal-proxy 32), following `target.edge`, in every place that uses it today.
    - **Design:**
      - when the facts carry routing rules and `opscrew/proxy/additions.<proxy>` does not exist, it writes the file with the header comment of plan.md "16." and shows the skipped list;
      - an existing file is never overwritten. When `vercel.json`'s SHA-256 differs from the one in the header, design says so. The comparison uses a fresh detect's `platformRouting.sha256` (detect hashes the text without a BOM), never the raw file bytes.
    - **Tests:**
      - the fixtures of T1417a, for both proxies;
      - every output passes `scanProxyAdditions`;
      - when Docker is present, each output passes the proxy's own checker (`caddy validate`, `nginx -t`) inside the full edge configuration;
      - for the SPA fixture under Docker, a request for an existing asset is served as it is, and an unknown path gets `/index.html`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents` and `pnpm lint`
  - Effort: high

## SSH algorithm hardening (lead, 2026-10-21, after T1405)

- [X] T1418 [P] [US3] Modern-only SSH algorithms on OpsCrew's servers, in `packages/iac-templates/modules/{hetzner-vps,digitalocean-droplet}/**`, `packages/iac-templates/src/generated/**`, `packages/connectors/ssh-host/src/**`, `packages/secops/src/deep/noise.ts`
  - Owns: those paths (+ tests, snapshots)
  - Reads: research.md R8; `packages/secops/src/deep/__fixtures__/ssh-audit-policy.json` (what the policy expects); spec FR-1426
  - Depends: T1405 (noise.ts), T1410 (the generated modules)
  - Accept:
    - **The sshd drop-in** that cloud-init writes (Hetzner and DigitalOcean) and the ssh-host `sshd` step applies gains R8's lines exactly, plus `HostKey` lines for the ED25519 and RSA keys only. The moduli are filtered with `awk '$5 >= 3071'`. `sshd -t` validates the configuration before the reload, and a failure leaves the old configuration in place.
    - **On an own server**, the host plan shows the change, and it is approved by its hash. When the deploy secrets' pinned host key is ECDSA, the ECDSA `HostKey` line stays, and the plan says why. Host keys are never regenerated.
    - **`noise.ts`** lists the policy's RSA host-key size mismatch (3072 against 4096), with R8's reason.
    - **Tests:**
      - the rendered cloud-init and the host-plan step;
      - the ECDSA-pinned case;
      - a Docker check, when Docker is present: an `ubuntu:24.04` container with `openssh-server` and the drop-in passes `sshd -t` and accepts a modern client.
    - **T1413's live pass** adds that ssh-audit's policy passes on a fresh OpsCrew server, apart from the noise.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/connector-ssh-host --filter=@opscrew/secops` (with `.tools/bin` on PATH) and `pnpm lint`
  - Effort: high

## Follow-up from 010 (founder, 2026-10-21)

- [X] T1416 [P] Portainer: Caddy holds requests during a redeploy, in `packages/iac-templates/src/portainer-target/**`, `packages/iac-templates/src/workflow/portainer.ts`, `docs/guide/zero-downtime.md`
  - Owns: those paths (+ tests, snapshots)
  - Reads: research.md "Spike results" 16; plan.md "15."; `docs/guide/zero-downtime.md` "In your Portainer"
  - Depends: T1402, T1407 (the same workflow files)
  - Accept:
    - **Caddy's service in the stack** no longer changes from one deploy to the next, so Portainer's redeploy recreates only the app and its workers. The image version leaves Caddy's environment.
    - **The deploy's version check** still proves the new image is live, through the mechanism the spike chose ("Spike results" 16):
      - a one-shot `stamp` service (the pinned curl image, `restart: "no"`) carries the version, writes it to a small named volume, and exits;
      - Caddy serves it at `/.well-known/opscrew-version`;
      - the workflow polls that path instead of the `X-OpsCrew-Image` header, which goes.

      It works for `redeploy: updater` and `redeploy: cloudflare`, and in every web mode.
    - **Caddy's `reverse_proxy`** to the app gets `lb_try_duration 30s` and `lb_try_interval 250ms`, so requests during the app's restart wait and pass, instead of failing. This applies in every web mode where the stack runs Caddy (`caddy`, `tunnel`, `proxy`).
    - **If the spike found that Portainer recreates unchanged services anyway,** this task stops at the finding and reports it, and the guide keeps today's sentence.
    - **The guide:** "In your Portainer" says visitors see a short pause instead of an error, and that a Docker Swarm environment (later work) would give true rolling updates.
    - **Tests:** the stack's snapshot (Caddy's service identical across two image versions), the version check, and the retry settings.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, `pnpm lint`, and a Docker check against Portainer CE: two redeploys under a request loop, with no failed request
  - Effort: high

## Dependencies

{T1401a, T1401b} → T1402 (lead) → {T1403, T1404, T1405, T1406, T1408, T1410} → T1407 (after
T1406) → T1409a → T1409b → {T1411, T1412} → T1413 → T1414. T1416 runs alongside T1409a, after
T1407. T1417a runs in wave 3, after T1401a. T1417b runs alongside T1409a, after T1417a, T1407 and
T1408.

**User stories:**
- **US1:** T1401a, T1401b, T1403, T1406, T1407, T1409a, T1409b.
- **US2:** T1401b, T1404, T1411.
- **US3:** T1405, T1411.
- **US4:** T1403, T1410, T1409a.
- **US5:** T1406, T1407, T1408, T1409a, T1417a, T1417b.
- **US6:** T1410, T1409b.

## Parallel waves

1. T1401a, T1401b.
2. T1402 (lead).
3. T1403, T1404, T1405, T1406, T1408, T1410, T1417a. Their Owns are disjoint: cloudflare; agents
   secrets with two call sites; secops deep with agents secure's deep parts; iac-templates edge,
   runtime, workflow and portainer-target; secops proxy rules; iac-templates catalog, modules and
   infra; plan-schema facts and detect.
4. T1407, T1418 (iac-templates edge, runtime and workflow; the server modules, ssh-host and secops noise).
5. T1409a, T1416, T1417b (agents provision, destroy and retarget; iac-templates portainer-target;
   iac-templates edge translation and agents design).
6. T1409b.
7. T1411, T1412.
8. T1413, then T1414.

## Parallel examples

- **Wave 3:** dispatch T1403, T1404, T1405, T1406, T1408 and T1410 in one message, each in its own
  worktree. Review each branch, then merge them one at a time: T1410 and T1408 first (small), then
  T1405, T1403, T1404 and T1406.
- **US2 alone:** T1401b, then T1404, then the `secrets` part of T1411, is the whole recovery copy.

## Implementation strategy

- **MVP:** US1 (only Cloudflare reaches the origin) on Hetzner with Caddy, and US2 (the recovery
  copy). That is T1401a–T1404, T1406, the Caddy half of T1409a, and the secrets part of T1411.
- **Then:** CAA and minimum TLS (US4), the deeper checks (US3), and Valkey (US6).
- **Then:** nginx and additions (US5).

Each wave is merged, gated and pushed before the next starts.

## End-of-feature simplify pass (after T1414)

- [ ] T1415 The end-of-feature simplify pass: duplication across 014's changes, and the items
  collected below during the waves
  - Owns: the files each item names (+ tests and snapshots), and any 014 file the sweep simplifies (outside `packages/cli/test/live/**` and `docs/e2e*.md`)
  - Accept:
    - **The items listed below.**
      - The zone fill written out by hand in `provision/steps.ts`, `portainer/run.ts` and `drift/portainer.ts` calls T1410's `withCloudflareZone` instead, and agents' index re-exports it (T1410's report).
      - `SharedDesired.tls.retiring` goes, because T1403 doesn't use it (T1403's report).
      - Verify Docker's error text when it cannot mount the host recursively read-only (T1405 recognises exit 125 with "recursive" in stderr, a guess), on a server with an old kernel or Docker if one is ever available; otherwise keep the guess documented.
      - Merge `RuntimeContext.cloudflareRanges` with `ctx.cloudflare.ipRanges` into one field (T1407's report).
      - Portainer's `opscrew-<app>_version` volume (T1416's stamp) is removed with the stack, not left behind by `destroy --delete-data`: add it to `portainerStackVolumes` (or remove it with the stack), with the agents tests and the runbook's backup note.
      - gixy-ng gives HIGH `regex_redos` and `http_splitting` advice on OpsCrew's own nginx translation of `vercel.json` (false positives: the CR/LF guard is ignored). Adjust the generated regexes, or list those two plugins as noise for lines OpsCrew wrote, so provision doesn't warn about its own file (T1412).
      - Refresh the older pins that moved upstream (the curl and mysql 8.4 digests, uv), found by T1401b's run of `update-pins.mjs`, then run the gate.
    - **A duplication sweep over 014's whole change:** merge repeated helpers where the code gets smaller and no less clear. List what was merged, and what was left and why.
    - **No behaviour change.**
  - Verify: `pnpm lint`, `node plugin/validate.mjs`, `pnpm turbo run typecheck test --concurrency=2`
  - Effort: high
