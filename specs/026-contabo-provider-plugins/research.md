# 026 research: Contabo, opening with the provider plugin system

Research for [026 in the roadmap](../roadmap.md#026-contabo-opening-with-the-provider-plugin-system),
started on the founder's go-ahead of 2026-11-11. Official sources only; anything not read on an
official page is marked *unverified*.

## R1. Where provider code lives today (code map)

Read 2026-11-11 from the working tree at `ac314cac`. The counts are lines or files that mention a
provider id outside tests, so they are upper bounds (the word "own" is noisy).

**The ids.**
- In `@opscrew/contracts` (`connector.ts`): `ProviderId` (hetzner, cloudflare, github,
  digitalocean, own, portainer) and `VpsProviderId` (hetzner, digitalocean, own).
- In `@opscrew/plan-schema` (`enums.ts`):
  - `VpsProviderSchema`;
  - `CloudProviderSchema` (the VPS ones minus `own`);
  - `ServerlessProviderSchema`;
  - `DeployProviderSchema` (VPS, plus portainer, localhost and serverless).

  These are generated into `schemas/*.schema.json`.
- Own lists elsewhere:
  - the MCP placement tool's enum;
  - `retarget`'s `SERVERS`;
  - the snapshot off-server choices;
  - the interview's provider question;
  - `PROFILES`;
  - the object-storage provider enums (r2, hetzner, digitalocean, garage).
- No `contabo`, `aws`, `gcp` or `azure` id is left in the code (ADR 0013 removed them).

**What varies per cloud provider (Hetzner and DigitalOcean) today, and where:**
- **API access:** the connector packages `@opscrew/connector-hetzner` and `-digitalocean`.
  - They implement `VpsConnector` (`contracts/connector.ts`): credentials, `verifyCredentials`, a
    catalog (`listOffers`, `extras`: IPv4, backups, snapshot price, VAT, live or static,
    `asOf`), and `ServerSnapshotApi` (find the app's servers, snapshot, list, delete, rebuild,
    power off and on).
  - Each has its dated static price table (Hetzner 2026-10-14, DigitalOcean 2026-10-12).
  - Each reads its token and adds it to the redactor.
- **The profile:** `agents/src/providers/profiles.ts` `ProviderProfile`. It holds:
  - the token variables and console URLs;
  - the Terraform resource types of the server and firewall;
  - delete protection and the default image;
  - the currency and backup percent, and whether backups outlive the server;
  - the regions and location names;
  - the error patterns for "unavailable" and "server limit";
  - the attributes the provider mirrors.

  `vpsConnector` (`providers/connector.ts`) is a switch that picks the connector.
- **Infrastructure code:** `iac-templates/src/providers.ts` `PROVIDER_TEXT`.
  - It holds the module name, the Terraform provider and its pin, the token variable, delete
    protection, the module arguments, the shared resources (the SSH key, DigitalOcean's tag) and
    the runbook text.
  - The HCL lives in `modules/hetzner-vps` and `modules/digitalocean-droplet`, which share
    `cloud-init.yaml.tftpl` through `scripts/gen-modules.ts`. That script generates
    `src/generated/modules.ts`.
  - `infra/servers.ts` `SHARED_RESOURCES`.
- **Object storage:** `infra/storage.ts` (endpoints) and `prices.ts` (prices).
- **Smaller tables:**
  - `design/delay.ts` (location coordinates);
  - `design/storage.ts` (storage locations);
  - `design/wording.ts`;
  - `destroy/texts.ts` and `destroy/storage.ts` (console names);
  - `provision/plan-apply.ts` `PROVIDER_API` (which 403 blames the token);
  - `init/checks.ts` (token help).
- **SecOps:** `secops/policies/plan.ts` reads each provider's firewall and server resources from
  the plan, and `secops/rules/secrets.ts` has a rule for each provider's token format.
- **Elsewhere:** `core/redact.ts` (DigitalOcean's token format) and `detect/env.ts` (variable
  prefixes).
- **What users see:** the interview's options, `retarget`'s flags, the MCP placement tool, the
  `opscrew-deploy` and `opscrew-snapshots` skills, the docs pages (object storage, snapshots,
  retarget and others), and the live tests (`packages/cli/test/live/live.test.ts` and the
  Hetzner-only checks).

**Most branches are on the kind of target, not on the cloud.**
- The matching lines: agents 563, cli 69, iac-templates 59, mcp-server 30, plan-schema 24,
  connectors 15, detect 9, secops 7.
- Most of them choose between a cloud server, the user's own server, a Portainer, the user's
  computer and the serverless hosts: different flows, wording and refusals.
- Own server and Portainer are kinds of target with flows of their own:
  - host plans through `@opscrew/connector-ssh-host`;
  - stack plans through `@opscrew/connector-portainer`;
  - their own interview questions, design options, destroy, drift, logs and tools.

  They are mentioned in about 100 and 125 files of `agents`. `own` has a thin `VpsConnector`
  (`providers/own.ts`) so that pricing and design can treat it as a server.

**The CLI, the MCP server and the Claude Code plugin.**
- **The CLI:** tsup bundles `packages/cli` into one file, `dist/opscrew.js`, with every
  `@opscrew/*` package inside. Every connector is imported statically.
  - It already installs one thing when first needed: `runtime-claude/src/sdk.ts` asks, then
    installs the pinned Claude Agent SDK with npm and no install scripts into
    `~/.opscrew/claude-agent-sdk`. It loads it with `createRequire(...).resolve` and `import()`
    of the file URL.
- **The MCP server:** its tools are shared. The provider is a parameter (the placement tool's
  enum) or a branch, and only Portainer has tools of its own.
- **The Claude Code plugin:**
  - `.claude-plugin/marketplace.json` lists one plugin, `./plugin`.
  - Its `.mcp.json` runs `node ${CLAUDE_PLUGIN_ROOT}/node_modules/opscrew/dist/opscrew.js mcp`
    from the `opscrew` npm package the plugin depends on.
  - Of its skills, `opscrew-deploy` and `opscrew-snapshots` name providers.

## R2. Contabo

Read 2026-11-11 from https://api.contabo.com/, https://github.com/contabo/cntb (its OAuth client
and generated API docs), https://github.com/contabo/terraform-provider-contabo (docs, source,
issues, releases), https://contabo.com/en/vps/ and the OpenTofu registry. The OpenAPI file itself
(`api-v1.openapi.json`) answered 404.

**Login.** An OAuth2 password grant against Contabo's Keycloak,
`https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token`, with four values: a
client id, a client secret, the API user (the account's login email) and an API password, all
from the Customer Control Panel under Account → Security. Every call sends
`Authorization: Bearer …` and an `x-request-id` (a UUIDv4). Access and refresh tokens both expire
(cntb reads the refresh token's `exp`); their lifetimes are unverified. No scoped keys were found:
these credentials reach the whole account.

**Instances** (`/v1/compute/instances`): create, get, rename (`PATCH`), reinstall (`PUT`, with
image, SSH keys, user data and default user), start, stop, restart, shutdown, rescue, and cancel
(`POST …/{id}/cancel`, with an optional `cancelDate`).
- Create needs `period`, the contract's months. The sources disagree: 1, 12 or 24 on the API
  page; 1, 3, 6 or 12 in the provider and cntb.
- The other create fields:
  - `productId`: `V…` ids, for example V153 = Cloud VPS 4 per the API page. No public table maps
    ids to plans.
  - `region`.
  - `imageId`: a UUID from `/v1/compute/images`. Look Ubuntu 24.04 up by name.
  - `sshKeys`: secret ids from `/v1/secrets`, type `ssh`.
  - `userData`: cloud-init, on Contabo's own images.
  - `defaultUser`: `admin`, unless `root` is passed.
  - `displayName` and `addOns`.
- **There is no delete.** A cancel ends the contract at the end of its term, and the instance
  gets a `cancelDate`. The Terraform provider's destroy only cancels and drops the instance from
  state.
  - The minimum term is one month.
  - No notice is needed for prepaid plans; postpaid ones need four weeks.
  - No pro-rata refund was found (unverified).
  - Whether the server keeps running until the cancel date is unverified.
- There is no idempotency key: a create retried after a timeout can buy a second server.
- Statuses include `provisioning`, `installing`, `running` and `error`. How long provisioning
  takes is unverified.
- Changing the image, SSH keys, root password or user data reinstalls the server.

**Firewall.** The API manages firewalls, and so does `contabo_firewall`: inbound rules by
protocol, ports and source CIDR, plus the attached instance ids. Provider issue #56 (2026-09-22):
creating a firewall panics when other resources change in the same apply, 5 times out of 5. It
worked only when the firewall was applied on its own. Issue #52 reports another firewall error.

**Private network.** A paid add-on per instance, one region per network. The first attach needs a
reinstall, a later one a restart. The private interface may need cloud-init to come up
(unverified).

**Snapshots and backups.**
- Snapshots: `contabo_instance_snapshot`, and the API's create, revert and delete.
  - Cloud VPS 4 keeps 1 snapshot, VPS 6 keeps 2, larger plans 3.
  - Reverting to an older snapshot deletes the newer ones.
  - The API sample shows an automatic delete after 30 days (unverified).
- Auto Backup is a paid daily add-on; its price is not listed.
- Neither is known to outlive a cancelled server (unverified; assume not).

**Object Storage.** S3-compatible.
- Regions: EU, US-central and SIN, one storage per region, 250 GB by default.
- Its endpoint is returned as `s3Url`, for example `eu1-s3.contabo.com`.
- It is cancelled at the next possible date.
- Terraform: `contabo_object_storage` and `contabo_object_storage_bucket`. A storage cannot be
  imported (issue #34).
- Its price and how its S3 credentials are made are unverified.

**Regions.** `EU`, `US-central`, `US-east`, `US-west` and `SIN`, plus `UK`, `AUS`, `JPN` and `IND`
on the API page. `/v1/data-centers` lists them with their capabilities. Whether other regions cost
more is unverified.

**Prices.** There is no price or catalogue API. From contabo.com/en/vps/ on 2026-11-11, in EUR a
month before VAT (the founder's checkout on 2026-11-12 showed €5.50 for Cloud VPS 4 as the net
price, with the buyer's country's VAT on top), on a 24-month term, with the standard rate in
brackets:

| Plan | vCPU | RAM | Disk | EUR a month |
|---|---|---|---|---|
| Cloud VPS 4 | 4 | 8 GB | 100 GB SSD | 4.40 (5.50) |
| Cloud VPS 6 | 6 | 12 GB | 200 GB SSD | 6.00 (7.50) |
| Cloud VPS 8 | 8 | 24 GB | 300 GB SSD | 11.20 (14.00) |
| Cloud VPS 12 | 12 | 48 GB | 400 GB SSD | 20.00 (25.00) |

Monthly terms add a setup fee on Cloud VPS 4, €2.00 before VAT (the checkout of 2026-11-12); longer
terms have none. The NVMe variants cost more.

**The Terraform provider `contabo/contabo`.**
- Official (Contabo's GitHub organisation, MIT) and pre-1.0. v0.1.44 came out on 2026-07-16, and
  it is on the OpenTofu registry too.
- Resources: instance, secret, private network, firewall, image, instance snapshot, object storage
  and bucket, and tags.
- Inputs: `oauth2_client_id`, `oauth2_client_secret`, `oauth2_user` and `oauth2_pass`. Whether
  environment variables can supply them is unverified.
- `existing_instance_id` adopts an existing instance.
- Open issues besides #56 and #52:
  - `default_user` is reset to `admin` (#45);
  - user data is lost after an image change (#49);
  - destroy fails with 422 for an instance not created through the API (#38);
  - product changes are silently ignored (#56);
  - there is no rDNS (#41).

**Errors and limits.** JSON errors with 400, 401, 402 (a paid service is required), 403, 404,
409, 422, 429 and 500. Lists come as `{data, _links, _pagination}`. The rate limit's numbers are
unverified.

**What this means for OpsCrew**
- A destroy is a cancellation at the end of the term, with at least a month paid. The plan, the
  approval and the typed confirmation must say when the billing ends.
- A create is never retried blindly: OpsCrew lists by display name first.
- While #56 is open, the firewall cannot share an apply with other resources.
- Prices come from a dated static table.
- The credentials reach the whole account, so they are used only where they are needed.
- Each live create costs at least a month of a server.

## R3. Installing and checking a provider package

Read 2026-11-11 from docs.npmjs.com (`npm audit`, registry signatures, provenance, trusted
publishers, `npm stage`), the npm CLI's `lib/commands/audit.js` and
`lib/utils/verify-signatures.js`, github.com/sigstore/sigstore-js and
github.com/oclif/plugin-plugins.

**What npm checks.**
- `npm audit signatures` checks two things for each package of an installed tree:
  - The registry's ECDSA P-256 signature over `<name>@<version>:<dist.integrity>`, from
    `dist.signatures`. The keys come from Sigstore's TUF repository, or else from
    `/-/npm/v1/keys`.
  - The provenance attestations, which are sigstore bundles from
    `/-/npm/v1/attestations/<name>@<version>`. That response's exact shape is unverified.

  The cryptography lives in pacote. The command refuses global installs.
- `dist.integrity` (sha512) proves only that the bytes match the registry's metadata. The
  signature proves the registry served them. Provenance ties them to a repository, a workflow and
  a ref, but it does not prove the code is benign.

**Checking provenance in OpsCrew.**
- The library options:
  - `sigstore` v5: six `@sigstore/*` packages; it fetches the trust root over TUF.
  - `@sigstore/verify` alone: needs trust material OpsCrew supplies.

  Both need Node `^22.22.2 || ^24.15.0 || >=26`.
- What has to be checked:
  - the bundle, against Sigstore's public-good trust root;
  - the subject: its sha512 is the downloaded tarball's, and its name is
    `pkg:npm/<name>@<version>`;
  - the predicate is SLSA provenance v1;
  - the certificate: OpsCrew's repository, its release workflow and a tag ref, issued by GitHub
    Actions' OIDC.

  These field names come from the SLSA and in-toto formats, not from sigstore-js's docs
  (unverified).
- Checking only the registry signature takes a few dozen lines with `node:crypto`.

**Installing.** Two ways:
- `npm install --prefix <dir> --ignore-scripts <pkg>@<exact>`. This needs npm, which sits next to
  `npx` in normal installs (unverified). It resolves the package's dependency tree, and it lets
  `npm audit signatures` run there.
- Fetch, verify and extract the tarball in OpsCrew. Node has zlib but no tar reader, so this needs
  a small hardened reader: no path traversal, no absolute paths, no links. It works only when the
  package is one self-contained bundle with no runtime dependencies.

**Loading.**
- `import()` of the file's URL. The plugin resolves its own `node_modules`, not the bundled CLI's.
- A second copy of zod breaks `instanceof` and schema identity. So only plain data and functions
  cross the boundary, types come from `@opscrew/contracts` as type-only imports, and the host
  validates every plugin output with its own zod.
- The contract's version is checked before the import.

**Prior art.** oclif's plugin-plugins installs with npm into the CLI's data folder and records
the version or a dist-tag. Pinning is optional, and no provenance check was seen.

**Publishing.**
- `npm stage publish` works per package, and each staged version needs its own 2FA approval.
  There is no approval for several packages at once.
- Trusted publishing needs npm 11.5.1 or later and Node 22.14 or later, and each package has its
  own trusted-publisher settings.
- So every provider package released with the core adds one approval for the founder.

## R4. The Claude Code side

Read 2026-11-11 from the Claude Code docs: plugins, marketplaces, the manifest and dependencies
references, MCP and skills.

- **Several plugins:** one marketplace (`.claude-plugin/marketplace.json`) lists several plugins
  from the same repository. Each is a self-contained folder with a relative `./…` source, and its
  marketplace name must match its `plugin.json` name.
- **Dependencies:** a plugin declares `"dependencies": ["opscrew"]`, and installing it installs
  and enables the core plugin too. Disabling the core is refused while another plugin needs it.
  Version ranges resolve against `<plugin>--v<version>` git tags.
- **Calling another plugin's tools:** a plugin's MCP tools are named
  `mcp__plugin_<plugin>_<server>__<tool>`. Whether a skill in one plugin may call another plugin's
  tools is **not documented**, so it needs a spike before the design relies on it.
- **One MCP server:** the docs don't say whether two plugins declaring the same server command run
  two processes, so the server is declared once, in the core plugin.
- **Versions:** `plugin.json`'s `version` wins over the marketplace entry's. Users update with
  `claude plugin update`; auto-update is off by default for marketplaces outside Anthropic's.
- **Skill names:** skills are namespaced `/<plugin>:<skill>`.
- **Installing from a shell:** `claude plugin install opscrew-aws@opscrew` works without a
  session, in user scope by default, so the CLI could offer it.

## R5. The founder's decisions (2026-11-11)

1. **What 026 builds of the plugin system:** the contract for cloud server providers. Everything
   about one provider lives in one place, behind a versioned contract of plain data and functions
   that a separate package could implement later. That covers its connector, prices, profile,
   Terraform module, firewall checks, token rules, interview option and docs. Hetzner and
   DigitalOcean move into it, and Contabo is the first provider written for it. Own server and
   Portainer stay as they are: they are kinds of target with flows of their own (R1), not
   providers. Installing packages comes with AWS in 028, designed around its first real user:
   `opscrew plugin add`, the provenance check (R3) and one Claude Code plugin per provider (R4).
   AWS is not a VPS (R1, the roadmap's 028), so the contract for packages installed separately
   is shaped there.
2. **Live tests on Contabo:** one live pass at the end of the feature on one Cloud VPS 4 (a
   month's price and the setup fee, R2). The founder is asked before any rerun that needs another
   server. The founder opens the account and creates its API credentials.
3. **A failed step keeps the server (2026-11-12):** the month is paid either way, and OpsCrew
   never takes back a cancelled server, so a rerun after a cancel buys another month and setup
   fee. A step from 3 to 8 that fails therefore waits for a fix and runs again on the same server
   (`OPSCREW_E2E_CONTABO_PAUSE_HOURS`, docs/e2e.md "Waiting for a fix"); the server is cancelled
   only when the pass ends. A new run cannot take the kept server over instead: the takeover needs
   the checkout that bought it, with its state and deploy key. On a postpaid account (four weeks'
   notice, R2) the server is cancelled at once as before, since a later cancel would add a month.

## R6. The spike (T2613, 2026-11-12)

Free calls only, on the founder's empty account: no instance was created. Read from the API, from
Contabo's API reference (the OpenAPI document embedded in api.contabo.com), from the provider's
source (v0.1.44) and with the provider through OpenTofu.

**Confirmed as built**
- Login: the password grant answers `expires_in` 300 (5 minutes) and `refresh_expires_in` 1800.
  The client's 30-second margin is enough.
- Ubuntu 24.04 is the standard image `ubuntu-24.04`, id `d64d5c6c-9dda-4e38-8174-0ee282474d8a`.
  It replaces the placeholder in the definition and in plan-schema's `DEFAULT_IMAGES`.
- Regions (`/v1/data-centers`): `EU`, `US-central`, `US-east`, `US-west`, `SIN`, `UK`, `AUS`,
  `JPN` and `IND`, each with VPS. The four OpsCrew maps to exist.
- Products: the API reference lists V153 to V156 as Cloud VPS 4, 6, 8 and 12 (SSD).
- Errors: `{statusCode, message}`, the message a string or a list of strings.
- Lists: `{data, _links, _pagination: {size, totalElements, totalPages, page}}`.
- The `name` filter on `/v1/tags`, `/v1/secrets` and `/v1/firewalls` matches substrings, so every
  lookup compares the exact name afterwards.
- Tags may hold letters, digits, colons, dashes and underscores (255 at most):
  `opscrew-app:<app>` is accepted. A tag assignment's `resourceType` is one of `instance`,
  `image` and `object-storage`.
- Secrets: a list answers no `value`; only `GET /v1/secrets/{id}` does.
- Cancel: `POST /v1/compute/instances/{id}/cancel`, with an optional `cancelDate`; the answer
  holds the instance's `cancelDate`.
- The provider reads `CNTB_OAUTH2_CLIENT_ID`, `_CLIENT_SECRET`, `_USER` and `_PASS` from the
  environment: `provider "contabo" {}` works.

**The firewall**
- Free with every VPS and VDS (contabo.com/en-us/firewall, help article 103000390430). The API's
  "firewalling add-on" is real: Contabo attaches it to a new instance by itself shortly after
  creating it, and refuses an assignment until then (R8, run 4).
- Inbound traffic no rule accepts is dropped; outbound traffic is not filtered. Only `accept`
  rules can be written.
- Contabo appends its own rule to every firewall: protocol `""`, no ports, empty IPv4 and IPv6
  lists, action `drop`, "Block all traffic". Its preset rules carry empty lists too. So **an empty
  source list means any source**, not none. A family with no network therefore gets a source that
  matches nobody: `127.0.0.1/32` or `::1/128` (accepted by the API), which no packet from the
  internet carries. SecOps reads an empty list as any source.
- `0.0.0.0/0` and `AnyIPv4` are stored alike, as `0.0.0.0/0`; ICMP takes `destPorts: []`.
- A firewall answers `firewallId` (a UUID string), `status`, `instances` and `instanceStatus`
  (`instanceId`, `status` ok|processing|deleting|error_processing|error_deleting, `errorMessage`).
- **The provider cannot manage a Contabo firewall (v0.1.44, the latest).** Its read reports
  Contabo's own drop rule, so every plan after the first wants to delete it (seen through
  OpenTofu); declaring that rule crashes the provider, which fails on an empty `src_cidr`
  (issue #56). A third party's fix (pull request #61, unmerged) also reports that the API
  answers a protected firewall's `instances` as a JSON-encoded string, which the provider cannot
  decode, so reading, importing and creating a firewall with an instance fail. Hence decision R7.

**The provider's login cache.** The provider keeps its token, with the refresh token, in
`<home>/.cache/contabo/terraform/token` and reuses it while the refresh token lasts (30 minutes),
whatever account the credentials name. A fake token left there by an experiment on 2026-11-11
(valid until 2100) made every call fail with "Unexpected API error, no http response", and a real
run leaves the account's token behind. OpsCrew removes that file before and after every engine
command (T2630).

**Left for the live pass (T2620):** the snapshot-limit refusal, whether a snapshot is usable as
soon as the create answers, a revert's statuses, the cancel date before a cancel, whether
`period` or `default_user` read back differently, an import by instance id, the `unavailable`
and `serverLimit` texts, and the firewall's `instances` shape with an instance. The founder's
checkout (2026-11-12) settled the setup fee (€2.00) and that the prices exclude VAT; whether
prices differ by region is still unverified.

## R7. Contabo's firewall through the connector (lead, 2026-11-12)

The plan still carries the firewall, so the approval and SecOps cover it: the `contabo-vps`
module writes the firewall it wants into a `terraform_data.firewall` (its name, its rules and the
server's id) and outputs it as `wanted_firewall`. After every successful apply, OpsCrew's Contabo
connector makes Contabo's firewall of that name exactly that (creates it, sets its rules, adds and
removes servers) and waits until the server's status is `ok`. Destroy deletes it, and drift
compares it, ignoring Contabo's own drop rule. ADR 0029, D8. When the provider can manage it,
the firewall can move back into the module.

## R8. The live pass (T2620, 2026-11-12)

Run 4, on a second Cloud VPS 4, passed all nine steps after the fixes below (two of them made
while it waited on the same server).

Run 3 bought one Cloud VPS 4 (runs 1 and 2 stopped before buying: the design text below, and
OpenTofu missing from the run's `PATH`). Steps 1 to 5 passed; step 6 failed, and the run waited
for a fix on the same server (R5 item 3).

- **Design with credentials set:** with Contabo's credentials set, design and advise used the
  connector's catalogue, which is the dated list, without saying so. Fixed: a provider without a
  price API says where its prices come from, credentials set or not.
- **An instant snapshot keeps only what reached the disk.** Contabo takes a snapshot in about two
  seconds. The app saved a value 5 seconds before the snapshot (SQLite, `synchronous=FULL`), and
  after the revert its database file was there but empty. On the same server:
  - a file written and `sync`ed every 2 seconds was in the snapshot up to its last second;
  - a value saved through the app 6 seconds before a snapshot was lost; with `sync` on the server
    just before the snapshot, it was kept.

  So a live whole-server snapshot now runs `sync` on the server first (as the deploy user,
  through the access `opscrew logs` uses), on every provider; a failure is said and the snapshot
  taken anyway.
- **The firewall add-on:** Contabo attaches an add-on, 1501, to a new instance by itself shortly
  after creating it, and answers HTTP 402 "does not have firewall add-on product" to a firewall
  assignment until then (run 4 assigned it within seconds of the apply). The connector waits for it,
  up to 10 minutes, and the module ignores `add_ons`.
- **`createdDate` an hour early:** a snapshot taken at 08:11:24Z was answered with `createdDate`
  07:11:24Z (its `autoDeleteDate`, its id `snap1794471084` and Contabo's own audit say 08:11).
  OpsCrew reads the time from the stamp it ends each description with.
- **Seen live:** the firewall protects exactly the server with status `ok`, and the connector finds
  no difference from the wanted one; a revert takes about 8 seconds and the server boots at once;
  a snapshot of a running server takes about 2 seconds; Contabo's snapshot audits record no revert.
- **Contabo's Terraform provider cannot cancel a server.** Its destroy of `contabo_instance` failed
  with "Unexpected API error, no http response" 1 ms after it started, without calling Contabo; it
  sends the cancel without a body. `POST /v1/compute/instances/{id}/cancel` with the body `{}`
  answered HTTP 200 with `cancelDate` 2026-12-11 (one month after the purchase). So OpsCrew
  cancels through its connector (ADR 0029, D10).
- **A firewall protecting a cancelled server:** a direct `DELETE /v1/firewalls/{id}` answered HTTP
  409; the connector's `remove`, which takes the servers off it first, deleted it.
