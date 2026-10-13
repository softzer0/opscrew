# ADR 0007: Moving a deployment between providers inside one state

- Status: accepted (2026-10-13)

## Context

Feature 004 added a second VPS provider but fixed the provider of a live deployment: changing it
meant destroying the deployment (and its database) and provisioning again. `opscrew retarget`
must move a live app with its data and a short maintenance window, keep every infrastructure
change behind plan → policy → approval → apply, and let the user step back until users are
switched.

## Decision

- **One root module, one state.** The old server's module is renamed `module.server_previous`
  with a `moved` block; the new server becomes `module.server`. DNS records stay in the same
  state and are updated in place at the switch, so there is no window without records and no
  cross-state import or `state rm`.
- **Two plans to start.** OpenTofu and Terraform reject a `moved` block that frees an address the
  same configuration declares again ("Moved object still exists", verified with both binaries),
  so the rename is its own moves-only plan, followed by the plan that creates the new server.
  The engine reports moves and OpsCrew applies a moves-only plan after an approval that says
  nothing changes in the cloud.
- **Blue-green with a maintenance window.** The deploy workflow puts the app on the new server
  while the old one serves users; only the database copy (dump on the old server, `scp -3` server
  to server, restore on the new one) needs the old app stopped.
- **Resumable steps in `plan.retarget`.** Every step records its completion; a re-run continues,
  and failures in the maintenance window or the DNS switch start the old app again.
- **Finish and abort.** `--finish` deletes the old server like `opscrew destroy` would (snapshot,
  protection lift, preview-bounded destroy, typed name). `--abort` works until the DNS switch:
  it deletes the new server and renames the old one back. After the switch the way back is
  another move.
- **Other provider only** in this feature: within one provider the two servers' names would
  collide.

## Consequences

- During a move the working tree holds a transitional root module with both providers; the
  final files are published once, in a pull request, by `--finish`.
- Provision, design, dns, drift and destroy refuse to run during a move.
- A later move within one provider needs distinct server names (for example a suffix) and the
  same machinery.
