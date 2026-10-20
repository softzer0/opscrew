# ADR 0017: Origin TLS behind Cloudflare, the recovery copy, deeper checks and the edge's proxy

**Status**: Accepted (2026-10-21, feature 014)

## Context

Behind Cloudflare's proxy, the origin accepted every request from Cloudflare's address ranges, so
any Cloudflare customer could reach it. OpsCrew's generated secrets, the deploy key and the
infrastructure state lived only on the user's machine. `opscrew secure` checked only what OpsCrew
set up. Caddy was the only proxy.

The founder decided (2026-10-13, amended 2026-10-21):
- an Origin CA certificate and Authenticated Origin Pulls;
- SOPS + age for an encrypted copy, committed and optionally copied to a folder;
- Lynis, ssh-audit and testssl.sh as optional deeper checks;
- CAA and minimum TLS;
- Caddy with the user's own additions, and nginx + certbot as a managed alternative;
- a password for Valkey.

## Decision

- **Origin TLS through 011's shared plan.**
  - Origin CA certificates, per-hostname client certificates and settings, and the zone's minimum
    TLS are change kinds of the shared Cloudflare plan. Each is read first, approved by the plan's
    hash and applied through the typed adapter.
  - They stay out of Terraform: the AOP upload resource would put the client's private key in
    state, and the zone-wide resource lists every app's hostnames.
  - The plan carries fingerprints and the CSR's hash. The keys stay with the caller.
  - Certificates last 15 years (Cloudflare's longest Origin CA validity), so a user who stops using
    OpsCrew keeps a working site (constitution II). Provision replaces one when the hostnames
    change or fewer than 30 days remain.
  - What never blocks a plan (a missing permission, the minimum-TLS advice) is advice beside the
    plan, not a finding.
- **The order.**
  - The origin requires the client certificate only after Cloudflare reports the hostname's
    setting active, and the server changes only with the deploy, after provision.
  - A hostname leaving the proxy takes two runs: first the origin gets a public certificate and
    drops the requirement; then the record and the setting change.
  - Superseded certificates and retiring hostnames are cleaned up once the server shows it has
    moved on (read over SSH, or through Portainer's API).
- **Keys on the user's machine.** P-256 keys, the CSR and the self-signed client certificate are
  built with `node:crypto` and a small DER writer in core. There is no new dependency.
  - The origin key reaches the server only as a deploy secret written through SSH's stdin, or as a
    Portainer stack variable.
  - The client key reaches Cloudflare once.
- **The recovery copy holds what cannot be rebuilt.** `opscrew/secrets.sops.json` encrypts, with
  SOPS to the user's age recipients:
  - the generated values;
  - the deploy key and known hosts;
  - the state passphrase;
  - the records;
  - the infrastructure state.

  Each file is one value, so only file names are readable. Without the state, a new machine could
  not manage the deployment.
  - **Updating** needs no private key.
  - **The key** is written once to a file at a path the user picks, and never printed, because
    terminal output passes through the redactor (constitution IV). OpsCrew never keeps it.
  - **sops** is a pinned binary OpsCrew fetches and checks. sops embeds age, so age is not
    fetched, and the age keys are X25519 pairs in Bech32.
- **Deeper checks** are pinned and read-only.
  - Lynis runs as root through Docker, because the `deploy` user has no sudo on cloud servers but
    is in the docker group everywhere. It runs in a throwaway container, chrooted into the host's
    root filesystem mounted read-only, with a tmpfs `/tmp`.
  - ssh-audit and testssl.sh run in pinned containers on the user's machine.
  - Their results reuse `CheckResult` with `source` and `noise`.
- **`target.edge: caddy | nginx`**, one per server. In v1 the proxy can be switched only while the
  server holds one OpsCrew app, because each app's deploy writes only its own site file.
  - **nginx** runs unprivileged with certbot: webroot HTTP-01, a renewal twice a day starting 45
    days before expiry, and a reload through a flag file (no Docker socket). The first certificate
    is obtained during the first deploy.
  - **Both proxies** share one hardened baseline and a catch-all refusal.
  - **The user's additions** (`opscrew/proxy/additions.caddy|nginx`) pass OpsCrew's rules, then
    the proxy's own checker on the runner, before anything reaches the server.
- **`vercel.json` routing rules** (`ProjectFacts.platformRouting`) are translated once into the
  app's additions. Rewrites become fallbacks after the app's 404, because Vercel checks the
  filesystem first. What cannot be translated is listed, and the file is the user's afterwards.
- **CAA** is set in the IaC engine's DNS module, at the app's DNS-only names only. **Minimum TLS
  1.2** is set only in a zone whose proxied records are all OpsCrew's and still at the default.
- **Valkey** requires a generated password, written to its config file at start.

## Consequences

- The Cloudflare token needs SSL and Certificates: Edit and Zone Settings: Edit. Without them,
  the app keeps today's protection and `secure` lists the gap.
- **The copy changes after every apply** (the state changes), so provision's pull requests often
  carry it. A copy that is behind is shown by `status`. A restore of an older copy is caught by
  the plan gate, because the plan would show changes the user did not ask for.
- **A public repository** holds an encrypted copy that anyone can keep. OpsCrew asks before
  committing it.
- **Switching a server's proxy** has a short, stated interruption, and waits until the server holds
  one OpsCrew app.
- **Portainer stacks** keep Caddy.
- **Valkey restarts once** when its password is added, with its data kept.
