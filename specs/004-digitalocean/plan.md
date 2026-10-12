# Implementation Plan: DigitalOcean Droplets

**Branch**: `mvp` | **Date**: 2026-10-12 | **Spec**: `specs/004-digitalocean/spec.md` |
**Research**: `specs/004-digitalocean/research.md`

## Summary

DigitalOcean becomes the second VPS provider with the topology OpsCrew already uses on Hetzner
(one server, Docker Compose, Caddy, cloud firewall, deploy key, GitHub Actions over SSH). The
provider is chosen in the interview and recorded in requirements and `plan.target.provider`. A
provider-neutral seam (a VPS connector contract and an agents-side provider profile) replaces the
places that import Hetzner directly. Hetzner behaviour and rendered files stay unchanged.

## Technical Context

Same stack as 000–003. New workspace package `@opscrew/connector-digitalocean` (dependencies:
`@opscrew/contracts`, `@opscrew/core`, `zod`, as the Hetzner connector). New Terraform provider
`digitalocean/digitalocean ~> 2.106` in the generated HCL only. No new third-party runtime
dependency.

## Constitution Check

- I (safety gate): provisioning and destroy keep plan → policy → approval bound to the plan hash →
  apply. DigitalOcean has no delete protection, so the destroy flow has one plan fewer; the
  `allowDestroy` approval and the typed server name still guard the destroy plan, and the preview
  says that the provider offers no extra protection. The snapshot is a typed adapter call inside
  the confirmed flow.
- II (user owns everything): the DigitalOcean module is vendored into `opscrew/infra/modules/`.
  The provider choice is the user's; DigitalOcean's referral programme is not used and never
  affects ranking.
- III (dual engine): the module stays in the common HCL subset and is validated by both engines.
- IV (secrets): the token comes from the environment, is registered with the redactor, never
  reaches tfvars or state (the provider reads it from the environment); `dop_v1_` tokens are
  redacted by value and flagged by `opscrew scan`.
- VI (contracts first): `ServerSnapshotApi`, `VpsConnector` and the schema enums are lead-owned
  (T401, ADR 0006); each task owns one package or one agents area.
- VIII (typed adapters): every DigitalOcean API mutation (only the snapshot action) goes through
  the new connector; infrastructure through the IaC engine.
- X (simplicity): no reserved IPs, projects, volumes, VPC settings or DigitalOcean DNS.

## Project Structure

```text
packages/contracts/src/connector.ts                    # T401: VpsProviderId, AppServer, SnapshotRequest,
                                                       #       ServerSnapshotApi, VpsConnector
packages/plan-schema/src/{enums,plan,design,requirements,questions}.ts (+ JSON Schemas)  # T401
packages/core/src/testing/fake-secrets.ts              # T401: fakeSecret("digitalocean-token")
packages/connectors/digitalocean/**                    # T401 skeleton, T402 implementation
packages/connectors/hetzner/src/**                     # T403
packages/iac-templates/{modules,src,scripts}/**        # T404
packages/agents/src/providers/**                       # T405 (lead): profiles, vpsConnector
packages/agents/src/provision/{types,credentials}.ts   # T405 (lead): services.provider rename
packages/secops/src/**, packages/core/src/redact.ts    # T406
packages/agents/src/design/**                          # T407
packages/agents/src/{provision,drift,init,secure,verify,dns,shared}/**   # T408
packages/agents/src/destroy/**, packages/cli/src/ui/__fixtures__/destroy.ts  # T409
packages/agents/src/interview/**                       # T410
packages/cli/src/**, packages/cli/test/e2e/**          # T411
packages/mcp-server/src/**, plugin/**, README.md       # T412
packages/cli/test/live/**, docs/e2e.md                 # T413 (lead)
docs/adr/0006-vps-provider-seam.md                     # T401 (lead)
```

## Design

### Contracts and schemas (T401, lead)

`packages/contracts/src/connector.ts`:

```ts
/** VPS providers OpsCrew deploys to in `vps-compose` mode. */
export type VpsProviderId = Extract<ProviderId, "hetzner" | "digitalocean">;

/** A server OpsCrew created for an app, as the provider reports it. */
export interface AppServer {
  /** Provider id as a string (both providers use numbers on the wire). */
  id: string;
  name: string;
  /** Provider status, for example `running` (Hetzner) or `active` (DigitalOcean). */
  status: string;
}

export interface SnapshotRequest {
  /** Snapshot name shown in the provider console (DigitalOcean) or used as its description. */
  name: string;
  description: string;
  /** Applied where the provider supports labels on images (Hetzner); otherwise ignored. */
  labels: Record<string, string>;
  /** Give up waiting after this long (default 15 minutes). */
  timeoutMs?: number;
}

/** Server lookup and snapshots, used before a teardown. */
export interface ServerSnapshotApi {
  /** Servers labelled or tagged as created by OpsCrew for `app`. */
  findAppServers(app: string): Promise<AppServer[]>;
  /** Snapshots the server and resolves when the provider reports it complete. */
  snapshotServer(serverId: string, request: SnapshotRequest): Promise<{ snapshotId: string }>;
}

/** A VPS provider connector: credentials, catalogue and server API. */
export interface VpsConnector extends Connector {
  readonly id: VpsProviderId;
  /** True when a token is set (it may still be invalid). */
  readonly configured: boolean;
  catalog(): ComputeCatalog;
  /** Undefined when no token is set. */
  readonly servers: ServerSnapshotApi | undefined;
}
```

`packages/plan-schema`: `VpsProviderSchema = z.enum(["hetzner", "digitalocean"])` in `enums.ts`;
`plan.target.provider` and `DesignOption.target.provider` use it; `plan.target.backups` comment
becomes provider-neutral; `RequirementsSchema.provider` optional; question id `provider`
(an interview placeholder description keeps `agents` compiling until T410); JSON Schemas
regenerated. `fakeSecret("digitalocean-token")` returns `dop_v1_` + 64 lowercase hex characters
derived from the seed. The DigitalOcean package skeleton (package.json, tsconfig, `src/index.ts`
exporting nothing yet), the dependency in `agents` and `cli`, and the lockfile. ADR 0006 records
the seam (connector contract, provider profile, provider fixed for a live deployment until
`retarget`).

### DigitalOcean connector (T402)

- `DigitalOceanClient({ token, fetch?, baseUrl = "https://api.digitalocean.com", sleep?, now? })`:
  `getAccount()`, `listSizes()` (all pages, `per_page=200`), `listRegions()`,
  `listDropletsByTag(tag)`, `snapshotDroplet(id, name)` → action, `getAction(id)`,
  `waitForAction(id, { timeoutMs, pollMs = 5000 })` (errored → error), `listDropletSnapshots(id)`.
  `Authorization: Bearer`, JSON, zod `looseObject` validation of every response.
- Errors are `OpsCrewError` with plain English and never the token: 401 → invalid token; 403 →
  missing scope (with the scope list from research.md); 404; 422 → the API message; 429 → wait
  until `ratelimit-reset` (epoch seconds, at most 60 s), retry once, then a `PROVIDER_ERROR`
  saying the rate limit was reached; network errors → a `PROVIDER_ERROR` that suggests retrying.
- `DigitalOceanCatalog implements ComputeCatalog` (`provider: "digitalocean"`):
  - locations from regions that are available and offer Droplet sizes, with names and countries
    from a small table (`fra1` Frankfurt DE, `ams3` Amsterdam NL, `lon1` London GB, `nyc1/nyc3`
    New York US, `sfo3` San Francisco US, `tor1` Toronto CA, `sgp1` Singapore SG, `blr1`
    Bangalore IN, `syd1` Sydney AU, `atl1` Atlanta US, others by slug);
  - offers: Basic regular sizes (`description` "Basic", slug `s-<n>vcpu-<m>gb`, memory ≥ 1 GiB)
    as `shared`, CPU-Optimized sizes (`description` "CPU-Optimized", slug `c-<n>`) as
    `dedicated`; x86; only `available` sizes listed for the location; USD monthly and hourly;
    `includedTrafficTb` from `transfer`; `pricesIncludeVat: false`; `source: "live"`;
  - `extras(location)`: `backupPercent: 30`, no separate IPv4 cost, `trafficPerTb` USD 10.24,
    `pricesIncludeVat: false`.
- `StaticDigitalOceanCatalog` from the dated table in research.md (`STATIC_PRICES_AS_OF`
  `2026-10-12`), all Droplet regions, `source: "static"`.
- `digitaloceanConnector({ env, fetch?, redactor?, baseUrl?, sleep?, now? })` →
  `VpsConnector & { client: DigitalOceanClient | undefined }`; `DIGITALOCEAN_CREDENTIALS`
  (`envVars` `["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"]`, the custom scopes from
  research.md, `createUrl` the token page); the token registered with the redactor;
  `verifyCredentials()` from the account: `active` → ok, `warning` → ok with the status message,
  `locked` or unverified email → not ok with the fix; `identity` is the team name or
  "personal account" (never the email address); `catalog()` live with a token, static without;
  `servers`: `findAppServers(app)` lists Droplets tagged `opscrew-app:<app>` that also carry
  `managed-by:opscrew`; `snapshotServer(id, request)` starts the snapshot action with
  `request.name`, waits, then finds the snapshot by name among the Droplet's snapshots (newest
  first) and returns its id as a string; `tools()` read-only `digitalocean_list_locations` and
  `digitalocean_list_offers`, mirroring Hetzner's.
- Fixtures: JSON documents shaped like the OpenAPI examples, a fake fetch with call recording.

### Hetzner connector (T403)

`hetznerConnector` gains `configured` and `servers` (an adapter over `HetznerClient`:
`findAppServers` with label selector `managed-by=opscrew,app=<app>`; `snapshotServer` →
`createSnapshot(id, { description: request.description, labels })` + `waitForAction` (timeout
from the request, default 15 min); the image id returned as a string) and satisfies
`VpsConnector`. Nothing else changes.

### Templates (T404)

- `modules/digitalocean-droplet/`: `versions.tf` (`>= 1.6.0`, `digitalocean ~> 2.106`),
  `variables.tf` (`name`, `region`, `size`, `image`, `backups`, `ssh_public_key`,
  `ssh_allowed_cidrs`, `http_allowed_cidrs`, `app_tag`, `shared_tags`), `main.tf`:
  - `digitalocean_tag.app` for `var.app_tag` only (the app's own tag, deleted with the app);
    `var.shared_tags` (`managed-by:opscrew`) are applied as plain names and never managed as
    resources, because deleting a DigitalOcean tag removes it from every resource in the account
    (other OpsCrew apps included); the Droplet create call creates a missing tag;
  - `digitalocean_ssh_key.deploy` (`"${var.name}-deploy"`);
  - `digitalocean_droplet.this`: name, region, size, image, `backups`, a `backup_policy`
    block (`plan = "daily"`, `hour = 4`) only when backups are on, `ipv6 = true`,
    `monitoring = true`, `ssh_keys = [fingerprint]`, `user_data` from the shared cloud-init
    template, `tags` = the app tag resource's name plus `var.shared_tags`, `lifecycle { ignore_changes = [user_data, image,
    ssh_keys] }` (as on Hetzner);
  - `digitalocean_firewall.this`: `droplet_ids = [droplet.id]`; inbound 22/tcp from
    `ssh_allowed_cidrs`, 80/tcp, 443/tcp and 443/udp from `http_allowed_cidrs`, icmp from
    everywhere; outbound tcp and udp `1-65535` and icmp to `0.0.0.0/0` and `::/0`;
  - `outputs.tf`: `ipv4_address`, `ipv6_address`, `server_id` (string), `server_name`.
- One cloud-init template: `hetzner-vps/cloud-init.yaml.tftpl` stays the source; the DigitalOcean
  module carries an identical copy and a test fails when they differ.
- Root module by `plan.target.provider`: `versions.tf` (hcloud or digitalocean, plus cloudflare
  when used), `main.tf` (provider block with the right token comment, module source, `region =
  var.location`, `size = var.server_type`, `app_tag = "opscrew-app:${var.app_name}"`,
  `shared_tags = ["managed-by:opscrew"]`), `variables.tf` (descriptions per provider; no
  `delete_protection` for DigitalOcean), the same outputs, and only the modules the plan uses
  vendored. Hetzner output is byte-identical (existing snapshots unchanged).
- Runbook: a small provider text table inside `iac-templates` (console link, "server" or
  "Droplet", backups wording and retention, delete protection or its absence, snapshot billing,
  teardown notes); Hetzner text unchanged.
- The existing gated validate test covers the DigitalOcean root under both engines.

### Provider seam (T405, lead, after T402 and T403)

`packages/agents/src/providers/`:

```ts
export interface ProviderProfile {
  id: VpsProviderId;
  displayName: string;            // "Hetzner Cloud" | "DigitalOcean"
  serverNoun: string;             // "server" | "Droplet"
  tokenVars: readonly string[];
  tokenUrl: string;
  consoleUrl: string;
  serverResourceType: string;     // hcloud_server | digitalocean_droplet
  firewallResourceType: string;   // hcloud_firewall | digitalocean_firewall
  deleteProtection: boolean;      // true | false
  defaultImage: string;           // ubuntu-24.04 | ubuntu-24-04-x64
  currency: "EUR" | "USD";
  backupPercent: number;          // 20 | 30
  backupsOutliveServer: boolean;  // false | true (kept up to four weeks)
  regionLocations: Record<Region, readonly string[]>;
  locationNames: Readonly<Record<string, string>>;
  /** Why a region maps to a location outside it (DigitalOcean eu-north → ams3). */
  regionNotes: Partial<Record<Region, string>>;
  /** Provider error text meaning the size is unavailable or out of stock in the location. */
  unavailable: RegExp;
  /** Provider error text meaning the account reached its server limit. */
  serverLimit: RegExp;
}
export function providerProfile(id: VpsProviderId): ProviderProfile;
export function planProvider(plan: DeployPlan): VpsProviderId;
export function requestedProvider(requirements: Requirements | undefined): VpsProviderId;
/** The provider whose token is set when exactly one is. */
export function providerFromTokens(env: Env): VpsProviderId | undefined;
export function vpsConnector(
  id: VpsProviderId,
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
  options?: { sleep?: (ms: number) => Promise<void>; now?: () => Date },
): VpsConnector;
```

Region locations: Hetzner as today; DigitalOcean `eu-central` → `fra1`, `ams3`; `eu-north` →
`ams3` (note: no Nordic data centre); `us-east` → `nyc3`, `nyc1`, `atl1`; `us-west` → `sfo3`;
`ap-southeast` → `sgp1`. Also in T405: `ProvisionServices.hetzner` becomes `provider`
(`{ configured; verify() }`) and `checkHetzner` becomes `checkProvider(deps, plan, services)`
built on `vpsConnector`; every test and fixture using the old key is updated (agents, CLI deploy
fixture, MCP deploy test).

### Security checks (T406)

- Plan policies (`secops/src/policies/plan.ts`) for DigitalOcean: each `digitalocean_droplet` has
  a `digitalocean_firewall` whose `droplet_ids` reference it (configuration references when the id
  is unknown), `ssh_keys` set, SSH not open to the world unless the plan says so, backups as
  planned; Hetzner rules unchanged.
- Secret rule and redactor value pattern for DigitalOcean tokens `do[por]_v1_[0-9a-f]{64}`
  (personal, OAuth, refresh); hardening and probe texts name the provider's console.

### Design (T407)

`resolveCatalog(provider)` via `vpsConnector(provider).catalog()` with the static fallback and
warning per provider; region locations and notes from the profile; option ids
`<provider>-single-<size>-<location>`; titles, summaries and token hints name the provider;
`plan.target` gets `provider` and the profile's `defaultImage`; costs in the catalogue currency
with backups at the extras' percentage (profile fallback); the existing fixed EUR/USD rate for
budget comparison, labelled approximate; design stops (`PHASE_PRECONDITION`, nothing written)
when the plan has a live deployment (`deployment.serverIpv4` or `deployment.lastApplyAt` set, or
a non-empty state file, and no `destroyedAt`, since an apply that failed before recording the
address can leave resources; provision clears `destroyedAt` before it applies) and the requested
provider differs; the MCP design preview shows the same stop as a warning.

### Provision, drift, init, secure, verify (T408)

Profile-driven texts and error mapping: unavailable size/location and server-limit hints,
"<displayName> and Cloudflare" labels, console links in hints, PR body wording. Init: one
provider check (id `provider`) titled by the planned or requested provider, or by the provider
whose token is set, or "Cloud provider token" when none (fail; the fix names both); online check
through `verifyCredentials()`; offline presence only; the other provider's token is never
checked; a working token on a locked or unverified account points to the account page
(`profile.accountUrl`). The check id `provider` replaces 003's `hetzner`. Drift, secure and
verify use `checkProvider` and profile texts only; `DriftReport.provider` (optional, absent in
reports from before this feature) lets the renderer name the provider's console. USD prices are
labelled "excl. tax", EUR prices "excl. VAT".

### Destroy (T409)

`DestroyServices.hetznerClient` becomes `servers?: ServerSnapshotApi` (default
`vpsConnector(planProvider(plan)).servers`). With `deleteProtection: false` there is no
protection-lifting plan and no `delete_protection` variable guard, and the preview reports that
the provider has no delete protection. `deletesServer()` and the data warning use the profile.
The snapshot uses `findAppServers` / `snapshotServer` (name `opscrew-<app>-before-destroy-<UTC
time>`, Hetzner labels as today) of the server the confirmed destroy plan deletes (its
`change.before.id`; the name is used only when the plan has no id and exactly one server has
that name; anything ambiguous stops before a change); the reuse record
`.opscrew/destroy-snapshot.json` stores `{ provider, serverId, snapshotId, takenAt }` as strings
and still reads a 003 record with a numeric image id. The destroy plan must delete the same
server id that was confirmed. `DestroyResult.snapshotImageId`
becomes `snapshotId: string`. The final report mentions retained DigitalOcean backups and each
provider's snapshot billing. Hetzner tests keep their meaning.

### Interview (T410)

Region labels are provider-neutral (the server goes to the chosen provider's closest data
centre). Question `provider` (single-select, required, placed before `region`): "Where should OpsCrew run
your app?" with options Hetzner Cloud (hint: lowest prices; Germany, Finland, US, Singapore) and
DigitalOcean (hint: use your DigitalOcean account; data centres in Germany, the Netherlands, the US and Singapore; prices in USD). Default and
inference: previous answer, else `providerFromTokens(env)`, else `hetzner`; non-interactive
answers files may set `provider`; the value is always written.

### CLI, MCP, plugin, docs (T411, T412)

Provider-neutral help and messages (`--snapshot` "Take a snapshot of the server first"), init
titles from the agents, the end-to-end suite gains a DigitalOcean run of one example with fakes
(DigitalOcean resource addresses in the fake engine), MCP texts and a DigitalOcean init-check
test, plugin skill and keywords, README provider line.

### Live test (T413, lead)

`packages/cli/test/live/live.test.ts` runs the existing flow for each provider whose
`OPSCREW_E2E_*` token is set (`OPSCREW_E2E_DIGITALOCEAN_TOKEN`, optional
`OPSCREW_E2E_REGION`, the interview region, default `eu-central`; the recommended design), tears down with
`opscrew destroy --confirm <name> --no-snapshot`, and falls back to API cleanup by the
`opscrew-app:<name>` tag. It also confirms the items marked "confirm live" in research.md.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| Two copies of the cloud-init template | Vendored modules must be self-contained in the user's repository | A shared path outside the module breaks the "user owns the module" rule; a test keeps the copies identical |
| Destroy has one plan fewer on DigitalOcean | The provider has no delete protection | Emulating protection with `prevent_destroy` cannot be switched by a variable and would require editing committed files during destroy |
