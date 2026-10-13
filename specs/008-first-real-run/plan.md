# Implementation Plan: First real run and release

**Branch**: `mvp` | **Date**: 2026-10-13 | **Spec**: `specs/008-first-real-run/spec.md`

## Summary

Run the gated live tests against real accounts, fix what they find, and prepare the CLI package for
release. Fixes are small, package-scoped tasks appended as findings arrive; the lead runs the live
passes (they use the founder's credentials from the gitignored `.env.e2e`, never printed).

## Constitution Check

- I: live passes approve plans by hash exactly as users do; the domain connect used `--confirm`
  with the founder's approval in the conversation; nothing is published to npm without approval.
- IV: credentials are read from `.env.e2e` (gitignored) into the test environment only; output is
  redacted by OpsCrew and masked again before it is shown.

## Design

### Next.js without a model (T802)

`adapt` writes the Dockerfile deterministically; `output: "standalone"` is a code change only the
Code-change agent made. Two layers:
1. Deterministic edit: when `next.config.{js,mjs,ts}` exports a plain object literal (the shapes
   `create-next-app` writes: `const nextConfig = {…}; export default nextConfig`,
   `module.exports = {…}`, `export default {…}`), add `output: "standalone"` (and
   `outputFileTracingRoot` for monorepo apps) as a deterministic change in the PR; no config file
   → create `next.config.mjs`. Anything else stays a manual/agent change.
2. A Dockerfile that builds either way: the build stage normalises the output (standalone when
   `.next/standalone` exists, else the full app with production dependencies and `next start`),
   so a missed edit costs image size, never a failed deploy.

### Domain answers (T803)

`searchDomains`: for a name the registrar reports as unavailable, ask `ownsDomain` (or
`getDomain` for Cloudflare) and, when the account holds it, say "already in your <Registrar>
account" with the connect command. Null MX (`0 .`) is recognised in the BIND reader and the record
mapping with one message.

### Re-runs and branches (T808, T811, T816)

Before pushing a branch OpsCrew names, it checks the remote: an open pull request from it stops
the run (adapt) or is added to only when this clone is on that branch and the push is a
fast-forward (provision); a merged or closed one leaves the name taken, so the next free `-2`,
`-3` … is used. Deploy branches start from `origin/<cicd.branch>`. Nothing is force-pushed.

### Drift (T812, T813)

Drift runs a refresh-only plan and drops, per resource type, the attributes the provider schema
marks read-only (computed, neither optional nor required) and the mirrored relationships listed in
`ProviderProfile.mirroredAttributes` (`hcloud_firewall.apply_to`). The schema comes from
`providers schema -json` through an optional `ProviderSchemaReader` capability of
`@opscrew/iac-engine` (the `IacEngine` contract is unchanged); when it cannot be read, drift says
so and reports everything.

### Server address (T814, T815; ADR 0010)

`.opscrew/server.json` (gitignored) holds the deployment's address and, during a move, both
servers'. One helper, `serverAddress`, reads it, with the root module's outputs as the fallback.
The root module renders `servers`, keyed by provider, in every layout, so a move names its old and
new servers without inferring anything from its step. `plan.yaml` no longer has address fields.

### Release prep (T806)

Version 0.1.0 for the CLI package, README quickstart, `pnpm pack` of the bundled CLI and an `npx`
smoke test from the tarball in an empty folder (CI-friendly script). No publish.

## Project Structure

```text
packages/agents/src/adapt/**, packages/iac-templates/src/docker/**   # T802
packages/agents/src/domain/{search,connect-bind}.ts, packages/connectors/cloudflare/src/records.ts  # T803
packages/cli/test/live/**, docs/e2e.md                              # T804, T805 (lead live runs)
packages/cli/package.json, README.md, scripts/pack-smoke.*          # T806
```
