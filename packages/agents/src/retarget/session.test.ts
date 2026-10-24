import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { moveHarness, SERVER_IPV4 } from "../testing";
import { openSession, renderFiles } from "./session";

const TFVARS = "opscrew/infra/prod/terraform.tfvars.json";

/** A move's session for the deployed plan with Portainer on a subdomain behind Cloudflare Access. */
async function portainerSession(committed: Record<string, unknown> | undefined) {
  const h = await moveHarness();
  const plan = DeployPlanSchema.parse({
    ...h.plan,
    dns: { ...h.plan.dns, zone: "example.com" },
    portainer: {
      enabled: true,
      version: "2.45.2",
      access: "subdomain",
      hostname: "portainer.example.com",
      allowedEmails: ["owner@example.com"],
    },
  });
  await writeArtifact("plan", h.paths.files.plan, plan);
  if (committed !== undefined) {
    const file = join(h.root, TFVARS);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(committed, null, 2)}\n`);
  }
  return openSession(h.deps, plan, {
    command: "opscrew retarget",
    providers: ["hetzner", "digitalocean"],
    services: h.services,
    servers: { from: { ipv4: SERVER_IPV4 } },
  });
}

describe.skipIf(!findExecutable("git"))("a move's session", () => {
  it("renders Portainer's Access with the one-time PIN login the last provision used", async () => {
    const session = await portainerSession({ one_time_pin_identity_provider_id: "pin-last-run" });
    const tfvars = (await renderFiles(session)).find((file) => file.path === TFVARS);
    expect(JSON.parse(tfvars?.content ?? "{}")).toMatchObject({
      portainer_hostname: "portainer.example.com",
      one_time_pin_identity_provider_id: "pin-last-run",
    });
  });

  it("stops plainly without the PIN login's id, saying to run provision", async () => {
    const session = await portainerSession(undefined);
    await expect(renderFiles(session)).rejects.toThrow(
      expect.objectContaining({
        code: "PHASE_PRECONDITION",
        hint: expect.stringContaining("Run `opscrew provision` again"),
      }),
    );
  });
});
