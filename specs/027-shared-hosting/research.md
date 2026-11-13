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
- **Tokens:** `Tokens::list` gives each token's `features` (a list), `whitelist_ips`,
  `expires_at`, `has_full_access` and `readonly`. The test token has full access and no expiry.
  A token can't be limited to features or addresses after all, only given an expiry (R10).
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

**Unverified at first, settled by the spike (R10):** a symlink, rename or move through Fileman
(API2 `fileop`); whether a document root can be changed after creation (`SubDomain::changedocroot`)
or point at a symlink; a single database's dump without SSH; the call that creates a limited
token; whether `cloudlinux-selector` runs for the user (inside CageFS). Still *unverified*: a
private GitHub repository in VersionControl.

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
  - A user restarts their own lsphp with `touch ~/.lsphp_restart.txt` (forum and third-party
    posts only; it works on the test account, R10).
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
- **Over a panel's API:** no panel's documented API makes a symbolic link. cPanel's `fileop`
  makes none either, but a tar that holds one does, and it replaces an existing link by removing
  it first, so not atomically (R10).
- **On an account SSH doesn't reach** (the test account, R10): the switch has to run on the
  account itself, as the account's user: PHP's `symlink()` and `rename()`, or a cron job's shell.

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

## R10. The spike on the cPanel test account (2026-11-12)

Three passes on the founder's account, every object named `e2e-…` and removed in each pass's
cleanup. Three traces the cleanup missed were removed afterwards with the founder's go-ahead: a
section in `~/.cl.selector/htaccess_cache` (the file is back to its original bytes), LiteSpeed's
test files in `~/lscache`, and the certificate AutoSSL had issued, with its key.
The account is ordinary **shared hosting**: CageFS, no root, lfd and Imunify360 on the host, and
SSH unreachable from outside (`SSH::get_port` answers 9000, which is filtered; port 22 refuses).
That is the account most users of this feature have, so its limits are the design's default.

**R7's questions, in order.**
1. **Tokens can't be limited.** UAPI `Tokens` has only `create_full_access`, `list`, `rename` and
   `revoke`. `create_full_access` accepts `features` and `whitelist_ips` and drops both without an
   error (`Tokens::list` then shows `has_full_access: 1`, `features: []`); only `expires_at` is
   kept. A cPanel token is the whole account.
2. **A document root on a symbolic link works.** With `e2e-…/current → releases/1` made first,
   `SubDomain::addsubdomain dir=e2e-…/current/public` answers status 1, cPanel keeps the link's
   path as the document root, and LiteSpeed serves it with no 403 (owner match). The hostname
   answered 26–28 s after creation (before that, a 301 to the host's own page); its A record was
   public within about 30 s. API2 `SubDomain::changedocroot` works too (about 4 s; the new root
   served 18–20 s later).
   - **The panel's API has no atomic switch.** API2 `Fileman::fileop`: `symlink` is unknown,
     `link` makes a hard link (refused on a folder), `rename` refuses an existing destination,
     and `move` onto a link to a folder moves the entry into that folder. A tar holding a link,
     uploaded with `Fileman::upload_files` and unpacked with `fileop op=extract`, makes the link,
     and replaces an existing one by removing it first (181 ms, not one rename).
   - **PHP's `symlink()` then `rename()` over the old link** switches atomically.
   - `upload_files` takes dotfiles; `Fileman::save_file_content` writes a file only into a folder
     that exists.
   - SFTP: not tested, since SSH doesn't answer.
3. **PHP after a switch.** PHP 7.0.33 under lsphp (`php_sapi_name()` `litespeed`), OPcache not
   loaded, `realpath_cache_ttl` 120, `LSWS_EDITION` unset, no function disabled. The lsphp process
   that made the switch served the new release within 0.8 s; the other kept serving the old one
   for the whole 15 s watched, so answers alternated. The cause is PHP's realpath cache, kept per
   process; `clearstatcache(true)` in one request fixes only that process. **Writing
   `~/.lsphp_restart.txt`** (through `save_file_content`) started new lsphp processes within 0.6 s,
   and every request served the new release after it. One request hung for 15 s around the second
   restart.
4. **`.htaccess`.** cPanel writes `.htaccess` (a MultiPHP INI block), `.user.ini` and `php.ini`
   into a new document root, through the link into the release folder, and a `.well-known/`
   folder later. A release must keep them (the first pass's upload overwrote cPanel's
   `.htaccess`). On LiteSpeed:

   | Rule | Seen |
   |---|---|
   | `RewriteRule` to HTTPS `[R=301]` | `http://` answers 301 to `https://` |
   | `<FilesMatch "^\.">` `Require all denied` | `/.env`, `/.htaccess`, `/shared/.env` answer 403; 200 without the rule |
   | `Header always set` (nosniff, HSTS) | present on 200, 301 and 403 answers |
   | `/../shared/.env` (`--path-as-is`) | 400 |

   **Directory listing is on by default** ("Index of /…"), so OpsCrew writes `Options -Indexes`.
   The AutoSSL certificate validates without `-k`.
5. **LSCache.** A PHP answer with `X-LiteSpeed-Cache-Control: public,max-age=60` alone is never
   cached; with `<IfModule LiteSpeed>CacheLookup on</IfModule>` in `.htaccess` the next requests
   hit. `X-LiteSpeed-Purge: *` from a PHP script empties it (a miss with the new body, then hits).
   The cache lives in `~/lscache`, owned by `nobody` (group the user, mode 2770); the account can
   remove LiteSpeed's files there through `fileop op=unlink`.
6. **SSH key and shell.** API2 `SSH::importkey` and `SSH::authkey action=authorize` work.
   `SSH::listkeys` shows public keys only with `pub=1`; removal is `authkey action=deauthorize`,
   then `SSH::delkey name=… pub=1` (with `key=` it answers "Invalid filename" and still
   `event.result: 1`). Shell facts, read through a cron line: CageFS (`/` shows a skeleton, one
   entry in `/home`, 5 processes visible); cron's `PATH` is `/usr/bin:/bin`; present are `mysql`
   and `mysqldump` (MariaDB 10.11 client), `php` CLI 7.0.33, `git` 2.56, `python3` 3.6, `curl` and
   `/usr/sbin/cloudlinux-selector`; missing are composer, node, npm, rsync and wp-cli.
   `mysqldump --defaults-extra-file=<0600 file> --single-transaction --no-tablespaces` works as the
   user. UAPI `Mysql::dump_database_schema` exists (schema only, not tried on data).
7. **Database, cron, certificate.** `Mysql::create_database`, `create_user` and
   `set_privileges_on_database` answer status 1 in about 1 s each; PDO with `host=localhost` works.
   **A deleted database came back** in `list_databases` minutes later (0 bytes, no users, and
   "does not control" on delete); a create then a delete removed it for good. API2 `Cron::add_line`
   answers a `linekey`, jobs run at the next minute, `remove_line linekey=` works, and `listcron`
   ends with a `{count: N}` entry. **AutoSSL ran by itself** when the subdomain was made; the
   certificate stays in the account's store after the subdomain is removed (`SSL::delete_cert`).
8. **CloudLinux's Node.js selector** runs for the user: `cloudlinux-selector get --json
   --interpreter nodejs` lists 13 versions (6.17 to 24.22). `create --version 24 --app-root …
   --app-uri node --app-mode production --domain … --startup-file app.js` succeeded in about
   11 s, made `~/nodevenv/<app root>/24`, and wrote the Passenger lines into
   `<document root>/node/.htaccess`, **inside the current release**, so a switch loses them unless
   each release carries them. `/node/` answered from the app (about 1 s cold); `tmp/restart.txt`
   or `cloudlinux-selector restart` gave a new process. `PassengerApps::list_applications` doesn't
   list it. `destroy` left an empty `~/nodevenv/<app root>`, the `.htaccess` lines, and a section in
   `~/.cl.selector/htaccess_cache` that only editing the file removes.

**Also seen.** API2 reports `event.result: 1` when the operation failed (`fileop`, `delkey`), so a
client reads `data[].result` and `error`. No rate limit across about 400 calls. `~/.cache` appears
in the home folder while the API is used. The `multiphp` feature is off, yet cPanel writes the
MultiPHP INI files.

**What it changes.**
- The token can't go to GitHub Actions (FR-2703): it is the whole account, not one app.
- GitHub Actions can't reach such an account over SFTP or SSH, and the panel's API can't switch
  atomically, so on a panel account the release is switched by code running on the account.
- PHP 7.0 is too old for the example Laravel app. A second, shorter spike (R11) looked at a newer
  PHP for one hostname without changing the account's, the CLI's alternative PHP binaries, and
  whether the account reaches GitHub.

## R11. The second spike: PHP versions, GitHub and the agent's tools (2026-11-12)

Two short passes on the same account, every object named `e2e-spike2…` and removed in each pass's
cleanup, the certificates AutoSSL issued and their keys included. The inventory afterwards matched
the one before except the zone's `_cpanel-dcv-test-record` TXT value, which AutoSSL rewrites on
each validation run (inferred). The selector's state and files were unchanged throughout.

- **PHP on the account.** `/opt/alt` holds CloudLinux's alt-php builds; the CLI binaries
  `/opt/alt/php80…85/usr/bin/php` answer 8.0.30 to 8.5.12. `/usr/local/bin/php` (CLI) and
  `/usr/bin/php` (cgi-fcgi) are the account's 7.0.33. `cloudlinux-selector get --json --interpreter
  php` answers `selected_version` 7.0, `default_version` 7.4, `domains_tab_is_hidden` false and
  4.4 to 8.5 enabled; `get --domain <hostname>` is accepted (7.0, no extensions for it).
- **One hostname on a newer PHP:** `AddHandler application/x-httpd-alt-php85___lsphp .php` in the
  hostname's `.htaccess`, above cPanel's block, gives PHP 8.5.12 under LiteSpeed (`litespeed`
  SAPI, 200, `application/json`); `alt-php82___lsphp` gives 8.2.35. The account's version is
  untouched, and removing the line goes back to 7.0 within 3 s.
  - A changed handler takes 1.4 to 8 s to apply (8.2 still answered 3 s after a change to 8.5);
    then it is stable. A deploy checks for the version it expects instead of assuming it.
  - **Only the base extensions load** that way: PDO, `pdo_mysql`, `mysqli`, `curl`, `openssl`,
    `json`, `session`, `tokenizer`, `xml`, `ctype`, `filter`, `iconv`, OPcache and the like, but
    no `mbstring`, `dom`, `fileinfo`, `intl`, `gd` or `zip`, whatever the selector lists for 8.5.
    The account's selected 7.0 has them all. Laravel needs `mbstring` and `fileinfo`, so the
    handler alone doesn't run it (inferred: the selector's extension choices apply to the
    selected version only).
  - **OPcache is on under 8.5** (`opcache.enable` 1; not loaded under 7.0), so the switch's lsphp
    restart (R10) clears it too. `memory_limit` 128M, `max_execution_time` 30, `upload_max_filesize`
    2M, `post_max_size` 8M, `realpath_cache_ttl` 120, nothing disabled, as under 7.0.
  - **`.user.ini` isn't read:** a marker setting written before any request didn't apply under 7.0
    or 8.5. cPanel's `php_value` lines in `.htaccess` do apply under both, so OpsCrew's PHP settings
    (`auto_prepend_file`) go in `.htaccess`.
  - The CLI binaries have the same base set: `/opt/alt/php85/usr/bin/php` loads `pdo_mysql`, not
    `mbstring`.
- **GitHub from the account:** `https://github.com` and `https://api.github.com` answer 200;
  `git ls-remote` over HTTPS works (cron's `git` is `/usr/bin/git` 2.43.7); OpenSSH 8.0p1 reaches
  both `git@github.com` (22) and `git@ssh.github.com` (443): "Permission denied (publickey)" with
  no key offered (`-F /dev/null`, `IdentitiesOnly`, no agent).
- **The account reaches its own hostname** over HTTPS by its public name, with a valid certificate
  (`ssl_verify_result` 0).
- **Tools:** GNU coreutils 8.30 (`mv -T`, `ln`, `sha256sum`, `timeout`), GNU tar 1.30, gzip 1.9,
  util-linux `flock` 2.32.1, OpenSSL 1.1.1k (`openssl dgst -sha256 -hmac` gives the right HMAC),
  `ssh-keygen`. `ulimit`: 1024 open files, no CPU or file size limit. Cron's time zone is CET.
- **Cron runs long jobs:** a job that slept 150 s finished and wrote its marker.
- **A new hostname:** it answered HTTP about 29 s after creation; AutoSSL issued its certificate by
  itself within 11 to 45 s, and HTTPS answered 404 for about 12 s after it was installed. The
  certificate stays in the account's store after the hostname is removed.

**What CloudLinux documents (read 2026-11-12).**
- **The selector's version is the account's:** without Isolates, PHP Selector sets one version per
  account, for all its sites. A version per site comes with CloudLinux Isolates (beta, cPanel and
  LiteSpeed supported): root allows site isolation, the user isolates a domain, then
  `selectorctl --set-user-current=<version> --domain <domain>` and
  `selectorctl --enable-user-extensions=<list> --version <v> --domain <domain>` apply to that domain
  only. [Isolates](https://docs.cloudlinux.com/cloudlinuxos/isolates/)
  - `cloudlinux-selector`'s `--domain` is documented for Node.js and Python only; that the PHP
    `get --domain` answers (above) is undocumented.
- **A handler line loads the version's default modules:** the extensions chosen in PHP Selector
  load only for the selected version; another alt-php version reached by a handler line loads
  `/opt/alt/phpXX/etc/php.d/default.ini`'s set, and the fix (a `symlinks.rules` file and
  `selectorctl --apply-symlinks-rules`) needs root. *From search summaries of CloudLinux's
  knowledge base; the articles answered 403:*
  [selected modules are not used](https://cloudlinux.zendesk.com/hc/en-us/articles/4412353451676-Different-PHP-Version-per-domain-folder-selected-modules-are-not-used),
  [changing modules per domain](https://cloudlinux.zendesk.com/hc/en-us/articles/4411475922450-How-to-change-PHP-modules-when-using-different-PHP-versions-per-domain).
  This matches what the account showed.
- **So, on a CloudLinux account without Isolates:** an app that needs only the base extensions
  (`pdo_mysql`, `curl`, `openssl`, `json`, `ctype`, `tokenizer`, `xml`…) can run on a newer PHP
  through its hostname's handler line; an app that needs more (Laravel's `mbstring` and
  `fileinfo`) needs the account's version, which changes every site on the account.
  `examples/php-plain-mysql` (PHP 8.3 or newer, `pdo_mysql`) fits the test account as it is;
  `examples/laravel-app` (PHP 8.4, `mbstring`) doesn't.
- **cPanel without CloudLinux** chooses a version per domain through MultiPHP (UAPI `LangPHP`,
  with the `multiphp` feature, which the test account lacks); its extensions are the host's
  EasyApache build for that version (*unverified* here, no such account).

## R12. OpenLiteSpeed in a container (spike, 2026-11-12)

Run locally with Docker; the configuration files that worked are kept outside the repository and
summarised here.

- **Image:** `litespeedtech/openlitespeed`, tags `<OLS>-lsphp82…85` and `latest`; 1.9.4 is the
  current release. `1.9.4-lsphp84`'s index digest is
  `sha256:84b5a648789f0c4ba1da9ffe3cb3ba79ae30a9c5c95f1e6a7f9302f8b273f2f8`, for `linux/amd64` and
  `linux/arm64`. Every tag carries PHP (1.09 GB, Ubuntu); there is no server-only one. OpenLiteSpeed
  is GPL-3.0 ([repository](https://github.com/litespeedtech/openlitespeed)); the Docker files are
  MIT. TLS is BoringSSL. Configuration: `/usr/local/lsws/conf/httpd_config.conf` and
  `conf/vhosts/<vhost>/vhconf.conf`, copied from defaults only when `conf/` is empty; OpenLiteSpeed
  writes `.txt` copies into that folder on every load, so it must be writable. Idle memory 10.5 MiB.
- **Not PID 1:** a graceful restart (`SIGUSR1`, `lswsctrl restart`) starts a new main process and
  the old one exits, so the container needs `init: true` and a loop that starts the daemon and
  watches it by name (`pgrep -f 'lshttpd - main'`); its pid file is briefly empty during a restart.
  After the first restart nothing reaches `docker logs`: the error log goes to a file.
- **As a reverse proxy:** per vhost an `extprocessor <name> { type proxy; address <host>:<port> }`
  and `context / { type proxy; handler <name> }`, plus `websocket / { address <host>:<port> }`
  (without it a WebSocket gets an empty reply); listeners on 80 and 443 with `map <vhost>
  <hostname>`. An extprocessor's hostname is resolved once at load, so a backend that changes its
  address needs a graceful restart (nginx re-resolves every 10 s); a WebSocket's address is
  resolved per connection.
- **The configuration check:** `/usr/local/lsws/bin/openlitespeed -t` exits 0 (clean), 1 (warnings;
  a correct proxy configuration always warns) or 2 (an error), and exits 0 without checking when
  `/tmp/lshttpd` is missing. It reports an unknown handler, a broken vhost file, a missing vhost
  certificate; it only warns about an unknown directive in the server file; it doesn't notice a
  missing listener certificate, and 443 then serves plain HTTP. A graceful restart applies a
  broken configuration anyway (nginx keeps the running one).
- **TLS:** `sslProtocol 24` (TLS 1.2 and 1.3; 1.0 and 1.1 refused), with `ciphers` and
  `enableECDHE 1` repeated in every vhost's `vhssl` (the listener's line reaches only its own
  certificate); certificates per vhost by SNI, the listener's for unknown names. A certificate file
  that changes is served only after a graceful restart; one under load kept a WebSocket and an
  85 s request and dropped no request.
- **Headers:** `extraHeaders` in the context (`Header set …`) for HSTS, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, on proxied answers, OpenLiteSpeed's own errors and 101s;
  `showVersionNumber 2` drops the `Server` header; OpenLiteSpeed's error pages name LiteSpeed in
  their body unless an error page is set. HTTP to HTTPS: a rewrite with `[R=308,L]`.
- **Unknown hostnames:** a catch-all vhost mapped `*` with `accessControl { deny ALL }` answers 403
  on HTTP and HTTPS, behind a placeholder certificate. There is no way to close the connection
  (nginx's 444) or refuse the handshake (`ssl_reject_handshake`).
- **WebSockets across a graceful restart** survive until `gracefulRestartTimeout` (300 s by
  default), when the old process ends; nginx keeps old workers until their connections close.
- **Admin console:** `disableWebAdmin 1` leaves only 80 and 443 (and UDP 443 for HTTP/3).
- **LSCache:** with the cache off, an answer is cached only when the backend sends
  `X-LiteSpeed-Cache-Control` (or a rewrite rule sets it). Turned on for a vhost, it caches every
  GET, `no-store`, `private`, `Authorization` and `Set-Cookie` answers included. A response header
  `X-LiteSpeed-Purge: *` empties every vhost's cache, not only its own; `PURGE` from 127.0.0.1
  empties one URL; removing the files under the cache's `storagePath` takes effect at once.
- **Long requests:** a 130 s answer reaches the client; the limit is the server-wide `connTimeout`
  (no per-app timeout).
- **Forwarded headers:** `X-Forwarded-For` is appended to; `RequestHeader unset X-Forwarded-For`
  in `extraHeaders` leaves the real address. Client certificates per hostname (Cloudflare's
  authenticated origin pulls): `clientVerify 2` fails the handshake without one, where nginx answers
  400.

## R13. What the live passes found (2026-11-13)

- **Parked domains (cPanel pass, run 1):** the test domain is a parked domain (an alias of the main
  domain) on the founder's account, with two subdomains of its own. `DomainInfo::domains_data`
  with `format=list` leaves parked domains out (main, addon and subdomains only), so the connector
  and the pass's inventory never saw it. Without `format`, `domains_data` gives `main_domain` as an
  object, `addon_domains` and `sub_domains` as arrays of objects, and `parked_domains` as an array
  of names (plain strings, no document root: a parked domain serves the main domain's).
  `list_domains` gives the four lists as names. A subdomain whose root is a parked domain is
  allowed (the account has two).
- **The main domain may not resolve (cPanel pass, run 2):** the founder's account's main domain
  has no DNS (`ENOTFOUND` over HTTPS and HTTP), while its parked domain and subdomains answer
  `Server: LiteSpeed`. Design read the web server from the main domain only, so it named none, and
  provision refused the PHP app though alt-php 8.3 to 8.5 load `pdo_mysql` through a handler line
  (R11). On shared hosting a main domain that is a placeholder or has lapsed is common.
- **The deploy job's wait ended early (cPanel pass, run 3):** the step "Wait for the account to switch
  to the release" runs under GitHub's `bash -e` with `set -uo pipefail`; its
  `curl … | tr -d '\r' | awk '… { print; exit }'` let awk exit at the `X-OpsCrew-Release` line, so
  `tr` failed writing the rest of the headers ("tr: write error: Broken pipe"), the pipeline failed
  and `-e` ended the step after 21 s, at the moment the release could be seen. The agent had
  deployed (its cache's pack written 20 s later).
- **cPanel can't remove a read-only file (run 3):** `Fileman::fileop unlink` removed the app's
  folder except git's pack files in the agent's cache (mode 0444, as git writes every object and
  pack), answering "Directory not empty" for the folder, then and later. After `fileop chmod 0644`
  on those files, the same unlink removed the folder. So a file the agent leaves read-only keeps
  destroy from removing its folder.
- **The deploy job and the agent's health check (run 5):** the job's wait took any answer with the
  release's `X-OpsCrew-Release` header, which OpsCrew's `.htaccess` sets on every answer, a 500
  included, while the agent keeps a release only when it answers 2xx or 3xx with it (and switches
  back otherwise). So the job could pass for a release the agent then switched back. `state/status`
  is written after the agent's check, so `opscrew status` right after the job may still show the
  state before.
- **AutoSSL's wildcard certificate (run 5):** for one run's hostname AutoSSL issued a certificate
  named `_wildcard__<domain>_…` for `*.<domain>` and `www.<hostname>`; destroy rightly leaves a
  certificate that covers other names, and it stayed in the store, installed nowhere.
- **A plain PHP app's paths (run 6):** `examples/php-plain-mysql` routes every path through
  `public/index.php` and has no `.htaccess`; on a server Caddy's `php_fastcgi` sends a path that is
  no file to `index.php`, but on the account `PUT /data` answered 404, since nothing in `.htaccess`
  did. LiteSpeed has no `FallbackResource` (R4), so the fallback is a rewrite rule.
- **The app's kept folder (run 7):** the note `examples/php-plain-mysql` keeps in `storage/` was gone
  after a second release ("No note yet."), while MySQL still had it: the agent linked only `.env`
  and Laravel's `storage` into each release, not the plan's kept folder (`storage.files.dir`), and
  the SFTP workflow links none. On a server that folder is a volume that outlives every deploy.
- **AutoSSL's challenge record (run 7):** after the run's hostname was removed, the zone kept a TXT
  record `_acme-challenge.www.<hostname>` that AutoSSL had added; OpsCrew leaves what it didn't make,
  and so does the pass, which never edits the zone (the founder removes such records by hand).
- **An empty file (run 8):** `Fileman::get_file_content` answers `content: null` for a file of 0
  bytes (seen on two empty files of the account), so the connector's read of the Node.js app's empty
  `shared/.env` failed ("expected string, received null"). Run 8 otherwise passed the PHP and the
  static site legs whole: provision, deploys, the switch watch, rollback, secure, drift, the
  snapshot's restore and destroy.
- **The selector's own check (run 10):** the Node.js app's first deploy stopped when
  `cloudlinux-selector install-modules` answered "An error occured during installation of modules.
  The operation was performed, but check availability of application has failed": the selector
  compares the app's answers (status code and MIME type) before and after it installs, and before a
  first release the app root holds the empty placeholder. `--skip-web-check` exists only for
  `migrate`, not `install-modules`
  ([command-line tools](https://docs.cloudlinux.com/cloudlinuxos/command-line_tools/), read
  2026-11-13). The packages were installed; the agent's health check after the switch is the check
  that decides.
- **The deploy job's path (run 12):** the agent deployed the Node.js app's first release (the
  selector's own check failed with a 503 before and `text/html` after, so T2741's note applied) and
  its health check on the app's health path passed, but the deploy job asked the site's root `/`,
  which never answered 2xx with the release in 9 minutes. The job now asks the health path the
  agent's check asks.
- **A certificate that isn't OpsCrew's (run 12):** provision recorded the certificate installed on
  the new hostname as made by OpsCrew, and on this account that was the domain's existing AutoSSL
  wildcard (`_wildcard__<domain>_…`, issued before the run): destroy would remove it when no other
  site has it installed. OpsCrew may count a certificate as its own only when it names nothing but
  the hostname and `www.` of it.
- **The selector resolves the app root (runs 11 and 12):** `cloudlinux-selector create --app-root
  opscrew/<app>-<env>/current` registered the app in `~/.cl.selector/node-selector.json` under the
  resolved folder (`…/releases/0-0`), so once `current` points at another release, `destroy` (and
  any other selector command given `current`) answers "No such application or it's broken. Unable
  to find app-root folder by this path …/releases/<id>". Passenger still ran each new release, so
  what the selector wrote for Passenger follows `current`.

## R14. CloudLinux's selector and the release switch (cPanel pass, runs 11–13, 2026-11-13)

What the selector made for `cloudlinux-selector create --app-root opscrew/<app>-<env>/current`,
while `current` pointed at the placeholder release `releases/0-0`:
- `~/.cl.selector/node-selector.json` keys the app by the resolved folder,
  `opscrew/<app>-<env>/releases/0-0`; `htaccess_cache` names both `current/public/.htaccess` and
  `releases/0-0/public/.htaccess`.
- The Passenger block it wrote into the served `.htaccess`: `PassengerAppRoot
  "/home/<user>/opscrew/<app>-<env>/releases/0-0"`, `PassengerNodejs
  "/home/<user>/nodevenv/opscrew/<app>-<env>/releases/0-0/22/bin/node"`, `PassengerAppType node`,
  `PassengerStartupFile dist/index.js`, `PassengerBaseURI "/"`; no variable of the app.
- The virtual environment is `~/nodevenv/opscrew/<app>-<env>/releases/0-0/`.
- It put its own placeholder app into `releases/0-0` (it answers `200 text/plain` "It works!" on
  every path), and Passenger ran that: the agent carried the Passenger block into each release
  byte for byte, so every release's `.htaccess` sent Passenger to `releases/0-0`. The health checks
  passed on the placeholder; the app's own code never ran.
- Every later selector command given `current` (`install-modules`, `set`, `destroy`) looks the app
  up by the folder `current` resolves to then, and once that is another release it answers "No such
  application or it's broken. Unable to find app-root folder by this path …".

So the selector resolves the app root once, for its registry, its environment and Passenger. A
release switch through `current` reaches Passenger only if each release's `.htaccess` names that
release as `PassengerAppRoot`; the selector's commands need the one folder it registered, which must
then stay. Open: whether the selector's environment variables reach an app whose `PassengerAppRoot`
isn't the registered folder (none were set on these runs).

After T2744 (run 15): Passenger ran the release's own code, and the app stopped with
`ERR_MODULE_NOT_FOUND: Cannot find package '@hono/node-server' imported from
…/releases/<id>/dist/index.js` ("Did you mean to import @hono/node-server/dist/index.cjs?"). The
selector made no `node_modules` link in the app's root, so the agent linked none into the release;
an ES module resolves packages only through a `node_modules` folder above it (CommonJS would also
read the `NODE_PATH` the hint suggests the selector sets). The packages are in the environment the
selector's `PassengerNodejs` line names: `<env>/bin/node`, packages in `<env>/lib/node_modules`.

After T2745 (runs 16 and 17): the first release ran its own code and passed verify, and the
release's `node_modules` link to `<env>/lib/node_modules` let its ES modules load. On the second
release every answer after the switch carried the new release's `X-OpsCrew-Release` (LiteSpeed read
the new `.htaccess` at once) but the old release's page: the Node.js process started for the first
release kept serving, since nothing restarted it. Passenger's restart signal is `tmp/restart.txt` in
the app's root (what `cloudlinux-selector restart` touches).

With `tmp/restart.txt` touched in both releases after the switch (run 18), one answer at the switch
still showed the old release's page; with the new release's also touched before the rename (run 19),
all 30 answers of the 20 s watch did (runs 16 and 17, with no touch: 25 and 29). LiteSpeed acts on
the restart file on its own timing, so a release switch can't rely on it: the old release's
processes must end, so that the next request starts the code the new `.htaccess` names.

Ending the old release's processes (run 20): at the second switch the agent found and ended 2
processes whose working folder was the old release (`/proc` is readable on the account) and the
health check passed 2 s later, yet every answer of the watch still showed the old page with the new
release's header. LiteSpeed re-reads `.htaccess` for headers at once but starts the app again from
the `PassengerAppRoot` it already holds for the site. So the `PassengerAppRoot` OpsCrew writes is the
`current` link, the same in every release: a new process follows the link to the release `current`
names.

`PassengerAppRoot` as the `current` link (runs 21–23): the selector's `install-modules` then failed
within seconds with "Node.js module installation failed without a diagnostic", before npm ran (no
`~/.npm`), twice of twice; with each release's own folder as the root (runs 16–20) it installed every
time. So the selector wants the Passenger block it wrote, and LiteSpeed holds the site's first
`PassengerAppRoot`: the root must be the one the selector registered, `app/`, unchanged. The release
is then reached through the startup file: the app is created with `--startup-file
current/<startup>`, `app/current` a link to `../current`, so Node runs the file through the link
(resolving it to the release's folder, whose `node_modules` link it uses), and a switch restarts the
app through `app/tmp/restart.txt`, the restart file of the one root LiteSpeed knows.

Leftover processes (runs 16–24): destroy removed each Node.js app's files, hostname and selector
entry but not its processes, so LiteSpeed's `lsnode` processes of removed apps stayed (15 after nine
runs) until the account reached CloudLinux's limit of 100 processes (`ResourceUsage::get_usages`:
`lvenproc` 100/100, `lveep` 15/20). Then nothing new could start: the selector's `install-modules`
failed "without a diagnostic" and the agent logged `fork: retry: Resource temporarily unavailable`
(runs 21–24), so those runs say nothing about `PassengerAppRoot`. A one-time cron job of the founder's
OK ended the 15 `lsnode` processes; the account went back to 0/100. Each `lsnode` process names the
app's folder on its command line.
