# ADR 0023: Rollback by digest, and a deploy pause

**Status**: Proposed (2026-10-31, feature 019). The founder asked for `opscrew rollback` on
2026-10-31 and gave the go-ahead; the design is the lead's.

## Context

A release that passes every check can still be wrong. Until now the way back was to revert the
commit and wait for a build, or to re-run an old workflow run, which rebuilds that commit and works
for 30 days only. The image that ran before is still in the registry by its exact digest, and
`promote` already deploys an image without a build, but only to promoted environments, and only
the source's image or the target's previous one.

## Decision

- **A rollback redeploys an earlier image of the environment by its digest,** through `promote`'s
  path. It never builds and never runs the release command (research R5).
  - Every server environment's deploy workflow takes a rollback dispatch: inputs `digest`, `tag`
    and `rollback`. This includes branch-following environments such as the default prod.
  - Such a run skips the build, checks the image's provenance in `verify`, and deploys it through
    the same switch as a deploy.
  - The switch script's second argument (`rollback`) skips the release command.
- **After a rollback, the environment's automatic deploys pause,** as on Vercel and Render, so the
  next push doesn't undo it unnoticed.
  - The pause is 018's repository variable `OPSCREW_DEPLOY_PAUSED`, with entries of reason
    `rollback` next to `move`.
  - Every deploy workflow now carries the job-level `if:` that reads it; until now the `if:` was
    rendered only during a move. GitHub reads the variable when a run is created (018's live run).
  - `opscrew rollback --resume [--deploy]` ends the pause.
- **D1 – provenance accepts `workflow_dispatch` builds** of this repository's branch, as well as
  `push` builds. Otherwise the image that `--resume --deploy` or GitHub's own "Run workflow" builds
  could never be promoted or rolled back to.
- **D2 – sites pause too.** Cloudflare's hosting and GitHub Pages roll back through their own
  version history (Worker versions; a re-run of a Pages run, which rebuilds), and their deploys
  pause the same way.
- **D3 – resuming is a `github-settings` approval,** which `--yes` grants in a script. A rollback
  itself is a `promote`-kind approval bound to its hash, which `--yes` never grants.
- **D4 – the default target** is the deployment before the running one: `opscrew-<env>-previous`
  when it was built before the running image, otherwise (after a rollback) the newest listed
  version built before the running one. A second rollback goes further back; it never undoes the
  first.
- **D5 – the hash binds** the environment, the current digest, the target digest and the plan's
  hash, as a promotion's does.
- **D6 – a rollback refuses while a deploy of the environment runs,** rather than waiting. It
  waits only for runs created in the moment before it set the pause.
- **The rest of recovery:** a failed copy's last log lines stay on the server
  (`<app folder>/.failed-deploy/`, the deploy user's, 0600), `opscrew logs --failed` shows them,
  and the failure messages point there.

## Consequences

- Every deploy workflow changes once. Before its first rollback, each environment needs
  `opscrew provision` and its merged pull request; the rollback says so until then.
- The data, the schema and the secrets are never rolled back. The earlier version runs with today's
  schema and settings, and the guide's rule (add in one release, remove in a later one) is what
  keeps it working.
- How far back is as far as the registry keeps the environment's images: retention's `keep`, 10 by
  default.
- A user without OpsCrew can do the same by hand: GitHub → Actions → Run workflow with the digest,
  plus the variable.
