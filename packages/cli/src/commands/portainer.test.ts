import { readFile } from "node:fs/promises";
import path from "node:path";
import { portainerPasswordFile } from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DeployProject,
  deployProject,
  FakeEngine,
  FakeGitHub,
} from "../ui/__fixtures__/deploy";
import { GIT, projectContext, run } from "../ui/__fixtures__/harness";
import {
  FakeHost,
  fakeHome,
  OWN_FINGERPRINT,
  OwnRunner,
  ownPlan,
  ownProvisionServices,
  ownServices,
  preparedFacts,
  recordOwnLogin,
} from "../ui/__fixtures__/own";
import { withDeployServices } from "../ui/deploy-services";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Approves everything (typing any phrase asked for) and records the requests. */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return {
      approved: true,
      approver: "test",
      decidedAt: "2026-10-14T12:00:00.000Z",
      ...(request.confirmPhrase === undefined ? {} : { confirmation: request.confirmPhrase }),
    };
  }
}

/** An app deployed on the user's own server (no domain); Portainer on when `enabled`. */
async function setup(options: { enabled?: boolean } = {}) {
  project = await deployProject(
    ownPlan({ domain: null, deployed: true, portainer: options.enabled }),
  );
  await recordOwnLogin(project, { hostKey: OWN_FINGERPRINT });
  const paths = resolveProjectPaths(project.root, { env: project.env });
  const facts = preparedFacts(paths.projectId);
  if (options.enabled) {
    facts.portainer = {
      installed: true,
      composeSha256: null,
      running: true,
      secretFile: false,
      dataVolume: true,
      tunnelId: null,
    };
  }
  const host = new FakeHost(facts);
  const own = ownServices(host, await fakeHome(project));
  const services = ownProvisionServices(new FakeEngine(), new FakeGitHub(), own);
  const context = (approvals?: ApprovalHandler) => {
    const ctx = projectContext(project as DeployProject, {
      services: {
        runner: new OwnRunner(),
        ...(approvals === undefined ? {} : { approvalHandler: approvals }),
      },
    });
    withDeployServices(ctx, { portainer: services });
    return ctx;
  };
  return { context, host, paths };
}

function printedHash(output: string): string {
  const hash = /Plan hash \(SHA-256\):\s+([0-9a-f]{64})\s/.exec(output)?.[1];
  if (hash === undefined) throw new Error(`No plan hash in:\n${output}`);
  return hash;
}

describe.skipIf(!GIT)("opscrew portainer", () => {
  it("enable --plan-only prints the host plan's hash; --approve <hash> installs it and prints how to open it", async () => {
    const s = await setup();
    const first = s.context();
    expect(await run(first, "portainer", "enable", "--plan-only", "--yes"), first.errors).toBe(0);
    expect(s.host.applies).toEqual([]);
    const hash = printedHash(first.output);
    expect(first.output).toContain(`    opscrew portainer enable --approve ${hash} --yes\n`);

    const second = s.context();
    const code = await run(second, "portainer", "enable", "--approve", hash, "--yes");
    expect(code, second.errors).toBe(0);
    expect(s.host.applies).toHaveLength(1);
    expect(s.host.applies[0]?.options.approvedHash).toBe(hash);
    // The password goes to the host adapter only; the terminal shows the file's path.
    const password = (await readFile(portainerPasswordFile(s.paths), "utf8")).trim();
    expect(s.host.applies[0]?.options.secrets?.portainerPassword).toBe(password);
    expect(`${second.output}${second.errors}`).not.toContain(password);
    expect(second.output).toContain(portainerPasswordFile(s.paths));
    expect(second.output).toContain("https://localhost:9443");
    expect(second.output).toMatch(/ssh .*-N -L 9443:127\.0\.0\.1:9443 deploy@/);
    const plan = await readArtifact("plan", path.join(s.paths.root, "opscrew", "plan.yaml"));
    expect(plan.portainer).toMatchObject({ enabled: true, access: "local" });
  });

  it("never applies the host plan through --yes alone", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "portainer", "enable", "--yes")).toBe(1);
    expect(s.host.applies).toEqual([]);
    expect(ctx.errors).toContain("--approve");
  });

  it("--allow-email without --subdomain is refused", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "portainer", "enable", "--allow-email", "me@example.com")).toBe(2);
    expect(ctx.errors).toContain("--subdomain");
  });

  it("disable --delete-data needs the typed app name; a script cannot delete the data", async () => {
    const s = await setup({ enabled: true });
    const ctx = s.context();
    expect(await run(ctx, "portainer", "disable", "--delete-data", "--yes")).toBe(1);
    expect(s.host.applies.every((a) => !JSON.stringify(a.plan).includes('"deleteData":true'))).toBe(
      true,
    );
  });

  it("--approve without --delete-data keeps the choice the --plan-only run saved", async () => {
    const s = await setup({ enabled: true });
    const first = s.context();
    const planOnly = ["portainer", "disable", "--delete-data", "--plan-only", "--yes"];
    expect(await run(first, ...planOnly), first.errors).toBe(0);
    expect(first.output).toContain("deletion of Portainer's data");
    const hashes = [...first.output.matchAll(/--approve ([0-9a-f]{64})/g)].map((m) => m[1]);
    expect(hashes.length).toBeGreaterThan(0);

    // A human approves (and types the app's name for the data); no option is repeated.
    const approvals = new ApproveAll();
    const second = s.context(approvals);
    const args = ["portainer", "disable", ...hashes.flatMap((h) => ["--approve", h as string])];
    expect(await run(second, ...args), second.errors).toBe(0);
    const typed = approvals.requests.find((r) => r.confirmPhrase !== undefined);
    expect(typed).toMatchObject({ kind: "host-apply", allowDestroy: true, confirmPhrase: "shop" });
  });

  it("status prints the tunnel command, the local address and the password file, never the password", async () => {
    const s = await setup({ enabled: true });
    const ctx = s.context();
    expect(await run(ctx, "portainer", "status")).toBe(0);
    expect(ctx.output).toContain("https://localhost:9443");
    expect(ctx.output).toContain(portainerPasswordFile(s.paths));
    expect(ctx.output).toMatch(/-N -L 9443:127\.0\.0\.1:9443/);
    expect(s.host.inspections).toBe(0);

    const json = s.context();
    expect(await run(json, "portainer", "status", "--json")).toBe(0);
    expect(JSON.parse(json.output)).toMatchObject({ enabled: true, access: "local" });
  });

  it("lists the subcommands and options in --help", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "portainer", "--help")).toBe(0);
    for (const sub of ["enable", "disable", "status"]) expect(ctx.output).toContain(sub);
    const enable = s.context();
    expect(await run(enable, "portainer", "enable", "--help")).toBe(0);
    for (const option of ["--subdomain <host>", "--allow-email <email>", "--plan-only"]) {
      expect(enable.output).toContain(option);
    }
  });
});
