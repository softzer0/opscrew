# Research: Scan and Plan (Phase 1a)

Facts verified on 2026-10-11 unless marked otherwise. Implementers: prefer these over memory.

## Hetzner prices (static fallback for `StaticHetznerCatalog`)

Source: Hetzner Docs, "Hetzner Price Adjustment 15 June 2026"
(https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), tables
"Cloud servers", new prices valid for orders from 2026-06-15. Prices are monthly, EUR, **excluding
IPv4 and excluding VAT** (Hetzner lists net prices). Use `asOf: "2026-06-15T00:00:00.000Z"`,
`source: "static"`, `pricesIncludeVat: false`. Live API prices (`GET /pricing`, `GET
/server_types`) always win when `HCLOUD_TOKEN` works.

Specs (vCPU / RAM GB / disk GB) for the new generations come from hetzner.com/cloud product pages
(cost-optimized CX, regular-performance CPX, general-purpose CCX); `cpuType` is `shared` for CX/CPX
and `dedicated` for CCX. ARM (CAX) types are listed for completeness but design excludes them.

**Germany (fsn1, nbg1) and Finland (hel1)** — network zone `eu-central`:

| Type | vCPU | RAM | Disk | EUR / month | EUR / hour |
|---|---|---|---|---|---|
| cx23 | 2 | 4 | 40 | 5.49 | 0.0088 |
| cx33 | 4 | 8 | 80 | 8.49 | 0.0136 |
| cx43 | 8 | 16 | 160 | 15.99 | 0.0256 |
| cx53 | 16 | 32 | 320 | 29.49 | 0.0473 |
| cpx22 | 2 | 4 | 80 | 19.49 | 0.0312 |
| cpx32 | 4 | 8 | 160 | 35.49 | 0.0569 |
| cpx42 | 8 | 16 | 320 | 69.49 | 0.1114 |
| cpx52 | 12 | 24 | 480 | 100.49 | 0.1610 |
| cpx62 | 16 | 32 | 640 | 129.99 | 0.2083 |
| ccx13 | 2 | 8 | 80 | 42.99 | 0.0689 |
| ccx23 | 4 | 16 | 160 | 85.99 | 0.1378 |
| ccx33 | 8 | 32 | 240 | 138.49 | 0.2219 |
| ccx43 | 16 | 64 | 360 | 275.99 | 0.4423 |
| ccx53 | 32 | 128 | 600 | 533.49 | 0.8550 |
| ccx63 | 48 | 192 | 960 | 853.49 | 1.3678 |
| cax11 (arm) | 2 | 4 | 40 | 5.99 | 0.0096 |
| cax21 (arm) | 4 | 8 | 80 | 10.49 | 0.0168 |
| cax31 (arm) | 8 | 16 | 160 | 20.99 | 0.0336 |
| cax41 (arm) | 16 | 32 | 320 | 40.99 | 0.0657 |

**USA (ash, hil)** — network zones `us-east` / `us-west`:

| Type | vCPU | RAM | Disk | EUR / month | EUR / hour |
|---|---|---|---|---|---|
| cpx11 | 2 | 2 | 40 | 17.49 | 0.0280 |
| cpx21 | 3 | 4 | 80 | 31.99 | 0.0513 |
| cpx31 | 4 | 8 | 160 | 62.49 | 0.1001 |
| cpx41 | 8 | 16 | 240 | 120.49 | 0.1931 |
| cpx51 | 16 | 32 | 360 | 237.99 | 0.3814 |
| ccx13 | 2 | 8 | 80 | 43.49 | 0.0697 |
| ccx23 | 4 | 16 | 160 | 87.49 | 0.1402 |
| ccx33 | 8 | 32 | 240 | 140.99 | 0.2259 |
| ccx43 | 16 | 64 | 360 | 279.49 | 0.4479 |
| ccx53 | 32 | 128 | 600 | 538.49 | 0.8630 |
| ccx63 | 48 | 192 | 960 | 853.49 | 1.3782 |

**Singapore (sin)** — network zone `ap-southeast`:

| Type | vCPU | RAM | Disk | EUR / month | EUR / hour |
|---|---|---|---|---|---|
| cpx12 | 1 | 2 | 40 | 15.49 | 0.0248 |
| cpx22 | 2 | 4 | 80 | 26.49 | 0.0425 |
| cpx32 | 4 | 8 | 160 | 48.99 | 0.0785 |
| cpx42 | 8 | 16 | 320 | 93.49 | 0.1498 |
| cpx52 | 12 | 24 | 480 | 134.49 | 0.2155 |
| cpx62 | 16 | 32 | 640 | 171.99 | 0.2756 |
| ccx13 | 2 | 8 | 80 | 53.99 | 0.0865 |
| ccx23 | 4 | 16 | 160 | 108.49 | 0.1739 |
| ccx33 | 8 | 32 | 240 | 174.49 | 0.2796 |
| ccx43 | 16 | 64 | 360 | 340.99 | 0.5465 |
| ccx53 | 32 | 128 | 600 | 651.99 | 1.0449 |
| ccx63 | 48 | 192 | 960 | 1036.49 | 1.6610 |

Extras for the static table: primary IPv4 0.50 EUR/month (docs.hetzner.com, servers overview;
not re-verified after the June 2026 adjustment, label as static); automated backups = 20 % of the
server price; volumes not used in v1. Availability is unknown offline: mark every static offer
`available: true` and let the live API decide; show "check availability" in the design output when
prices are static. Locations: `fsn1` Falkenstein DE, `nbg1` Nuremberg DE, `hel1` Helsinki FI, `ash`
Ashburn US, `hil` Hillsboro US, `sin` Singapore SG.

## Hetzner Cloud API shapes (hcloud-go schema, main branch)

`GET /server_types` → `server_types[]`: `id`, `name`, `description`, `category`, `cores`,
`memory` (GB float), `disk` (GB), `storage_type`, `cpu_type` (`shared`|`dedicated`),
`architecture` (`x86`|`arm`), `included_traffic`, `deprecated` (bool) / `deprecation` (object, older
field), `prices[]` (`location`, `price_hourly{net,gross}`, `price_monthly{net,gross}`,
`included_traffic`, `price_per_tb_traffic{net,gross}`; prices are decimal strings), `locations[]`
(`id`, `name`, `available`, `recommended`). `GET /pricing` → `pricing`: `currency`, `vat_rate`,
`primary_ips[]` (`type` `ipv4`|`ipv6`, `prices[{ location, price_hourly, price_monthly }]`),
`server_backup.percentage` (string), `volume.price_per_gb_month`, `server_types[]`. Pagination:
`meta.pagination.{page, per_page, next_page, last_page, total_entries}`.

## Claude Code plugin format (code.claude.com/docs, plugins reference and marketplace reference)

- Layout: `.claude-plugin/plugin.json` (optional; if present only `name` is required — kebab-case,
  must not start with `claude-`, `anthropic-`, `anthropics-`, `cc-plugin-`), `skills/<name>/SKILL.md`,
  `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` (`{ "mcpServers": { … } }`) at the plugin
  root. Recommended fields to avoid validator warnings: `version`, `description`, `author { name }`,
  plus `homepage`, `repository`, `license`, `keywords`.
- `${CLAUDE_PLUGIN_ROOT}` (install dir, changes on update), `${CLAUDE_PLUGIN_DATA}` (persistent),
  `${CLAUDE_PROJECT_DIR}` are substituted in MCP `command`/`args`/`env` and skill bodies.
- Plugin MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`; plugin skills run as
  `/<plugin>:<skill>`.
- SKILL.md frontmatter: all optional; use `name`, `description` (with `when_to_use` folded in, max
  ~1,500 chars combined), `allowed-tools` where useful; keep the file under 500 lines.
- Marketplace `.claude-plugin/marketplace.json` at the repo root: required `name` (not reserved:
  avoid `claude-*`, `anthropic-*`, `npm`, `github`, …), `owner { name }`, `plugins[]` with `name` +
  `source` (`"./plugin"`); recommended `description`.
- Install: `claude plugin marketplace add <owner>/<repo>` then `claude plugin install
  opscrew@<marketplace>` (or `/plugin marketplace add …` and `/plugin install …` in a session);
  local dev: `claude --plugin-dir ./plugin`; validation: `claude plugin validate ./plugin`.
- Windows: npx-based stdio servers may need `"command": "cmd", "args": ["/c", "npx", …]`
  (UNVERIFIED; document in the plugin README).

## MCP (Claude Code + TypeScript SDK 1.x)

- Claude Code supports MCP **elicitation** (form and URL modes) with no configuration; it shows a
  dialog and returns the user's answer (code.claude.com/docs/en/mcp, "Respond to MCP elicitation
  requests"). Always check client capabilities at runtime.
- A tool can set `_meta: { "anthropic/requiresUserInteraction": true }` in its `tools/list` entry to
  force Claude Code's permission prompt on every call, even in auto/bypass modes (same page). Use it
  on every mutating OpsCrew tool (`opscrew_select_design` excluded — it only writes artefacts).
- SDK calls (confirm in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/*.d.ts`):
  `McpServer` (`server/mcp.js`), `registerTool(name, { title, description, inputSchema, annotations,
  _meta? }, handler)`, `StdioServerTransport` (`server/stdio.js`), `InMemoryTransport`
  (`inMemory.js`) for tests, low-level `server.server.getClientCapabilities()` and
  `server.server.elicitInput({ message, requestedSchema })` → `{ action: "accept"|"decline"|"cancel",
  content? }` (form schemas are flat objects of primitive properties).

## Decisions

| Decision | Rationale | Alternatives |
|---|---|---|
| Static price table from Hetzner's price-adjustment docs page | official, dated, offline | no fallback (design unusable without a token) |
| Net prices everywhere | live API and static table agree; label "excl. VAT" | gross depends on the account's VAT country |
| OSV API for dependencies | no binary; same database as osv-scanner | npm audit / pip-audit need tool installs and network anyway |
| Deterministic interview | free, testable, works in plugin mode | LLM interviewer |
| Analyst on Haiku 5.5, Code-change on Opus 5.5 | approved plan; cost vs. quality | single model for everything |
