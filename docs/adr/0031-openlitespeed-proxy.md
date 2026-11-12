# ADR 0031: OpenLiteSpeed as a third proxy on servers

**Status**: Accepted (2026-11-12, feature 027). The founder chose OpenLiteSpeed as a third proxy
next to Caddy and nginx on 2026-11-11; the design is the lead's, settled by a container spike (027
research R12).

## Context

ADR 0017 made the proxy a choice (`target.edge`: Caddy or nginx) and nginx's work in 014 set what a
proxy must give: TLS 1.2 and 1.3 only, the security headers, WebSockets and long requests, unknown
hostnames refused, a configuration check before every change, reloads that drop nothing,
certificates from Cloudflare or its own renewals, an additions file checked by OpsCrew's rules. The
spike found that OpenLiteSpeed gives most of it, with gaps:
- a graceful restart applies a broken configuration, and its check misses a missing listener
  certificate and passes silently without its work folder;
- it resolves a backend's hostname once, at load;
- turned on, its page cache stores every GET, private and authenticated answers included;
- it can't refuse an unknown hostname's connection or handshake, only answer 403;
- a graceful restart ends WebSockets older than `gracefulRestartTimeout`;
- it can't run as a container's PID 1.

## Decision

- **D1. A third `EdgeProxy`, `openlitespeed`,** from `litespeedtech/openlitespeed` pinned by
  digest, with `init: true` and OpsCrew's loop as the command: it starts the daemon, watches it by
  name, and on a reload flag runs the check and then the graceful restart. The error log goes to a
  file; the admin console is off (`disableWebAdmin 1`).
- **D2. Nothing is reloaded unchecked.** Before every graceful restart OpsCrew makes sure
  `/tmp/lshttpd` exists, checks itself that every certificate and key the configuration names is
  there and readable, and runs `openlitespeed -t`, refusing exit 2. A refusal leaves the running
  configuration in place, as nginx's does.
- **D3. A graceful restart follows every change that moves a backend,** a deploy's switch and a
  rollback included, since OpenLiteSpeed doesn't resolve a backend's name again.
- **D4. The page cache stays off;** an app opts its pages in with `X-LiteSpeed-Cache-Control`. Each
  app's cache has its own `storagePath`, and a deploy or rollback empties it by removing its files.
- **D5. Unknown hostnames get a 403** from a catch-all vhost behind a placeholder certificate
  (`default.invalid`), on HTTP and HTTPS.
- **D6. TLS and headers per vhost:** `sslProtocol 24`, `enableECDHE 1` and the ciphers repeated in
  every `vhssl`; Caddy's and nginx's headers through `extraHeaders`; `showVersionNumber 2` and set
  error pages, so nothing names the server; `X-Forwarded-For` reset to the client's address.
- **D7. Timeouts:** the server-wide `connTimeout` is 300 s, the longest request any app gets;
  `gracefulRestartTimeout` stays 300 s.
- **D8. Certificates** as nginx's: origin certificates behind Cloudflare's proxy, certbot's webroot
  renewals for DNS-only hostnames, served after a checked graceful restart.
- **D9. Not on Portainer stacks or previews,** which keep Caddy.

## Consequences

- A visitor asking for a hostname the server doesn't serve gets a 403 page, not a closed
  connection; the guide says so.
- A deploy, a rollback or a certificate renewal ends WebSockets open longer than five minutes.
- Every app on the server gets the same long-request limit, 300 s.
- The image is about 1.1 GB, PHP included; there is no server-only image.
- An app behind Cloudflare's authenticated origin pulls that presents no client certificate fails
  its TLS handshake instead of getting a 400.

## Alternatives considered

- **Turning the cache on per app:** it would serve one visitor's private page to another.
- **Purging with `X-LiteSpeed-Purge: *`:** it empties every app's cache on the server.
- **OpenLiteSpeed as PID 1:** the container exits at the first graceful restart.
