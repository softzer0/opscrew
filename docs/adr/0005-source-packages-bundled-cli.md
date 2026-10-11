# ADR 0005: Source-consumed internal packages, one bundled CLI

- Status: accepted (2026-10-11)

## Context

Fourteen workspace packages are developed in parallel by several agents. Building each package
before others can use it slows the loop and complicates watch mode and tests.

## Decision

Internal packages export TypeScript source (`"exports": { ".": "./src/index.ts" }`) and are type-
checked with TypeScript 7 (`moduleResolution: Bundler`). Only the `opscrew` CLI is built: tsup bundles
all `@opscrew/*` code into `dist/opscrew.js`; third-party runtime dependencies (the Agent SDK, the MCP
SDK, …) stay external and are listed in the CLI's `dependencies`.

## Consequences

- No per-package build step; Vitest and tsx run source directly.
- Publishing individual `@opscrew/*` packages later requires adding builds (not planned for v1).
