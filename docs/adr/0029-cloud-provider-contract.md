# ADR 0029: One package per cloud server provider, behind a versioned contract

**Status**: Accepted (2026-11-11, feature 026). It supersedes ADR 0006's seam. On 2026-11-11 the
founder chose the scope (026's research R5): the contract for cloud server providers now, and
installing provider packages with AWS in 028. The rest of the design is the lead's.

## Context

ADR 0006 gave the phases one seam, `vpsConnector` and `providerProfile`, so that they would not
import a provider's connector. But a provider's facts still live in some sixty files (026's
research R1):
- its profile in `agents`;
- its HCL module, Terraform provider and runbook text in `iac-templates`;
- its firewall checks and token formats in `secops`;
- its wording, coordinates and error patterns in a dozen phases.

Adding Contabo that way would touch all of them again. AWS (028) is to ship as a package installed
when first needed, which needs everything about one provider in one place behind a contract that
does not share code with the core.

Own server, Portainer, this computer and the server-less hosts are kinds of target with flows of
their own (host plans, stack plans), not providers. Most of the branching in the code is on those
kinds, not on which cloud.

## Decision

- **D1: a provider is one package that exports one definition.** The definition is
  `CloudProviderDefinition` in `@opscrew/contracts` (`provider.ts`), `contractVersion: 1`. It
  holds:
  - its names and links;
  - its credentials: the variables, `any` or `all` of them, token formats, detection prefixes and
    the 403 pattern;
  - its connector factory;
  - its regions, locations and coordinates;
  - its offering: currency, image, backups, snapshots per GB or included, delete protection,
    resizing, removal by deletion or by cancellation at the end of the term, and error patterns;
  - its Terraform part: provider requirement, resource types, mirrored attributes, module files,
    module arguments and shared resources;
  - its texts, by where they are said: interview, design, init, runbook, destroy and SecOps.
- **D2: only plain data, regular expressions and functions cross the contract.** No zod schema,
  no class instance, and no import from another OpsCrew package except `@opscrew/contracts`'
  types and `@opscrew/core`'s runtime helpers. A package installed separately later can then
  carry its own copies of its dependencies.
- **D3: one registry, `@opscrew/providers`, is where consumers read provider facts.** It lists
  the built-in definitions in order (Hetzner, DigitalOcean, Contabo), validates each at load (its
  version, every part, region keys within OpsCrew's regions), and runs a conformance test over
  every one of them.
- **D4: dependencies point one way:** provider packages → contracts and core; the registry → the
  providers and plan-schema; agents, iac-templates, secops, detect, mcp-server and the CLI → the
  registry. plan-schema keeps literal provider enums, and a registry test keeps them equal to the
  registry's ids.
- **D5: first-boot setup stays OpsCrew's.** A provider's module never ships
  `cloud-init.yaml.tftpl`; iac-templates adds the shared one to every server module it writes.
  `scripts/gen-provider-modules.ts` embeds each provider's `module/` folder into its
  `src/generated/module.ts`.
- **D6: providers live in `packages/providers/<id>` as `@opscrew/provider-<id>`**, the name 028's
  AWS package will have. The connector packages of Hetzner and DigitalOcean moved there.
- **D7: what 028 adds.** Installing a package with npm, pinned to an exact version and with no
  install scripts, into OpsCrew's own folder, as the Claude Agent SDK is installed. A check of its
  npm provenance against OpsCrew's repository and release workflow. Loading it with `import()`
  behind a version check. A contract shaped by AWS's managed services, which are not a VPS.
  The Claude Code side splits into one plugin per provider that depends on the core plugin.
- **D8: a firewall the provider's Terraform cannot manage goes through the connector**
  (`terraform.connectorFirewall`, research R6 and R7). The module still describes the firewall it
  wants, in a `terraform_data.firewall` (its `firewallResourceType` is then
  `terraform_data.firewall`), and outputs it as `wanted_firewall`. So the plan's hash, its
  approval and SecOps cover it. After every successful apply, OpsCrew passes each wanted firewall
  to the connector's `firewalls.sync`, which makes the provider's firewall exactly that. Destroy
  calls `firewalls.remove`, and drift calls `firewalls.differences`. Contabo is the first such
  provider: its Terraform provider reports Contabo's own drop rule as a change on every plan and
  cannot read a firewall that protects an instance.
- **D9: a provider's login cache never outlives an engine command** (`terraform.homeCacheFiles`).
  The engine removes the files a provider caches its login in under the user's home folder
  before and after every command. No command reuses another account's or an earlier run's login,
  and no token stays on disk (Contabo's provider keeps its token in
  `.cache/contabo/terraform/token`, research R6).

## Consequences

- Adding a cloud server provider is one package and one line in the registry, plus its id in
  plan-schema's enums and the docs. Contabo is the first.
- Hetzner's and DigitalOcean's plans, generated files, prices and messages are unchanged by the
  move. The snapshot tests prove it.
- Object storage (bucket providers r2, hetzner, digitalocean, garage) stays outside the contract
  until a cloud provider's own storage is added.
- A definition is validated on every start. A broken built-in fails the tests long before a user
  sees it.
