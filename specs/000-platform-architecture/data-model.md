# Data Model: OpsCrew artefacts and local state

All schemas live in `@opscrew/plan-schema` (zod 4). Types are inferred with `z.infer`. Every
persisted artefact carries `schemaVersion: 1`. Enumerations below are exhaustive for v1.

Conventions:
- Paths inside artefacts are repo-relative POSIX paths (`apps/web/Dockerfile`), never absolute.
- Timestamps are ISO-8601 UTC strings (`z.iso.datetime()`).
- `Money` = `{ amount: number (>= 0, finite), currency: "EUR" | "USD" }`.
- Objects are strict (`z.strictObject`) unless stated, so typos in hand-edited YAML are caught.
- Optional fields are omitted when absent (never `null`).

## Shared enums (`src/enums.ts`)

| Name | Values |
|---|---|
| `Language` | `javascript`, `typescript`, `python`, `go`, `ruby`, `php`, `java`, `rust`, `other` |
| `PackageManager` | `npm`, `pnpm`, `yarn`, `bun`, `pip`, `poetry`, `uv`, `pipenv`, `none` |
| `AppKind` | `static-spa`, `ssr`, `api`, `fullstack`, `worker`, `unknown` |
| `PlatformExport` | `lovable`, `bolt`, `replit`, `v0`, `base44`, `none` |
| `ServiceKind` | `postgres`, `mysql`, `mongodb`, `redis`, `sqlite`, `supabase`, `firebase`, `s3`, `stripe`, `email`, `queue`, `websocket`, `cron` |
| `Region` | `eu-central`, `eu-north`, `us-east`, `us-west`, `ap-southeast` |
| `UserScale` | `<1k`, `1k-10k`, `10k-100k`, `>100k` (monthly active users) |
| `Uptime` | `best-effort`, `standard`, `high` |
| `DataCriticality` | `none`, `important`, `critical` |
| `CodeChangeKind` | `dockerfile`, `dockerignore`, `health-endpoint`, `port-config`, `env-example`, `build-config`, `secret-removal`, `other` |
| `CodeChangeStatus` | `pending`, `applied`, `skipped` |

`PhaseName` comes from `@opscrew/contracts` (`PHASES`).

## ProjectFacts (`src/facts.ts`) — produced by `@opscrew/detect`

| Field | Type | Notes |
|---|---|---|
| `name` | string (1..100) | from package.json / pyproject / directory name |
| `languages` | `Language[]` | unique, sorted |
| `packageManager` | `PackageManager` | |
| `frameworks` | `{ name: string; version?: string; path: string }[]` | `path` = directory, `.` for root |
| `appKind` | `AppKind` | |
| `platformExport` | `{ platform: PlatformExport; evidence: string[] }` | evidence like `devDependency:lovable-tagger` |
| `build` | `{ installCommand?, buildCommand?, startCommand?, outputDir? }` (strings) | |
| `port` | int 1..65535, optional | listening port detected or declared |
| `runtimeVersions` | `{ node?: string; python?: string }` | |
| `envVars` | `{ name: string; files: string[]; clientExposed: boolean; secretLikely: boolean }[]` | names only, never values; sorted by name |
| `services` | `{ kind: ServiceKind; evidence: string[] }[]` | unique by kind |
| `docker` | `{ dockerfile?: string; compose?: string; dockerignore?: string }` | repo-relative paths |
| `healthEndpoint` | string starting with `/`, optional | |
| `monorepo` | boolean | |
| `git` | `{ remoteUrl?, owner?, repo?, defaultBranch?, currentBranch? }` | `remoteUrl` MUST have userinfo stripped |

## Architecture — `opscrew/architecture.json` (`src/architecture.ts`)

| Field | Type |
|---|---|
| `schemaVersion` | literal `1` |
| `generatedAt` | datetime |
| `generator` | `{ tool: "opscrew"; version: string }` |
| `facts` | `ProjectFacts` |
| `summary` | string — plain-English description of the app (deterministic template or model-written) |
| `risks` | string[] — deployment risks in plain English |
| `aiEnriched` | boolean — true when a model refined the summary/risks |

## Requirements — `opscrew/requirements.yaml` (`src/requirements.ts`)

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | literal `1` | |
| `answeredAt` | datetime | |
| `expectedMonthlyUsers` | `UserScale` | |
| `budgetMonthly` | `Money` | amount > 0 |
| `region` | `Region` | |
| `uptime` | `Uptime` | |
| `dataCriticality` | `DataCriticality` | |
| `domain` | FQDN string, optional | lower-case; e.g. `app.example.com` |
| `dnsProvider` | `cloudflare` \| `other` \| `none` | `cloudflare` or `other` requires `domain` |
| `keepExternalServices` | `ServiceKind[]` | e.g. keep `supabase` instead of self-hosting Postgres |
| `contactEmail` | email, optional | used for TLS certificate registration |
| `notes` | string, optional | free text from the user |

## Interview question (`src/interview.ts`) — not persisted, returned by MCP/CLI

| Field | Type |
|---|---|
| `id` | requirements field key, e.g. `expectedMonthlyUsers` |
| `prompt` | plain-English question |
| `help` | optional explanation |
| `kind` | `single-select` \| `multi-select` \| `text` \| `money` \| `confirm` |
| `options` | `{ value: string; label: string; hint?: string }[]`, for select kinds |
| `default` | optional default value (same type as the answer) |
| `required` | boolean |

## Cost estimate and design option (`src/design.ts`) — option not persisted

`CostEstimate`: `{ monthly: Money; breakdown: { item: string; monthly: Money }[];
pricesIncludeVat: boolean; source: "live" | "static"; asOf: datetime }`. The sum of `breakdown`
amounts equals `monthly.amount` (rounded to 2 decimals); all currencies equal.

`DesignOption`:

| Field | Type |
|---|---|
| `id` | string, e.g. `hetzner-single-cpx22-nbg1` |
| `title`, `summary` | plain-English strings |
| `target` | `{ provider: "hetzner"; location: string; serverType: string; vcpus: number; memoryGb: number; diskGb: number; cpuType: "shared" \| "dedicated"; architecture: "x86" \| "arm" }` |
| `services` | `{ postgres: boolean; redis: boolean }` — self-hosted containers |
| `externalServices` | `ServiceKind[]` |
| `backups` | boolean |
| `cost` | `CostEstimate` |
| `fitsBudget` | boolean |
| `recommended` | boolean (exactly one option per list is recommended) |
| `tradeoffs` | string[] |

## Deploy plan — `opscrew/plan.yaml` (`src/plan.ts`)

| Field | Type / default | Notes |
|---|---|---|
| `schemaVersion` | literal `1` | |
| `createdAt`, `updatedAt` | datetime | |
| `app.name` | string, DNS-label safe (`^[a-z0-9][a-z0-9-]{0,40}$`) | used for resource names |
| `app.port` | int 1..65535 | container port |
| `app.healthPath` | string starting with `/`, default `/health` | |
| `app.buildContext` | string, default `.` | |
| `app.dockerfile` | string, default `Dockerfile` | |
| `app.env` | `{ name: string; secret: boolean; source: "user" \| "generated" \| "derived" }[]` | names only, never values |
| `target.provider` | literal `hetzner` | v1 |
| `target.mode` | literal `vps-compose` | v1 |
| `target.location` | string, e.g. `nbg1` | |
| `target.serverType` | string, e.g. `cpx22` | |
| `target.image` | string, default `ubuntu-24.04` | |
| `target.backups` | boolean | Hetzner automated backups |
| `services` | `{ postgres: boolean; redis: boolean }` | |
| `externalServices` | `ServiceKind[]` | |
| `cost` | `CostEstimate` | |
| `codeChanges` | `{ id: string; kind: CodeChangeKind; path: string; reason: string; status: CodeChangeStatus }[]` | |
| `infra.engine` | `auto` \| `tofu` \| `terraform`, default `auto` | |
| `infra.dir` | string, default `opscrew/infra/prod` | |
| `infra.stateEncryption` | boolean, default `true` | effective only with OpenTofu |
| `dns.provider` | `cloudflare` \| `none` | |
| `dns.domain` | FQDN, optional | required when provider is `cloudflare` |
| `dns.zone` | string, optional | registrable zone, e.g. `example.com` |
| `dns.proxied` | boolean, default `true` | |
| `dns.www` | boolean, default `false` | also serve `www.<domain>` |
| `cicd.provider` | literal `github-actions` | |
| `cicd.workflowPath` | string, default `.github/workflows/opscrew-deploy.yml` | |
| `cicd.registry` | literal `ghcr` | |
| `cicd.branch` | string, default `main` | deploys run on pushes to this branch |
| `security.sshAllowedCidrs` | string[] (valid CIDRs), default `["0.0.0.0/0", "::/0"]` | |
| `security.httpAllowedFrom` | `any` \| `cloudflare`, default `cloudflare` when proxied else `any` | |
| `security.wafCustomRules` | boolean, default `true` | |
| `security.imageScan` | boolean, default `true` | |
| `approvals` | `{ planHash: string (64 hex); approver: string; at: datetime; kind: string }[]`, default `[]` | informational copy |
| `deployment` | `{ url?: string (domain URLs only); lastPlanHash?: string; lastApplyAt?: datetime; firstDeployAt?: datetime }`, default `{}` | the server address is not here: `.opscrew/server.json` (feature 008, ADR 0010); `firstDeployAt` is set once, by the first passing verify (014, T1414d) |

Cross-field rules (`superRefine`):
- `dns.provider === "cloudflare"` ⇒ `dns.domain` present.
- `services.postgres` ⇒ `externalServices` does not contain `postgres` or `supabase`.
- `cost.breakdown` sums to `cost.monthly.amount` (tolerance 0.01).

## Read/write helpers (`src/io.ts`)

```ts
type ArtifactKind = "architecture" | "requirements" | "plan";
function parseArtifact<K extends ArtifactKind>(kind: K, text: string, file: string): ArtifactOf<K>;
function serializeArtifact<K extends ArtifactKind>(kind: K, value: ArtifactOf<K>): string;
async function readArtifact<K extends ArtifactKind>(kind: K, file: string): Promise<ArtifactOf<K>>;
async function writeArtifact<K extends ArtifactKind>(kind: K, file: string, value: ArtifactOf<K>): Promise<void>;
class ArtifactError extends Error { code: "ARTIFACT_INVALID" | "ARTIFACT_MISSING"; file: string; issues: { path: string; message: string }[]; hint: string }
```

- `architecture` is JSON (2-space indent, trailing newline); `requirements` and `plan` are YAML
  with a first-line comment `# Generated by OpsCrew (schema v1). Validated on every read.`
- Serialisation validates first (never writes invalid data), is deterministic (same value →
  same bytes) and uses LF line endings. Parsing strips a UTF-8 BOM and accepts CRLF.
- `writeArtifact` creates parent directories and writes atomically (temp file + rename).
- `ArtifactError.hint` per kind: architecture → "Run `opscrew analyze` to regenerate it.";
  requirements → "Run `opscrew interview` to answer the questions again.";
  plan → "Run `opscrew design` to regenerate the plan, or fix the field shown above."
- Issue paths are dotted (`target.serverType`, `codeChanges.2.path`).

## JSON Schema export (`src/json-schema.ts`, `scripts/gen-schemas.ts`)

`toJsonSchemas(): Record<ArtifactKind, object>` via `z.toJSONSchema(schema, { target: "draft-7", io: "input" })`
(input mode: fields with defaults are optional, matching what `readArtifact` accepts; output mode would
reject the transform that defaults `security.httpAllowedFrom`).
`pnpm --filter @opscrew/plan-schema gen:schemas` writes `schemas/<kind>.schema.json` (2-space JSON,
trailing newline). A test fails if the committed files differ from freshly generated output.

## Local state (`@opscrew/core`)

| File | Format | Owner |
|---|---|---|
| `.opscrew/.gitignore` | `*` | `ensureStateDir()` |
| `.opscrew/state.json` | `{ schemaVersion: 1, phases: { [PhaseName]: { status: "ok" \| "failed" \| "skipped"; at: datetime; summary?: string } }, updatedAt?: datetime }` | `ProjectStateStore` |
| `.opscrew/approvals.jsonl` | one `ApprovalRecord` per line | `JsonlApprovalStore` |
| `.opscrew/costs.jsonl` | `{ at, phase, model?, costUsd }` per line | `CostLedger` |
| `.opscrew/plans/<hash>.tfplan` | engine plan files | feature 002 |
| `.opscrew/tfstate/prod.tfstate` | engine state (encrypted with OpenTofu) | feature 002 |
| `~/.opscrew/audit/YYYY-MM-DD.jsonl` | one `AuditEntry` per line (UTC date) | `JsonlAuditLog` |
| `~/.opscrew/projects/<projectId>/` | deploy key, known_hosts, state passphrase (mode 0600) | feature 002 |
