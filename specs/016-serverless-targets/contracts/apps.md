# Contract: several apps in one repository

## plan-schema (T1617a, ADR 0020)

```ts
// plan.app.key?: string    // a further app's key; absent for the repository's first app
// requirements.appDir stays the app's folder in the repository.
const APP_KEY_PATTERN: RegExp;                       // as ENVIRONMENT_NAME_PATTERN
function appsOf(root, fs?): Promise<{ key?: string; dir: string }[]>;   // the first app, then opscrew/apps/*
function environmentsOf(root, fs?, app?: string): Promise<...>;         // per app
// Derived names, the only place they are built:
function workflowPathFor(app?: string, env?: string): string;           // .github/workflows/opscrew-deploy[-<key>][-<env>].yml
function deploySecretPrefix(app?: string, env?: string): string;        // OPSCREW_[<KEY>_][<ENV>_]
function githubEnvironmentFor(app?: string, env?: string): string;      // production | <env> | <key>-production | <key>-<env>
function ghcrImageFor(repo: string, app?: string): string;             // ghcr.io/<repo>[/<key>], lower case
function appBranch(base: "opscrew/prepare-deploy" | "opscrew/deploy-setup", app?: string): string;
function derivedNames(app?: string, env?: string): string[];            // for the uniqueness check
```

## core (T1617a)

```ts
resolveProjectPaths(root, { app?: string; environment?: string; ... }): ProjectPaths;   // + ProjectPaths.app
```

The first app's paths are unchanged (a snapshot of every field). A further app's `artefactsDir`, `stateDir` and `projectHomeDir` gain `apps/<key>`, and its environments nest inside. `files.shared` keeps the app's own architecture and the repository's scan report.

## CLI and MCP (T1617d)

- **`opscrew app add <key> --dir <folder>`:** writes `opscrew/apps/<key>/requirements.yaml` with `appDir`, after the uniqueness check.
- **`app list`:** each app's key (or "first app"), its folder, and whether it's deployed.
- **`app remove <key>`:** refused while the app is deployed.
- **`--app <key>`:** on every command that takes `--env`, and on `analyze`, `interview`, `design` and `adapt`. `analyze --dir <folder>` replaces `analyze --app <dir>`.
- **Choice:** one app means that app. With several, an interactive run asks, and a script gets `PHASE_PRECONDITION` listing the keys and `--app`.
- **MCP:** an `app` input next to `environment`; `opscrew_app_add`, `opscrew_app_list`, `opscrew_app_remove`.
