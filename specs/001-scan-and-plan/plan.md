# Implementation Plan: Scan and Plan (Phase 1a)

**Branch**: `mvp` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)
**Input**: `specs/001-scan-and-plan/spec.md`; foundation from `specs/000-platform-architecture/`.

## Summary

Deterministic packages do the heavy lifting: `@opscrew/detect` (repository facts),
`@opscrew/secops` (scan engine, rules, reports), `@opscrew/connector-hetzner` (catalogue) and the
deterministic parts of `@opscrew/agents` (interview, design, code-change derivation, templates from
`@opscrew/iac-templates`). Models are used in exactly two places: the read-only Analyst
(`claude-haiku-5-5`) and the edit-repo Code-change agent (`claude-opus-5-5`), both through the
`AgentRuntime` contract. The MCP server and the Claude Code plugin expose the deterministic tools.

## Technical Context

**Language/Version**: TypeScript 7, Node ≥ 20.19.
**Primary Dependencies**: zod, yaml, smol-toml (TOML), ignore (gitignore), tinyglobby (globs),
`@modelcontextprotocol/sdk` (MCP server), libsodium-wrappers (GitHub secrets, feature 002).
**Storage**: artefacts in `opscrew/`, local state in `.opscrew/` (see 000 data-model).
**Testing**: Vitest; fixtures materialised into temp dirs with `materializeFixture()`; HTTP via
injected `fetch`; git via injected `CommandRunner` or real `git` in temp repos.
**Target Platform**: Windows/macOS/Linux terminals; Claude Code (plugin).
**Performance Goals**: scan < 10 s offline on 5,000 files; detection < 2 s on fixtures.
**Constraints**: constitution I, IV, V, VII; no model in scan, detect, interview, design or MCP.

## Constitution Check

| Principle | Compliance |
|---|---|
| I | adapt asks approval before commit and again before push/PR; Code-change agent runs in `edit-repo` (policy denies `git push`, network, secret files, `opscrew/**`). |
| II | All outputs are files in the repo (`opscrew/*`, Dockerfile …) and a normal PR. |
| IV | Findings masked; reports have no absolute paths; `.env` values never read by agents; fixtures use generated fake secrets. |
| V | Detection, sizing, pricing and rendering deterministic; Analyst/Code-change outputs zod-validated. |
| VI | New package `@opscrew/detect` consumed by secops, agents, mcp-server via its root export. |
| VII | Each task has a Verify command; network only through injected `fetch`. |
| VIII | Hetzner adapter is typed and read-only in this feature. |
| X | Optional external scanners; built-in baseline. |

## Project Structure

```text
packages/detect/src/
  files.ts        listProjectFiles(root, opts) → repo-relative POSIX paths (gitignore-aware)
  git.ts          readGitInfo(root) from .git files; parseGitRemote(url) (strips userinfo)
  manifests.ts    package.json / pyproject / requirements / go.mod … readers
  frameworks.ts   framework + app-kind + build/start/port rules
  env.ts          environment-variable reference extraction
  services.ts     service detection from dependencies and env names
  platform.ts     Lovable / Bolt / Replit / v0 / Base44 fingerprints
  detect.ts       detectProject(root, opts) → ProjectFacts
  index.ts
packages/secops/src/
  scanners.ts     defaultScanners() registry                      (lead-owned)
  scan/           context.ts (createScanContext), run.ts (runScan), finding.ts (ids, sort, counts)
  rules/          secrets.ts, config.ts, supabase.ts, firebase.ts, deps.ts
  lockfiles/      npm.ts, pnpm.ts, yarn.ts, python.ts
  external/       gitleaks.ts, osv-scanner.ts, trivy.ts
  report/         markdown.ts, terminal.ts
  index.ts                                                         (lead-owned)
packages/connectors/hetzner/src/
  client.ts       HetznerClient (fetch, pagination, retry, zod)
  catalog.ts      HetznerCatalog (live), StaticHetznerCatalog (dated table)
  static-prices.ts
  connector.ts    hetznerConnector(): Connector (credentials, verify, tools)
  index.ts
packages/iac-templates/src/
  types.ts        RenderedFile, RenderContext                     (lead-owned)
  docker/         dockerfile.ts (renderDockerAssets), templates per stack
packages/agents/src/
  context.ts      PhaseDeps                                       (lead-owned)
  analyze/        runAnalyze, summarizeFacts, renderArchitectureMarkdown, prompts
  interview/      buildQuestions, answersToRequirements, runInterview
  design/         sizing.ts, options.ts, code-changes.ts, plan.ts, runDesign
  adapt/          runAdapt, playbooks/, prompts
  index.ts                                                         (lead-owned)
packages/mcp-server/src/
  server.ts       createOpscrewMcpServer(deps), startStdioServer()
  tools/plan.ts   001 tools;  tools/deploy.ts (stub, filled in 002)
  index.ts
packages/cli/src/commands/{scan,analyze,interview,design,adapt,mcp}.ts
plugin/           .claude-plugin/plugin.json, .mcp.json, skills/*/SKILL.md, README.md
.claude-plugin/marketplace.json
examples/{lovable-supabase,nextjs-postgres,fastapi-redis,static-vite}/ + expected.json
```

**Structure Decision**: `@opscrew/detect` is a new package (not in the approved layout) because
scan, analyze and the MCP server all need the same facts. Barrels and registries marked lead-owned
are created before the waves so parallel tasks never edit the same file.

## Design

### Detection (`@opscrew/detect`)

- **File listing**: walk from `root`, always skipping `node_modules`, `.git`, `.opscrew`,
  `.terraform`, `dist`, `build`, `.next`, `.nuxt`, `.svelte-kit`, `.output`, `coverage`, `.venv`,
  `venv`, `__pycache__`, `.mypy_cache`, `.pytest_cache`, `target`, `vendor`; honour `.gitignore`
  files at every level (package `ignore`); skip files > 1 MB; stop at `maxFiles` (default 20,000)
  and report `truncated: true`. Paths returned sorted, POSIX, repo-relative.
- **Git** (no binary needed): read `.git/config` `[remote "origin"] url`, `.git/HEAD`
  (`ref: refs/heads/<branch>`), `.git/refs/remotes/origin/HEAD` for the default branch; support
  `.git` files pointing to a worktree gitdir. `parseGitRemote` handles `https://`, `ssh://`,
  `git@host:owner/repo(.git)` and strips `user:pass@`.
- **Frameworks → app kind**: `next` → `ssr` unless `output: "export"` in `next.config.*` →
  `static-spa`; `nuxt`, `@remix-run/*`, `@sveltejs/kit`, `astro` with a server adapter → `ssr`
  (astro without adapter → `static-spa`); `vite`, `react-scripts`, `@angular/core` without a server
  framework → `static-spa`; `express`, `fastify`, `@nestjs/core`, `hono`, `koa`, `fastapi`, `flask`,
  `django` (API-only when `rest_framework` and no templates) → `api`; a frontend framework plus a
  server framework in one app, Django with templates, Rails, Laravel → `fullstack`; only queue/cron
  libraries → `worker`; otherwise `unknown`.
- **Build/start/port**: from `package.json` scripts (`build`, `start`), framework defaults (Next 3000,
  Express/Fastify/Nest/Hono 3000, FastAPI 8000, Flask 5000, Django 8000, Vite static output `dist`,
  CRA `build`, Angular `dist/<project>/browser`); literal `listen(<n>)` / `--port <n>` / `PORT ||
  <n>` patterns; uvicorn target found from `FastAPI(` assignment (`module:app`).
- **Env vars**: `process.env.X`, `process.env["X"]`, `import.meta.env.X`, `Deno.env.get("X")`,
  `os.environ["X"]`, `os.environ.get("X")`, `os.getenv("X")`, plus keys in `.env.example`/
  `.env.sample`; `clientExposed` for prefixes `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `PUBLIC_`,
  `NUXT_PUBLIC_`, `EXPO_PUBLIC_`, `GATSBY_`; `secretLikely` when the name contains `SECRET`, `TOKEN`,
  `PASSWORD`, `PASSWD`, `PRIVATE`, `CREDENTIAL`, `API_KEY`, `DSN`, `DATABASE_URL`, `SERVICE_ROLE`, and
  the name is not client-exposed — except client-exposed names containing `SECRET`, `SERVICE_ROLE`,
  `PRIVATE` or `PASSWORD`, which are `secretLikely: true` (that is the dangerous case).
- **Services**: dependency → kind map (pg/postgres/@prisma with postgresql datasource/drizzle with pg
  /typeorm+pg/sequelize+pg/psycopg/psycopg2/asyncpg/sqlalchemy+postgres URL → postgres; mysql2/
  pymysql → mysql; mongoose/mongodb/pymongo → mongodb; redis/ioredis/redis-py → redis; bullmq/bull/
  celery/rq → queue (+redis when broker is redis); better-sqlite3/sqlite3 → sqlite;
  @supabase/supabase-js/supabase-py → supabase; firebase/firebase-admin → firebase;
  @aws-sdk/client-s3/boto3 → s3; stripe → stripe; nodemailer/resend/@sendgrid/mail/postmark → email;
  socket.io/ws/websockets → websocket; node-cron/cron/apscheduler → cron) and env names
  (`DATABASE_URL`/`POSTGRES_*` → postgres, `REDIS_URL` → redis). Evidence strings like
  `dependency:pg`, `env:DATABASE_URL`.
- **Platform fingerprints**: Lovable — `lovable-tagger` dependency, `lovable` in `index.html` meta or
  README links to `lovable.dev`/`lovable.app`; Bolt — `.bolt/` directory; Replit — `.replit`,
  `replit.nix` or `.replit/`; v0 — `components.json` + `next` + (`v0.dev`/`v0.app` in README or
  package name `my-v0-project`); Base44 — `@base44/sdk`. Highest-evidence platform wins; ties → first
  in that order.
- **Monorepo**: `workspaces` in package.json, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`,
  `lerna.json`. The deployable app is the workspace with a start script/server framework; when more
  than one qualifies, facts describe the root and list candidates in `risks` (interview asks).

### Scan (`@opscrew/secops`)

- `createScanContext(root, { offline, fetch, runner, files? })` uses `listProjectFiles` from detect
  and `git ls-files -z` (via runner, when `.git` exists) for `gitTracked`.
- `runScan(root, { offline, fetch, runner, scanners?, version, onProgress? })`: runs available
  scanners concurrently (max 4), records `ScannerStatus` (ran/skipped/failed + reason, duration),
  never lets one scanner's failure stop the scan, deduplicates by finding id and by
  (file, line, ruleId family), sorts by severity then file then line, computes counts.
- Finding id = first 16 hex of sha256(`ruleId|file|line|fingerprint`), where fingerprint is a hash
  of the raw match (the raw value never leaves the scanner).
- Rule ids are namespaced: `secrets/github-token`, `supabase/rls-disabled`, `config/dockerfile-root`,
  `deps/<GHSA-or-CVE-id>`, `gitleaks/<rule>`, `trivy/<id>`.
- Severity guide: a live credential in tracked files → critical; committed `.env` with values →
  critical; service-role key in client code → critical; RLS disabled on a table → high; open
  Firebase rules → critical; `using (true)` on writes → high; Dockerfile as root → medium; `latest`
  tag → low; debug mode → high; dependency severity from OSV (`CRITICAL/HIGH/MODERATE/LOW` →
  critical/high/medium/low; CVSS ≥ 9/7/4/0.1 when only a score exists).
- Placeholders ignored: values containing `your-`, `xxx`, `changeme`, `example`, `placeholder`,
  `<`…`>`, `${`, `process.env`, all-same characters, or shorter than the rule minimum.
- OSV API: `POST https://api.osv.dev/v1/querybatch` with `{ queries: [{ package: { name, ecosystem
  }, version }] }` in chunks of 500; then `GET https://api.osv.dev/v1/vulns/{id}` for up to 100
  unique ids (summary, aliases, severity, `database_specific.severity`, affected ranges/fixed
  version). Timeouts 15 s; failures → scanner `failed` with reason, scan continues.
- External: gitleaks (`gitleaks dir <root> --report-format json --report-path - --redact
  --no-banner --exit-code 0`, falling back to `gitleaks detect --no-git --source <root> …` for older
  versions), osv-scanner (`osv-scanner scan source -r --format json <root>`; when it runs, the OSV API
  scanner is skipped as "superseded"), trivy (`trivy fs --scanners misconfig --format json --quiet
  <root>`). Each detects its binary with `findExecutable` and parses JSON defensively.
- Reports: Markdown (title, project name, date, summary table by severity, findings grouped by
  severity with file:line, masked evidence, description, remediation, references; scanners table;
  footer "Generated by OpsCrew <version>") and terminal summary (counts line + top 10 findings +
  report path). Both deterministic for a given report.

### Hetzner catalogue (`@opscrew/connector-hetzner`)

- `HetznerClient({ token, fetch, baseUrl = "https://api.hetzner.cloud/v1" })`: `listServerTypes`,
  `listLocations`, `getPricing`, `listImages({ name?, architecture? })`, `getServer(id)`,
  `verifyToken()`; pagination via `meta.pagination.next_page` (`per_page=50`); retries on 429 (wait
  until `RateLimit-Reset` or 2^n s, max 3) and 5xx (max 2); errors → `OpsCrewError`
  (`CREDENTIALS_INVALID` for 401, `PROVIDER_ERROR` otherwise) with the API `error.message`.
- Response schemas (zod, passthrough for unknown fields) follow hcloud-go: `server_types[]` with
  `name, description, cores, memory, disk, cpu_type, architecture, deprecated (bool | object),
  prices[{ location, price_hourly{net,gross}, price_monthly{net,gross}, included_traffic }],
  locations[{ name, available, recommended }]` (handle the `locations` field being absent on older
  responses); `pricing{ currency, primary_ips[{ type, prices[{ location, price_monthly }] }],
  server_backup{ percentage }, volume{ price_per_gb_month } }`; `locations[]` with `name, city,
  country, network_zone`.
- `HetznerCatalog` (live): offers = one per (server type, location price) with net monthly/hourly
  prices (`pricesIncludeVat: false`), x86 and ARM both reported (design filters), `available` from
  the type's `locations[]` (missing → true), deprecated types flagged. `extras(location)` → IPv4
  monthly (type `ipv4`), backup percent, volume price, `source: "live"`.
- `StaticHetznerCatalog`: the same interface over a table in `static-prices.ts` with `asOf` date and
  `source: "static"`; built from Hetzner's public price list (see research.md); when a price is
  unknown the offer is omitted.
- `hetznerConnector({ env, fetch })`: `credentials` = `HCLOUD_TOKEN`, Read & Write project token,
  `https://console.hetzner.cloud/` (Security → API tokens); `verifyCredentials()` lists one location;
  tools `hetzner_list_locations`, `hetzner_list_offers` (read-only).

### Interview, design and code changes (`@opscrew/agents`)

- `PhaseDeps` (lead-owned `context.ts`) carries: `paths`, `reporter`, `runtime?`, `approvals`
  (ApprovalGate), `audit`, `state`, `costs`, `runner`, `fetch`, `env`, `clock`, `redactor`,
  `interactive`, `version`.
- Question bank and inference rules as in the spec; `answersToRequirements` validates with
  `RequirementsSchema` and normalises the domain (lower-case, no scheme, no trailing dot).
- Region → Hetzner locations: eu-central → `nbg1`, `fsn1`; eu-north → `hel1`; us-east → `ash`;
  us-west → `hil`; ap-southeast → `sin`. First location where the offer is available wins.
- Sizing (vCPU, GB RAM) by `expectedMonthlyUsers`: `<1k` (1, 2), `1k-10k` (2, 4), `10k-100k`
  (4, 8), `>100k` (8, 16); static-spa halves memory (min 1 GB); self-hosted Postgres adds (1, 2) at
  `<1k`, (2, 4) at `1k-10k`, (2, 8) above; Redis/Valkey adds 0.5 GB; disk ≥ 40 GB (+ 20 GB with
  Postgres). Self-hosted Postgres when the app uses `postgres` and the user did not keep an external
  provider (`supabase`/`postgres` in `keepExternalServices`).
- Options (x86, not deprecated, available): **Lean** = cheapest shared offer meeting the need;
  **Comfortable** = cheapest shared offer with ≥ 2× the need's memory; **Dedicated** = cheapest
  dedicated-vCPU offer meeting the need, only when uptime is `high` or users ≥ `10k-100k`.
  Recommended = Lean when it fits the budget and uptime is not `high`, else Comfortable when it
  fits, else the cheapest. Backups on when data criticality is not `none`.
- Cost = server net monthly + IPv4 monthly + backups (percent × server) → `CostEstimate` (2-decimal
  rounding, breakdown sums to total). Budget comparison converts USD↔EUR at a fixed approximate rate
  of 1 EUR = 1.10 USD stated in the output.
- `deriveCodeChanges(facts, scan?)`: Dockerfile missing → `dockerfile`; `.dockerignore` missing →
  `dockerignore`; non-static app without health endpoint → `health-endpoint` (path per framework:
  Next app router `app/api/health/route.ts` with health path `/api/health`; pages router
  `pages/api/health.ts`; others `/health`); hard-coded port → `port-config`; env vars used and no
  `.env.example` → `env-example`; Next.js without `output: "standalone"` → `build-config`; secret
  findings (`secrets/*`, `supabase/service-role-*`) in source files → `secret-removal` per file.

### Docker templates (`@opscrew/iac-templates/src/docker`)

`renderDockerAssets(facts, { appPort, healthPath })` returns `Dockerfile`, `.dockerignore` and
`.env.example` (names only, empty values, comments for client-exposed ones). Templates: Next.js
standalone (node:22-alpine, multi-stage, `npm|pnpm|yarn` from facts, `USER node`, `PORT`/`HOSTNAME`
env, `CMD ["node","server.js"]`); Node server (build if a build script exists, `npm start`
equivalent, `USER node`); static SPA (build with node, serve with `caddy:2-alpine` on 8080 with SPA
fallback `try_files {path} /index.html`, non-root); FastAPI (python:3.13-slim, uvicorn
`--host 0.0.0.0 --port ${PORT:-8000}`, non-root user); Django (gunicorn `<project>.wsgi`,
`collectstatic`, non-root); generic Python. Every Dockerfile has a header comment saying it was
generated by OpsCrew and may be edited.

### Adapt (`@opscrew/agents/src/adapt`)

1. Preconditions: plan exists; git repo; `git status --porcelain` empty (ignoring `opscrew/` and
   `.opscrew/`), else `PHASE_PRECONDITION` with "commit or stash first".
2. Branch `opscrew/prepare-deploy` (suffix `-2`, `-3` if it exists) from the current HEAD.
3. Deterministic files (only when missing) from `renderDockerAssets`.
4. Code-change agent (when `ai` and the runtime is configured): `edit-repo` profile,
   `claude-opus-5-5`, effort `high`, `maxTurns` 60, `maxBudgetUsd` 3; prompt = framework playbook +
   pending changes with acceptance criteria; output schema `{ changes: { id, status: "applied" |
   "skipped", notes }[] }`. Without a model: pending changes are listed with manual instructions.
5. Show `git diff --stat` and changed file list → approval `repo-write` → commit
   `chore(opscrew): prepare app for deployment` including `opscrew/{architecture.json,
   ARCHITECTURE.md, requirements.yaml, plan.yaml, SECURITY_SCAN.md}`.
6. Unless `--no-push`: approval `git-push` (branch name, remote) → push → approval `pull-request` →
   PR "OpsCrew: prepare the app for deployment" with body listing changes, scan summary, review
   checklist and "Opened by OpsCrew".
7. Update `plan.codeChanges[].status`, write plan, mark phase.

Git and GitHub operations come from `@opscrew/connector-github` (implemented in feature 002's task
list but scheduled in the same wave as adapt; adapt depends on it).

### MCP server and plugin

- Server built with `McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk` (check the
  installed type definitions). Each tool: `title`, `description`, `inputSchema` (zod shape) with
  `projectDir` (absolute; defaults to the server's cwd), `annotations` (`readOnlyHint` for detect/
  questions/options/status; `destructiveHint: false` for writes of artefacts, including the scan,
  which writes its two reports and is `idempotentHint: true`), returns text
  plus `structuredContent`. Errors → `isError: true` with the user-facing message and hint.
- Plugin layout and marketplace format per research.md (verified against current Claude Code docs).
  Skills tell the agent to always use OpsCrew tools for infrastructure, never run `tofu`/
  `terraform`/`hcloud` directly, never print secrets, and ask the user to approve plans.

## Complexity Tracking

| Deviation from the approved plan | Why | Simpler alternative rejected because |
|---|---|---|
| New package `@opscrew/detect` | shared by scan, analyze, MCP | duplicating detection in three places breaks consistency |
| Interviewer is a deterministic question bank (no model) | cheaper, testable, works without a key | a model adds cost and variance for a fixed set of questions |
| Analyst defaults to Haiku 5.5 | approved plan: Haiku for file walking | Opus is ~40× the price for the same file reading |
| Policies and secrets in TS instead of Conftest/SOPS (see 002 research) | fewer binaries for vibe coders | Rego/SOPS can be added later behind the same interfaces |
