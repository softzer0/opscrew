import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordServerAddress, serverAddressesFile } from "@opscrew/agents";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../program";
import { createTestContext } from "../test-context";
import { deployedPlan, SERVER_IPV4, SERVER_IPV6 } from "../ui/__fixtures__/deploy";

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
  await writeArtifact("plan", paths.files.plan, deployedPlan());
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
    await writeArtifact("plan", paths.files.plan, deployedPlan());
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
