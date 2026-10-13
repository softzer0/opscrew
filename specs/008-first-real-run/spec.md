# Feature Specification: First real run and release

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/008-first-real-run`)
**Created**: 2026-10-13
**Status**: In progress
**Input**: Founder go-ahead 2026-10-13 (real end-to-end run before more providers; tokens for a
throwaway Hetzner project, a throwaway GitHub repository, a Cloudflare account and the founder's
Namecheap account with poasjet.com, connected to Cloudflare for the test and restored to Afternic
afterwards); findings of the first live runs.

## Why

Features 000–007 were tested with fakes only (2,621 tests). The plan's Phase 1b exit criterion — a
stranger deploys Next.js + Postgres to Hetzner with a custom domain in under 20 minutes — has never
been checked against real services. The first live run (2026-10-13) created a real server and
reached the deploy workflow, which failed: the Next.js image needs `output: "standalone"`, a change
only the Code-change agent made, so every Next.js app deployed without a model failed to build.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy without a model (Priority: P1)

1. **Given** a Next.js app and no model credentials, **When** the user runs `opscrew adapt
   --no-ai`, merges the pull request and provisions, **Then** the image builds and the app is
   served: OpsCrew applies the build-critical change itself when the config file is a simple
   object, and the image builds without it otherwise.

### User Story 2 - The live runs pass (Priority: P1)

1. **When** the gated live test runs on Hetzner (with and without a Cloudflare domain), **Then**
   every step succeeds and teardown leaves nothing billable behind.

### User Story 3 - Honest domain answers (Priority: P2)

1. **When** the user searches for a domain that is already in their own registrar account,
   **Then** OpsCrew says so and names `opscrew domain connect <domain>` instead of "registered by
   someone else".
2. **When** a connected domain has a null MX record (`0 .`, "accepts no mail"), **Then** the copy
   plan names it as a null MX, not as "has no mail server".

### User Story 4 - Ready to release (Priority: P2)

1. **When** the CLI package is packed, **Then** `npx` from the tarball runs `opscrew --version`
   and `opscrew --help` in an empty folder; the README has a quickstart. Publishing to npm needs
   the founder's explicit approval and is not done by this feature.

## Requirements *(mandatory)*

- **FR-801**: Every supported stack MUST build and serve without a model: build-critical changes
  are applied deterministically where safe, and the generated Dockerfile builds without them.
- **FR-802**: The gated live passes (Hetzner; Hetzner + Cloudflare domain) MUST succeed against
  real accounts and leave nothing billable behind.
- **FR-803**: Domain search MUST distinguish a domain in the user's own account (any registrar)
  from one registered by someone else, and name `opscrew domain connect`.
- **FR-804**: The connect copy plan MUST name null MX records correctly.
- **FR-805**: The CLI package MUST pack into a tarball that runs with `npx` on a clean folder
  (version 0.1.0, quickstart in the README); no publishing without approval.
- **FR-806**: Every live run is recorded in `docs/e2e.md` ("Live results": date, pass, outcome,
  findings).

## Success Criteria *(mandatory)*

- **SC-801**: The Hetzner live pass passes end to end.
- **SC-802**: The Hetzner + Cloudflare pass serves `https://e2e.poasjet.com` with a valid
  certificate, then tears down.
- **SC-803**: `npx ./opscrew-0.1.0.tgz --version` prints 0.1.0 in an empty folder.

## Assumptions

- DigitalOcean, the Namecheap sandbox purchase and the Cloudflare Registrar sandbox are not part of
  this run (no credentials); their passes stay skipped.
- poasjet.com is restored to Afternic's nameservers after the test, on the founder's instruction.
- More tasks are appended as the live runs find problems.
