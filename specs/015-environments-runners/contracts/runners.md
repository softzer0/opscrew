# Contract: self-hosted runners (015)

Owners:
- `packages/connectors/ssh-host`: the host step (T1507);
- `packages/connectors/github`: the runner calls (T1504);
- `packages/agents/src/runners`: the flows (T1511);
- `packages/iac-templates`: the pin (T1501b) and `runs-on` (T1505).

## The pin (`@opscrew/iac-templates`)

```ts
TOOLS.githubRunner: {
  version: string;   // "2.338.0"
  assets: Record<"linux-x64" | "linux-arm64" | "win-x64" | "osx-x64" | "osx-arm64",
    { url: string; sha256: string }>;
}
```

`update-pins.mjs` reads each SHA-256 from the release body (`<!-- BEGIN SHA <asset> -->…<!-- END SHA <asset> -->`).

## GitHub connector

```ts
runnerRegistrationToken(owner, repo): Promise<string>;   // redacted on receipt
runnerRemoveToken(owner, repo): Promise<string>;         // redacted on receipt
listRunners(owner, repo): Promise<{ id: number; name: string; status: "online" | "offline"; labels: string[]; version?: string }[]>;
deleteRunner(owner, repo, id): Promise<void>;
repositoryVisibility(owner, repo): Promise<"public" | "private" | "internal">;
forkPrApprovalPolicy(owner, repo): Promise<"first_time_contributors_new_to_github" | "first_time_contributors" | "all_external_contributors">;
setForkPrApprovalPolicy(owner, repo, policy): Promise<void>;   // a github-settings change
```

## The host step `github-runner` (`@opscrew/connector-ssh-host`)

```ts
interface DesiredRunner {
  label: string;          // "opscrew-<app>-<env>"
  name: string;           // "<host>-<app>-<env>"
  repositoryUrl: string;  // "https://github.com/<owner>/<repo>"
  version: string; sha256: string; asset: "linux-x64" | "linux-arm64";
}
DesiredHost.runner?: DesiredRunner;
```

**Plan:** the step's title and details name the version, the checksum, the user (`deploy`), the
label and the folder. The token never enters the plan: the plan says "a registration token
fetched while this plan is applied".

**Apply:** `applyHostPlan(plan, { …, runnerToken: () => Promise<string> })`. The callback is
called only when the step runs. The token goes to the script on stdin, is read into a shell
variable, used once, and unset. It is registered with the redactor before the call, so no output
line can carry it.

**Teardown:** the step's removal is in `planTeardown` and `planUndo`. It runs `svc.sh stop` and
`svc.sh uninstall`, then `config.sh remove` with a remove token on stdin, then deletes the folder.
When the host is gone, the flow calls `deleteRunner` instead.

**Inspect:** the service's state (`systemctl is-active`) and the installed version
(`bin/Runner.Listener --version`).

## Agents

```ts
planServerRunner(deps, plan): Promise<{ step?: DesiredRunner; settings?: GithubSettingsChange; refusal?: string }>;
startLocalRunner(deps, { environment }): Promise<{ stop: () => Promise<void> }>;
runnerStatus(deps, plan): Promise<{ registered: boolean; online?: boolean; version?: string; behind?: boolean; visibility: string }>;
```

**Rules:**
- A public repository is refused unless the fork-PR policy is `all_external_contributors`, or the user approves setting it (`github-settings`).
- `runner: server` needs a cloud or own-server target. `runner: local` needs a localhost target.
- The local runner downloads the pinned asset for this computer, checks it, configures it `--ephemeral` with the label, runs it in the foreground, and removes itself through the API on exit, a signal included.
- **Status and secure:**
  - offline is a warning;
  - more than 21 days behind GitHub's latest release is a warning, since GitHub stops sending jobs at 30;
  - a public repository whose fork-PR policy is not `all_external_contributors` is high.
