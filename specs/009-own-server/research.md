# Research: Your own server, and Portainer

Fetched 2026-10-14 from official sources (vendor docs and the vendors' GitHub repositories). Items
marked **confirm live** are checked by the gated live test or a CI smoke test before release.

## R1. Docker Engine on the user's server

- **Decision**: install Docker Engine, the CLI, containerd and the Buildx and Compose plugins from
  Docker's apt repository (`/etc/apt/keyrings/docker.asc`, a deb822
  `/etc/apt/sources.list.d/docker.sources` with the release codename and `dpkg --print-architecture`),
  never the `get.docker.com` script. Require **Docker Engine 28.0.0 or newer**; plan an upgrade from
  the repository when an older Docker from the same repository is installed.
- **Rationale**: Docker says the convenience script is "not recommended for production
  environments" and may cause unexpected major upgrades
  (https://docs.docker.com/engine/install/ubuntu/#install-using-the-convenience-script). Engine 28.0.0
  fixed "neighbor hosts [connecting] to ports mapped on a loopback address" (moby/moby#49325,
  https://docs.docker.com/engine/release-notes/28/), and OpsCrew relies on loopback-only ports.
- **Supported**: Ubuntu 22.04, 24.04 and 26.04 LTS; Debian 12 and 13; amd64 and arm64
  (https://docs.docker.com/engine/install/ubuntu/, https://docs.docker.com/engine/install/debian/).
- **Refused (with the reason and what to do)**: Docker from Snap, Podman (`podman-docker`), and the
  distribution packages Docker lists as conflicting (`docker.io`, `docker-compose`,
  `docker-compose-v2`, `docker-doc`, `podman-docker`), because replacing them on a server that runs
  other things is the user's decision.
- **Alternatives**: the convenience script (rejected above); keeping any Docker that works (rejected:
  pre-28 loopback ports are reachable from the LAN).

## R2. Host firewall

- **Decision**: use ufw only when no other firewall manages the host (no active firewalld, no
  nftables or iptables rules beyond Docker's own). Add the SSH rule for the port sshd really uses
  (`sshd -T`), then the web rules (only when the server serves the web directly), then `ufw --force
  enable`, all under a dead-man switch (R6). Only Caddy, or the tunnel connector, publishes ports;
  every other container port binds to 127.0.0.1 or stays on the internal network.
- **Rationale**: ufw prompts and may drop connections when enabled over SSH
  (https://manpages.ubuntu.com/manpages/noble/man8/ufw.8.html). Docker-published ports are routed
  before ufw's chains, so ufw cannot protect them
  (https://docs.docker.com/engine/network/packet-filtering-firewalls/).
- **Alternatives**: editing Docker's rules or `"iptables": false` (Docker: likely to break container
  networking); rules in the `DOCKER-USER` chain (more moving parts than publishing nothing).
- **Behind Cloudflare's proxy** (founder, 2026-10-14, after T913 found that ufw rules limited to
  Cloudflare's ranges cannot filter Caddy's Docker-published 80/443): an own server whose site is
  behind Cloudflare's proxy uses the tunnel (R3) by default, also with a public address. As an
  explicit option, a server with a public address serves directly behind the proxy with a filter in
  Docker's `DOCKER-USER` chain (Docker's documented place for rules on published ports): for
  connections whose original destination port is 80 or 443 (`conntrack --ctorigdstport`), sources
  in Cloudflare's IPv4/IPv6 ranges pass and everything else is dropped; the rules are installed by a
  unit that runs before Docker and that Docker requires, so Docker never publishes ports without the
  filter (fail closed). In this mode the site is published on IPv4 only (Caddy binds `0.0.0.0`, no
  AAAA record; visitors still get IPv6 from Cloudflare's edge): Docker serves an IPv6 host port of a
  container without IPv6 through docker-proxy on the INPUT path, which `DOCKER-USER` never sees
  (found by the T913 review), so the filter is IPv4 only and the mode needs a public IPv4 address.
  Without either, public mode is DNS only (not proxied). Rejected: Caddy
  refusing non-Cloudflare clients (the ports still accept connections); editing ufw's `after.rules`
  (changes the filtering of every container the user runs).

## R3. Servers without a public address: Cloudflare Tunnel

- **Decision**: a remotely managed tunnel created as IaC with the Cloudflare provider v5
  (`cloudflare_zero_trust_tunnel_cloudflared` with `config_src = "cloudflare"`,
  `cloudflare_zero_trust_tunnel_cloudflared_config` with the app's hostname routed to Caddy and a
  final `http_status:404` rule, a proxied CNAME to `<tunnel-id>.cfargotunnel.com`), the connector
  token read from `data.cloudflare_zero_trust_tunnel_cloudflared_token`. The connector runs on the
  server as its own Compose project (`cloudflared tunnel --no-autoupdate run`, token in a root-only
  env file).
- **Rationale**: IaC keeps the tunnel in the user's repository with drift and destroy like the DNS
  records (Principle II). Resources and the token data source exist in provider v5.28
  (https://github.com/cloudflare/terraform-provider-cloudflare, `docs/resources`, `docs/data-sources`);
  API flow: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/.
  Egress on port 7844 must be allowed.
- **Token permissions**: Account → Cloudflare Tunnel (Edit), Zone → DNS (Edit); Access needs Access:
  Apps and Policies (Edit), Access: Service Tokens (Edit) and, for one-time PIN, Access:
  Organizations, Identity Providers, and Groups (Edit)
  (https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
- **Alternatives**: the REST API through the connector (not represented in the user's repo);
  locally managed tunnels (credentials files on the server, more to manage).

## R4. Deploying to a server without inbound ports

- **Decision**: the tunnel also routes a dedicated SSH hostname (`service: ssh://localhost:<port>`),
  protected by a Cloudflare Access application whose only policy has the **Service Auth** decision
  (`non_identity` in Terraform) for one `cloudflare_zero_trust_access_service_token`. The GitHub
  workflow downloads a pinned `cloudflared`, checks its SHA-256, and connects with
  `ProxyCommand cloudflared access ssh --hostname %h`, the service token passed as
  `TUNNEL_SERVICE_TOKEN_ID` / `TUNNEL_SERVICE_TOKEN_SECRET` from deploy secrets.
- **cloudflared version**: pin **2026.5.1**. cloudflared 2026.6.0 ignores service-token flags and env
  vars for `access tcp`/`access ssh` and falls back to browser login, so CI hangs
  (https://github.com/cloudflare/cloudflared/issues/1673, open). A newer version replaces the pin
  only after a CI smoke test proves service tokens work (**confirm live**). Release assets and their
  SHA-256 are listed per release (https://github.com/cloudflare/cloudflared/releases).
- **Rationale**: keeps the push-based deploy, its health check and rollback unchanged; the flag names
  and env vars are in `cmd/cloudflared/access/cmd.go`; service tokens need Service Auth
  (https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
- **Alternatives**: a pull-based deploy on the server (a second deploy path to build and secure);
  a self-hosted GitHub runner on the server (runs untrusted workflow code on the user's machine).
- **Assumption**: during `opscrew provision` the CLI reaches the server directly (same network or a
  VPN); only GitHub Actions goes through the tunnel.

## R5. Portainer CE

- **Decision**: Portainer CE as its own Compose project on the server, image pinned to a confirmed
  version tag (**confirm live**; the docs install `portainer/portainer-ce:lts`), publishing only
  `127.0.0.1:9443:9443` (no Edge port 8000, no 9000), the Docker socket and a `portainer_data`
  volume mounted. The admin password is generated locally, kept in
  `~/.opscrew/projects/<id>/portainer_password` (0600), written to a root-only file on the server for
  `--admin-password-file`, and that file is deleted once Portainer reports an admin exists.
  The subdomain opt-in always goes through a tunnel (R3) behind an Access application that allows the
  listed emails with the one-time PIN identity provider, so the origin is never exposed and Access
  cannot be bypassed.
- **Rationale**: `--admin-password`/`--admin-password-file` create the admin at first start and need
  no setup token (https://docs.portainer.io/advanced/cli); without an admin, new instances need a
  setup token and stop after 5 minutes
  (https://docs.portainer.io/faqs/installing/setup-token,
  https://docs.portainer.io/faqs/installing/your-portainer-instance-has-timed-out-for-security-purposes-error-fix).
  The socket gives root-level control of the host, so the UI stays local.
- **Zero Trust**: Access needs a Zero Trust organization (`cloudflare_zero_trust_organization`); new
  organizations have no one-time PIN identity provider until one is added. Free-plan seats (50) and
  whether a brand-new account must first enable Zero Trust in the dashboard: **confirm live**.
- **Alternatives**: Portainer behind Caddy on a public subdomain (UI reachable from the internet);
  the Portainer agent (not needed for one host).

## R6. Changing SSH and the firewall without locking anyone out

- **Decision**: every step that can cut access runs under a dead-man switch: before the change,
  `systemd-run --on-active=<n>s` schedules the undo (restore the previous sshd drop-in and reload,
  or `ufw disable`); after the change OpsCrew opens **new** connections as the deploy user and as
  the user's own login; only when both succeed is the scheduled undo cancelled. sshd changes are a
  drop-in `/etc/ssh/sshd_config.d/10-opscrew.conf`, validated with `sshd -t` before reload; no
  `AllowUsers`. Root logins: `PermitRootLogin no` unless the user connects as root
  (`prohibit-password` then). Password logins are turned off only when no other login user lacks a
  key; otherwise the plan names those users and the step needs an explicit choice.
- **Rationale**: an established session may drop when ufw is enabled or sshd reloads; a scheduled
  undo on the server restores access even if OpsCrew's connection dies.
- **Host key**: trust on first use with the SHA-256 fingerprint shown for confirmation (or
  `--host-key SHA256:…` in scripts), pinned in the project's `known_hosts`; a different key later
  stops everything (`ssh-keyscan` alone is open to a man in the middle).

## R7. Images for arm64 servers

- **Decision**: build on GitHub's `ubuntu-24.04-arm` runner when the server is arm64, `ubuntu-latest`
  otherwise. Standard arm64 runners are free for public repositories and use included minutes for
  private ones (https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- **Alternatives**: QEMU emulation with `docker/setup-qemu-action` (much slower builds).

## R8. Fit with the codebase (map of 2026-10-14)

- Provider seam: `ProviderId`/`VpsProviderId` (`packages/contracts/src/connector.ts`),
  `VpsProviderSchema` (`packages/plan-schema/src/enums.ts`), `PROFILES` and `vpsConnector`
  (`packages/agents/src/providers/`; `vpsConnector` currently falls through to Hetzner for unknown
  ids), the interview question (`packages/agents/src/interview/questions.ts`), the design catalogue
  (`packages/agents/src/design/options.ts`), `PROVIDERS` in `packages/iac-templates/src/providers.ts`.
- Remote commands: `RemoteExec` (`packages/contracts/src/io.ts`), `SshRemoteExec` and `sshArgs`
  (`packages/agents/src/shared/remote.ts`, supports a port, defaults to the `deploy` user),
  `pinHostKey` (`packages/agents/src/shared/wait.ts`, ssh-keyscan without confirmation today).
- cloud-init (`modules/*/cloud-init.yaml.tftpl`) sets `AllowUsers deploy` and `disable_root`; the own
  server bootstrap must not, or it would lock the user's own login out.
- Destroy and drift key on `serverResourceType` and provider snapshots; own servers need their own
  teardown (host plan) and drift (host checks plus IaC drift for DNS and the tunnel).
