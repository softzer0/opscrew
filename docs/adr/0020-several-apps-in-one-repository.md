# ADR 0020: Several apps in one repository

**Status**: Proposed (2026-10-23, feature 016). The founder chose to add it to 016; the layout is the lead's default.

## Context

OpsCrew deployed one app per repository. `opscrew analyze --app <dir>` could pick one app out of several, but every plan, workflow, secret and state file assumed it was the only one. Monorepos are common, for example a landing page and its documentation as two sites in one repository, each on its own hostname.

## Decision

- **Layout, one level above 015's environments:**
  - the repository's first app keeps today's paths;
  - a further app lives in `opscrew/apps/<key>/`, `.opscrew/apps/<key>/` and the project home's `apps/<key>/`, with its environments nested inside;
  - `resolveProjectPaths(root, { app, environment })` is the single seam.
- **The plan records `app.key`.** Every per-repository name derives from it through helpers plan-schema owns: workflow files, deploy secret prefixes, GitHub environments, the GHCR image, the branches OpsCrew opens, the concurrency group. A new app or environment whose derived names equal existing ones is refused.
- **Commands:**
  - `opscrew app add <key> --dir <folder>`, `app list` and `app remove`;
  - `--app <key>` on every command that acts on an app, chosen like `--env`;
  - `analyze --dir` replaces `analyze --app <dir>`.
- **One repository-wide scan.** One `dependabot.yml` covers every app's folders.

## Consequences

- A contract change (T1617a), and renderer and agent changes keyed on `plan.app.key` (T1617b, T1617c). The first app's output stays byte-identical.
- Each app's workflow runs on every push to its branch. Path filters per app are a later improvement.
- Each app is designed, provisioned, verified and destroyed on its own, with its own approvals.
