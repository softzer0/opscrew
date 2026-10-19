# Quickstart: validating 013

Prerequisites as in 012. The local Docker pass needs Docker. The live tests need the throwaway
Hetzner project, GitHub repositories and Cloudflare zone (`docs/e2e.md`), plus an R2-enabled
Cloudflare account and, for Hetzner Object Storage, a key pair from Hetzner's console.

## Offline

- `pnpm check`: the component schema, detection fixtures, the catalog's snapshots (Compose and
  Portainer), the start forms per builder, the deploy script's order, sizing and prices.
- Each new example's `expected.json` names its components, and `examples.test.ts` checks them
  against design.

## Local Docker pass (`OPSCREW_DOCKER_TESTS=1`)

For each new example, the pass:
1. builds the image with its builder;
2. starts the rendered Compose project (the app, workers, cron and services);
3. checks that:
   - the health route answers 200;
   - data written through the app is read back after `docker compose restart`;
   - a queued job is consumed by the worker;
   - the cron job runs within one minute;
   - every container has its memory limit (`docker inspect`);
   - no service port is published.

## Live (gated, `docs/e2e.md`)

1. **Hetzner, components:**
   - the worker and cron example, MySQL, MongoDB, RabbitMQ, Kafka;
   - object storage with R2, and with Hetzner Object Storage;
   - data survives a deploy and a reboot;
   - limits hold, and no service port is public;
   - the leak search finds nothing.
2. **Own server, two apps:**
   - two examples on two hostnames;
   - a change to each under 20 requests per second each, with no failed request;
   - destroying the first leaves the second answering, and the edge stays;
   - destroying the second removes the edge.
3. **Portainer:** components in stacks; a search engine refused for its host setting.
4. **Part 2:** Meilisearch and ClickHouse examples on Hetzner.

Results go in `docs/e2e.md` and `docs/e2e-coverage.md`.
