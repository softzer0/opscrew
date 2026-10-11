# ADR 0003: Apache-2.0 core, FSL-1.1-ALv2 for `ee/`

- Status: accepted (2026-10-11)

## Context

OpsCrew is open source to earn trust (it holds the keys to users' infrastructure) and to spread
through the developer community; a hosted control plane funds it. Comparables: Dokploy (Apache +
directory-scoped source-available), Cal.com (AGPL, went closed in 2026), HashiCorp (relicensed,
forked as OpenTofu), Sentry (FSL).

## Decision

Everything outside `ee/` is Apache-2.0. Team/enterprise control-plane features live in `ee/` under
the Functional Source License 1.1 with Apache-2.0 future license (each release becomes Apache-2.0
after two years). Public commitment: anything primarily useful to individual developers stays
outside `ee/`.

## Consequences

- No AGPL or non-commercial dependency may be linked into the CLI (optional external binaries only).
- Contributors need no CLA for the Apache-2.0 part; `ee/` contributions require a decision later.
