/**
 * Feature 028 (T2807): the new Cloudflare account's connector beside the app stack's, on Docker.
 * The app stack's template (its Caddy) runs as the stack Portainer runs; the beside stack, curl in
 * cloudflared's place, joins the app stack's network as rendered and reaches Caddy at caddy:80.
 *
 * It pulls the pinned Caddy and curl images, so it runs only with OPSCREW_DOCKER_TESTS=1. It removes
 * its containers, network and volumes, and the images it pulled.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { docker, hasImage } from "../__fixtures__/docker";
import { testContext } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { skipReason } from "../workflow/__fixtures__/sh";
import { portainerTestPlan } from "./__fixtures__/plans";
import { PORTAINER_VERSION_PATH, renderPortainerStack } from "./index";
import { renderNextConnectorStacks } from "./next-connector";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the beside connector on Docker: ${reason}`);

/** `shop` with a name of its own, so its stack's project and network are the test's. */
function plan(): DeployPlan {
  const base = portainerTestPlan({ web: { mode: "tunnel" }, domain: "shop.example.com" });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: `t2807-${randomBytes(3).toString("hex")}` },
  });
}

type Compose = Record<string, unknown> & {
  name: string;
  services: Record<string, Record<string, unknown>>;
};

describe.skipIf(reason !== undefined)("the beside connector on Docker", () => {
  let dir = "";
  let pulled: string[] = [];
  const env = { ...process.env, MSYS_NO_PATHCONV: "1", TUNNEL_TOKEN: "unused" };
  const files: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(process.env.OPSCREW_TEST_TMP ?? tmpdir(), "opscrew-next-"));
    pulled = [IMAGES.caddy.ref, IMAGES.curl.ref].filter((ref) => !hasImage(ref));
  }, 60_000);

  afterAll(() => {
    for (const file of [...files].reverse()) {
      try {
        docker(["compose", "-f", file, "down", "--volumes", "--timeout", "1"], { env });
      } catch (error) {
        console.warn(String(error));
      }
    }
    for (const ref of pulled) spawnSync("docker", ["image", "rm", ref]);
    rmSync(dir, { recursive: true, force: true });
  }, 300_000);

  function write(name: string, document: Compose): string {
    const file = join(dir, name);
    writeFileSync(file, stringify(document, { lineWidth: 0 }));
    files.push(file);
    return file;
  }

  it("reaches the app stack's Caddy from the beside stack", () => {
    const p = plan();
    // The app stack as Portainer runs it, with only Caddy: the app itself need not answer.
    const stack = parse(renderPortainerStack(p, testContext()).content) as Compose;
    const { depends_on: _app, ...caddy } = stack.services.caddy as Record<string, unknown>;
    const app = write("app.yaml", {
      name: stack.name,
      services: { caddy },
      networks: stack.networks,
      volumes: stack.volumes,
      configs: { caddyfile: (stack.configs as Record<string, unknown>).caddyfile },
    });
    docker(["compose", "-f", app, "up", "--detach", "--wait"], { env });

    const [beside] = renderNextConnectorStacks(p);
    const next = parse(beside?.content ?? "") as Compose;
    next.services.cloudflared = {
      ...next.services.cloudflared,
      image: IMAGES.curl.ref,
      restart: "no",
      entrypoint: ["curl"],
      command: [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "20",
        "--retry",
        "5",
        "--retry-connrefused",
        "-H",
        "Host: shop.example.com",
        `http://caddy:80${PORTAINER_VERSION_PATH}`,
      ],
    };
    const file = write("next.yaml", next);
    const status = docker(["compose", "-f", file, "run", "--rm", "cloudflared"], { env });
    // Caddy answered from its own files (no version stamped yet): the beside container reached it.
    expect(status).toMatch(/^(200|404)$/);
  }, 900_000);
});
