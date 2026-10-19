import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordServerAddress, serverAddressesFile } from "@opscrew/agents";
import { SERVER_IPV4, SERVER_IPV6, testPlan } from "@opscrew/agents/testing";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../program";
import { createTestContext } from "../test-context";

const argv = (...args: string[]) => ["node", "opscrew", ...args];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-status-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A provisioned project: the plan (without any address) and the address in the local state. */
async function provisioned(): Promise<void> {
  const paths = resolveProjectPaths(dir, { env: {} });
  await writeArtifact("plan", paths.files.plan, testPlan({ deployed: true, userSecret: false }));
  await recordServerAddress(paths, { ipv4: SERVER_IPV4, ipv6: SERVER_IPV6 });
  await new ProjectStateStore(paths.files.state).markPhase("provision", "ok");
}

describe("opscrew status and the server's address", () => {
  it("shows the address from OpsCrew's local state", async () => {
    await provisioned();
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toMatch(/provision\s+ok/);
    expect(ctx.output).toContain(
      `Server address (kept on this computer only, never in the repository):\n  ${SERVER_IPV4} (IPv6 ${SERVER_IPV6})\n`,
    );
  });

  it("shows the image builder and the deploy strategy with their reasons", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    const plan = testPlan({ userSecret: false });
    const build = {
      builder: "railpack" as const,
      chosen: "auto" as const,
      reason: "Rust: Railpack builds it.",
      runtime: { language: "rust" as const, version: "1.98" },
      probe: "bash" as const,
    };
    await writeArtifact("plan", paths.files.plan, { ...plan, app: { ...plan.app, build } });
    await new ProjectStateStore(paths.files.state).markPhase("design", "ok");
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toContain("\nImage builder: railpack. Rust: Railpack builds it.\n");
    expect(ctx.output).toContain("\nDeploys: rolling. New versions start next to the running one");
    // The supply-chain settings, with what each does and the setting that changes it.
    expect(ctx.output).toContain("\nImage signing: off (the default). Set supplyChain.sign: true");
    expect(ctx.output).toContain("\nDeploy tags: off (the default). Set cicd.deployTags.enabled");
    expect(ctx.output).toContain(
      "\nImage retention: keeps the newest 10 deployed images in GitHub's container registry, never the running or the previous one",
    );
  });

  it("shows signing, deploy tags and image retention as plan.yaml sets them", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    const plan = testPlan({ userSecret: false });
    await writeArtifact("plan", paths.files.plan, {
      ...plan,
      supplyChain: { sign: true },
      cicd: {
        ...plan.cicd,
        deployTags: { enabled: true, release: true },
        imageRetention: { enabled: false, keep: 10 },
      },
    });
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toContain(
      "\nImage signing: on. Each image gets a keyless cosign signature.",
    );
    expect(ctx.output).toContain("Sigstore's public log");
    expect(ctx.output).toContain(
      "\nDeploy tags: on. Each healthy deploy tags its commit deploy-<UTC time> and gets a GitHub Release naming the image digest.",
    );
    expect(ctx.output).toContain("\nImage retention: off. Every deployed image stays");
  });

  it("prints only the IPv4 address with --ip, for ssh deploy@$(opscrew status --ip)", async () => {
    await provisioned();
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status", "--ip"), ctx)).toBe(0);
    expect(ctx.output).toBe(`${SERVER_IPV4}\n`);
  });

  it("still shows the phases when .opscrew/server.json is damaged, with a note on what to do", async () => {
    await provisioned();
    const paths = resolveProjectPaths(dir, { env: {} });
    await writeFile(serverAddressesFile(paths), "{ not json");
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toMatch(/provision\s+ok/);
    const note = ctx.output
      .split("\n")
      .filter((line) => line.startsWith("Server address: unknown."));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain(".opscrew/server.json) is damaged");
    expect(note[0]).toContain("Delete .opscrew/server.json and run the command again");
    expect(ctx.output).not.toContain(SERVER_IPV4);

    // --ip has nothing to print: it stops with the same explanation.
    const ip = createTestContext({ cwd: dir });
    expect(await main(argv("status", "--ip"), ip)).not.toBe(0);
    expect(ip.output).toBe("");
    expect(ip.errors).toContain("is damaged");
  });

  it("says where the address is when this computer does not know it", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    await writeArtifact("plan", paths.files.plan, testPlan({ deployed: true, userSecret: false }));
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status", "--ip"), ctx)).toBe(1);
    expect(ctx.output).toBe("");
    expect(ctx.errors).toContain("OpsCrew does not know the server's address on this computer.");
    expect(ctx.errors).toContain("the computer that ran `opscrew provision`");

    const plain = createTestContext({ cwd: dir });
    expect(await main(argv("status"), plain)).toBe(0);
    expect(plain.output).not.toContain("Server address");
  });
});
