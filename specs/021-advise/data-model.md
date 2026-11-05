# Data model: advise (021)

Nothing new is stored: advise reads, and `--apply` writes only fields the plan already has.

## A proposal

| Field | Type | Rule |
|---|---|---|
| `id` | string | Stable across runs for the same finding: `<category>.<server or "env">.<what>`, e.g. `size.app.larger`, `reliability.app.backups`, `upkeep.env.github-token`. |
| `category` | `size` \| `cost` \| `reliability` \| `upkeep` \| `security` \| `components` \| `moving` | |
| `urgency` | `now` \| `soon` \| `when-convenient` | `now`: about to break (disk full within 7 days, memory at its limit, a token expiring within 7 days, a reboot pending for security updates). `soon`: security findings (Dependabot alerts off included), a disk within 30 days, a short server, a restart loop, a flapping check, over budget. The rest `when-convenient`. |
| `server` | string? | The plan's name (`app` or an extra server) when it concerns one. |
| `title` | string | One line, the change. |
| `reasons` | `{ text, figure?, basis }[]` | `basis`: `{ kind: "history", days }` or `{ kind: "one-reading", at }`, or `{ kind: "plan" }` / `{ kind: "account" }` for facts not measured. |
| `price` | `{ before, after, currency, source: "live" \| "static", asOf? }`? | Monthly, net. Absent when nothing changes in price. |
| `apply` | `{ kind: "plan", change }` \| `{ kind: "command", command }` \| `{ kind: "manual", text }` | `change`: one of the plan edits below; `command`: a real command, with the environment's `--app`/`--env` flags; `manual`: what to do where there is nothing to type. |

**Plan edits `--apply` can make:**

| Change | Field |
|---|---|
| `server-type` | `target.serverType` (app) or `servers[].target.serverType` |
| `memory-limit` | `app.memoryMb` (the web process), `workers[].memoryMb` or `services[].memoryMb` (research R5, S2) |
| `backups` | `target.backups` or `servers[].target.backups` |
| `check` | `observability.check.enabled` |

Every other proposal names a command (`opscrew addon enable monitoring`, `opscrew retarget`,
`opscrew design`, merging Dependabot's pull requests, turning Dependabot alerts on in the
repository's settings, replacing a token).

## The report

`AdviceReport`: `proposals` (ordered), `basis` per server (`history` with its days, or
`one-reading`), `checked` (what was read), `notRead` (what couldn't be, with why: no permission, a
server unreachable, prices static).

## The thresholds (`THRESHOLDS`, in code and in the guide)

| Name | Value | Used by |
|---|---|---|
| `historyDays` | 14 | the queries' window |
| `minHistoryDaysToShrink` | 7 | never smaller with less |
| `percentile` | 0.95 | CPU, memory, a container's memory |
| `memoryHigh` | 0.85 | larger server |
| `loadHighShare` | 0.25 | larger server: the 15-minute load above the CPUs for this share of the period |
| `shrinkHeadroom` | 0.4 | smaller: the p95 fits the smaller type with this headroom |
| `containerAtLimit` | 0.95 | a container's maximum against its limit; any OOM kill in the period counts too |
| `limitRaise` | 1.5 | the proposed limit: 1.5 times the current one, rounded up to 64 MB; the server has room when its p95 memory plus the raise stays under `memoryHigh` |
| `diskHigh` | 0.85 | now |
| `diskFullDays`, `diskFullDaysNow` | 30, 7 | the disk's projection: `soon`, `now` |
| `restarts` | 3 in 14 days | a restart loop: restarts of one container (a deploy starts a new one and isn't counted) |
| `checkFlaps` | 3 issues in 14 days | a flapping health check |
| `tokenDays`, `tokenDaysNow` | 30, 7 | a token's expiry: `soon`, `now` |
| `databaseShare` | 0.5 | Postgres's share of a short server's memory (p95 of its container) |

Settled by the spike (research R5); the guide states them.
