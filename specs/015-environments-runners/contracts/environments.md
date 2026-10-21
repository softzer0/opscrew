# Contract: environments and promotion (015)

Owners:
- `packages/core`: paths (T1503);
- `packages/plan-schema` and `packages/contracts`: the types (T1501a);
- `packages/connectors/github`: the GitHub calls (T1504);
- `packages/agents`: the flows (T1508a, T1508b, T1509).

Consumers: `packages/cli`, `packages/mcp-server` (T1512).

## Paths (`@opscrew/core`)

```ts
interface ResolveProjectPathsOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  environment?: string;            // absent or "prod": today's paths
}
resolveProjectPaths(root, options): ProjectPaths;   // + environment: string (resolved name)
environmentsOf(root, deps): Promise<string[]>;      // "prod" first when deployed or planned, then by order
```

- For an environment other than prod, `artefactsDir` is `opscrew/environments/<env>`, `stateDir`
  is `.opscrew/environments/<env>` and `projectHomeDir` is `<home>/projects/<id>/environments/<env>`.
- The files shared by every environment keep prod's paths, through the separate `shared` group of
  `ProjectPaths.files`: `architecture`, `architectureMd`, `scanReportMd`, `scanReportJson`, `proxyDir` and
  `requirementsBase`.
- An unknown environment name is `INVALID_INPUT`, with the list.

## The environment choice (agents)

```ts
resolveEnvironment(root, requested: string | undefined, deps): Promise<string>;
```

- With one environment, `requested` may be absent.
- With several and no `requested`: interactive runs ask, and scripts get `PHASE_PRECONDITION`, which lists the names and `--env`.

## Commands (CLI) and tools (MCP)

| CLI | MCP | Does |
|---|---|---|
| `opscrew env add <name> [--target …] [--from <source>] [--runner github\|server\|local]` | `opscrew_env_add` | asks the environment's own questions, writes its requirements, designs it, shows its cost |
| `opscrew env list` | `opscrew_env_list` | name, target, deploy source, runner, deployed or not |
| `opscrew env remove <name>` | `opscrew_env_remove` | refuses while deployed; removes its files |
| `opscrew promote --to <env> [--digest sha256:…] [--approve <hash>]` | `opscrew_promote` (dialog) | section below |
| `--env <name>` on provision, destroy, drift, status, verify, secure, retarget, secrets | `environment` input on the matching tools | acts on that environment only |

## Promotion (agents)

```ts
promote(deps, { target: string; digest?: string; approveHash?: string }): Promise<{
  digest: string; runUrl: string; deployed: boolean;
}>;
```

1. `source` = the target's `deploySource.source`. `digest` = the given digest, which must be the source's `opscrew-<source>` tag or the target's `opscrew-<target>-previous`, else `taggedDigest("opscrew-<source>")`.
2. `imageProvenance(digest)`: the repository must be this one and the ref the default branch. When `supplyChain.sign` is on, the cosign signature must verify.
3. The target plan must have no pending infrastructure or stack change, else `PHASE_PRECONDITION`: "provision --env <target> first".
4. The approval `{ kind: "promote", planHash: sha256(canonical({ target, source, digest, targetPlanHash })) }`.
5. `dispatchWorkflow(opscrew-deploy-<target>.yml, defaultBranch, { digest })`, then wait for the run. On success, record the digest in the target's state.

Refusals (`PHASE_PRECONDITION`, plain English):
- no deployed source;
- a digest that isn't the source's or a rollback;
- a provenance mismatch;
- pending changes;
- a target workflow missing on the default branch.

## GitHub connector (`@opscrew/connector-github`)

```ts
putEnvironment(owner, repo, name, body): Promise<EnvironmentView>;
getEnvironment(owner, repo, name): Promise<EnvironmentView | undefined>;
deleteEnvironment(owner, repo, name): Promise<void>;
environmentCapability(owner, repo, probe: string): Promise<{ environments: boolean; branchPolicies: boolean; reviewers: boolean }>;
environmentPublicKey(owner, repo, env): Promise<{ key_id: string; key: string }>;
setEnvironmentSecret(owner, repo, env, name, value): Promise<void>;   // sealed locally
deleteEnvironmentSecret(owner, repo, env, name): Promise<void>;
dispatchWorkflow(owner, repo, workflowFile, ref, inputs): Promise<{ runId: number; url: string }>;
taggedDigest(owner, image, tag): Promise<string | undefined>;
imageProvenance(owner, image, digest): Promise<{ repository: string; workflow: string; ref: string; commit: string } | undefined>;
```

- `environmentCapability` creates `probe`, reads it back, and deletes it when the probe was new. Creating it is a `github-settings` change shown to the user.
- Every call validates the response with zod. 404 on a missing environment is `undefined`.
