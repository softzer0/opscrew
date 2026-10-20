# Quickstart: validating 014

Prerequisites are as in 013. The local Docker pass needs Docker and the network (pinned images).
The live tests need the throwaway Hetzner project, GitHub repositories and Cloudflare zone
(`docs/e2e.md`). The e2e Cloudflare token also needs **SSL and Certificates: Edit** and **Zone
Settings: Edit**.

## Offline

`pnpm check` covers:
- **The schemas:** `target.edge`, `app.maxBodyMb` and the record schema with `tls` and
  `zoneSettings`.
- **Key material:**
  - a CSR and a client certificate that `node:crypto`'s `X509Certificate` parses and verifies;
  - `openssl req -verify` where `openssl` is installed;
  - age keys matching age's test vectors.
- **The fetcher:** a fake download with the right checksum, a wrong one, a cached file changed,
  and the override.
- **The shared plan:** every new change kind, the apply order, waiting for `active`, a partial
  failure continued by the next plan, `tls-permission-missing` that does not block, a hostname
  another app claims, and the minimum-TLS decision in a zone with and without non-OpsCrew records.
- **The recovery copy,** with a fake sops: what is collected, changed hashes, the first key
  written once to the user's file (never printed), the public-repository question, restore conflicts, and rotate.
  It also runs once against real sops when `OPSCREW_SOPS_BIN` is set.
- **The deeper checks:** the parsers over recorded Lynis, ssh-audit and testssl.sh outputs
  (fixtures from the spike), the severity mapping, noise and skips.
- **The edge and DNS:** snapshots of both edges and their sites (proxied, DNS-only, tunnel) and of
  the deploy steps; the additions rules over good and bad fixtures; CAA in the DNS module under
  both engines; Valkey's password in the rendered config and URLs.
- **The leak search:** generated keys, the client key and the age identity appear in no plan JSON,
  audit entry, report or snapshot.

## Local Docker pass (`OPSCREW_DOCKER_TESTS=1`)

1. **Caddy and nginx, each with Pebble as the ACME server:**
   - a DNS-only site gets its first certificate;
   - `certbot renew --force-renewal` (nginx) under a request loop has no failed request, and nginx
     serves the new certificate;
   - an unknown hostname is refused on 80 and 443;
   - visitors see the same headers and TLS versions on both;
   - the switch from Caddy to nginx has a measured interruption under the plan's stated bound.
2. **Origin TLS,** with a local CA standing in for Cloudflare's: a client without the client
   certificate is refused, a client with it passes, and the served certificate covers exactly the
   app's hostnames.
3. **Additions:** a header addition is served. An unsafe addition is refused by the rules, and a
   broken one by the checker step, with the running configuration unchanged.
4. **The deeper check** against a container server (systemd-less Ubuntu with sshd):
   - Lynis through Docker gives a report;
   - ssh-audit and testssl.sh run;
   - a file listing of the host's root before and after is the same, apart from logs.
5. **Valkey:** `redis-cli PING` without the password is refused, the queue example's job runs, and
   data survives the restart that adds the password.

## Live (gated, `docs/e2e.md`)

1. **Hetzner, Caddy, proxied:**
   - the site works through Cloudflare;
   - from the server, `openssl s_client` without the client certificate is refused and the issuer
     is Cloudflare's Origin CA;
   - `secure --deep` finishes in under 5 minutes, with no high finding from testssl.sh;
   - destroy revokes the origin certificate and removes the client certificate and settings, and
     nothing else in the zone changes.
2. **Hetzner, an app already live:** origin protection is turned on while a request loop runs
   through Cloudflare, with no failed request (SC-1408).
3. **Hetzner, DNS-only:** CAA at the app's hostname and not at the apex. The zone's minimum TLS
   goes to 1.2 when only OpsCrew apps are proxied, and is only advised otherwise.
4. **The recovery copy:**
   1. provision with a database;
   2. delete `~/.opscrew/projects/<id>` and `.opscrew`;
   3. clone fresh, `opscrew secrets restore --key-file …`, then `opscrew provision`;
   4. the plan shows no change, no secret is regenerated, and the data is intact, within 5
      minutes.
5. **Own server, nginx:**
   - two apps, one DNS-only (a certbot certificate obtained during the first deploy) and one
     proxied (origin TLS);
   - an addition served;
   - a forced renewal with no failed request;
   - testssl.sh with no high finding (SC-1407);
   - a different proxy for one app refused while both are on the server;
   - with one app left, a switch to Caddy and back, within the stated interruption.
6. **Portainer:** the stack Caddy (`web: caddy`) with origin TLS, and `secure --deep` running only
   testssl.sh, with the reason given for the others. A redeploy under a request loop
   shows a pause, not an error (T1416).

Every pass ends with the leak search (SC-1406): the run's logs, commits, plans, reports and audit
entries contain none of the generated keys, the client key or the age identity.
