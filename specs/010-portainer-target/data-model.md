# Data model: An existing Portainer as a deploy target

## Plan target (`opscrew/plan.yaml` → `target`, committed)

| Field | Meaning |
|---|---|
| `provider` | `portainer` |
| `mode` | `portainer-stack` |
| `environmentId` | Portainer's id of the environment (a single Docker host) |
| `arch` | `amd64` or `arm64`, from the environment's Docker info |
| `redeploy` | `updater` (default) or `cloudflare` |
| `web` | `{ mode: "tunnel" }` (default), `{ mode: "proxy", port }` or `{ mode: "caddy" }` |

Rules: `tunnel` and `cloudflare` need `dns.provider: cloudflare` and a domain; `caddy` needs a
domain; Cloudflare-served names stay one level below the zone. Portainer's address never appears
here.

## Portainer connection (local, `.opscrew/server.json` → `portainer`)

| Field | Meaning |
|---|---|
| `url` | Portainer's address as the user gave it (`https://…:9443`, or `http://localhost…`) |
| `certFingerprint` | pinned SHA-256 fingerprint of Portainer's certificate (absent for `http://localhost`) |
| `environmentId`, `environmentName` | the environment the user picked |
| `created.stacks` | `[{ id, name, role: "app" | "updater" | "tunnel-connector" }]` OpsCrew created |
| `created.registryId` | the registry entry OpsCrew added (admin token only) |
| `created.volumes` | the app stack's named volumes, recorded at apply (for data deletion) |
| `webhook` | absent: the webhook UUID is a secret kept in `~/.opscrew/projects/<id>/` (0600) |

The access token never appears in any file (environment variable `PORTAINER_API_KEY`).

## Portainer facts (read-only inspection result, zod-validated)

- `version`, `edition` (`CE`/`BE`), `composeVersion`, `dockerVersion`
- `user`: `{ id, username, role: "admin" | "user" }`
- `environments`: `[{ id, name, type, swarm: boolean, status }]`; chosen environment: `arch`
- `stacks` with OpsCrew's names: `[{ id, name, status, gitConfig?, autoUpdate?, file?, envKeys }]`
  (env values are never kept)
- `registries` usable on the environment: `[{ id, url, name }]`
- admin only: `projects`: compose project names in use by containers; `publishedPorts` (80, 443)

## Stack plan (hashed, approved as `stack-apply`)

```text
StackPlan { schemaVersion: 1, purpose: "setup" | "teardown", app, environmentId,
            changes: StackChange[], findings: Finding[], deleteData?: boolean }
StackChange { id: "registry" | "app-stack" | "updater-stack" | "tunnel-connector-stack" | "volumes",
              title, state: "in-place" | "change" | "blocked", reason?, params }
```

`params` hold only non-secret values (names, branch, compose file hash, env keys, webhook enabled,
registry URL); secrets (`Env` values, the webhook UUID, the tunnel token, registry and repository
tokens) are supplied at apply and never hashed into the plan.

## Deploy branch (`opscrew-deploy`, in the user's repository)

An orphan branch holding only `compose.yaml` (the app stack with the image digest); every commit is
written by the deploy workflow; the previous commit is the rollback target.

## State transitions (app stack)

`absent → deploying (3) → active (1)`; update: `active → deploying → active | error (4)`;
`error → (next deploy removes everything) → deploying → …`; destroy: `any → absent` (volumes kept
unless data deletion is approved).
