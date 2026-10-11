# Feature Specification: Scan and Plan (Phase 1a)

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/001-scan-and-plan`)
**Created**: 2026-10-11
**Status**: Ready for implementation
**Input**: Approved OpsCrew plan, roadmap Phase 1a: "free security scan; Analyst (incl.
Lovable/Bolt/Replit/v0 fingerprinting); Interviewer; Architect with live pricing; Code-change PR;
plan.yaml; MCP server + Claude Code plugin skeleton."

## User Scenarios & Testing *(mandatory)*

Primary user: a "vibe coder" who built an app with Lovable, Bolt, Replit, v0 or an AI coding agent,
has it in a GitHub repository, and does not know how to run it safely on their own server.
Secondary user: a developer who wants the same flow with less ceremony.

### User Story 1 - Free security scan (Priority: P1)

The user runs `opscrew scan` in their repository. Within a minute they see what is dangerous in
plain English: leaked keys, a Supabase service-role key in frontend code, database tables without
row-level security, permissive Firebase rules, risky Docker or framework settings, and known-vulnerable
dependencies. Each finding says where it is and what to do. A shareable report is written to
`opscrew/SECURITY_SCAN.md` that never contains a full secret. No account, no model and no network
are needed (dependency lookups are the only network call and can be turned off).

**Why this priority**: this is the free wedge: the security pain is what stops vibe-coded apps from
launching, and the scan is useful even if the user never deploys with OpsCrew.

**Independent Test**: run the scan on the fixture apps in `examples/` and compare findings with the
expected list for each fixture.

**Acceptance Scenarios**:

1. **Given** the Lovable-style fixture with a planted fake service-role key in `src/`, a migration
   creating a `profiles` table without row-level security and a committed `.env`, **When** the user
   runs `opscrew scan`, **Then** the scan reports a critical finding for the leaked key (the
   service-role key is reported in the Supabase category because only that rule can tell it from
   the public anon key), a high "RLS disabled" finding for `profiles`, and a critical
   "committed .env" finding, each with file, line and masked evidence, and exits with code 1.
2. **Given** a clean repository, **When** the user runs `opscrew scan`, **Then** the summary says
   no high or critical problems were found and the exit code is 0.
3. **Given** `--offline`, **When** the scan runs, **Then** no network request is made and the
   scanners that need the network (the OSV dependency lookup, osv-scanner and Trivy, which may
   download its checks) are listed as skipped with the reason.
4. **Given** `gitleaks` or `osv-scanner` is installed, **When** the scan runs, **Then** their results
   are merged into the report and duplicates are removed; **Given** they are not installed, **Then**
   the report says which optional scanners were skipped and how to install them.
5. **Given** any finding, **When** the report is written, **Then** the full secret value appears
   nowhere in the terminal output, the Markdown report or the JSON report.

---

### User Story 2 - Understand the app (Priority: P1)

The user runs `opscrew analyze`. OpsCrew detects the stack (languages, frameworks, package manager,
build and start commands, port, environment variable names, databases and other services, Docker
files, health endpoint) and which builder the app came from (Lovable, Bolt, Replit, v0, Base44). It
writes `opscrew/architecture.json` and a readable `opscrew/ARCHITECTURE.md`. When a model is
configured, an Analyst agent reads the code (read-only) to refine the summary, list deployment
risks and correct wrong guesses; without a model, the deterministic result is still complete.

**Why this priority**: every later phase depends on correct facts.

**Independent Test**: run `analyze` on each fixture and compare `architecture.json` with expected
facts.

**Acceptance Scenarios**:

1. **Given** the Lovable-style fixture, **When** `opscrew analyze --no-ai` runs, **Then** the facts
   say `platformExport: lovable`, framework `vite` + `react`, app kind `static-spa`, service
   `supabase`, and list `VITE_SUPABASE_URL` as a client-exposed variable.
2. **Given** the Next.js + Postgres fixture, **When** analysis runs, **Then** the facts say
   framework `next`, app kind `ssr`, port 3000, service `postgres`, and `DATABASE_URL` is marked
   secret-likely.
3. **Given** a configured model, **When** `opscrew analyze` runs, **Then** the Analyst can only read
   files inside the project (no writes, no shell, no network), its output is schema-validated, the
   cost is shown, and `aiEnriched` is true.
4. **Given** the model run fails or returns invalid output, **When** analysis finishes, **Then** the
   deterministic result is written, the user is told the AI step was skipped and why, and the exit
   code is 0.

---

### User Story 3 - Choose a deployment that fits the budget (Priority: P2)

The user runs `opscrew interview` and answers a few plain-English questions (expected users,
monthly budget, where users are, how much downtime is acceptable, how bad data loss would be,
domain, whether DNS is on Cloudflare, whether to keep Supabase). Questions whose answers can be
inferred are skipped. Then `opscrew design` shows two or three concrete options on Hetzner Cloud
with monthly cost (live prices when a Hetzner token is set, otherwise a dated price table clearly
labelled as an estimate), marks which fit the budget and recommends one. The chosen option becomes
`opscrew/plan.yaml`, including the list of code changes the app needs.

**Why this priority**: turns analysis into a decision the user understands, with costs before
anything is created.

**Independent Test**: run interview with an answers file and design with a fake catalogue; check
the options, costs and the written plan.

**Acceptance Scenarios**:

1. **Given** a static SPA and answers "<1k users, €10 budget, eu-central", **When** design runs,
   **Then** the cheapest option uses the smallest available x86 server in Nuremberg or Falkenstein,
   its cost breakdown includes the server and IPv4 address, it fits the budget and is recommended.
2. **Given** a Next.js + Postgres app with "critical" data, **When** design runs, **Then** every
   option includes a Postgres container and automated backups, and the backup surcharge appears in
   the cost breakdown.
3. **Given** a budget lower than the cheapest option, **When** design runs, **Then** the options are
   still shown, none is marked as fitting the budget, and the user is told what the minimum cost is.
4. **Given** no Hetzner token, **When** design runs, **Then** prices come from the dated static table
   and every price is labelled "estimate as of <date>"; **Given** a token, prices are live.
5. **Given** non-interactive use, **When** `opscrew interview --answers answers.yaml` and
   `opscrew design --option <id>` run, **Then** no prompt is shown and the artefacts are written.

---

### User Story 4 - Prepare the code in a pull request (Priority: P2)

The user runs `opscrew adapt`. OpsCrew applies the code changes from the plan on a new branch:
deterministic files first (a production Dockerfile for the detected stack, `.dockerignore`,
`.env.example`), then — when a model is configured — a Code-change agent that edits the app to add
a health endpoint, read the port from the environment, move hard-coded secrets to environment
variables and adjust the build configuration. The user sees the diff, approves the commit, and
OpsCrew pushes the branch and opens a pull request that includes the analysis, plan and scan report.

**Why this priority**: the app must be container-ready before infrastructure exists.

**Independent Test**: run adapt on a temporary copy of a fixture with the fake runtime and a fake
GitHub client; check the branch, files, commit and pull-request request.

**Acceptance Scenarios**:

1. **Given** the Next.js fixture without a Dockerfile, **When** adapt runs, **Then** a multi-stage
   Dockerfile that runs as a non-root user and starts the standalone server is created, and the
   plan marks the change `applied`.
2. **Given** uncommitted changes in the working tree, **When** adapt starts, **Then** it stops and
   asks the user to commit or stash first, without touching any file.
3. **Given** a configured model, **When** the Code-change agent runs, **Then** it can only edit
   files inside the project and outside `opscrew/`, cannot push, cannot read `.env` or keys, and its
   result lists which changes it applied or skipped.
4. **Given** the user refuses the commit approval, **When** adapt ends, **Then** the changes stay
   uncommitted on the new branch and nothing is pushed.
5. **Given** approval to push, **When** adapt finishes, **Then** a pull request exists whose body
   lists every change and links the reports, and the PR URL is printed.

---

### User Story 5 - Use OpsCrew from inside a coding agent (Priority: P3)

A user who already works in Claude Code installs the OpsCrew plugin. The plugin's skills guide the
agent through scan → analyze → interview → design → adapt, and the OpsCrew MCP server gives it
deterministic tools (scan, detect, interview questions, save requirements, design options, select a
design, status). The user's own agent does the reasoning; OpsCrew needs no API key in this mode.

**Why this priority**: the cheapest distribution channel to the exact audience, but the CLI must work
first.

**Independent Test**: start the MCP server over stdio in a test, list tools, call each tool against
a fixture.

**Acceptance Scenarios**:

1. **Given** `opscrew mcp`, **When** an MCP client lists tools, **Then** every tool has a
   description, a zod-derived input schema and correct read-only/destructive annotations.
2. **Given** a fixture project, **When** the client calls `opscrew_scan`, **Then** it receives the
   counts, the top findings (masked) and the report path.
3. **Given** the plugin directory, **When** it is validated, **Then** its manifest, MCP config,
   skills and marketplace file follow the current Claude Code plugin format.

### Edge Cases

- Monorepos with several apps: detect the deployable app (the one with a start script or server
  framework). When several apps remain, analyze lists them as a risk and design stops with a plain
  explanation: v1 deploys one app per repository, so run OpsCrew from the app's folder when that app
  is self-contained. A single app in a workspace subfolder (for example `apps/web`) is supported.
- Repositories without git: scan and analyze work; adapt explains that git is required.
- Very large repos: file walking skips ignored folders and files over 1 MB and stops at 20,000
  files with a warning.
- Binary files and minified bundles: skipped by secret rules except for key-file detection.
- `.env.example` placeholder values (`your-key-here`, `changeme`, `xxx`) are never reported as leaks.
- A Supabase anon key in frontend code is normal and is not a finding; a service-role key is critical.
- Windows line endings and paths everywhere; reports always use POSIX repo-relative paths.
- Hetzner API rate limiting or outage during design: fall back to the static table with a warning.
- The user's budget is in USD while prices are in EUR: compare using a stated approximate rate.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-101**: `opscrew scan [--offline] [--fail-on <severity>] [--json]` MUST run all built-in
  scanners, use optional external scanners when installed, deduplicate findings, write
  `opscrew/SECURITY_SCAN.md` and `.opscrew/scan.json`, print a summary, and exit 1 when any finding is
  at or above `--fail-on` (default `high`), 0 otherwise, 2 on error.
- **FR-102**: Built-in scanners MUST cover: secrets (FR-007 families plus generic high-entropy
  assignments to secret-like names, private-key files, committed `.env` files), Supabase (service-role
  key in client code or client-exposed env names, tables without RLS in migrations, `using (true)`
  policies on writes or on sensitive tables, grants to `anon`), Firebase (open Firestore/Storage/RTDB
  rules, expired test-mode rules), config (Dockerfile without `USER`, `latest` base tags, secrets in
  `ENV`/`ARG`, debug mode in Django/Flask, CORS `*` with credentials, secret-like names with
  client-exposed prefixes), and dependencies (npm and PyPI lockfiles via the OSV API).
- **FR-103**: Evidence MUST be masked with `maskSecret`; reports MUST contain no absolute paths.
- **FR-104**: `opscrew analyze [--no-ai]` MUST write a valid `architecture.json` and `ARCHITECTURE.md`
  from deterministic detection, and MAY refine summary, risks and selected facts (app kind, port,
  start command, health endpoint) with a read-only Analyst agent whose output is schema-validated.
- **FR-105**: Detection MUST identify platform exports: Lovable (`lovable-tagger` dependency or
  Lovable markers), Bolt (`.bolt/`), Replit (`.replit`, `replit.nix`), v0 (`components.json` + Next.js
  + v0 markers), Base44 (`@base44/sdk`).
- **FR-106**: `opscrew interview [--answers <file>]` MUST ask only questions that cannot be inferred
  and write a valid `requirements.yaml`; re-running pre-fills previous answers.
- **FR-107**: `opscrew design [--option <id>]` MUST produce 2–3 options (exactly one recommended),
  using live Hetzner prices when `HCLOUD_TOKEN` works and the dated static table otherwise, exclude
  ARM and deprecated or unavailable server types, and write a valid `plan.yaml` for the chosen
  option including derived code changes.
- **FR-108**: `opscrew adapt [--no-ai] [--no-push]` MUST require a clean git working tree, create a
  branch, write deterministic files only when missing, run the Code-change agent in the `edit-repo`
  profile when a model is configured, ask for approval before committing and again before pushing and
  opening a pull request, and update code-change statuses in `plan.yaml`.
- **FR-109**: Deterministic templates MUST exist for: Next.js (standalone), Node servers (Express,
  Fastify, NestJS, Hono and generic `npm start`), Vite/CRA/Angular static sites (served by Caddy in
  the container), FastAPI, Django and generic Python; each runs as a non-root user.
- **FR-110**: `opscrew mcp` MUST start a stdio MCP server exposing the deterministic tools
  `opscrew_scan`, `opscrew_detect`, `opscrew_interview_questions`, `opscrew_save_requirements`,
  `opscrew_design_options`, `opscrew_select_design` and `opscrew_status`, with zod input schemas and
  annotations; tools never call a model.
- **FR-111**: The repository MUST contain a Claude Code plugin in `plugin/` (manifest, MCP config,
  skills `opscrew-deploy`, `opscrew-scan`, `opscrew-adapt`; the MCP config pins the `opscrew`
  version that matches the plugin version) and a marketplace manifest at
  `.claude-plugin/marketplace.json`; both pass `claude plugin validate`.
- **FR-112**: Fixture apps MUST exist in `examples/` (Lovable-style Vite + Supabase with planted fake
  problems, Next.js + Postgres, FastAPI + Redis, static Vite SPA) with expected scan and analysis
  results checked by tests.
- **FR-113**: Every phase MUST record its status in `.opscrew/state.json` and model cost in
  `.opscrew/costs.jsonl`.

### Key Entities

Artefacts and shapes from `specs/000-platform-architecture/data-model.md` (ProjectFacts,
Architecture, Requirements, Question, DesignOption, CostEstimate, DeployPlan) plus the `ScanReport`
and `Finding` contracts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-101**: `opscrew scan --offline` finishes in under 10 seconds on a 5,000-file repository.
- **SC-102**: On the fixture set, the scan finds 100% of planted problems with 0 findings on the
  clean fixture.
- **SC-103**: Detection produces the expected facts for 100% of fixtures.
- **SC-104**: A user can go from a fresh clone to a written `plan.yaml` (scan → analyze → interview →
  design) in under 5 minutes without reading documentation.
- **SC-105**: An AI-enriched analyze run of a fixture costs under $0.50; an adapt run under $3.
- **SC-106**: 0 full secret values appear in any output across the test suite (asserted by tests
  that grep outputs for the planted fake values).

## Assumptions

- v1 deploy target is Hetzner Cloud x86 servers; ARM servers are excluded because the GitHub-hosted
  x86 runners would need cross-builds.
- The interview's budget currency comparison uses an approximate fixed EUR/USD rate stated in the
  output.
- Dependency scanning covers npm (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) and PyPI
  (`requirements.txt` with pinned versions, `poetry.lock`, `uv.lock`) in v1.
- The plugin's MCP config uses `npx -y opscrew mcp`, which works once `opscrew` is published to npm;
  until then the plugin README documents a local path.
- Models used by default: Analyst `claude-haiku-5-5` (file walking, per the approved plan),
  Code-change `claude-opus-5-5`; both overridable with `--model` / `OPSCREW_MODEL`.
