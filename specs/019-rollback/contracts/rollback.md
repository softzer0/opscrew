# Contract: rollback

## iac-templates (T1902, T1905)

```ts
export const FAILED_DEPLOY_DIR = ".failed-deploy";
export const DEPLOY_PAUSED_VARIABLE = "OPSCREW_DEPLOY_PAUSED";   // unchanged
export const ROLLBACK_INPUTS = { digest: "digest", tag: "tag", rollback: "rollback" } as const;
export const PORTAINER_RELEASE_PLACEHOLDER = "__OPSCREW_RELEASE__";
// switchCommands(plan, init, edgeFiles): the script's $1 is the image, $2 is "rollback" or "deploy" (the default)
```

- **Workflow inputs:**
  - **A branch-following server or Portainer environment:** `digest` (string, `""`), `tag` (string, `""`), `rollback` (boolean, `false`).
  - **A promoted environment:** `digest` and `tag` (required), plus `rollback` (boolean, `false`).
- **Jobs:** as the table in plan.md 1.
  - `PAUSED` is `contains(vars.OPSCREW_DEPLOY_PAUSED, '"<checkEnvironmentKey>"')`.
  - The `paused` job holds `permissions: {}`.
  - Cloudflare's hosting: `deploy` has `if: !PAUSED`. GitHub Pages: `if: github.run_attempt > 1 || !PAUSED`.
- **Start step:** `MODE` is `rollback` when `inputs.rollback`, otherwise `deploy`. It is passed as `$2`.
- **`verify`:** it accepts `push` and `workflow_dispatch` builds of this repository on the builder branch (D1).

## connector-github (T1903)

```ts
GhcrReader.tags(owner, image, credential?): Promise<string[] | undefined>          // every tag, paged
GhcrReader.describeTags(owner, image, tags, credential?):
  Promise<{ tag: string; digest?: string; facts?: ImageFacts }[]>               // one pull token
GitHubClient.imageTags(...); GitHubClient.describeTags(...)                       // pass-throughs
WorkflowRunSource += { createdAt: string; status: string; conclusion: string | null;
                       headCommit?: { message: string; timestamp: string } }
WorkflowRun += { event?: string; headBranch?: string; headCommit?: { message: string; timestamp: string } }
listWorkflowRuns(owner, repo, { workflowFile, branch?, event?, perPage? })
fileText(owner, repo, path, ref): Promise<string | undefined>                    // contents API, ≤ 1 MB
```

## agents (T1904, T1906, T1908, T1910)

```ts
// shared/deploy-pause.ts
type DeployPause =
  | { reason: "move"; since: string }
  | { reason: "rollback"; since: string; image: string; commit: string; from?: string };
deployPauseOf(github, plan): Promise<DeployPause | undefined>
setDeployPause(deps, github, plan, entry): Promise<DeployPause | undefined>      // returns the replaced entry
restoreDeployPause(deps, github, plan, entry: DeployPause | undefined): Promise<void>
clearDeployPause(deps, github, plan, reason: DeployPause["reason"]): Promise<boolean>
runningDeploy(github, plan): Promise<{ url: string } | undefined>
waitForDeploys(deps, github, plan, services): Promise<void>

// shared/deploy-run.ts
dispatchAndFollow(deps, github, input: { workflowFile; ref; inputs: Record<string, string>;
  target: string; command: string; detail: string }):
  Promise<{ status: "deployed" | "waiting"; runId: number; runUrl: string }>  // a failed run: COMMAND_FAILED

// rollback/
rollback(deps, options: RollbackOptions): Promise<RollbackResult>
interface RollbackOptions {
  to?: string; list?: boolean; resume?: boolean; deploy?: boolean;
  approveHash?: string; allowOldSecrets?: string[]; services?: RollbackServices;
}
type RollbackResult =
  | { kind: "list"; versions: VersionView[]; paused?: DeployPause; leftOut: number }
  | { kind: "rolled-back"; status: "deployed" | "waiting"; target: VersionView;
      from?: VersionView; runUrl?: string; paused: boolean; how: "image" | "worker" | "pages" | "local" }
  | { kind: "resumed"; wasPaused: boolean; deployed?: { runUrl: string; commit: string } };
listVersions(deps, ctx): Promise<{ versions: Version[]; leftOut: { count: number; reasons: string[] } }>
describeImage(image: AppImage, digest: string): Promise<{ commit; message?; builtAt; runUrl } | undefined>
imageRollbackHash(parts: { environment; current; target; targetPlanHash }): string
```

- **Promote:**
  - `requireApplied(deps, { …, branch })`;
  - `rollBackWorker` and `rollBackPages` exported with `{ command, versionFlag, beforeChange? }`;
  - `promote` refuses while its target is paused.
- **Status:** `ComponentStatusReport` gains `deploys?: { running?: VersionView; previous?: VersionView; paused?: DeployPause }`.

## CLI and MCP (T1907, T1911, T1909)

- `opscrew rollback [--to <commit|digest|version>] [--list] [--resume [--deploy] [--yes]] [--approve <hash>] [--allow-old-secrets <names>] [--app <key>] [--env <name>]`
- `opscrew logs --failed [--service <name>]`, not with `--follow` or `--since`.
- MCP:
  - `opscrew_status` data gains `deploys`;
  - `opscrew_logs` gains `failed: boolean`;
  - there is no rollback tool: it stays in the terminal (US6).
