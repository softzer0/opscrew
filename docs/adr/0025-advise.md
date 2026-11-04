# ADR 0025: Advise: deterministic proposals, applied through the plan

**Status**: Accepted (2026-11-05, feature 021). The founder set the scope on 2026-10-18 and gave the
go-ahead on 2026-11-04; the design is the lead's, settled by the spike (research R5).

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
  type, a container's memory limit, backups, the scheduled check); `opscrew provision` applies them
  with its hash-bound approval. Other proposals name their command.
- **D3. History only from the self-hosted stack.** With 020's stack, 14 days of figures through
  fixed queries (research R5, S2); without it, one reading, and never a smaller server on one
  reading.
- **D4. OpsCrew's own thresholds,** written in the code and the guide; the clouds publish none
  (research R1.2).
- **D5. Deterministic, no model in this version.** Each rule is a pure, tested function.
- **D6. A larger server is one way, and provision guards it.** At Hetzner a move up grows the disk,
  which can't shrink again; a move to a smaller disk is refused only after the provider switched
  the server off, and leaves it off (research R5, S1). So a "larger" proposal says it is one way,
  "smaller" keeps to types with at least the current disk, and provision refuses a smaller disk
  before any change.

## Consequences

- Users without monitoring get advice that is safe but can't shrink a server; advise says so.
- A resize is still an IaC plan with the provider's restart (one to three minutes offline); the
  proposal says it.
- A smaller server is rare at Hetzner (within a line each smaller type has a smaller disk); the
  common saving is a cheaper type with at least the same CPUs, memory and disk.
- Restarts are counted per container, so deploys don't count; a container at its limit gets a
  higher limit before a larger server.
- Grafana Cloud's and Beszel's history are not read (a second token; no documented API).

## Alternatives considered

- **A local history of `status` readings:** only the moments the user ran it.
- **A model to rank or explain proposals:** adds cost and unpredictability for prose the rules can
  write.
- **Advise applying changes itself:** would bypass provision's single approval path.
- **Keeping the disk on a move up** (`keep_disk`, `resize_disk = false`): a move would stay
  reversible, but a larger type would then never give more disk, the only way to grow it today.
