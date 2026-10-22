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
  name: string;           // "<8 hex of sha256(host)>-<app>-<env>": GitHub never sees the address, and two servers never share a name
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

## Runner machines (FR-1532–FR-1535)

```ts
// @opscrew/agents
addRunnerHost(deps, { name, ssh: { user, host, port? }, keyFile? }): Promise<{ plan: HostPlan; hash: string }>;   // inspect, pin the host key, plan
applyRunnerHost(deps, { name, approvedHash }): Promise<void>;
removeRunnerHost(deps, { name, approvedHash? }): Promise<void>;   // refused while an environment uses it
listRunnerHosts(deps): Promise<{ name: string; arch: string; docker: boolean; environments: string[] }[]>;
```

- **An environment with `runner: host`** adds its `github-runner` step to the machine's host plan at its provision, and removes it at its destroy, each approved by the machine's plan hash.
- **The deploy job** on a runner machine runs `runs-on: [self-hosted, opscrew-<app>-<env>]` with the same SSH deploy steps a GitHub-hosted job uses, and the same deploy secrets.
- **`build: runner`:** the build job runs on the environment's self-hosted runner label, with Buildx, provenance and SBOM as on GitHub's machines.

## Agents

```ts
planServerRunner(repository, plan, server: { arch, host }): Promise<{ step?: DesiredRunner; settings?: GithubSettingsChange; refusal?: string }>;
startLocalRunner(deps, { environment }): Promise<{ stop: () => Promise<void>; finished: Promise<void> }>;   // finished: the CLI waits on it in the foreground
runnerStatus(deps, repository, plan): Promise<{ registered: boolean; online?: boolean; version?: string; latest?: string; behind?: boolean; visibility: string; forkPrApproval?: string }>;
```

**Rules:**
- A public repository is refused unless the fork-PR policy is `all_external_contributors`, or the user approves setting it (`github-settings`).
- `runner: server` needs a cloud or own-server target. `runner: local` needs a localhost target.
- The local runner downloads the pinned asset for this computer, checks it, configures it `--ephemeral` with the label, runs it in the foreground, and removes itself through the API on exit, a signal included.
- **Status and secure:**
  - offline is a warning;
  - more than 21 days behind GitHub's latest release is a warning, since GitHub stops sending jobs at 30;
  - a public repository whose fork-PR policy is not `all_external_contributors` is high.
