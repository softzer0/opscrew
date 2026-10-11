# Research: Hetzner Deploy (Phase 1b)

Facts verified on 2026-10-11 unless marked otherwise.

## Engines and providers

- OpenTofu 1.13.1 (MPL-2.0) and Terraform 1.16.5 (BSL 1.1) installed for development in `.tools/bin`
  (checksums verified against the official SHA256SUMS). Both report their version with
  `version -json` (`terraform_version` key).
- Registry versions: `hetznercloud/hcloud` 1.70.0, `cloudflare/cloudflare` 5.27.0 (OpenTofu registry
  API, 2026-10-11). Constraints: `~> 1.70`, `~> 5.27`.
- Provider schema (from `tofu providers schema -json`):
  - `hcloud_server`: required `name`, `server_type`; optional `location`, `image`, `backups`,
    `ssh_keys` (list of string), `firewall_ids` (set of number), `user_data`, `labels`,
    `delete_protection`, `rebuild_protection`, `keep_disk`, `shutdown_before_deletion`,
    `allow_deprecated_images`; blocks `public_net { ipv4_enabled, ipv6_enabled, ipv4, ipv6 }`,
    `network`, `timeouts`. Computed: `ipv4_address`, `ipv6_address`, `id`, `status`.
  - `hcloud_firewall`: required `name`; block `rule { direction (req), protocol (req), port,
    source_ips, destination_ips, description }`; block `apply_to { server, label_selector }`.
  - `hcloud_ssh_key`: required `name`, `public_key`; optional `labels`.
  - `cloudflare_dns_record` (v5): required `zone_id`, `name`, `ttl` (1 = automatic), `type`;
    optional `content`, `proxied`, `comment`, `tags`, `priority`, `data`, `settings`.
  - `cloudflare_ruleset` (v5): required `kind`, `name`, `phase`; optional `zone_id`/`account_id`,
    `description`, `rules` (list of objects: `action`*, `expression`*, `action_parameters`,
    `description`, `enabled`, `logging`, `ratelimit`, `ref`). Confirm the `action_parameters.ssl`
    attribute for `set_config` with `tofu providers schema -json` before relying on it.
  - `cloudflare_zone_setting` exists but is zone-wide; OpsCrew does not use it (other hostnames in
    the zone would be affected).
- One entrypoint ruleset per zone and phase: managing `http_config_settings` or
  `http_request_firewall_custom` when the user already has rules there would overwrite them, hence
  the `hasEntrypointRuleset` pre-check and the rule toggles.

## OpenTofu state encryption

`TF_ENCRYPTION` environment variable carries the `encryption` block (HCL) so `.tf` files stay
dialect-neutral (OpenTofu docs, "State and plan encryption" → environment configuration). Key
provider `pbkdf2` (passphrase ≥ 16 chars), method `aes_gcm`, targets `state` and `plan`. Verify in
the engine integration test.

## GitHub Actions

- `actions/checkout` latest tag v7.0.1 (2026-10-11). The tag is lightweight (no `^{}` entry):
  `git ls-remote https://github.com/actions/checkout 'refs/tags/v7.0.1'` gives the commit SHA
  directly; pin `actions/checkout@<sha> # v7.0.1`.
- Trivy image `aquasec/trivy:0.75.0` is pinned by its multi-arch index digest from the Docker Hub
  registry API (`registry-1.docker.io/v2/aquasec/trivy/manifests/0.75.0`; `ghcr.io/aquasecurity/trivy`
  serves the same digest).
- GHCR: `docker login ghcr.io -u <actor> --password-stdin` with `GITHUB_TOKEN`; job permission
  `packages: write`; image names must be lower-case.
- Secrets API: `GET /repos/{owner}/{repo}/actions/secrets/public-key` → `{ key_id, key }`;
  `PUT /repos/{owner}/{repo}/actions/secrets/{name}` with `{ encrypted_value, key_id }`, value sealed
  with libsodium `crypto_box_seal` and base64-encoded (docs.github.com "Encrypting secrets for the
  REST API").
- Trivy image for the optional scan step: pin `aquasec/trivy:<latest release tag>` resolved at
  implementation time (`git ls-remote --tags https://github.com/aquasecurity/trivy`); reporting only.

## Hetzner

- Image `ubuntu-24.04`; server types and prices: see `specs/001-scan-and-plan/research.md`.
- `delete_protection` and `rebuild_protection` must have the same value.
- Hetzner automated backups cost 20 % of the server price and keep 7 daily backups.
- Cloud-init runs once at first boot; OpsCrew writes `/var/lib/opscrew-ready` as its last step.

## Cloudflare

- Token verify: `GET /user/tokens/verify` (user tokens); account-owned tokens may need a different
  endpoint — fall back to a successful `GET /zones?per_page=1`.
- Zone lookup: `GET /zones?name=<zone>`. Entrypoint rulesets:
  `GET /zones/{zone_id}/rulesets/phases/{phase}/entrypoint` (404 when none).
- IP ranges: `GET /ips` → `result.ipv4_cidrs`, `result.ipv6_cidrs` (public).
- Token permissions to request (dashboard names): Zone → Zone → Read; Zone → DNS → Edit;
  Zone → Config Rules → Edit; Zone → Zone WAF → Edit.
- ACME HTTP-01 through the proxy works (Cloudflare exempts `/.well-known/acme-challenge/` from
  HTTPS redirects); with "Full (strict)" for the hostname, Caddy's Let's Encrypt certificate is
  validated by Cloudflare.

## Decisions

See plan.md "Complexity Tracking" (TS policies instead of Conftest, no SOPS, Hetzner backups instead
of restic, x86 only, Valkey, DNS through HCL).
