# Contract: observability

## plan-schema (T1701a, ADR 0021)

```ts
type Observability = {
  check?: {
    enabled?: boolean;                         // design sets it: prod on, others off; refused on localhost
    intervalMinutes?: 5 | 10 | 15 | 20 | 30 | 60; // first app's prod plan only (agents refuse it elsewhere)
    webhook?: "slack" | "discord" | "ntfy";    // the same rule; the address is a GitHub secret
  };
  beszel?: {
    enabled: boolean;                          // default false
    version: PinnedVersion;
    mode: "hub" | "agent";                     // default "hub"
    access: "local" | "subdomain";             // default "local"; hub mode only
    hostname?: Fqdn;                           // subdomain only, required there
    allowedEmails?: string[];                  // subdomain only, at least one there
    hubUrl?: string;                           // agent mode only, required there (https)
    hubKey?: string;                           // agent mode only, required there (public key)
    memoryMb: { hub: number; agent: number; proxy: number };
  };
  grafanaCloud?: {
    enabled: boolean;                          // default false
    version: PinnedVersion;
    metrics: { url: string; user: string };    // https; numeric user id
    logs: { url: string; user: string };
    logSampling: number;                       // 1–100, default 100
    memoryMb: { alloy: number; proxy: number };
  };
};
// DeployPlanSchema gains `observability`, optional: plans without it stay byte-identical.
// Refused: beszel or grafanaCloud enabled unless onServer(plan); check.enabled on localhost.
```

## contracts (T1701a)

```ts
interface RemoteExec {
  readonly host: string;
  run(
    command: string,
    options?: {
      timeoutMs?: number;
      input?: string;
      onLine?: (stream: "stdout" | "stderr", line: string) => void; // new: lines as they arrive
      signal?: AbortSignal;                                         // new: stop (follow)
    },
  ): Promise<CommandResult>;
}
```

`SshRemoteExec` passes both to `CommandRunner.run`. `FakeHost` and the other fakes accept and ignore them, or replay their output line by line.

## Connectors

**Cloudflare (T1703)**

```ts
workersLogs(accountId: string, worker: string, q: { from: number; to: number; limit: number }):
  Promise<{ time: string; level: string; message: string; status?: number; outcome?: string; error?: string }[]>;
workersTail(accountId: string, worker: string, o: { signal: AbortSignal; onEvent: (e: TailEvent) => void }): Promise<void>;
workersAnalytics(accountId: string, worker: string, since: Date):
  Promise<{ requests: number; errors: number; cpuTimeP50Ms: number; cpuTimeP99Ms: number }>;
observabilityPermissions(accountId: string, worker: string): Promise<{ missing: string[] }>; // names each missing permission
// CLOUDFLARE_OBSERVABILITY_PERMISSIONS: Workers Observability Read only. The tail and analytics work with
// the Workers Scripts Edit that the hosting token already has (T1703's review, measured live).
```

**GitHub (T1704)**

```ts
checkWorkflowState(owner: string, repo: string, file: string):
  Promise<"active" | "disabled_inactivity" | "disabled_manually" | "disabled_fork" | "missing">;
openIssues(owner: string, repo: string, label: string): Promise<{ number: number; title: string; url: string; body: string; createdAt: string }[]>;
getRepoVariable(owner: string, repo: string, name: string): Promise<string | undefined>;
setRepoVariable(owner: string, repo: string, name: string, value: string): Promise<void>;
deleteRepoVariable(owner: string, repo: string, name: string): Promise<void>;
includedMinutes(owner: string): Promise<number | undefined>;  // from the account's plan, when readable
// getRepo gains hasIssues?: boolean (absent in older fakes; only an explicit false means issues are off).
// GITHUB_TOKEN_PERMISSIONS gains Issues: Read and Variables: Read and write (only with the check).
```

**Portainer (T1705)**

```ts
containerLogs(envId: number, containerId: string, o: { tail: number; since?: number | string }):
  Promise<{ stream: "stdout" | "stderr"; time: string; line: string }[]>; // demultiplexed, oldest first; a TTY stream as stdout
  // since: whole Unix seconds, or "<seconds>.<nanoseconds>"; sinceAfter(time) gives the next nanosecond
containerStats(envId: number, containerId: string):
  Promise<{ cpuPercent: number; memoryUsedBytes: number }>;   // the limit comes from containerInspect
containerInspect(envId: number, containerId: string):
  Promise<{ restartCount: number; startedAt: string; memoryLimitBytes?: number }>; // only these fields kept
// dockerInfo gains cpus (NCPU) and memoryBytes (MemTotal), optional. ContainerSummary gains id.
```

**ssh-host (T1706)**
- **Host steps:**
  - `check-key`: adds or removes the line `restrict,command="df -P -B1 /" <public key> opscrew-check`;
  - `beszel` and `alloy`: write the Compose file and configs under `opscrew/addons/<name>`, start them, and on teardown remove them, their volumes included unless `keepData` (a volume's deletion is a destroying plan).
- **Planners:** `planAddon(kind, …)`, and `planTeardown` gains the add-ons.
- **`ApplyOptions.secrets`** gains `beszelPassword`, `beszelToken` and `grafanaCloudToken` (stdin only).

## iac-templates (T1707, T1708)

```ts
renderCheck(input: {
  plans: DeployPlan[];
  repo: { owner: string; name: string; public: boolean };
  serverIds?: Record<string, string>;    // by checkEnvironmentKey(plan): the server's identity, so a shared server is checked once
}): { path: string; content: string }[]; // the workflow, check.json, check.mjs
renderAddon(plan: DeployPlan, kind: "beszel" | "grafana-cloud"):
  { path: string; content: string }[];   // compose.yaml, the proxy's Caddyfile, config.yml or config.alloy
```

**`check.mjs`:** `node opscrew/check/check.mjs [--only disk:<server id>]`.
- **It reads:**
  - `check.json` next to it;
  - `GITHUB_TOKEN`, `GITHUB_REPOSITORY` and `GITHUB_EVENT_PATH`;
  - `OPSCREW_CHECK_PAUSED`;
  - the secrets the workflow maps into its environment.
- **Exit code:** 0 when it could report everything. 1 when GitHub's API fails, or when issues are off and something is failing.

## Agents and surfaces (T1709–T1712)

- **Agents:**
  - `readLogs(deps, plan, { service?, since?, tail?, follow? })`: an async iterable of `LogLine` (data-model.md);
  - `readResources(deps, plan)`: a `ResourceReading`;
  - `registerAppSecrets(deps, plan)`.
- **The CLI:**
  - `opscrew logs [--follow] [--service <name>] [--since <duration>] [--tail <lines>] [--app <key>] [--env <name>]`;
  - `opscrew addon <enable|disable|status|open> <beszel|grafana-cloud> [--mode hub|agent] [--hub-url <url>] [--access local|subdomain] [--hostname <fqdn>] [--allow-email <email>…] [--keep-data] [--confirm <app>]`.
- **MCP:** `opscrew_logs { app?, env?, service?, since?, tail? }`.
  - Read-only, with no follow.
  - At most 500 lines and 64 KiB; past that, `truncated: true`.
  - Redacted.
- **`opscrew_status`'s data** gains `resources` (a `ResourceReading`) and `check` (its state and open alerts).

**Refusals, each with a plain message and the fix:**
- `logs --service` with an unknown name: the list of names.
- `addon enable` off a server target: why, and what the target offers instead.
- A second app turning on an add-on already on the server: which app has it.
- `addon enable beszel --mode agent` without `--hub-url`, the key or the token.

When the Grafana Cloud estimate passes the free tier, `addon enable grafana-cloud` says so before the host plan, and offers a lower `logSampling`.
