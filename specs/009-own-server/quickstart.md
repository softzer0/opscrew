# Quickstart validation: Your own server, and Portainer

## Offline (every `pnpm check`)

- Host adapter tests: fake hosts for a fresh Ubuntu 24.04, Debian 12, a server with nginx on 80/443,
  firewalld, Snap Docker, `docker.io`, Docker 27 from Docker's repository, a password-sudo user, a
  root admin, another OpsCrew app's marker. Expected: plans, findings and hashes as in
  `contracts/host-adapter.md`; generated scripts pass `sh -n`; no secret in any plan or error.
- Template tests: the own-server root module and the tunnel and Access modules validate under both
  engines; the workflow in tunnel mode pins cloudflared with its SHA-256 and never prints the
  service token; arm64 plans use `ubuntu-24.04-arm`.
- Agents tests: interview → design → provision (plan-only and approve) → destroy for `own` with fakes;
  `opscrew/plan.yaml`, pull requests and commit messages never contain the address.

## Gated live test (`OPSCREW_E2E_OWN_SERVER=1` with the Hetzner, GitHub and Cloudflare variables)

1. The test creates a throwaway Hetzner server with its own SSH key (outside OpsCrew).
2. Directly, DNS only: `opscrew interview` (own server, root, the test key, served directly with
   DNS only) → `design` → `adapt` → `provision` (confirm the host key, approve both plans) → merge
   the deploy PR → `verify`, `secure`, `drift` clean. Expected: the app answers on the domain (not
   proxied); root still logs in with its key.
3. Re-run `provision`: both plans show no changes.
4. `opscrew portainer enable`: nothing answers on 9443/9000/8000 from outside; through the printed
   tunnel command the UI answers and the admin exists.
5. Directly behind Cloudflare's proxy with the filter (answer changed in the interview, then
   `provision`): the domain answers through Cloudflare; 80/443 on the server's own address do not
   answer from the test machine; after a reboot of the server the filter is back before Docker
   serves anything (the domain answers again, the address still does not); `drift` is clean.
6. Through the tunnel (answer changed again, then `provision`; switching runs in two steps): ufw
   allows only SSH; the app answers on the domain through the tunnel; a merged change deploys
   through the Access-protected SSH hostname.
7. `opscrew destroy --undo-host`: the app, DNS, tunnel and Access are gone; the server still accepts
   root with the key; the test then deletes the server through Hetzner's API.
