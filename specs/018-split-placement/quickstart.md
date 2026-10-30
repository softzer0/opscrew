# Quickstart: validating split placement and the private network

**Prerequisites:**
- An app with Postgres deployed by OpsCrew on a Hetzner server, in a repository you can push to
  (the throwaway repository for live runs), deployed at least once with some rows in a table.
- The Hetzner token OpsCrew already uses. For the cross-provider case, a DigitalOcean token too.
- For devices: the official WireGuard app on the computer or phone you add.

## 1. Give Postgres a server of its own (US1, SC-1801, SC-1802)

Add to `opscrew/plan.yaml`:
```yaml
servers:
  - name: db
    target: { provider: hetzner, mode: vps-compose, location: nbg1, serverType: cx23, backups: true }
services:
  - kind: postgres
    server: db
    # … the rest as before
```
```bash
npx opscrew design      # both servers, prices, the total, the delay estimate, the window
npx opscrew provision   # IaC plan, a host plan per server, the pull request, then the window
```
**Expect:**
- The app answers.
- `SELECT count(*)` and a checksum match the numbers from before.
- Port 5432 doesn't answer on either server's public address, nor from a device without a grant.
- `nmap` of the db server from outside shows only 22/tcp and the WireGuard UDP port.

Then move it back (remove `server: db`), `provision`, and check the rows again.
`npx opscrew provision --finish-move` asks for the typed service name and removes the old copy.

## 2. Every command (US2)
```bash
npx opscrew status      # both servers, the link up, its handshake and round trip
npx opscrew logs --service db
npx opscrew drift       # after `touch /srv/apps/<app>/x` on the db server: reported with its name
npx opscrew secure
```
Reboot each server: the app answers again within 5 minutes (SC-1803).

## 3. A device (US3, SC-1804)
```bash
npx opscrew vpn add laptop --this-computer
# import the written .conf into the WireGuard app and turn the tunnel on
ssh deploy@<the app server's private address>
npx opscrew vpn list
npx opscrew vpn remove laptop   # the tunnel no longer reaches any server
```

## 4. Close public SSH (US4, SC-1805)
With the environment's runner on the server (`environment.runner: server`) and this computer's
tunnel up:
```bash
npx opscrew secure --close-public-ssh
git commit --allow-empty -m test && git push   # still deploys
npx opscrew status && npx opscrew logs && npx opscrew drift
npx opscrew secure --open-public-ssh
```

## 5. Read-only database access (US5, SC-1806)
```bash
npx opscrew vpn grant laptop db
psql "<the printed URL>" -c 'select count(*) from <table>'        # works
psql "<the printed URL>" -c 'insert into <table> default values'  # refused
npx opscrew vpn revoke laptop db                                  # the login is gone
```

## 6. Destroy
```bash
npx opscrew destroy     # lists both servers; each needs its typed name
```
