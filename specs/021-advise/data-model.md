# Data model: advise (021)

Nothing new is stored: advise reads, and `--apply` writes only fields the plan already has.

## A proposal

| Field | Type | Rule |
|---|---|---|
| `id` | string | Stable across runs for the same finding: `<category>.<server or "env">.<what>`, e.g. `size.app.larger`, `reliability.env.backups`, `upkeep.env.github-token`. |
| `category` | `size` \| `cost` \| `reliability` \| `upkeep` \| `security` \| `components` \| `moving` | |
| `urgency` | `now` \| `soon` \| `when-convenient` | `now`: about to break (disk full within 7 days, memory at its limit, a token expiring within 7 days, a reboot pending for security updates). `soon`: security findings, a disk within 30 days, over budget. The rest `when-convenient`. |
| `server` | string? | The plan's name (`app` or an extra server) when it concerns one. |
| `title` | string | One line, the change. |
| `reasons` | `{ text, figure?, basis }[]` | `basis`: `{ kind: "history", days }` or `{ kind: "one-reading", at }`, or `{ kind: "plan" }` / `{ kind: "account" }` for facts not measured. |
| `price` | `{ before, after, currency, source: "live" \| "static", asOf? }`? | Monthly, net. Absent when nothing changes in price. |
| `apply` | `{ kind: "plan", change }` \| `{ kind: "command", command }` | `change`: one of the plan edits below. |

**Plan edits `--apply` can make:**

| Change | Field |
|---|---|
| `server-type` | `target.serverType` (app) or `servers[].target.serverType` |
| `backups` | `target.backups` or `servers[].target.backups` |
| `check` | `observability.check.enabled` |

Every other proposal names a command (`opscrew addon enable monitoring`, `opscrew retarget`,
`opscrew design`, merging Dependabot's pull requests, replacing a token).

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
| `containerAtLimit` | 0.95 | a container's maximum against its limit |
| `diskHigh` | 0.85 | now |
| `diskFullDays` | 30 (7 for `now`) | the disk's projection |
| `restarts` | 3 in 14 days | a restart loop |
| `checkFlaps` | 3 issues in 14 days | a flapping health check |
| `tokenDays` | 30 (7 for `now`) | a token's expiry |
| `databaseShare` | 0.5 | Postgres's share of a short server |

The spike (T2101) may adjust them; the guide states the final values.
