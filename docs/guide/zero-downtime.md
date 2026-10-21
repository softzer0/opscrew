# Deploys without downtime

When you merge a change, the deploy workflow builds a new image and switches your server to it.
Visitors keep being served during the switch, and a release that does not work never replaces one
that does. This works on Hetzner Cloud, DigitalOcean and a server you already have.

## How a deploy switches

1. **Migrations first.** When the app has a release command (`app.releaseCommand` in
   `opscrew/plan.yaml`, such as `prisma migrate deploy`), it runs in a one-off container of the new
   image. If it fails, the deploy stops and the running version keeps serving.
2. **A new copy starts** next to the running one. The database, the cache and the proxy keep
   running; a deploy never restarts them, unless their own image or settings changed (for example
   a Dependabot update), which restarts them once.
3. **The health check.** A small proxy in front of the app, [kamal-proxy](https://github.com/basecamp/kamal-proxy),
   asks the new copy for its health route. Only when it answers does the proxy send it traffic.
4. **The drain.** The old copy gets no new requests and has 30 seconds to finish the ones it has.
5. **The old copy is removed.**
6. **A last check** from outside, through your domain when the app has one. If the app does not
   answer there, OpsCrew switches the server back to the previous version and the run fails.

Caddy stays in front, as before, and passes every request to kamal-proxy.

## A broken release never gets traffic

The new copy has 60 seconds to pass its health check. When it does not, it is removed without ever
receiving a request, the old copy keeps serving, and the run fails with a message that says what to
check: the app must listen on the port in its `PORT` variable and answer its health route. The
message also names the builder that made the image and the setting that switches to another one
(see [How OpsCrew builds your app's image](builders.md)).

## Limits

- **Migrations must work with the running version.** The migration runs while the old version still
  serves visitors, and for a moment both versions run side by side. Add columns and tables in one
  release and remove the old ones in a later release, after nothing uses them.
- **WebSockets are cut at the switch.** Open WebSocket connections stay on the old copy and close
  when the drain ends at the latest. Your app's clients should reconnect.
- **Requests longer than 300 seconds are cut.** This includes slow uploads and downloads.
- **The drain time** is 30 seconds by default. Change it with `deploy.drainSeconds` (5 to 300) in
  `opscrew/plan.yaml`, then run `npx opscrew provision`.

## Small servers restart the app instead

Two copies of the app run during a switch. On a server with less than 1 GB of memory, OpsCrew
records `deploy.strategy: recreate` in `opscrew/plan.yaml` and says why: each deploy stops the old
version before the new one starts, so the site is down for a few seconds. A broken release is still
caught: OpsCrew then switches back to the previous version.

To switch anyway, set `deploy.strategy: rolling` in `opscrew/plan.yaml` and run
`npx opscrew provision`. You can also set `recreate` on a larger server. `npx opscrew design` keeps
your choice while the server type stays the same. On a server you already have, it reads the
memory again each time, and below 1 GB it goes back to `recreate`. `npx opscrew status` shows the
strategy in use.

## In your Portainer

In a Portainer you already run, Portainer itself redeploys the app's stack. Standalone Docker cannot
start the new copy before it stops the old one, so the app restarts in place. Caddy keeps running
through the redeploy and holds each request for up to 30 seconds until the new version answers, so
visitors see a short pause instead of an error. Only the app's own containers restart; the database,
the cache and Caddy stay up. OpsCrew says so at design and records `deploy.strategy: recreate`.

The deploy workflow waits until the site serves the new version and its health route answers. If
the new version does not answer in time, it writes the previous version back.

A Docker Swarm environment in Portainer would give true rolling updates, with the new copy started
before the old one stops. OpsCrew does not support Swarm environments yet; it is planned for a later
release.
