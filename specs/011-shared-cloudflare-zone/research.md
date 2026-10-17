# Research: Several OpsCrew apps in one Cloudflare zone

Sources: Cloudflare's developer documentation (Rulesets API, WAF custom rules, Configuration Rules,
rules language, API token permissions, SSL/TLS options; read 2026-10-17) and a live spike on the e2e
zone (2026-10-17; it created and removed one ruleset, nothing left).

## R1. Changing one rule instead of a whole ruleset

- **Decision**: OpsCrew reads `GET /zones/{zone}/rulesets/phases/{phase}/entrypoint`, then:
  - adds its rule with `POST /zones/{zone}/rulesets/{ruleset}/rules` (appended at the end);
  - changes it with `PATCH …/rules/{rule}`;
  - deletes it with `DELETE …/rules/{rule}`.

  It creates the entrypoint with `PUT …/phases/{phase}/entrypoint` only when the `GET` answered 404,
  and never sends `PUT` to an entrypoint that exists, because PUT replaces every rule in it.
- **Facts** (spike):
  - A missing entrypoint answers HTTP 404, code 10003.
  - `PUT` on a missing entrypoint creates it with the given rules (version 1).
  - `POST` appends a rule and raises the ruleset version.
  - `PATCH` keeps the rule's `id` and raises the rule's version.
  - `DELETE` of the last rule leaves an empty ruleset (200, no rules).
  - `DELETE /zones/{zone}/rulesets/{ruleset}` answers 204.
  - Every change returns the whole ruleset.
- **Rationale**: the Terraform provider has no resource for a single rule; `cloudflare_ruleset`
  owns the whole list, which is why today a second app (or the user's own rules) blocks OpsCrew.
- **Alternatives**: keep Terraform and one ruleset per app (impossible: one entrypoint per phase per
  zone); a ruleset of kind `custom` deployed from the entrypoint (needs an entrypoint rule anyway,
  and custom rulesets for the WAF phase are not on the Free plan).

## R2. Finding OpsCrew's rule

- **Decision**: OpsCrew's rules carry a fixed `ref`:
  - `opscrew-block-probes` (phase `http_request_firewall_custom`);
  - `opscrew-strict-tls` (phase `http_config_settings`).

  OpsCrew finds them by `ref` in the entrypoint it read, and changes them by their `id`.
- **Facts**: `ref` is set by the client, unique per ruleset (a second rule with the same `ref` is
  refused: 400, code 20023), and kept on `PATCH`. No endpoint looks a rule up by `ref`.

## R3. One shared rule per phase, not one rule per app

- **Decision**: one OpsCrew rule per phase, whose hostname set is the union of every OpsCrew app's
  hostnames in the zone; each app adds and removes only the hostnames it recorded.
- **Facts**:
  - The Free plan allows 5 WAF custom rules and 10 configuration rules per zone.
  - Expressions are limited to 4,096 characters: a longer one is refused with 400, code 20127, which
    names the size.
  - A block rule is terminating; for configuration rules the last matching rule wins.
- **Rationale**: every app's rule is the same except its hostnames. One rule per app would cap a
  Free zone at 5 apps and use the user's own slots. A shared rule uses one slot per phase, and fits
  roughly 60 to 100 hostnames, depending on their length.
- **Alternatives**:
  - One rule per app (simple ownership, but at most 5 apps and every slot gone).
  - Cloudflare Lists (IP lists only on the Free plan, no hostname lists).

## R4. No locking

- **Decision**:
  - Just before each write, OpsCrew reads the entrypoint again and compares only its own rule with
    what the approved plan expected: present or absent, action, paths or setting, enabled, and
    hostnames. If anything differs, it stops and changes nothing.
  - The user's own rules may change in between without stopping OpsCrew.
  - After each write, OpsCrew checks the returned ruleset.
- **Facts**: the API has no If-Match or version precondition, and the documentation advises against
  concurrent updates.

## R5. Account-wide Zero Trust pieces

- **Decision**:
  - The Zero Trust organization and the one-time-PIN identity provider leave each app's Terraform.
  - The same shared-resources plan creates them when they are absent, and passes their ids to the
    Access module.
  - Destroy never deletes them.
- **Rationale**: today the first app's state holds them, so its destroy breaks every other app's
  Access. They cost nothing and other tools may rely on them.
- **Facts**: the connector already reads both (`accessOrganization`, `accessIdentityProviders`,
  feature 010 T1022). Creating them needs the token's Account → Access: Organizations, Identity
  Providers, and Groups → Edit permission, as today.

## R6. Token permissions

- **Decision**: the token needs:
  - Zone → Zone WAF → Edit and Zone → Config Rules → Edit, as today and as the guide already says;
  - Account → Access: Organizations, Identity Providers, and Groups → Edit, only where Access is
    used.

  `opscrew init` tests the WAF and Config Rules permissions with a read of each entrypoint: 403
  means the permission is missing.
- **Facts**: the token-permission documentation lists the older names (Zone WAF Edit, Config Rules
  Edit) and newer ones (Zone WAF Write, Config Settings Write) for the same permissions. The
  guide's labels match the dashboard.

## R7. Zone-wide settings (rule for later features)

- **Decision**: a zone-wide setting is changed only after reading it, and never when it already
  differs from what OpsCrew wants. Per-hostname alternatives are preferred where the user's plan
  has them.
- **Facts** (for 014):
  - **Minimum TLS version:** zone-wide on the Free plan; per hostname only with Advanced
    Certificate Manager.
  - **Always Use HTTPS:** zone-wide. The per-host alternative is a redirect rule, which has its own
    phase and limits.
  - **Authenticated Origin Pulls:** can be per hostname, with an uploaded certificate.
  - **Origin CA certificates:** per hostname, up to 200 SANs.
  - **Configuration rules** can set the SSL mode, Automatic HTTPS Rewrites and Opportunistic
    Encryption per host.

## R8. What the user sees

- **Decision**:
  - The plan lists, per phase, the hostnames added and removed, and whether OpsCrew's rule or the
    entrypoint is created or deleted. It says that the user's own rules are not touched and that
    the Zero Trust pieces stay.
  - Plans never contain tokens. Hostnames are public, and other apps' hostnames in the shared rule
    are shown as a count: "2 other hostnames from other OpsCrew apps". That keeps the output short
    and does not make one app's output depend on others.
