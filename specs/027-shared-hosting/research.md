# 027 research: shared hosting (cPanel, Plesk, DirectAdmin, SFTP) and LiteSpeed

Research for [027 in the roadmap](../roadmap.md#027-shared-hosting-cpanel-plesk-directadmin-sftp-and-litespeed),
started on the founder's go-ahead of 2026-11-12. Official sources only; anything not read on an
official page or seen on the test account is marked *unverified*. Nothing here names the
founder's account, its domains or its user.

## R1. cPanel's API

**Read on official pages (2026-11-12).**
- **Auth:** an API token per cPanel user, sent as `Authorization: cpanel <user>:<token>` to port
  2083 over HTTPS. Tokens work for UAPI and API2, not API1. They are made in cPanel under
  Security → Manage API Tokens or with UAPI `Tokens::create_full_access`; an expired token is not
  removed by itself (`Tokens::revoke`). A host can turn tokens off in WHM's Feature Manager.
  [How to use cPanel API tokens](https://docs.cpanel.net/knowledge-base/security/how-to-use-cpanel-api-tokens/)
- **Calls:** UAPI is `https://<host>:2083/execute/<Module>/<function>?a=b`, booleans `1`/`0`.
  The answer is `{apiversion, func, module, result: {status, data, errors, messages, warnings,
  metadata}}`. [UAPI introduction](https://api.docs.cpanel.net/cpanel/introduction/),
  [start_autossl_check](https://api.docs.cpanel.net/openapi/cpanel/operation/start_autossl_check/)
- **Subdomains:** `SubDomain::addsubdomain` takes `domain`, `rootdomain` and `dir` (the document
  root, relative to the home folder; under `public_html` unless WHM's "Restrict document roots to
  public_html" is off). [addsubdomain](https://api.docs.cpanel.net/openapi/cpanel/operation/addsubdomain/)
- **Databases:** a database name has at most 64 characters (an underscore counts as two), a user
  at most 47 on MariaDB, and both carry the account's prefix (`<user>_`).
  [MySQL Databases](https://docs.cpanel.net/cpanel/databases/mysql-databases/)
- **AutoSSL:** `SSL::start_autossl_check` starts a check of the user's domains.
- **Uploads:** `Fileman::upload_files` (multipart, `file-0`…, `dir`, `overwrite`, `permissions`,
  default 0644) creates `dir` when missing; the account's upload limit, quota and virus scan
  apply. [upload_files](https://api.docs.cpanel.net/openapi/cpanel/operation/upload_files/)
- **Application Manager:** `PassengerApps::register_application` (`domain`, `name`, `path`,
  `base_uri`, `deployment_mode`, `enabled`, `envvar_name`/`envvar_value`) registers an app that is
  already on disk. [register_application](https://api.docs.cpanel.net/openapi/cpanel/operation/register_application/)
- **Git deployment:** `.cpanel.yml` at the repository's top holds `deployment.tasks` (shell
  commands), run on a push to a cPanel-managed repository or by "Deploy HEAD Commit".
  [Guide to Git deployment](https://docs.cpanel.net/knowledge-base/web-services/guide-to-git-deployment/)
- **CloudLinux selectors:** driven by `cloudlinux-selector` (`create --interpreter=nodejs
  --app-root … --app-uri … --app-mode … --version … --domain …`, `install-modules`, `restart`).
  [CloudLinux components](https://docs.cloudlinux.com/cloudlinuxos/cloudlinux_os_components/),
  [command-line tools](https://docs.cloudlinux.com/cloudlinuxos/command-line_tools/)

**Seen on the founder's cPanel test account (2026-11-12, read-only calls only).**
- **Errors come with HTTP 200.** A failed UAPI call answers 200 with `result.status` 0 and the
  reason in `errors`, even for a module that doesn't exist. API2 answers
  `{cpanelresult: {…, data, error?}}` with `event.result`. A client must read the status, never
  the HTTP code alone.
- **Tokens can be limited:** `Tokens::list` gives each token's `features` (a list),
  `whitelist_ips`, `expires_at`, `has_full_access` and `readonly`. The test token has full access
  and no expiry. The call that makes a limited token is *unverified*.
- **Cron is API2 only here:** UAPI `Cron` doesn't exist on this server ("Failed to load module");
  API2 `Cron::listcron` works.
- **SSH keys are API2 only here:** UAPI `SSH::list_keys` doesn't exist; API2 `SSH::listkeys`
  lists the account's keys with their authorisation state. The account's shell is `/bin/bash`
  and its `ssh` feature is on.
- **No MultiPHP:** every `LangPHP` call answers "You do not have the feature multiphp". The PHP
  version comes from CloudLinux's PHP Selector instead (feature `lvephpsel`), which has no UAPI.
- **Databases:** MariaDB 10.11, on the same host; `Mysql::get_restrictions` gives the prefix and
  the limits (47 and 64). PostgreSQL: "This server does not support this functionality."
- **Domains:** `DomainInfo::list_domains` and `domains_data` give each domain's document root and
  type; `docroots_in_public_html_only` is 0 (`Variables::get_server_information`), so a document
  root may be outside `public_html`.
- **Certificates:** `SSL::installed_hosts` lists each served host with its certificate;
  `SSL::get_autossl_problems` names the domains AutoSSL could not cover and why;
  `SSL::is_autossl_check_in_progress` answers 0 or 1.
- **Apps:** `PassengerApps::list_applications` works (none yet); at most 4 apps
  (`maximum_passenger_apps`); the Node.js, Python and Ruby selectors are on (`lvenodejssel`,
  `lvepythonsel`, `lverubysel`). `VersionControl::retrieve` and `WebApp::list` work (empty).
- **Quota:** `Quota::get_quota_info` gives megabytes used and left.
- **The web server is LiteSpeed:** the site answers `Server: LiteSpeed` with HTTP/3 offered
  (`alt-svc: h3`). Neither UAPI nor `get_server_information` names the web server; the Apache
  port fields are there regardless.

**Unverified (the spike settles these, R7):** a symlink, rename or move through Fileman (API2
`fileop`); whether a document root can be changed after creation (`SubDomain::changedocroot`) or
point at a symlink; a single database's dump without SSH; the call that creates a limited token;
whether `cloudlinux-selector` runs for the user over SSH (inside CageFS); a private GitHub
repository in VersionControl.

## R2. Plesk's API, as a customer

- **REST API** (`https://<host>:8443/api/v2/`): basic auth works for a customer whose hosting
  plan has "Ability to use REST API" (on by default; a customer sees only their own objects).
  API keys (`X-API-Key`) are made with `POST /api/v2/auth/keys`; whether a customer can make one
  for themselves is *unverified*. The spec is at `/api/v2/openapi.yml` on each server.
  [About the REST API](https://docs.plesk.com/en-US/obsidian/api-rpc/about-rest-api.79359/)
  - An older support article says the REST API is for the administrator only; it predates the
    page above. [Can resellers and customers use the REST API?](https://support.plesk.com/hc/en-us/articles/12376962044823-Can-Plesk-resellers-and-customers-use-REST-API)
- **CLI gateway:** `POST /api/v2/cli/<utility>/call` with `{"params": [...]}`; `GET
  /api/v2/cli/commands/` lists the utilities. Whether a customer may call it is *unverified*.
  [Manage Plesk via REST API](https://support.plesk.com/hc/en-us/articles/12377322315159-How-to-manage-Plesk-via-REST-API)
- **XML API:** secret keys can belong to a customer with "Ability to use XML API".
  [Creating secret keys](https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-secret-keys/creating-secret-keys.37131/)
- **Node.js:** the Node.js Toolkit's CLI (`plesk ext nodejs`) starts, stops and restarts apps;
  since Toolkit 2.6.0 the XML API has its operations except start, stop, restart and status.
  [Plesk change log](https://docs.plesk.com/release-notes/obsidian/change-log/)
- **Certificates:** SSL It! (`plesk ext sslit --certificate -issue -domain …`), CLI only in what
  was read. [SSL It!](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/websites-and-domains/advanced-website-security/securing-connections-with-ssltls-certificates/securing-connections-with-the-ssl-it%21-extension.80001/)
- **Unverified:** subdomains, document roots, databases, cron, files, the PHP version and SSH
  keys through the customer's API. Plesk stays on fakes (no account), so its connector is built
  from `openapi.yml` and these pages, and its live pass waits for an account.

## R3. DirectAdmin's API, as a user

- **Auth:** basic auth with a login key as the password. `CMD_API_LOGIN_KEYS` makes one:
  `keyname`, `key`, `passwd`, `never_expires` or `expiry_timestamp`, `max_uses`, the commands it
  may call (`select_allow0..n`, `select_deny0..n`, `ALL_USER`) and the IPs (`ips`). A host can turn
  login keys off per user. [API](https://docs.directadmin.com/developer/api/),
  [legacy API](https://docs.directadmin.com/developer/api/legacy-api.html),
  [1.40.2 change log](https://docs.directadmin.com/changelog/version-1.40.2.html)
- **Two APIs:** the JSON API under `/api/…` (OpenAPI 2.0 at `/static/swagger.json`, port 2222)
  and the legacy `/CMD_API_*` (any `/CMD_*` answers JSON with `?json=yes`).
- **Subdomains:** `CMD_API_SUBDOMAINS` lists, creates (`action=create&subdomain=`) and deletes.
- **Databases:** `/api/db-show` and `/api/db-manage` (`create-db`, `create-db-with-user`) since
  1.659. [1.659](https://docs.directadmin.com/changelog/version-1.659.html)
- **Certificates:** `CMD_API_SSL?domain=` reads `ssl_on` and the certificate.
  [1.24.4](https://docs.directadmin.com/changelog/version-1.24.4.html)
- **Cron:** `CMD_API_CRON_JOBS` lists, creates (`minute`, `hour`, `dayofmonth`, `month`,
  `dayofweek`, `command`) and deletes. [1.21.3](https://docs.directadmin.com/changelog/version-1.21.3.html)
- **SSH keys:** `CMD_API_SSH_KEYS` since 1.55.0; adding one is *unverified*.
  [1.55.0](https://docs.directadmin.com/changelog/version-1.55.0.html)
- **Unverified:** issuing Let's Encrypt, uploads, symlinks and renames, the PHP version and the
  selectors through the user's API. DirectAdmin stays on fakes too.

## R4. LiteSpeed Web Server on a hosting account

- **`.htaccess`:** LiteSpeed reads it where the host allows overrides (cPanel hosts do) and needs
  no restart after a change. Rewrite rules, `Require` and `Options` are supported; `php_value` and
  `php_flag` work under lsphp. Differences from Apache: `[L]` acts like `[END]`; rewrite rules in
  `<Location>` or `<FilesMatch>` are ignored; `<IfModule>` is ignored except
  `<IfModule LiteSpeed>`; no MultiViews or `FallbackResource`.
  [General](https://www.litespeedtech.com/docs/webserver/config/general),
  [switching from Apache on cPanel](https://docs.litespeedtech.com/lsws/cp/cpanel/switch-apache/)
  - *Unverified:* `Header` and `FilesMatch` with `Require all denied`, and whether LiteSpeed
    caches `.htaccess` for a while.
- **Telling it apart:** the `Server: LiteSpeed` header, which a host can hide (Enterprise's "Hide
  Full Header"). From PHP, `php_sapi_name()` is `litespeed` (*unverified*).
- **LSCache:** a PHP response header `X-LiteSpeed-Purge: *` empties the public cache; it is ignored
  where the server isn't LiteSpeed or the cache is off. WordPress: `wp litespeed-purge all`.
  [Cache controls](https://docs.litespeedtech.com/lscache/devguide/controls/),
  [LSCWP CLI](https://docs.litespeedtech.com/lscache/lscwp/cli/)
  - An app that sends no `X-LiteSpeed-Cache-Control` and no `CacheEnable` rule has nothing cached
    (inference). The cache folder's default place is *unverified*.
- **PHP processes:** lsphp runs detached by default, so PHP processes (and their OPcache) live on
  across a deploy. [PHP how-to](https://docs.litespeedtech.com/lsws/extapp/php/how-to/)
  - A user restarts their own lsphp with `touch ~/.lsphp_restart.txt` (*unverified*: forum and
    third-party posts only).
- **Node.js and Python apps:** LiteSpeed runs CloudLinux selector apps from the Passenger-style
  lines the selector writes into `.htaccess` (`PassengerAppRoot`, `PassengerStartupFile`, …), on
  a Unix socket (the app's own port is ignored), with WebSockets proxied. An app restarts when
  `<app root>/tmp/restart.txt` is touched or with `cloudlinux-selector restart`. Next.js needs its
  standalone build with `server.js`. [LiteSpeed and CloudLinux](https://docs.litespeedtech.com/lsws/cp/cpanel/cloudlinux/)
- **Symbolic links:** a host sets "Follow Symbolic Link" per virtual host, and LiteSpeed
  recommends "If Owner Match" on shared hosting; a user's `Options +FollowSymLinks` can't change
  it. A link and its target owned by the account itself pass; a target outside the virtual host's
  root is refused under "Restrained".
  [Virtual host basics](https://www.litespeedtech.com/docs/webserver/config/vhostbasic),
  [Security](https://www.litespeedtech.com/docs/webserver/config/security)

## R5. The atomic switch and PHP's caches

- **OPcache:** with `opcache.validate_timestamps=1` a script is checked again every
  `revalidate_freq` seconds (2 by default); with 0, only `opcache_reset()`,
  `opcache_invalidate()` or a restart refreshes it.
  [OPcache configuration](https://www.php.net/manual/en/opcache.configuration.php)
  - PHP's realpath cache (`realpath_cache_ttl`, 120 s by default) can keep resolving a switched
    symbolic link to the old release (*unverified* on LiteSpeed; the usual fix is a one-time
    request that calls `opcache_reset()` and `clearstatcache(true)`, or restarting lsphp).
- **Over SFTP alone:** OpenSSH's SFTP server offers `symlink` and the `posix-rename@openssh.com`
  extension, so a new link can be made beside the old one and renamed over it in one step, without
  a shell. [OpenSSH PROTOCOL](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)
- **Over a panel's API:** no panel's documented API makes a symbolic link (cPanel's API2 `fileop`
  is *unverified*). So deploys upload and switch over SFTP or SSH on every kind of account, and
  the panel's API makes the rest (domains, databases, cron, certificates, apps, keys).

## R6. OpenLiteSpeed as the server's proxy

- **Image:** `litespeedtech/openlitespeed`, tagged `<OLS version>-<PHP version>`, on Ubuntu; a
  server-only and a WordPress variant; amd64 and arm64 (*unverified*). The `ols-docker-env`
  example is MIT-licensed; OpenLiteSpeed's own licence (GPLv3) is *unverified*.
  [Docker Hub](https://hub.docker.com/r/litespeedtech/openlitespeed),
  [ols-docker-env](https://github.com/litespeedtech/ols-docker-env),
  [Docker install](https://docs.openlitespeed.org/installation/docker/)
- **Configuration as files:** `conf/httpd_config.conf` and `conf/vhosts/<name>/vhconf.conf`. A
  reverse proxy is an external app of type "Web Server" (its address) and a proxy context (`/`)
  pointing at it; a listener maps hostnames to virtual hosts.
  [Reverse proxy](https://docs.openlitespeed.org/config/reverseproxy/)
  - The file keywords (`extprocessor`, `context`, `map`) are *unverified*: the docs show the
    WebAdmin screens only.
- **WebSockets:** a separate "WebSocket Proxy" entry per virtual host (URI and address), plain
  `ws` to the backend only. [WebSocket proxy](https://docs.openlitespeed.org/config/reverseproxy/websocket/)
- **TLS:** certificate and key per listener or per virtual host (SNI), chained; ciphers settable.
  Limiting protocols to TLS 1.2 and 1.3 and OCSP stapling are *unverified*.
  [SSL](https://docs.openlitespeed.org/security/ssl/)
- **Headers:** "Header Operations" per context (HSTS, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`). [Headers](https://docs.openlitespeed.org/security/headers/)
- **Check and reload:** `/usr/local/lsws/bin/openlitespeed -t` tests the configuration; a
  graceful restart is described as zero-downtime. Whether open WebSockets survive it is
  *unverified*. [Commands](https://docs.openlitespeed.org/commands/)
- **WebAdmin:** listens on 7080 with a password set by a script; how to turn it off entirely is
  *unverified* (remove its listener).
- **Certificates:** OpenLiteSpeed issues none itself; `ols-docker-env` runs acme.sh beside it.
- **LSCache through a proxy:** it caches pages from a backend that sends LiteSpeed's cache headers
  (the WordPress plugin, with `LSWS_EDITION`), *unverified* for a backend that sends none.
  [LSCache as a proxy](https://docs.openlitespeed.org/config/reverseproxy/lscache/),
  [LSCache](https://docs.openlitespeed.org/config/lscache/)

## R7. What the spike must settle

**On the founder's cPanel account** (every object named `e2e-…`, removed afterwards):
1. A limited token (features, IPs, expiry): the call, and which features each operation needs.
2. A subdomain whose document root is a symbolic link `e2e-…/current/public` → a release folder,
   switched over SFTP (`symlink` then `posix-rename`): served without a 403 under LiteSpeed's
   owner match, and how soon the new release answers (OPcache, realpath cache).
3. `touch ~/.lsphp_restart.txt`, and a one-time `opcache_reset()` request, after a switch.
4. `.htaccess`: HTTPS forced, `/.env` refused (403), `Header` lines answered.
5. `X-LiteSpeed-Purge: *` from a plain PHP app, and where the cache lives.
6. API2 `SSH::importkey` and `authkey` for a deploy key; SFTP and `mysqldump` over SSH with it.
7. A database and user through UAPI `Mysql`, a cron line through API2, and AutoSSL on the new
   subdomain.
8. `cloudlinux-selector` for the user over SSH: a Node.js app created, deployed and restarted.

**In a container:** OpenLiteSpeed's file syntax with `openlitespeed -t`; TLS 1.2/1.3 only
(`openssl s_client`); headers in a proxy context; a catch-all virtual host refusing unknown
hostnames; a WebSocket across a graceful restart; the admin listener removed; LSCache with a
backend that sends no cache headers, and its purge.

## R8. Where a hosting account plugs in (code map, 2026-11-12)

Read from the working tree at `f8eca286`; line numbers drift, the files don't.

- **Kinds:** `VpsProviderSchema`, `ServerlessProviderSchema` and `DeployProviderSchema` in
  `plan-schema/src/enums.ts` (guards `onOneServer`, `isServerlessProvider`); the plan's `target` is
  a discriminated union on `provider` (`DeployTargetSchema` in `plan-schema/src/plan.ts`, one strict
  object per kind), generated into `schemas/plan.schema.json` and `requirements.schema.json`.
  `ProviderId` in `contracts/src/connector.ts`; cloud providers come only from
  `@opscrew/providers` (a hosting account is not one: nothing is bought or priced).
- **Names and hints:** `agents/src/providers/profiles.ts` (`providerProfile`),
  `iac-templates/src/providers.ts` (`NOT_CLOUD`), `plan-schema/src/placement.ts`
  (`TARGET_NAMES`), `agents/src/shared/vps-target.ts`, the interview's `SERVERLESS_HINTS`, the CLI
  commands' own hints (interview, env, logs, retarget, status, destroy) and the MCP tools'
  answer help.
- **Approvals:** `ApprovalKind` in `contracts/src/safety.ts` and `APPROVE_BY_HASH_KINDS` in
  `cli/src/approval.ts`; own servers use `host-apply` (ADR 0011), Portainer `stack-apply`
  (ADR 0012), GitHub Pages `pages-apply`.
- **The pattern to follow** is ADR 0011's: a zod plan schema in the connector, its hash as SHA-256
  of the canonical JSON, the plan file under `.opscrew/plans/`, `approvals.request` with the
  kind and hash, and an apply that recomputes the hash and refuses a mismatch
  (`PLAN_HASH_MISMATCH`). Connector packages hold a client, inspection, plan, apply and fakes
  (`connectors/portainer`, `connectors/ssh-host`).
- **Phases:** there is no target registry. GitHub Pages, the closest kind (deploys from GitHub
  Actions, no server), is reached through guards and exhaustive switches in interview, design,
  provision (`provision/run.ts`), the workflow renderer (`iac-templates/src/workflow/index.ts`),
  verify, status, rollback, destroy, secure, drift and retarget, with its own modules under
  `agents/src/serverless/pages/`. About 74 non-test files name a server-less kind, and about 60 use
  the target guards.
- **Docs that list targets:** `docs/guide/index.md`, `README.md`, `docs/guide/retarget.md`,
  `docs/guide/logs-and-status.md`.

## R9. Where the proxy choice reaches (code map, 2026-11-12)

nginx came with 014 (ADR 0017; T1407 alone touched 30 files, and about 156 files mention nginx).

- **The choice:** `EdgeSchema` (`caddy`, `nginx`) in `plan-schema/src/plan.ts`, on the own,
  cloud and localhost targets (Portainer keeps Caddy); written by design (`design/run.ts`, the
  previous plan's choice or `caddy`), never asked. Previews refuse anything but Caddy.
  `EDGE_PROXIES` in `iac-templates/src/edge/index.ts` is an exhaustive record, so a third proxy
  fails to compile until every `Record<EdgeProxy, …>` has it.
- **What nginx needed, each needing an OpenLiteSpeed equivalent:**
  - its configuration (`edge/nginx.ts`): server tokens off, header inheritance, WebSockets, a
    default server refusing unknown names (`ssl_reject_handshake`, 444);
  - a configuration test before every change: the deploy's switch (`workflow/switch.ts`), the
    additions check (`provision/additions.ts`), the CI check (`workflow/edge-check.ts`) and
    retarget (`retarget/server-ops.ts`);
  - a graceful reload in the same places and in `localhost/destroy.ts`, plus a flag-file loop
    (`NGINX_LOOP`) that reloads after a certificate changes;
  - certificates: origin certificates read from `/srv/edge/tls/<app>`, and certbot (webroot,
    renewal every 12 h, `renew_before_expiry` 45 days) for DNS-only hostnames; CAA issuers per
    proxy (`infra/cloudflare.ts`, `secure/settings.ts`); renewal failures in
    `status/certificates.ts` and `secops/hardening/tls.ts`;
  - the additions file's rules (`secops/src/proxy-rules`, gixy for nginx);
  - `vercel.json` routing per proxy (`edge/vercel-routing.ts`);
  - inspection of an own server (`ssh-host/src/inspect.ts`) and teardown (`ssh-host/src/steps.ts`);
  - the image pin (`iac-templates/src/pins.ts`) and the memory estimate (`edgeMemoryMb`).
- **Tests to mirror:** `edge/nginx.test.ts`, `edge/nginx-validate.test.ts` (unknown hostnames,
  HTTPS redirect, HSTS, TLS 1.2/1.3 only, Cloudflare client certificates), `workflow/nginx-deploy`,
  `workflow/edge-check`, `workflow/switch`, `provision/additions`, `secops/proxy-rules`; the live
  pass `packages/cli/test/live/own-nginx.test.ts` (the switch between proxies, renewals under load,
  a failed first certificate); docs `docs/guide/reverse-proxy.md` and the pages it links.
- **No cache purge exists today**: OpsCrew empties no proxy cache, so OpenLiteSpeed's is new.
