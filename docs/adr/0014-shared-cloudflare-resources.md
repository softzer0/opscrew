# ADR 0014: Cloudflare resources shared by several OpsCrew apps

- Status: accepted
- Date: 2026-10-17
- Decision makers: founder, lead

## Context

Each OpsCrew app's Terraform owned two whole zone rule sets: the WAF custom rules and the
configuration rules. A zone holds one rule set of each kind. So a second OpsCrew app in the same
zone, or a zone with rules of the user's own, could not get its probe block and strict TLS rule,
and destroying an app deleted rule sets others relied on.

The account's Zero Trust organization and one-time-PIN identity provider had the same problem.
The first app created them, and its destroy deleted them under every other app's Access.

Terraform's Cloudflare provider can only own a whole rule set. Research and a live spike
(specs/011-shared-cloudflare-zone/research.md) confirmed that the Rulesets API adds, changes and
deletes single rules, and that rules carry a stable `ref` the client chooses.

## Decision

- **One shared rule per phase.** OpsCrew keeps one rule of its own per phase in a zone, found by
  its fixed `ref`: `opscrew-block-probes` and `opscrew-strict-tls`. Its hostname set is the union
  of every OpsCrew app's hostnames in the zone. Each app adds and removes only the hostnames it
  recorded in `.opscrew/cloudflare.json`.
- **A typed adapter.** These rules, plus the Zero Trust organization and the one-time-PIN identity
  provider, leave Terraform. A typed part of `@opscrew/connector-cloudflare` inspects them, plans
  one app's change, and applies it behind an approval of the new kind `cloudflare-apply`, bound to
  the plan's SHA-256 hash. It re-reads OpsCrew's rule just before writing and stops if the rule
  changed since the plan.
- **Rules OpsCrew did not create** are never changed or reordered. A `PUT` is sent only to a
  missing entrypoint.
- **Zero Trust pieces** are created when absent and never deleted.
- **Later zone-wide settings** are set per hostname where the user's plan allows it. Otherwise
  OpsCrew reads the setting first and never overwrites one that already differs.

## Consequences

- **Provision** gains one more approval before the IaC plan. Both hashes are printed for
  `--approve`. Destroy removes this app's hostnames under its typed confirmation.
- **Rule slots:** a Free zone fits any number of OpsCrew apps in two rule slots, limited only by
  the 4,096-character expression, roughly 60 to 100 hostnames.
- **Concurrency:** Cloudflare has no locking, so two applies at the same moment in one zone are
  caught by the re-check, not prevented.
- **Constitution 1.5.0:** Principle I names the Cloudflare shared-resources adapter.
