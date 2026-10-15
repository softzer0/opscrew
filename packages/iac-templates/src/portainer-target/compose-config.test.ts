import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { portainerTestPlan, TEST_ENV } from "./__fixtures__/plans";
import {
  portainerStackEnvKeys,
  renderPlaceholderStack,
  renderPortainerConnectorStack,
  renderPortainerStack,
  renderUpdaterStack,
} from "./index";

/*
 * Checks every rendered stack with `docker compose config`, which parses and validates it as
 * Portainer's Compose would. Needs Docker with Compose 2.23 or newer (inline `configs` content),
 * so it runs only with OPSCREW_DOCKER_TESTS=1.
 */

const IMAGE = `ghcr.io/acme/shop@sha256:${"ab".repeat(32)}`;

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const version = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
  if (version.status !== 0) return "docker compose is not available";
  const [major = 0, minor = 0] = version.stdout.trim().replace(/^v/, "").split(".").map(Number);
  if (major < 2 || (major === 2 && minor < 23)) {
    return `docker compose ${version.stdout.trim()} is older than 2.23 (no inline configs)`;
  }
  return undefined;
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping docker compose config: ${reason}`);

/** Runs `docker compose config` on `content` with `env` as the stack's environment. */
function composeConfig(content: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "opscrew-portainer-stack-"));
  try {
    writeFileSync(join(dir, "compose.yaml"), content);
    const envFile = join(dir, "stack.env");
    writeFileSync(
      envFile,
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        envFile,
        "-f",
        join(dir, "compose.yaml"),
        "config",
        "--format",
        "json",
      ],
      { cwd: dir, encoding: "utf8", timeout: 60_000 },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const valuesFor = ({ app, opscrew }: { app: string[]; opscrew: string[] }) =>
  Object.fromEntries([...app, ...opscrew].map((key) => [key, `value-of-${key.toLowerCase()}`]));

describe.skipIf(reason !== undefined)("docker compose config (OPSCREW_DOCKER_TESTS=1)", () => {
  const ctx = testContext({ acmeEmail: "ops@example.com" });
  const webs = [{ mode: "tunnel" }, { mode: "proxy", port: 8080 }, { mode: "caddy" }] as const;

  for (const web of webs) {
    it(`accepts the app stack in ${web.mode} mode, with Postgres, Valkey and a release command`, () => {
      const plan = portainerTestPlan({
        web,
        postgres: true,
        redis: true,
        releaseCommand: "npx prisma migrate deploy",
        env: TEST_ENV,
      });
      const content = renderPortainerStack(plan, ctx, { image: IMAGE }).content;
      const run = composeConfig(content, valuesFor(portainerStackEnvKeys(plan)));
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).not.toMatch(/variable is not set/);
      const config = JSON.parse(run.stdout);
      expect(config.name).toBe("opscrew-shop");
      expect(config.services.app.image).toBe(IMAGE);
      expect(config.services.app.environment.STRIPE_KEY).toBe("value-of-stripe_key");
      // Compose prints `$$` (a literal `$` for the container) as it read it: never interpolated.
      expect(config.services.db.healthcheck.test[1]).toBe(
        "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}",
      );
      expect(config.services.db.environment.POSTGRES_PASSWORD).toBe("value-of-opscrew_db_password");
      if (web.mode === "tunnel") {
        expect(config.services.cloudflared.environment.TUNNEL_TOKEN).toBe(
          "value-of-opscrew_tunnel_token",
        );
      }
      expect(config.configs.caddyfile.content).toContain(
        'X-OpsCrew-Image "{$$OPSCREW_APP_VERSION}"',
      );
    }, 60_000);

    // Pulls Caddy's image: the inline Caddyfile is what Caddy accepts, with the variable set.
    it(`gives Caddy a valid configuration in ${web.mode} mode`, () => {
      const plan = portainerTestPlan({ web });
      const doc = parse(renderPortainerStack(plan, ctx, { image: IMAGE }).content);
      const caddyfile = (doc.configs.caddyfile.content as string).replaceAll("$$", "$");
      const run = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "-e",
          `OPSCREW_APP_VERSION=${doc.services.caddy.environment.OPSCREW_APP_VERSION}`,
          doc.services.caddy.image,
          "caddy",
          "validate",
          "--config",
          "/dev/stdin",
          "--adapter",
          "caddyfile",
        ],
        { input: caddyfile, encoding: "utf8", timeout: 240_000 },
      );
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout + run.stderr).toContain("Valid configuration");
    }, 300_000);
  }

  it("accepts the template before the image is filled in", () => {
    const plan = portainerTestPlan();
    const run = composeConfig(
      renderPortainerStack(plan, ctx).content,
      valuesFor(portainerStackEnvKeys(plan)),
    );
    expect(run.status, run.stderr).toBe(0);
  }, 60_000);

  it("accepts the placeholder, the updater and the connector stacks", () => {
    const plan = portainerTestPlan({ redeploy: "cloudflare" });
    const placeholder = composeConfig(renderPlaceholderStack(plan).content, {});
    expect(placeholder.status, placeholder.stderr).toBe(0);

    const updater = composeConfig(renderUpdaterStack(plan).content, {
      PORTAINER_WEBHOOK_URL: "https://host.docker.internal:9443/api/stacks/webhooks/x",
      PORTAINER_PINNED_KEY: "sha256//AAAA",
    });
    expect(updater.status, updater.stderr).toBe(0);
    const loop = JSON.parse(updater.stdout).services.updater.entrypoint[2] as string;
    // The loop reads both from its environment: Compose left them for the container's shell.
    expect(loop).toContain('--pinnedpubkey "$$PORTAINER_PINNED_KEY"');
    expect(loop).not.toContain("sha256//AAAA");
    expect(JSON.parse(updater.stdout).services.updater.environment.PORTAINER_PINNED_KEY).toBe(
      "sha256//AAAA",
    );

    const connector = composeConfig(renderPortainerConnectorStack(plan).content, {
      TUNNEL_TOKEN: "token",
    });
    expect(connector.status, connector.stderr).toBe(0);
    expect(parse(renderPortainerConnectorStack(plan).content).name).toBe(
      "opscrew-shop-portainer-tunnel",
    );
  }, 60_000);
});
