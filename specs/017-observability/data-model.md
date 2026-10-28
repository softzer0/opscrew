# Data model: Observability

## The plan block (`plan.observability`)

Each environment's plan has one. Every part is optional and defaults to off, except as design sets it.

**The scheduled check (`observability.check`)**

| Field | Type | Rule |
|---|---|---|
| `enabled` | boolean | Design sets it: on for prod, off for other environments. Refused on localhost, with the reason: GitHub can't reach the user's computer. |
| `intervalMinutes` | 5, 10, 15, 20, 30 or 60 | Repository-wide: only in the first app's prod plan (`opscrew/plan.yaml`), and refused in any other plan. Absent: 15 in a public repository, 60 in a private one. |
| `webhook` | `"slack"`, `"discord"` or `"ntfy"` | Repository-wide, as `intervalMinutes`. Its address is a GitHub secret, never in the plan. |

**Beszel (`observability.beszel`)**, only on the cloud and own targets

| Field | Type | Rule |
|---|---|---|
| `enabled` | boolean, default `false` | |
| `version` | pinned version | The hub's and the agent's, from `pins.ts`. |
| `mode` | `"hub"` or `"agent"`, default `"hub"` | `hub`: the dashboard and the agent on this server. `agent`: only the agent, connected out to `hubUrl`. |
| `access` | `"local"` or `"subdomain"`, default `"local"` | `hub` mode only. `local`: through an SSH tunnel (`opscrew addon open beszel`). `subdomain`: behind Cloudflare Access, as Portainer's. |
| `hostname` | FQDN | With `subdomain` only, and required there. A subdomain of the app's zone. |
| `allowedEmails` | email addresses, at least one | With `subdomain` only, and required there. |
| `hubUrl` | `https://` URL | `agent` mode only, and required there. |
| `hubKey` | the hub's public key (`ssh-ed25519 …`) | `agent` mode only, and required there. Public, not a secret. |
| `memoryMb` | `{ hub, agent, proxy }` | Defaults from the spike. Shown with their price share. |

**Grafana Cloud (`observability.grafanaCloud`)**, only on the cloud and own targets

| Field | Type | Rule |
|---|---|---|
| `enabled` | boolean, default `false` | |
| `version` | pinned version | Alloy's, from `pins.ts`. |
| `metrics` | `{ url, user }` | The stack's Prometheus `remote_write` URL (`https://…/api/prom/push`) and its numeric user id. |
| `logs` | `{ url, user }` | The stack's Loki push URL (`https://…/loki/api/v1/push`) and its numeric user id. |
| `logSampling` | integer 1–100, default 100 | The percentage of log lines sent. Design offers less when the estimate passes the free tier. |
| `memoryMb` | `{ alloy, proxy }` | Defaults from the spike. |

Plan-wide rules:
- **Where they apply:** Beszel and Grafana Cloud only where `onServer(plan)`. On a Portainer, on localhost and on the server-less targets, design says why.
- **One of each per server.** On an own server with several apps, an add-on belongs to the app that turned it on (the host record says which). Beszel already shows every container on the server. Alloy sends that app's logs and the server's metrics. Another app turning the same add-on on is refused with the reason in this version.

## Secrets kept apart

| Secret | Where it lives | Written by |
|---|---|---|
| The check's private key | `~/.opscrew/projects/<id>/check_key` (recovery copy), GitHub secret `OPSCREW_CHECK_SSH_KEY` | provision (`github-secrets`) |
| An environment's server address, SSH port, user and host key | GitHub secret `<prefix>CHECK_SERVER` (`deploySecretPrefix`) | provision (`github-secrets`) |
| The webhook's address | GitHub secret `OPSCREW_CHECK_WEBHOOK`; ntfy's optional token `OPSCREW_CHECK_NTFY_TOKEN` | provision (`github-secrets`), asked like an app secret |
| Beszel's dashboard password (hub mode) | generated; recovery copy; root-only env file on the server | `addon enable beszel` (`host-apply`, on stdin) |
| Beszel's agent token | generated in hub mode, or given by the user in agent mode; recovery copy; root-only env file | the same |
| Beszel's hub key (hub mode) | generated (Ed25519); recovery copy; the hub's data folder on the server (0600) | the same |
| The Grafana Cloud token | given by the user; recovery copy; root-only file on the server | `addon enable grafana-cloud` (`host-apply`, on stdin) |

None is ever in a plan, a committed file, a host plan's text, a log or an audit entry.

## The check's files

**`opscrew/check/check.json`** (generated, committed):

```jsonc
{
  "version": 1,
  "intervalMinutes": 60,
  "thresholds": { "diskWarn": 85, "diskHigh": 95, "certDays": 14, "tries": 3, "retrySeconds": 30, "timeoutSeconds": 10 },
  "webhook": "ntfy",                    // or absent
  "public": false,                      // the repository's visibility when rendered
  "environments": [
    {
      "key": "example-app/prod",        // <app key or name>/<env>
      "hosts": [{ "hostname": "example.com", "healthPath": "/health" }],
      "server": {                       // absent for Portainer, Cloudflare and GitHub Pages
        "id": "own-<host key fingerprint>", // from renderCheck's serverIds, else <provider>-<app name>; a shared server is checked once
        "secret": "OPSCREW_CHECK_SERVER",
        "via": "github"                 // "github", "runner-host" or "own-runner"
      }
    }
  ]
}
```

Never an address, a key or a webhook URL.

**`.github/workflows/opscrew-check.yml`:** the `check` job, plus one job per server whose `via` isn't `github`.

**`opscrew/check/check.mjs`:** vendored, the same in every repository.

## Alerts (GitHub issues)

| Part | Value |
|---|---|
| Label | `opscrew-check` (created by the check if missing) |
| Marker | `<!-- opscrew-check:<key> -->` in the body. Key: `<app>/<env>/<check>/<host or server id>`, with `<check>` one of `https`, `certificate` or `disk`. Also `inactivity` for the 60-day warning. |
| Title | `OpsCrew check: <app> (<env>) <what failed> on <hostname or server>` |
| Body | when it started (UTC), what failed (fixed text, status code or error code, days left, disk figures), the command to see more (`npx opscrew status`, `npx opscrew logs`) |
| Comment | only when what fails changes |
| Close | `state_reason: completed`, with a comment naming how long it lasted; or the pause's reason |

**The pause (`vars.OPSCREW_CHECK_PAUSED`):** a repository variable holding JSON, `{ "<app>/<env>": { "reason": "retarget" | "destroyed", "since": "<ISO time>" } }`.
- Set and cleared through the GitHub connector:
  - retarget sets it when its window opens, and clears it at `--finish`;
  - destroy sets it;
  - a healthy provision clears it.
- Absent means nothing is paused.

## Reading figures (`ResourceReading`, agents)

```ts
type ResourceReading = {
  takenAt: string;
  server?: {
    cpus: number; load1?: number; load5?: number; load15?: number;      // load: servers only
    memory: { usedBytes?: number; totalBytes: number };                 // used: servers only
    disk?: { usedBytes: number; freeBytes: number; totalBytes: number }; // servers only
  };
  containers: {
    service: string;                 // web, a worker, a cron job, a service, edge
    cpuPercent: number;
    memory: { usedBytes: number; limitBytes?: number };
    restarts: number;                // since the container was created (the last deploy)
    startedAt: string;
  }[];
  edgeRequests?: {                   // Cloudflare
    since: string; requests: number; errors: number; cpuTimeP50Ms: number; cpuTimeP99Ms: number;
  };
  unavailable: string[];             // the figures this target can't give, by name
  flags: { figure: string; severity: "warning" | "high"; meaning: string; fix: string }[];
};
```

Thresholds:
- memory at 90% or more of a container's limit is a warning;
- the disk at 85% or more is a warning, and 95% or more is high (`secure`'s);
- a restart since the last deploy is a warning.

## Log lines (agents)

```ts
type LogLine = { time: string; service: string; stream: "stdout" | "stderr" | "edge"; text: string };
```

- Every `text` passes the redactor before it is shown or returned.
- **On Cloudflare:** `service` is the Worker, and `text` holds the request's method, path, status and outcome, then its console lines and exceptions.
