# ADR 0025: Advise: deterministic proposals, applied through the plan

**Status**: Proposed (2026-11-04, feature 021). The founder set the scope on 2026-10-18 and gave the
go-ahead on 2026-11-04; the design is the lead's. The spike (T2101) may amend it.

## Context

Once an app runs, OpsCrew has its figures (017, and 14 days of history with 020), its plan, the
interview's traffic and budget, and the providers' live prices, but nothing that reads them together
and says what to change. The founder asked for `opscrew advise`: "analyze the current setup and then
propose what to change and how to scale", each change explained and priced, applied through the
existing flows.

## Decision

- **D1. One read-only command.** `opscrew advise` changes nothing on a server, an account or the
  repository.
- **D2. Applied through the plan.** `--apply <id>` writes only fields the plan already has (a server
  type, backups, the scheduled check); `opscrew provision` applies them with its hash-bound
  approval. Other proposals name their command.
- **D3. History only from the self-hosted stack.** With 020's stack, 14 days of p95 figures through
  fixed queries; without it, one reading, and never a smaller server on one reading.
- **D4. OpsCrew's own thresholds,** written in the code and the guide; the clouds publish none
  (research R1.2).
- **D5. Deterministic, no model in this version.** Each rule is a pure, tested function.

## Consequences

- Users without monitoring get advice that is safe but can't shrink a server; advise says so.
- A resize is still an IaC plan with the provider's restart; the proposal says it.
- Grafana Cloud's and Beszel's history are not read (a second token; no documented API).

## Alternatives considered

- **A local history of `status` readings:** only the moments the user ran it.
- **A model to rank or explain proposals:** adds cost and unpredictability for prose the rules can
  write.
- **Advise applying changes itself:** would bypass provision's single approval path.
