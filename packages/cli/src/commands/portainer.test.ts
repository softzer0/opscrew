import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { portainerPasswordFile } from "@opscrew/agents";
import {
  ED25519_FINGERPRINT,
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  ownPlan,
  preparedServerFacts,
} from "@opscrew/agents/testing";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { type DeployProject, deployProject } from "../ui/__fixtures__/deploy";
import { GIT, projectContext, run } from "../ui/__fixtures__/harness";
import {
  fakeHome,
  OwnRunner,
  ownProvisionServices,
  ownServices,
  recordOwnLogin,
} from "../ui/__fixtures__/own";

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

/**
 * An app deployed on the user's own server (no domain, or `shop.example.com` on Cloudflare with
 * `domain`); Portainer on when `enabled`.
 */
async function setup(options: { enabled?: boolean; domain?: boolean } = {}) {
  project = await deployProject(
    ownPlan({
      ...(options.domain ? { proxied: false } : { domain: null }),
      deployed: true,
      ...(options.enabled ? { portainer: "local" } : {}),
    }),
  );
  await recordOwnLogin(project, { hostKey: ED25519_FINGERPRINT });
  const paths = resolveProjectPaths(project.root, { env: project.env });
  const facts = preparedServerFacts(paths.projectId);
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
  const host = new FakeHostServer(facts);
  const own = ownServices(host, await fakeHome(project));
  const services = ownProvisionServices(new FakeEngine(), new FakeGitHub(), own);
  // A person answering (`approvals`) sits at a terminal.
  const context = (approvals?: ApprovalHandler) => {
    const ctx = projectContext(project as DeployProject, {
      interactive: approvals !== undefined,
      services: {
        runner: new OwnRunner(),
        ...(approvals === undefined ? {} : { approvalHandler: approvals }),
      },
    });
    withServices(ctx, { portainer: services });
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

  it("enable --subdomain --plan-only prints the Cloudflare plan's hash in the --approve command", async () => {
    const s = await setup({ domain: true });
    const ctx = s.context();
    const args = ["portainer", "enable", "--subdomain", "portainer"];
    const planOnly = [...args, "--allow-email", "owner@example.com", "--plan-only", "--yes"];
    expect(await run(ctx, ...planOnly), ctx.errors).toBe(0);
    expect(ctx.output).toContain("Cloudflare plan for example.com");
    expect(ctx.output).not.toContain("Nothing to apply");
    const hash = /Cloudflare plan hash: ([0-9a-f]{64})/.exec(ctx.output)?.[1];
    expect(hash).toBeDefined();
    expect(ctx.output).toMatch(
      new RegExp(
        `    opscrew portainer enable --approve ${hash}( --approve [0-9a-f]{64})* --yes\\n`,
      ),
    );
    expect(s.host.applies).toEqual([]);
    expect(existsSync(s.paths.files.cloudflareRecord)).toBe(false);

    // Its hash approves the Cloudflare plan; the infrastructure plan then asks for its own.
    const second = s.context();
    expect(await run(second, "portainer", "enable", "--approve", hash as string, "--yes")).toBe(1);
    expect(existsSync(s.paths.files.cloudflareRecord)).toBe(true);
    expect(second.errors).toMatch(/--approve [0-9a-f]{64}/);
    expect(s.host.applies).toEqual([]);
  });

  it("--allow-email without --subdomain is refused", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "portainer", "enable", "--allow-email", "me@example.com")).toBe(2);
    expect(ctx.errors).toContain("--subdomain");
  });

  const deletesData = (s: { host: FakeHostServer }) =>
    s.host.applies.some((a) => JSON.stringify(a.plan).includes('"deleteData":true'));

  /** The hashes `disable --delete-data --plan-only` printed (removal and data deletion). */
  async function plannedDeletion(s: Awaited<ReturnType<typeof setup>>): Promise<string[]> {
    const ctx = s.context();
    const args = ["portainer", "disable", "--delete-data", "--plan-only", "--yes"];
    expect(await run(ctx, ...args), ctx.errors).toBe(0);
    expect(ctx.output).toContain("add --confirm <app name>");
    return [...ctx.output.matchAll(/--approve ([0-9a-f]{64})/g)].map((m) => m[1] as string);
  }

  it("a script without --confirm never deletes Portainer's data and says what to add", async () => {
    const s = await setup({ enabled: true });
    const hashes = await plannedDeletion(s);
    const ctx = s.context();
    const args = ["portainer", "disable", ...hashes.flatMap((h) => ["--approve", h]), "--yes"];
    expect(await run(ctx, ...args)).toBe(1);
    expect(ctx.errors).toContain("--confirm shop");
    expect(deletesData(s)).toBe(false);
  });

  it("--confirm <app> with the data plan's hash deletes the data in a script", async () => {
    const s = await setup({ enabled: true });
    const hashes = await plannedDeletion(s);
    const ctx = s.context();
    const approve = hashes.flatMap((h) => ["--approve", h]);
    const args = ["portainer", "disable", ...approve, "--confirm", "shop", "--yes"];
    expect(await run(ctx, ...args), ctx.errors).toBe(0);
    expect(deletesData(s)).toBe(true);
    expect(ctx.output).toContain("(confirmed with --confirm shop)");
  });

  it("--confirm needs the right name and the data plan's hash", async () => {
    const s = await setup({ enabled: true });
    const hashes = await plannedDeletion(s);
    const wrong = s.context();
    const approve = hashes.flatMap((h) => ["--approve", h]);
    expect(await run(wrong, "portainer", "disable", ...approve, "--confirm", "shopx")).toBe(1);
    expect(wrong.errors).toContain("does not match the app's name");
    expect(s.host.applies).toEqual([]);

    // The data plan's hash left out: the removal may run, the data is never deleted.
    const partial = s.context();
    const first = ["--approve", hashes[0] as string];
    expect(await run(partial, "portainer", "disable", ...first, "--confirm", "shop", "--yes")).toBe(
      1,
    );
    expect(deletesData(s)).toBe(false);
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
