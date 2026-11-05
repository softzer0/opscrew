# Data model: preview environments (022)

## `plan.environment.previews` (plan-schema, T2202)

```yaml
environment:
  name: preview
  deploySource: { from: main }
  runner: github
  previews:
    cap: 3              # 1-20; how many previews run at once
    lifetimeDays: 7     # 1-30; a preview not updated this long is removed
    domain: shop.example.com   # the base: previews are pr-<n>.<domain>; default the app's prod hostname
    seed: "php artisan db:seed --force"   # a command, or null for none; absent until design sets it
dns:
  provider: cloudflare
  zone: example.com     # no domain: the preview environment serves no hostname of its own
  proxied: false
  www: false
```

Refinements on a plan with `previews` (each with a plain message): target `hetzner`, `digitalocean`
or `own`; `runner: github`; `build` absent or `github`; `deploySource.from: main`; no `servers`;
no observability add-ons, check, monitoring, signing or deploy tags; `dns.provider: cloudflare`
with `zone`, without `domain`, `proxied: false`, `www: false`; `previews.domain` inside `dns.zone`;
`app.name` at most 31 characters (so `<app.name>-pr-999999` fits the app-name pattern). Another
environment can't be promoted from a preview environment. One preview environment per app.

## Architecture (plan-schema, T2202; detect, T2203)

`facts.build.seedCommand?: string` and `facts.build.seedNote?: string`, beside `releaseCommand` and
`releaseNote`: the seed command detection found (or why there is none), run from the repository root like the
release command (`cd <dir> && …` for an app in a folder).

## Paths (core, T2202)

| What | Where |
|---|---|
| The preview key (restricted; its private half goes to GitHub) | `~/.opscrew/projects/<id>/environments/<env>/preview_key`, `preview_key.pub` |
| The deploy key (unrestricted; never to GitHub for a preview environment) | `~/.opscrew/projects/<id>/environments/<env>/deploy_key` (existing) |
| The preview values | `.env.<env>` in the repository (gitignored), read at provision |
| The rendered recipe, without values | `opscrew/environments/<env>/previews/` (committed) |
| The workflow | `.github/workflows/opscrew-preview.yml`, or `opscrew-preview-<app key>.yml` |

## On the preview server (T2204 renders, T2206 installs)

`<app>` is the preview environment's `app.name` (`shop-preview`); each preview is the app
`<app>-pr-<n>` (`shop-preview-pr-42`).

```text
/srv/apps/<app>/                the recipe (the environment's own app folder, the deploy user's)
  settings.env                  APP, CAP, LIFETIME_DAYS, IMAGE_NAME, BASE, SEED
  values.env                    the preview values (0600), written at apply, never in the plan
  bin/opscrew-preview           the command (contracts/opscrew-preview.md), 0755
  template/                     every file a deploy uploads (Compose, service files, crontab,
                                edge/compose.yaml, edge/sites/<app>-pr-@N@.caddy), start.sh,
                                rollback.sh, env/app.env, env/<service>.env; placeholders @N@
                                and @SECRET:<name>:<format>@ (format hex32, hex64, b64k32, gk)
  previews.log                  one line per up, down and gc
  .lock                         held only to count previews and create one
/srv/apps/<app>-pr-<n>/         one preview: the template filled in, secrets.env (0600),
                                .preview (commit, digest, created, updated), .seeded, .lock,
                                .docker (only during up), up.log
/srv/edge/sites/<app>-pr-<n>.caddy   its site on the shared edge; kamal-proxy route <app>-pr-<n>
~deploy/.ssh/authorized_keys
  restrict,command="/srv/apps/<app>/bin/opscrew-preview" <key> opscrew-preview:<owner>/<repo>:<app>
crontab of deploy
  <m> * * * * /srv/apps/<app>/bin/opscrew-preview gc
```

## GitHub (T2205, T2209)

- GitHub environment: `githubEnvironmentFor(key, env)` (`preview`, or `<app key>-preview`), placed
  as 015 places environments, with no branch rule; secrets `OPSCREW_<ENV>_HOST`,
  `OPSCREW_<ENV>_SSH_PRIVATE_KEY` (the preview key), `OPSCREW_<ENV>_SSH_KNOWN_HOSTS`. Build values
  as for any named environment (`OPSCREW_<ENV>_BUILD_…`, repository secrets).
- Images: `ghcr.io/<owner>/<repo>[/<app key>]:pr-<n>-<sha>` (intermediate `build-pr-<n>-<sha>`,
  cache `buildcache-<env>`).
- The comment: one per pull request and app, found by `<!-- opscrew-preview:<app> -->`.

## DNS (T2205)

One record in the preview environment's IaC root: `*.<previews.domain>` → the preview server's
IPv4 (and IPv6 when the server has one), DNS only, no CAA.

## Hidden addresses (US8)

- A preview plan: `dns: { provider: cloudflare, zone: <preview zone>, proxied: true }`,
  `previews.domain` equal to the zone, `security.httpAllowedFrom: cloudflare`.
- DNS: one proxied record `*.<preview zone>` to the preview server.
- On the preview server: `/srv/edge/tls/<app>/origin.pem` and `origin.key` (0600), the Origin CA
  certificate for `*.<zone>` and `<zone>`; each preview's `.preview` keeps its random part.
- A preview's address: `pr-<n>-<random>.<zone>`, `<random>` 10 of `[a-z0-9]`.
- Another environment's suggested hostname: `<env>-<random>.<zone>` (10 random characters).

## Opt-ins (US9, US10)

A preview plan on another environment's server (A):

```yaml
target: { provider: own, mode: vps-compose, arch: amd64, access: public, edge: caddy }
environment:
  name: preview
  previews:
    server: { environment: dev }   # dev's app server; never prod's
```

- The preview root is an own target's, and holds no server: `TF_VAR_server_ipv4` and
  `TF_VAR_server_ipv6` are the host server's public addresses, which provision reads from the host
  environment.
- On the host server, the recipe sits in `/srv/apps/<app>-preview/` and each preview is
  `<app>-preview-pr-<n>`, as on a server of their own, beside `<app>-dev`.

A preview plan under the app's zone (B): `dns.zone: example.com`, `previews.domain:
previews.example.com`. The root gains:

```hcl
resource "cloudflare_certificate_pack" "previews" {
  zone_id               = var.zone_id
  type                  = "advanced"
  hosts                 = ["example.com", "*.previews.example.com"]
  certificate_authority = "lets_encrypt"
  validation_method     = "txt"
  validity_days         = 90
  lifecycle { create_before_destroy = true }
}
```

Its address is `pr-<n>-<random>.previews.example.com`. The Origin CA certificate covers
`*.previews.example.com` and `previews.example.com`.
