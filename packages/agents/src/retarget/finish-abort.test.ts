import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { previewDeploymentFiles } from "../provision";
import { readServerAddresses, serverAddressesFile } from "../shared";
import {
  APP,
  cliAnswer,
  DOMAIN,
  type MoveHarness,
  moveHarness,
  OLD_IDS,
  OLD_IPV4,
  OLD_IPV6,
  STRIPE,
  TOKENS,
} from "../testing";
import {
  caught,
  crashAfter,
  drive,
  everythingPrinted,
  expectGated,
  moveOnDisk,
  run,
  trail,
} from "./__fixtures__/assert";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";
import type { AbortRetargetOptions, FinishRetargetOptions } from "./types";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function finish(h: MoveHarness, options: FinishRetargetOptions = {}) {
  return finishRetarget(h.deps, { services: h.services, confirm: h.confirm, ...options });
}

function abort(h: MoveHarness, options: AbortRetargetOptions = {}) {
  return abortRetarget(h.deps, { services: h.services, confirm: h.confirm, ...options });
}

/** From here on the harness answers like `opscrew retarget … --confirm shop` in a script. */
function scripted(h: MoveHarness): void {
  h.deps.interactive = false;
  h.cli.confirm = APP;
  h.handler.answer = cliAnswer(() => h.cli);
}

/** Events since `mark` (an index into the trail). */
function since(h: MoveHarness, mark: number) {
  return h.events.slice(mark);
}

const git = new NodeCommandRunner();

describe.skipIf(!findExecutable("git"))("finishRetarget", () => {
  it("US2-1: deletes only the old server after a snapshot and the typed name, then publishes", async () => {
    const h = await moveHarness();
    await run(h);
    // The old module files were committed by `opscrew provision`; the final PR deletes them.
    await git.run("git", ["-C", h.root, "add", "opscrew/infra/modules/hetzner-vps"]);
    await git.run("git", ["-C", h.root, "commit", "-q", "-m", "provisioned"]);
    const mark = h.events.length;

    const result = await finish(h);
    expect(result).toMatchObject({ step: "finished", done: true, snapshotId: "snap-4711" });
    expect(trail(since(h, mark))).toEqual([
      `${h.newServer.ipv4} start caddy`,
      `confirm ${APP}`,
      "snapshot 4711",
      "approve iac-apply",
      "apply updates=1",
      "approve iac-apply",
      "apply deletes=3",
      "approve git-push",
      "approve pull-request",
    ]);
    expectGated(h.events, true);
    const lift = h.engine.plans.find((p) => p.effect.unprotects.length > 0);
    expect(lift?.effect.unprotects).toEqual(["server_previous"]);
    expect(h.events.find((e) => e.type === "plan" && e.vars.includes("protection"))).toMatchObject({
      vars: '{"previous_delete_protection":"false"}',
    });
    const deleted = h.events.findLast((e) => e.type === "apply");
    expect(
      deleted?.type === "apply" &&
        deleted.deletes.every((a) => a.startsWith("module.server_previous.")),
    ).toBe(true);

    expect(Object.keys(h.engine.state.servers)).toEqual(["server"]);
    expect(h.engine.state.servers.server?.provider).toBe("digitalocean");
    const knownHosts = await readFile(h.paths.files.knownHosts, "utf8");
    expect(knownHosts).not.toContain(OLD_IPV4);
    expect(knownHosts).toContain(h.newServer.ipv4);

    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.retarget).toBeUndefined();
    expect(plan.target.provider).toBe("digitalocean");
    // The new server receives the traffic; its address stays in the local state only.
    expect(await readServerAddresses(h.paths)).toEqual({
      schemaVersion: 1,
      deployment: { ipv4: h.newServer.ipv4, ipv6: h.newServer.ipv6 },
    });
    expect(plan.approvals).toHaveLength(5);

    const main = await readFile(join(h.root, "opscrew/infra/prod/main.tf"), "utf8");
    expect(main).not.toContain("server_previous");
    expect(main).not.toContain('provider "hcloud"');
    expect(main).not.toContain("moved {");
    expect(await exists(join(h.root, "opscrew/infra/modules/hetzner-vps"))).toBe(false);
    expect(await exists(join(h.root, "opscrew/infra/modules/digitalocean-droplet/main.tf"))).toBe(
      true,
    );
    expect(h.github.pulls).toEqual([
      expect.objectContaining({ head: "opscrew/deploy-setup", base: "main" }),
    ]);
    const tree = await git.run("git", [
      "-C",
      h.bare,
      "ls-tree",
      "-r",
      "--name-only",
      "opscrew/deploy-setup",
    ]);
    expect(tree.stdout).toContain("opscrew/infra/modules/digitalocean-droplet/main.tf");
    expect(tree.stdout).not.toContain("hetzner-vps");
    expect(tree.stdout).toContain("opscrew/plan.yaml");
    // Neither the published files nor the pull request name either server's address.
    const published = await git.run("git", ["-C", h.bare, "show", "opscrew/deploy-setup"]);
    const files = await git.run("git", [
      "-C",
      h.bare,
      "grep",
      "-I",
      "-e",
      ".",
      "opscrew/deploy-setup",
    ]);
    expect(files.stdout).toContain("opscrew/deploy-setup:opscrew/plan.yaml:");
    for (const ip of [OLD_IPV4, OLD_IPV6, h.newServer.ipv4, h.newServer.ipv6]) {
      expect(published.stdout).not.toContain(ip);
      expect(files.stdout).not.toContain(ip);
      expect(h.github.pulls[0]?.body).not.toContain(ip);
    }
    expect(await exists(join(h.paths.stateDir, "retarget-snapshot.json"))).toBe(false);
    expect((await h.deps.state.read()).phases.retarget?.status).toBe("ok");
    expect(result.next.join(" ")).toContain("https://github.com/acme/shop/pull/7");
    expect(result.next.join(" ")).toContain("Hetzner image snap-4711");
    expect(h.audit.entries.some((e) => e.action === "retarget finished")).toBe(true);
    const printed = everythingPrinted(h);
    for (const secret of [STRIPE, ...Object.values(TOKENS)]) expect(printed).not.toContain(secret);
  });

  it("says the final files were not published when an earlier run's pull request is in the way", async () => {
    const h = await moveHarness();
    await run(h);
    // An earlier run's branch (pushed from another clone) with an open pull request.
    await git.run("git", [
      "-C",
      h.root,
      "push",
      "-q",
      "origin",
      "HEAD:refs/heads/opscrew/deploy-setup",
    ]);
    const open = { number: 5, url: "https://github.com/acme/shop/pull/5" };
    h.github.openPulls.set("opscrew/deploy-setup", open);
    const before = await git.run("git", ["-C", h.root, "rev-parse", "HEAD"]);

    const result = await finish(h);

    expect(result).toMatchObject({ step: "finished", done: true });
    const text = h.reporter.text();
    expect(text).toContain(
      `The move is finished, but the final files were not published; the pull request ${open.url} from an earlier OpsCrew run is still open`,
    );
    expect(text).not.toContain("opscrew provision");
    expect(text).not.toContain("did not change anything");
    expect(result.next[0]).toBe(
      "Merge or close it on GitHub, then commit the changed files under opscrew/ on a new branch and open a pull request yourself, so the repository describes the deployment.",
    );
    expect(h.github.pulls).toEqual([]);
    expect((await git.run("git", ["-C", h.root, "rev-parse", "HEAD"])).stdout).toBe(before.stdout);
  });

  it("deletes an old DigitalOcean Droplet without a protection step", async () => {
    const h = await moveHarness({ from: "digitalocean" });
    await run(h);
    const mark = h.events.length;
    const result = await finish(h, { snapshot: false });
    expect(result.snapshotId).toBeUndefined();
    expect(trail(since(h, mark)).filter((line) => !line.startsWith("approve git"))).toEqual([
      `${h.newServer.ipv4} start caddy`,
      `confirm ${APP}`,
      "approve iac-apply",
      "apply deletes=4",
      "approve pull-request",
    ]);
    expect(h.engine.plans.some((p) => p.effect.unprotects.length > 0)).toBe(false);
    expect(
      h.events.filter((e) => e.type === "plan").every((e) => e.type === "plan" && e.vars === "{}"),
    ).toBe(true);
    expectGated(h.events, true);
    const variables = await readFile(join(h.root, "opscrew/infra/prod/variables.tf"), "utf8");
    expect(variables).toContain('variable "delete_protection"');
    expect(variables).not.toContain("previous_");
    expect((await readArtifact("plan", h.paths.files.plan)).retarget).toBeUndefined();
  });

  it("US3: a script finishes with --confirm and one --approve per plan", async () => {
    const h = await moveHarness();
    await run(h);
    scripted(h);
    const first = await finish(h, { confirm: async () => true });
    expect(first).toMatchObject({ step: "switched", done: false });
    const lift = first.pendingPlanHash as string;
    expect(first.next.join(" ")).toContain(
      `opscrew retarget --finish --confirm ${APP} --approve ${lift}`,
    );
    h.cli.approve = lift;
    const second = await finish(h, { confirm: async () => true, approvePlanHash: lift });
    expect(second).toMatchObject({ step: "switched", done: false });
    const removal = second.pendingPlanHash as string;
    expect(removal).not.toBe(lift);
    h.cli.approve = removal;
    const last = await finish(h, { confirm: async () => true, approvePlanHash: removal });
    expect(last).toMatchObject({ step: "finished", done: true, snapshotId: "snap-4711" });
    // One snapshot, reused by the later runs.
    expect(h.events.filter((e) => e.type === "snapshot")).toHaveLength(1);
    expectGated(h.events);
    expect(Object.keys(h.engine.state.servers)).toEqual(["server"]);
  });

  it("refuses before the switch, and without the typed name deletes nothing", async () => {
    const h = await moveHarness();
    crashAfter(h, "deployed");
    await expect(run(h)).rejects.toThrow("interrupted");
    const early = await caught(finish(h));
    expect(early.code).toBe("PHASE_PRECONDITION");
    expect(early.message).toContain("Traffic does not go to the new server yet");
    expect(early.hint).toContain("opscrew retarget --abort");

    await run(h);
    const mark = h.events.length;
    const refused = await caught(finish(h, { confirm: async () => false }));
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(trail(since(h, mark))).toEqual([`${h.newServer.ipv4} start caddy`]);
    expect(h.engine.state.servers.server_previous).toBeDefined();
    expect((await moveOnDisk(h))?.step).toBe("switched");
  });

  it("after an interruption at the switch, starts Caddy and checks the app before deleting", async () => {
    const h = await moveHarness();
    const n = h.newServer.ipv4;
    crashAfter(h, "switched");
    await expect(run(h)).rejects.toThrow("interrupted");
    expect(h.hosts.host(n).caddy).toBe(false);
    const mark = h.events.length;
    await finish(h);
    const events = since(h, mark);
    const lines = trail(events);
    expect(lines[0]).toBe(`${n} start caddy`);
    const checked = events.findIndex((e) => e.type === "fetch" && e.url.startsWith("https://"));
    const confirmed = events.findIndex((e) => e.type === "confirm");
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(checked).toBeLessThan(confirmed);
    expect(h.engine.state.servers.server_previous).toBeUndefined();
  });

  it("a switch made by hand, local record gone: deletes the old server and keeps the new app", async () => {
    // Without managed DNS no `switched` layout was applied: the state's live server is the old one.
    const h = await moveHarness({ dns: "none", postgres: false });
    const n = h.newServer.ipv4;
    crashAfter(h, "switched");
    await expect(run(h)).rejects.toThrow("interrupted");
    await rm(serverAddressesFile(h.paths));
    const mark = h.events.length;
    expect(await finish(h)).toMatchObject({ step: "finished", done: true });
    const lines = trail(since(h, mark));
    expect(lines.slice(0, 2)).toEqual([`${n} start caddy`, `${OLD_IPV4} stop app`]);
    expect(lines.filter((line) => line.startsWith(n))).toEqual([`${n} start caddy`]);
    expect(h.engine.state.servers).toEqual({
      server: expect.objectContaining({ provider: "digitalocean", ipv4: n }),
    });
    expect(h.hosts.host(n)).toMatchObject({ app: true, caddy: true });
    const knownHosts = await readFile(h.paths.files.knownHosts, "utf8");
    expect(knownHosts).not.toContain(OLD_IPV4);
    expect(knownHosts).toContain(n);
    expect(await readServerAddresses(h.paths)).toEqual({
      schemaVersion: 1,
      deployment: { ipv4: n, ipv6: h.newServer.ipv6 },
    });
  });

  it("finishes once the old server is gone even when this computer lost its address", async () => {
    const h = await moveHarness();
    await run(h);
    // The old server was deleted (an earlier finish, or by hand) and .opscrew/server.json is lost.
    delete h.engine.state.servers.server_previous;
    const servers = h.engine.state.outputs.servers as Record<string, unknown>;
    delete servers.hetzner;
    await rm(serverAddressesFile(h.paths));
    const mark = h.events.length;

    const result = await finish(h);

    expect(result).toMatchObject({ step: "finished", done: true });
    expect(trail(since(h, mark)).filter((line) => line.startsWith("apply"))).toEqual([]);
    const text = h.reporter.text();
    expect(text).toContain("The old server is already deleted; OpsCrew finishes the cleanup.");
    expect(text).toContain("its SSH host key stays in OpsCrew's known_hosts");
    expect((await readArtifact("plan", h.paths.files.plan)).retarget).toBeUndefined();
    expect(await readServerAddresses(h.paths)).toEqual({
      schemaVersion: 1,
      deployment: { ipv4: h.newServer.ipv4, ipv6: h.newServer.ipv6 },
    });
  });

  it("does not delete anything of an old server whose address this computer does not know", async () => {
    const h = await moveHarness();
    await run(h);
    const servers = h.engine.state.outputs.servers as Record<string, unknown>;
    delete servers.hetzner;
    await rm(serverAddressesFile(h.paths));
    const mark = h.events.length;

    const error = await caught(finish(h));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("the address of the server being replaced is neither");
    expect(error.hint).toContain("opscrew retarget --finish");
    expect(
      trail(since(h, mark)).filter((line) => line.startsWith("apply") || line.startsWith("snap")),
    ).toEqual([]);
    expect(h.engine.state.servers.server_previous).toBeDefined();
  });

  it("keeps the old server while the new one does not answer", async () => {
    const h = await moveHarness();
    const n = h.newServer.ipv4;
    crashAfter(h, "switched");
    await expect(run(h)).rejects.toThrow("interrupted");
    h.hosts.fail = (ip, op) =>
      ip === n && op === "start caddy"
        ? { exitCode: 1, stdout: "", stderr: "port 443 busy" }
        : undefined;
    const mark = h.events.length;
    const error = await caught(finish(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("does not serve the app yet: starting Caddy there failed");
    expect(error.message).toContain("OpsCrew keeps the old server; nothing was deleted.");
    expect(error.hint).toContain("run `opscrew retarget` to check again");
    expect(error.hint).not.toContain("--finish");
    expect(trail(since(h, mark)).filter((line) => !line.endsWith("start caddy"))).toEqual([]);
    expect(h.engine.state.servers.server_previous).toBeDefined();

    // The same check on `opscrew retarget` never suggests finishing while the app does not answer.
    h.hosts.fail = undefined;
    h.hosts.host(n).app = false;
    const stuck = await caught(run(h));
    expect(stuck.message).toContain("did not answer");
    expect(stuck.hint).not.toContain("--finish");
    h.hosts.host(n).app = true;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    // With Cloudflare the applied DNS plan is the proof: the domain is never resolved.
    expect(h.events.some((e) => e.type === "resolve")).toBe(false);
  });

  it("without managed DNS, keeps the old server until the domain resolves to the new one", async () => {
    const h = await moveHarness({ dns: "other", interactive: false });
    const n = h.newServer.ipv4;
    await drive(h, { allowDowntime: true });
    // `--dns-switched` although the domain still resolves to the old server (which would answer
    // if its app ran): the switch is recorded but not settled, and finish refuses.
    h.hosts.host(OLD_IPV4).app = true;
    const early = await caught(run(h, { dnsSwitched: true }));
    expect(early.message).toContain("does not serve the app yet");
    expect(early.message).toContain(`${DOMAIN} resolves to ${OLD_IPV4} from this computer`);
    expect(early.hint).toContain(`Change the DNS records of ${DOMAIN} to ${n}`);
    expect(early.hint).not.toContain("--finish");
    expect(h.events.some((e) => e.type === "fetch" && e.url.includes(DOMAIN))).toBe(false);
    expect((await moveOnDisk(h))?.step).toBe("switched");

    scripted(h);
    const refused = await caught(finish(h, { confirm: async () => true }));
    expect(refused.code).toBe("PHASE_PRECONDITION");
    expect(refused.message).toContain(`${DOMAIN} resolves to ${OLD_IPV4}`);
    expect(refused.message).toContain("OpsCrew keeps the old server; nothing was deleted.");
    expect(h.engine.state.servers.server_previous).toBeDefined();
    expect(h.events.some((e) => e.type === "snapshot" || e.type === "confirm")).toBe(false);

    // Once the domain resolves to the new server the move settles and can be finished.
    h.manual.ip = n;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    const first = await finish(h, { confirm: async () => true });
    expect(first.pendingPlanHash).toBeDefined();
  });

  it("an interrupted finish continues with what is left", async () => {
    const h = await moveHarness();
    await run(h);
    h.engine.failApply = (effect) =>
      effect.destroys.length > 0 ? "Error: DigitalOcean API timeout" : undefined;
    const error = await caught(finish(h));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.hint).toContain("opscrew retarget --finish");
    h.engine.failApply = undefined;
    const result = await finish(h);
    expect(result).toMatchObject({ step: "finished", snapshotId: "snap-4711" });
    expect(h.events.filter((e) => e.type === "snapshot")).toHaveLength(1);
    expect(h.engine.state.servers.server_previous).toBeUndefined();
  });

  it.each([
    {
      what: "a resource outside the old server's module",
      address: "module.dns.cloudflare_dns_record.a",
      says: "would do more than delete resources under module.server_previous.",
    },
    {
      what: "an old-server resource that was not in the confirmed list",
      address: "module.server_previous.hcloud_volume.data",
      says: "now deletes resources that were not in the list you confirmed",
    },
  ])("FR-509: stops when the removal plan deletes $what", async ({ address, says }) => {
    const h = await moveHarness();
    await run(h);
    let removals = 0;
    h.engine.tamper = (effect) => {
      // The first plan without the old module is the preview; the second one is applied.
      if (!effect.destroys.includes("server_previous") || ++removals < 2) return;
      effect.changes.push({
        address,
        type: address.split(".").at(-2) as string,
        name: address.split(".").at(-1) as string,
        provider: "registry.opentofu.org/hetznercloud/hcloud",
        action: "delete",
      });
    };
    const mark = h.events.length;
    const error = await caught(finish(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(says);
    expect(error.message).toContain("Nothing was deleted.");
    expect(error.message).toContain("Hetzner image snap-4711");
    expect(trail(since(h, mark)).filter((line) => line.startsWith("apply"))).toEqual([
      "apply updates=1",
    ]);
    expect(h.engine.state.servers.server_previous).toBeDefined();
    expect((await moveOnDisk(h))?.step).toBe("switched");
    expect(await exists(join(h.paths.stateDir, "retarget-pending.json"))).toBe(false);
  });
});

describe.skipIf(!findExecutable("git"))("abortRetarget", () => {
  it.each(["started", "renamed", "created", "deployed", "migrated"])(
    "US2-2: aborts after %s and restores the previous deployment exactly",
    async (step) => {
      const h = await moveHarness();
      crashAfter(h, step);
      await expect(run(h)).rejects.toThrow("interrupted");
      const mark = h.events.length;

      const result = await abort(h);
      expect(result).toMatchObject({ step: "aborted", done: true });
      const lines = trail(since(h, mark));
      if (step === "migrated") expect(lines[0]).toBe(`${OLD_IPV4} start app`);
      const created = !["started", "renamed"].includes(step);
      expect(lines.filter((line) => line.startsWith("apply"))).toEqual(
        step === "started"
          ? []
          : created
            ? ["apply deletes=4", "apply moves=3"]
            : ["apply moves=3"],
      );
      expect(lines.includes("approve github-secrets")).toBe(created);
      expectGated(h.events, true);

      // The state, DNS, plan, secrets, host keys, files and the running app are as before.
      expect(h.engine.state.servers).toEqual({
        server: expect.objectContaining({
          id: OLD_IDS.hetzner,
          provider: "hetzner",
          protected: true,
        }),
      });
      expect(h.engine.dnsServer()?.ipv4).toBe(OLD_IPV4);
      const plan = await readArtifact("plan", h.paths.files.plan);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target).toEqual(h.plan.target);
      expect(plan.cost.monthly.currency).toBe("EUR");
      expect(plan.cost.breakdown[0]?.item).toBe("Server cx23 (nbg1)");
      expect(plan.deployment.url).toBe(h.plan.deployment.url);
      expect(await readServerAddresses(h.paths)).toEqual({
        schemaVersion: 1,
        deployment: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 },
      });
      if (created) expect(h.github.secrets.get("OPSCREW_HOST")).toBe(OLD_IPV4);
      expect(await readFile(h.paths.files.knownHosts, "utf8")).not.toContain(h.newServer.ipv4);
      expect(h.hosts.host(OLD_IPV4).app).toBe(true);
      const preview = await previewDeploymentFiles(h.deps, {
        services: { cloudflare: h.services.cloudflare ?? null },
      });
      expect(preview.changed).toEqual([]);
      expect(preview.created.filter((path) => path.startsWith("opscrew/infra/"))).toEqual([]);
      expect(await exists(join(h.root, "opscrew/infra/modules/digitalocean-droplet"))).toBe(false);
      expect((await h.deps.state.read()).phases.retarget?.status).toBe("skipped");
      expect(await exists(join(h.paths.stateDir, "retarget-pending.json"))).toBe(false);
    },
  );

  it("restores the deploy settings and the image build the move changed for the new server", async () => {
    const h = await moveHarness();
    const before = await readArtifact("plan", h.paths.files.plan);
    const deploy = { strategy: "recreate" as const, drainSeconds: 45 };
    const build = {
      builder: "buildpacks" as const,
      chosen: "auto" as const,
      reason: "Before the move.",
      runtime: { language: "node" as const, version: "24" },
    };
    await writeArtifact("plan", h.paths.files.plan, {
      ...before,
      app: { ...before.app, build },
      deploy,
    });
    crashAfter(h, "created");
    await expect(run(h)).rejects.toThrow("interrupted");
    const moving = await readArtifact("plan", h.paths.files.plan);
    expect(moving.deploy).toEqual({ strategy: "rolling", drainSeconds: 45 });
    expect(moving.app.build?.builder).toBe("generated-dockerfile");
    expect(moving.retarget?.from).toMatchObject({ deploy, build });

    expect(await abort(h)).toMatchObject({ step: "aborted", done: true });
    const restored = await readArtifact("plan", h.paths.files.plan);
    expect(restored.deploy).toEqual(deploy);
    expect(restored.app.build).toEqual(build);
  });

  it("lifts a new Hetzner server's protection before deleting it", async () => {
    const h = await moveHarness({ from: "digitalocean" });
    crashAfter(h, "created");
    await expect(run(h)).rejects.toThrow("interrupted");
    const mark = h.events.length;
    await abort(h);
    expect(trail(since(h, mark))).toEqual([
      `confirm ${APP}`,
      "approve iac-apply",
      "apply updates=1",
      "approve iac-apply",
      "apply deletes=3",
      "approve github-secrets",
      "approve iac-apply",
      "apply moves=4",
    ]);
    expect(h.events.find((e) => e.type === "plan" && e.vars.includes("protection"))).toMatchObject({
      vars: '{"delete_protection":"false"}',
    });
    expectGated(h.events, true);
    expect(h.engine.state.servers).toEqual({
      server: expect.objectContaining({ provider: "digitalocean" }),
    });
    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.target.provider).toBe("digitalocean");
    expect(plan.cost.monthly.currency).toBe("USD");
  });

  it.each([
    { what: "finish's lift also changes the new server", side: "finish", other: "server" },
    { what: "abort's lift also changes the old server", side: "abort", other: "server_previous" },
  ])("stops before any approval when $what", async ({ side, other }) => {
    const h = await moveHarness(side === "finish" ? {} : { from: "digitalocean" });
    if (side === "finish") {
      await run(h);
    } else {
      crashAfter(h, "created");
      await expect(run(h)).rejects.toThrow("interrupted");
    }
    const address = `module.${other}.hcloud_server.this`;
    h.engine.tamper = (effect) => {
      if (effect.unprotects.length === 0) return;
      // Only the other server's protection: allowed on its own, but outside the removal's module.
      effect.changes.push({
        address,
        type: "hcloud_server",
        name: "this",
        provider: "registry.opentofu.org/hetznercloud/hcloud",
        action: "update",
      });
      const before = { id: "1", name: APP, delete_protection: true, rebuild_protection: true };
      const after = { ...before, delete_protection: false, rebuild_protection: false };
      (effect.planJson as { resource_changes: unknown[] }).resource_changes.push({
        address,
        type: "hcloud_server",
        change: { actions: ["update"], before, after, after_unknown: {} },
      });
    };
    const mark = h.events.length;
    const error = await caught(side === "finish" ? finish(h) : abort(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("would also change other things");
    expect(error.message).toContain(`update ${address}`);
    expect(error.message).toContain("Nothing was deleted.");
    const gated = trail(since(h, mark)).filter(
      (line) => line.startsWith("approve iac-apply") || line.startsWith("apply"),
    );
    expect(gated).toEqual([]);
  });

  it.each([
    {
      what: "a resource outside the new server's module",
      address: "module.server_previous.hcloud_firewall.this",
      says: "would do more than delete resources under module.server.",
    },
    {
      what: "a new-server resource that was not in the confirmed list",
      address: "module.server.digitalocean_volume.data",
      says: "now deletes resources that were not in the list you confirmed",
    },
  ])("FR-509: stops when the abort's removal plan deletes $what", async ({ address, says }) => {
    const h = await moveHarness();
    crashAfter(h, "created");
    await expect(run(h)).rejects.toThrow("interrupted");
    let removals = 0;
    h.engine.tamper = (effect) => {
      // The first plan without the new module is the preview; the second one is applied.
      if (!effect.destroys.includes("server") || ++removals < 2) return;
      effect.changes.push({
        address,
        type: address.split(".").at(-2) as string,
        name: address.split(".").at(-1) as string,
        provider: "registry.opentofu.org/digitalocean/digitalocean",
        action: "delete",
      });
    };
    const mark = h.events.length;
    const error = await caught(abort(h, { confirm: async () => true }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(says);
    expect(error.message).toContain("Nothing was deleted.");
    expect(error.hint).toContain("opscrew retarget --abort");
    expect(trail(since(h, mark)).filter((line) => line.startsWith("apply"))).toEqual([]);
    expect(h.engine.state.servers.server).toBeDefined();
    expect(await exists(join(h.paths.stateDir, "retarget-pending.json"))).toBe(false);
  });

  it("US2-3: refuses after the switch and says the way back is another move", async () => {
    const h = await moveHarness();
    await run(h);
    const error = await caught(abort(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("can no longer be aborted");
    expect(error.hint).toContain("opscrew retarget --finish");
    expect(error.hint).toContain("opscrew retarget --to hetzner");
    expect(h.engine.state.servers.server_previous).toBeDefined();
  });

  it("US3: a script aborts with --confirm and one --approve per plan", async () => {
    const h = await moveHarness();
    crashAfter(h, "deployed");
    await expect(run(h)).rejects.toThrow("interrupted");
    scripted(h);
    const first = await abort(h, { confirm: async () => true });
    expect(first).toMatchObject({ step: "deployed", done: false });
    expect(first.next.join(" ")).toContain(
      `opscrew retarget --abort --confirm ${APP} --approve ${first.pendingPlanHash}`,
    );
    expect((await moveOnDisk(h))?.abort).toEqual({ step: "started" });
    h.cli.approve = first.pendingPlanHash;
    const second = await abort(h, {
      confirm: async () => true,
      approvePlanHash: first.pendingPlanHash as string,
    });
    expect(second).toMatchObject({ done: false });
    expect((await moveOnDisk(h))?.abort).toEqual({ step: "secrets-restored" });
    h.cli.approve = second.pendingPlanHash;
    const last = await abort(h, {
      confirm: async () => true,
      approvePlanHash: second.pendingPlanHash as string,
    });
    expect(last).toMatchObject({ step: "aborted", done: true });
    expectGated(h.events);
    expect(h.github.secrets.get("OPSCREW_HOST")).toBe(OLD_IPV4);
  });

  it("starts the old app before checking anything else", async () => {
    const h = await moveHarness();
    crashAfter(h, "migrated");
    await expect(run(h)).rejects.toThrow("interrupted");
    expect(h.hosts.host(OLD_IPV4).app).toBe(false);
    h.services.providers = {
      ...h.services.providers,
      digitalocean: { configured: true, verify: async () => ({ ok: false, message: "revoked" }) },
    };
    const error = await caught(abort(h));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    // The old app took writes again, so the copy is stale: the move went back before the window.
    const state = await moveOnDisk(h);
    expect(state?.oldAppStoppedAt).toBeUndefined();
    expect(state?.step).toBe("deployed");
    expect(state?.abort).toBeUndefined();

    // Continuing instead copies the database again before any DNS change.
    h.services.providers = {
      ...h.services.providers,
      digitalocean: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    };
    const mark = h.events.length;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    const lines = trail(h.events.slice(mark));
    const windowAt = lines.indexOf("approve remote-exec");
    const dumpAt = lines.indexOf(`${OLD_IPV4} dump`);
    const dnsAt = lines.indexOf("apply updates=2");
    expect(windowAt).toBeGreaterThanOrEqual(0);
    expect(dumpAt).toBeGreaterThan(windowAt);
    expect(dnsAt).toBeGreaterThan(dumpAt);
    expect(h.events.filter((e) => e.type === "remote" && e.op === "dump")).toHaveLength(2);
  });

  it("with the local record gone too, starts the app on the old server (from the state)", async () => {
    const h = await moveHarness();
    crashAfter(h, "migrated");
    await expect(run(h)).rejects.toThrow("interrupted");
    expect(h.hosts.host(OLD_IPV4).app).toBe(false);
    await rm(serverAddressesFile(h.paths));
    // No working provider token is needed to start the old app again.
    h.services.providers = {
      ...h.services.providers,
      digitalocean: { configured: true, verify: async () => ({ ok: false, message: "revoked" }) },
    };
    const mark = h.events.length;
    const error = await caught(abort(h));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(trail(since(h, mark))).toEqual([`${OLD_IPV4} start app`]);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    expect(h.hosts.host(h.newServer.ipv4).db).toBe("orders before the move");
    expect((await readServerAddresses(h.paths)).retarget).toEqual({
      from: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 },
      next: { ipv4: h.newServer.ipv4, ipv6: h.newServer.ipv6 },
    });
  });

  it("an abort whose old-app start fails still forces a fresh copy before any switch", async () => {
    const h = await moveHarness();
    crashAfter(h, "migrated");
    await expect(run(h)).rejects.toThrow("interrupted");
    h.hosts.fail = (ip, op) =>
      ip === OLD_IPV4 && op === "start app"
        ? { exitCode: 1, stdout: "", stderr: "docker is not running" }
        : undefined;
    const error = await caught(abort(h));
    expect(error.message).toContain("Your app is offline");
    const state = await moveOnDisk(h);
    // Back before the window first, the mark kept: whatever happens next, the copy is redone.
    expect(state?.step).toBe("deployed");
    expect(state?.oldAppStoppedAt).toBeDefined();

    // The user starts the app by hand (it takes writes again), then continues the move.
    h.hosts.fail = undefined;
    h.hosts.host(OLD_IPV4).app = true;
    const mark = h.events.length;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    const lines = trail(h.events.slice(mark));
    const windowAt = lines.indexOf("approve remote-exec");
    const dumpAt = lines.indexOf(`${OLD_IPV4} dump`);
    expect(windowAt).toBeGreaterThanOrEqual(0);
    expect(dumpAt).toBeGreaterThan(windowAt);
    expect(lines.indexOf("apply updates=2")).toBeGreaterThan(dumpAt);
    expect(h.events.filter((e) => e.type === "remote" && e.op === "dump")).toHaveLength(2);
  });

  it("US2-2: refusing the typed name leaves the move as it was (it can continue)", async () => {
    const h = await moveHarness();
    crashAfter(h, "created");
    await expect(run(h)).rejects.toThrow("interrupted");
    const refused = await caught(abort(h, { confirm: async () => false }));
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect((await moveOnDisk(h))?.abort).toBeUndefined();
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
  });

  it("once an abort changed something, the move can only be aborted", async () => {
    const h = await moveHarness();
    crashAfter(h, "created");
    await expect(run(h)).rejects.toThrow("interrupted");
    // Typed name given, then the removal plan refused: the abort has begun.
    h.handler.answer = (r) => !(r.kind === "iac-apply" && r.allowDestroy === true);
    await caught(abort(h));
    expect((await moveOnDisk(h))?.abort).toEqual({ step: "started" });
    const error = await caught(run(h));
    expect(error.message).toContain("is being aborted");
    expect(error.hint).toContain("opscrew retarget --abort");
    const finishing = await caught(finish(h));
    expect(finishing.message).toContain("being aborted");
    h.handler.answer = () => true;
    expect(await abort(h)).toMatchObject({ step: "aborted", done: true });
  });

  it("a DNS switch that failed half-way: the error says so, and abort points DNS back first", async () => {
    const h = await moveHarness();
    const n = h.newServer.ipv4;
    // The apply updates the records, then fails (e.g. a timeout on the last request).
    h.engine.failApply = (effect) => {
      if (effect.dnsTo === undefined) return undefined;
      h.engine.state.dns = effect.dnsTo;
      return "Error: Cloudflare API timeout";
    };
    const failed = await caught(run(h));
    expect(failed.message).toContain("The switch failed");
    expect(failed.message).toContain(`may already point at the new server (${n}`);
    expect(failed.message).toContain("opscrew retarget --abort` points them back");
    expect(h.engine.dnsServer()?.ipv4).toBe(n);
    expect((await moveOnDisk(h))?.step).toBe("deployed");
    h.engine.failApply = undefined;

    const mark = h.events.length;
    expect(await abort(h)).toMatchObject({ step: "aborted", done: true });
    const lines = trail(since(h, mark));
    expect(lines.filter((line) => line.startsWith("apply"))).toEqual([
      "apply updates=2",
      "apply deletes=4",
      "apply moves=3",
    ]);
    expect(lines.indexOf("apply updates=2")).toBeLessThan(lines.indexOf(`confirm ${APP}`));
    expect(h.engine.dnsServer()?.ipv4).toBe(OLD_IPV4);
    expectGated(h.events, true);
    // Neither the switch nor the restore of the DNS records costs money: no cost change claimed.
    const dnsApprovals = h.handler.requests.filter(
      (r) => r.kind === "iac-apply" && r.title.includes("0 to create, 2 to update"),
    );
    expect(dnsApprovals).toHaveLength(2);
    for (const request of dnsApprovals) {
      expect(request.costDelta).toBeUndefined();
      expect(request.details).toContain("Cost: unchanged");
      expect(request.details).not.toContain("Estimated cost");
    }
  });
});
