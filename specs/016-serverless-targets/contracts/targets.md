# Contract: server-less targets

## plan-schema (T1601a, ADR 0019)

```ts
type CloudflareWorkersTarget = {
  provider: "cloudflare-workers";
  mode: "workers-assets";
  worker: string;                       // Worker name; default the app's name (<app>-<env> for another environment)
  render: "static" | "ssr";
  notFound: "single-page-application" | "404-page" | "none";
  workersDev: boolean;                  // default false
  previewUrls: boolean;                 // default false
  site: Site;
};
type GithubPagesTarget = { provider: "github-pages"; mode: "pages-workflow"; site: Site };
type Site = {
  tool: "node" | "hugo" | "none";
  packageManager?: "npm" | "pnpm" | "yarn" | "bun"; // node only, required there
  nodeVersion?: string;                 // node only
  command?: string;                     // required with node and hugo, refused with none
  outputDir: string;                    // repository path
  entry?: string;                       // Cloudflare ssr only, required there
};
// DeployTargetSchema gains both; DeployProviderSchema gains "cloudflare-workers" and "github-pages".
// onServer(plan) is true only for the cloud and own targets.
// The running version is read from the provider, never stored in the plan (data-model.md).
```

**Approval kind** (contracts `ApprovalKind`, core `APPROVAL_KINDS` and `HASH_BOUND`): `pages-apply`, hash-bound, may allow deleting, never granted by `--yes`.

Refusals, each with a plain message and the fix:
- either target without Cloudflare DNS and a domain;
- with services, processes beyond web, cron or SQLite;
- with a `server` or `host` runner;
- GitHub Pages proxied, or with a `site.entry` (server code);
- a second GitHub Pages environment in one repository (agents: it needs the other plans);
- retarget to or from either.

## The Cloudflare connector (T1603)

```ts
listWorkerVersions(accountId, worker): Promise<{ id: string; createdOn: string; source?: string }[]>;
listWorkerDeployments(accountId, worker): Promise<{ id: string; versions: { id: string; percentage: number }[]; createdOn: string }[]>;
deployWorkerVersion(accountId, worker, versionId): Promise<void>;          // 100%
listWorkerCustomDomains(accountId, worker): Promise<{ hostname: string; zoneId: string; certStatus?: string }[]>;
workersPermissions(): Promise<{ missing: string[] }>;                      // names the missing ones
```

## The GitHub connector (T1604)

```ts
getPages(owner, repo): Promise<{ buildType: "workflow" | "legacy"; cname?: string; httpsEnforced: boolean; status?: string } | undefined>;
createPages(owner, repo): Promise<void>;                                   // build_type workflow
updatePages(owner, repo, change: { cname?: string | null; httpsEnforced?: boolean }): Promise<void>;
deletePages(owner, repo): Promise<void>;
pagesHealth(owner, repo): Promise<{ certificate: "pending" | "issued" | "error"; dns: "ok" | "pending" | "error" } | undefined>;
latestPagesDeployment(owner, repo): Promise<{ runId: number; status: string } | undefined>;
rerunWorkflowRun(owner, repo, runId): Promise<void>;
```

Every call validates its answer with zod. A 404 for Pages or a Worker is `undefined`.

## CLI and MCP (T1612)

- **`opscrew interview` / `env add --target`:** `cloudflare-workers` and `github-pages`.
- **`opscrew promote --to <env>`** (Cloudflare, a promoted environment): the source's build, by run id and SHA-256.
- **`opscrew promote --to <env> --version <id>`** (a rollback, any environment): Cloudflare activates that version of the environment's own Worker; GitHub Pages re-runs that Pages run. `--digest` is refused on these targets, and `--version` on server targets.
- **`opscrew destroy --delete-verification`:** also removes GitHub's verification record.
- **MCP:** the interview tool's provider help lists every target, localhost included. The provision, promote and destroy tools take the same inputs.
