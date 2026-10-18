# OpsCrew example apps

Fixture apps used by the end-to-end tests (`packages/cli/test/e2e`) and the live deploy test.
They are not part of the pnpm workspace.

- Files named `*.fixture` are written without that suffix when a test materialises the example
  (`.env.fixture` → `.env`, `.gitignore.fixture` → `.gitignore`), so they do not affect this repo.
- Secret-shaped values are `{{FAKE:<kind>[:<seed>]}}` markers expanded by `materializeFixture()`
  from `@opscrew/core/testing`. Nothing secret-shaped is committed.
- One app per language OpsCrew builds without its own Dockerfile (feature 012): `go-api`,
  `rails-api`, `spring-boot-api` and `dotnet-api` build with Buildpacks, `laravel-app` and
  `rust-api` with Railpack. `rails-api` pins Ruby 4.0.6 in `.ruby-version`, a version the pinned
  Buildpacks builder offers (`BUILDPACKS_OFFERS.ruby` in `packages/iac-templates/src/pins.ts`).
  Rails' `master.key` and credentials and Laravel's `.env` are not committed: they hold keys, and
  production reads `SECRET_KEY_BASE` and `APP_KEY` from the environment.

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
| `builder` | the builder `opscrew design` chooses on its own (`app.build.builder`) |
| `chosenApp` | monorepos only: the app the interview's `appDir` answer picks, and what analysis describes after it (`appDir`, `appKind`, `frameworkNames`, `port`) |
