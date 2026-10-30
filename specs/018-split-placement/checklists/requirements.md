# Specification Quality Checklist: Split placement and the private network

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-30
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). WireGuard, the official WireGuard apps and the named engines are the feature's scope as the founder set it, and research R1 chose WireGuard over Docker Swarm, as earlier OpsCrew specs name their products. How they are driven is left to the plan.
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain. The founder set the scope; the lead's defaults (one network per app and environment, no TLS over WireGuard, no login for Kafka, Redpanda and OpenSearch, services only, extra servers need a public address) are in Assumptions, open for him to change.
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded (Assumptions, "Out of scope")
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Facts the research of 2026-10-30 could not confirm go to the plan's spikes, not the spec:
  - whether a container whose port is bound to the WireGuard address fails to start while the interface is down;
  - whether containers reach another server's WireGuard address through the host's route, and with which source address;
  - filtering published ports by source in `DOCKER-USER` on the WireGuard interface;
  - keys made with Node's x25519 accepted by `wg`;
  - the read-only login of each of the seven kinds against the pinned images (Dragonfly's categories in particular);
  - the MTU across two providers.
- The founder gave the go-ahead for research, spec, plan, tasks and implementation on 2026-10-30.
