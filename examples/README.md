# OpsCrew example apps

Fixture apps used by the end-to-end tests (`packages/cli/test/e2e`) and the live deploy test.
They are not part of the pnpm workspace.

- Files named `*.fixture` are written without that suffix when a test materialises the example
  (`.env.fixture` → `.env`, `.gitignore.fixture` → `.gitignore`), so they do not affect this repo.
- Secret-shaped values are `{{FAKE:<kind>[:<seed>]}}` markers expanded by `materializeFixture()`
  from `@opscrew/core/testing`. Nothing secret-shaped is committed.

`expected.json` per example:

| Field | Meaning |
|---|---|
| `facts.platformExport.platform` | expected `ProjectFacts.platformExport.platform` |
| `facts.appKind`, `facts.port`, `facts.languages` | expected values in `ProjectFacts` |
| `facts.frameworkNames` | names that must all appear in `ProjectFacts.frameworks[].name` |
| `facts.services` | service kinds that must all appear in `ProjectFacts.services[].kind` (`[]` = none detected) |
| `facts.clientExposedEnv` / `facts.secretEnv` | env var names that must be client-exposed / secret-likely |
| `scan.mustInclude` | rule ids that `opscrew scan` must report |
| `scan.clean` | `true` → no high or critical findings |
| `codeChanges` | code-change kinds `opscrew design` must derive |
