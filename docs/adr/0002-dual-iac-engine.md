# ADR 0002: HCL for both Terraform and OpenTofu

- Status: accepted (2026-10-11)

## Context

Users own the infrastructure code, and both engines are widely installed. Terraform is BSL 1.1
(no embedding in a competing hosted offering); OpenTofu is MPL-2.0.

## Decision

Generate plain HCL in the common dialect subset and run it through one `IacEngine` contract with
`tofu` and `terraform` implementations. `auto` prefers OpenTofu. Engine-specific features are opt-in
and stay out of `.tf` files (OpenTofu state/plan encryption is passed via `TF_ENCRYPTION`). A
dialect checker and CI validation with both binaries guard the subset. The hosted control plane will
run OpenTofu only.

## Consequences

- Users switch engines freely; lock files differ by registry host and are regenerated on `init`.
- Some newer features of either engine are unavailable until both support them.
