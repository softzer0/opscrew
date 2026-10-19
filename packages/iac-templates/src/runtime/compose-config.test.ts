import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { GARAGE_STORAGE, withServices } from "../catalog/__fixtures__/plans";
import { renderCompose, renderRuntimeFiles } from "./index";

/*
 * Checks the server's Compose file with every part 1 service, workers and cron with
 * `docker compose config`, which parses and validates it as the server's Compose would. Needs
 * Docker Compose, so it runs only with OPSCREW_DOCKER_TESTS=1. Starts no container.
 */

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
  return version.status === 0 ? undefined : "docker compose is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping docker compose config (server): ${reason}`);

const base = withServices(
  [
    { kind: "postgres" },
    { kind: "valkey", options: { mode: "queue" } },
    { kind: "mysql" },
    { kind: "mariadb" },
    { kind: "mongodb", options: { replicaSet: true } },
    { kind: "rabbitmq" },
    { kind: "nats" },
    { kind: "kafka" },
    { kind: "redpanda" },
    { kind: "garage" },
  ],
  { storage: GARAGE_STORAGE },
);
const plan = DeployPlanSchema.parse({
  ...base,
  app: {
    ...base.app,
    releaseCommand: "npm run migrate",
    build: {
      builder: "buildpacks",
      chosen: "auto",
      reason: "test",
      runtime: { language: "node", version: "24" },
      probe: "node",
    },
  },
  processes: {
    workers: [
      { name: "worker", command: "node worker.js", source: "procfile", count: 2 },
      { name: "mailer", command: "node mailer.js $QUEUE", source: "library" },
    ],
    cron: [{ name: "report", schedule: "0 * * * *", route: "/api/cron/report" }],
  },
});

describe.skipIf(reason !== undefined)("docker compose config (OPSCREW_DOCKER_TESTS=1)", () => {
  it("accepts the server's Compose file with every part 1 service, workers and cron", () => {
    const dir = mkdtempSync(join(tmpdir(), "opscrew-compose-"));
    try {
      const compose = renderCompose(plan);
      for (const file of [compose, ...renderRuntimeFiles(plan)]) {
        const path = join(dir, file.path.replace(/^opscrew\/runtime\//, ""));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      // The deploy writes these next to compose.yaml; their values are never in the repository.
      for (const name of ["app", ...plan.services.map((service) => service.name)]) {
        writeFileSync(join(dir, `${name}.env`), "");
      }
      const result = spawnSync(
        "docker",
        ["compose", "-f", join(dir, "compose.yaml"), "config", "--format", "json"],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 60_000,
          env: { ...process.env, APP_IMAGE: `ghcr.io/acme/shop@sha256:${"ab".repeat(32)}` },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(result.stdout);
      expect(config.services.worker.deploy.replicas).toBe(2);
      expect(config.services.worker.mem_limit).toBe("268435456");
      expect(config.services.mongodb.volumes).toHaveLength(2);
      expect(config.services.mailer.command).toEqual(["exec node mailer.js $$QUEUE"]);
      expect(Object.keys(config.volumes)).toContain("kafka_data");
      expect(config.services.app.networks).toHaveProperty("opscrew-edge");
      expect(config.networks["opscrew-edge"]).toMatchObject({ external: true });

      // The shared edge's file, uploaded with them.
      const edge = spawnSync(
        "docker",
        ["compose", "-f", join(dir, "edge", "compose.yaml"), "config", "--format", "json"],
        { cwd: dir, encoding: "utf8", timeout: 60_000 },
      );
      expect(edge.status, edge.stderr).toBe(0);
      const edgeConfig = JSON.parse(edge.stdout);
      expect(edgeConfig.name).toBe("opscrew-edge");
      expect(Object.keys(edgeConfig.services)).toEqual(["caddy", "kamal-proxy"]);
      expect(edgeConfig.configs.caddyfile.content).toContain("import /etc/caddy/sites/*.caddy");
      expect(edgeConfig["x-opscrew-edge-version"]).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
