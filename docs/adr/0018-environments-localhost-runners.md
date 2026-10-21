# ADR 0018: Environments as plans of their own, localhost as a target, and self-hosted runners

**Status**: Proposed (2026-10-21, feature 015). The lead's defaults, for the founder to confirm.

## Context

Every OpsCrew app had one deployment, on a cloud server, the user's own server or their
Portainer. Deploys reached the server over SSH from GitHub's machines. The founder agreed on
2026-10-20 to three additions:
- **localhost as a target**, for developers without a deploy host;
- **dev, staging and prod** per app, promoting the same image from one to the next;
- **self-hosted runners** chosen per environment.

The idea came from a developer friend's QA feedback.

## Decision

- **Each environment is a full plan of its own.**
  - Prod's stays at `opscrew/plan.yaml`, and any other lives at `opscrew/environments/<env>/plan.yaml`.
  - `resolveProjectPaths(root, { environment })` gives each environment its own state, records, saved plans, infrastructure root, state file, generated values and deploy key. Prod keeps today's paths, so nothing moves for an existing app.
  - The shared parts are the build, components, port and health route. `design` copies them from prod's plan, and `provision` refuses an environment whose copy differs.
  - `app.name` is `<app>-<env>` outside prod, so environments can share a server, a Portainer and a zone, as apps do.
- **Promotion by digest, with its own approval.**
  - The environment that follows main builds and deploys. The others are promoted with `opscrew promote`:
    1. the digest comes from the source environment's GHCR label tag;
    2. its provenance must name this repository and the default branch, and its signature must verify when the app signs images;
    3. a new hash-bound approval kind, `promote`, covers the target plan's hash, the digest and both environments;
    4. a `workflow_dispatch` carries the digest.
  - Label tags (`opscrew-<env>`, `opscrew-<env>-previous`) protect each environment's images from retention. Deploys reference only digests.
- **GitHub environments only where the repository's plan supports them.**
  - OpsCrew creates the environment and reads it back to see what GitHub enforces.
  - Otherwise the secrets are prefixed repository secrets, and the approval is OpsCrew's own. The guide says this guards against mistakes, not against someone with write access.
  - Repository settings (an environment, its rules, the fork-PR policy) use a new approval kind, `github-settings`.
- **Localhost runs the production deploy on the user's computer.**
  - A `localhost` target, and a local executor that runs the same rendered switch scripts with the computer's POSIX shell (Git for Windows' bash on Windows), their root folders set by variables.
  - The edge listens on 127.0.0.1, with certificates from an OpsCrew local CA, one per computer, for Caddy and nginx. Trusting the CA is a separate, explicit command.
  - The stack is a local plan approved by its hash (`host-apply`).
- **The server's runner** is a persistent repository runner, installed by a host-plan step.
  - It runs as `deploy`, which has the same privilege as today's SSH deploy.
  - It is pinned with its checksum, and registered with a token fetched only at apply.
  - A JIT runner per job was rejected: it would need an Administration-write token on the server.
- **The local runner** is ephemeral, one foreground session as the user.
- **Public repositories:** both runners are refused unless outside contributors' runs need approval.

## Consequences

- Every deployment command and MCP tool takes an environment. Most phases change only through their paths.
- Two new approval kinds, `promote` and `github-settings`. A contract change (T1501a).
- The switch scripts gain variable roots. A server's rendered output stays byte-identical.
- Free private repositories get environments without GitHub's protection rules, and are told so.
- macOS Docker is checked only on GitHub's Intel macOS runners with Colima. Apple silicon Docker stays untested live.
- Out of scope:
  - closing public SSH (OpsCrew's own management still uses it until 016's private network);
  - preview environments per pull request;
  - runner groups;
  - a runner per job.
