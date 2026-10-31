import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { renderEdgeSite } from "@opscrew/iac-templates";
import { DeployPlanSchema, readArtifact, serviceOf, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { selfHostedServices } from "../design/sizing";
import { recordedEdge, siteContext } from "../provision/render";
import { lastHostSetup, passwordLoginChoice, recordOwnServer } from "../shared";
import { CF_V4, CF_V6, ownCloudflare, ownPlan, withOtherApp } from "../testing";
import {
  ED25519_FINGERPRINT,
  everythingPrinted,
  LAN_IPV4,
  OWN_IPV4,
  type OwnProject,
  ownProject,
  provisionOwn,
} from "./__fixtures__/own-project";
import { expectedRuntimeFiles, type HostDifference } from "./host";
import { driftNextSteps, renderDriftReport } from "./render";
import { runDrift } from "./run";
import type { DriftReport } from "./types";

/** Changes the fake server's facts as someone working on the server would. */
function edit(s: OwnProject, change: (facts: OwnProject["host"]["facts"]) => void): void {
  const facts = structuredClone(s.host.facts);
  change(facts);
  s.host.facts = HostFactsSchema.parse(facts);
}

/** A WireGuard public key for the tests: 32 bytes of 1, in base64 (never a real key). */
const WG_KEY = Buffer.alloc(32, 1).toString("base64");

const details = (report: Awaited<ReturnType<typeof runDrift>>) =>
  (report.host?.differences ?? []).map((d) => `${d.area}: ${d.detail}`);

describe.skipIf(!findExecutable("git"))("runDrift: the kernel settings of the services", () => {
  it("reports vm.max_map_count lowered on the server, which provision raises again", async () => {
    const base = ownPlan({ access: "public" });
    const plan = DeployPlanSchema.parse({
      ...base,
      services: [
        ...base.services,
        {
          kind: "opensearch",
          version: "3.9",
          memoryMb: 1024,
          reason: "The app uses OpenSearch.",
          licence: "Apache-2.0",
        },
      ],
    });
    const s = await ownProject({ plan });
    await provisionOwn(s);
    expect((await runDrift(s.deps, { services: s.services })).host).toEqual({ differences: [] });
    edit(s, (f) => {
      f.sysctl.live["vm.max_map_count"] = 65530;
    });
    const [difference, ...rest] =
      (await runDrift(s.deps, { services: s.services })).host?.differences ?? [];
    expect(rest).toEqual([]);
    expect(difference).toMatchObject({
      area: "sysctl",
      detail:
        "The kernel's vm.max_map_count is below the 262144 the app's services need, or /etc/sysctl.d/90-opscrew.conf no longer keeps it.",
      restoredByProvision: true,
    });
  });
});

describe.skipIf(!findExecutable("git"))("runDrift on a server the user owns", () => {
  it("public mode: a prepared server is clean; the address reaches the engine only as TF_VAR_*", async () => {
    const s = await ownProject();
    await provisionOwn(s);
    const applies = { engine: s.engine.applies.length, host: s.host.applies.length };
    s.engine.plans.length = 0;

    const report = await runDrift(s.deps, { services: s.services });

    expect(report.provider).toBe("own");
    expect(report.host).toEqual({ differences: [] });
    expect(report).toMatchObject({ drift: [], pending: [], clean: true });
    expect(report.files).toEqual({ changed: [], created: [] });
    // Both drift plans ran with the address in the environment only.
    expect(s.engine.plans.map((p) => p.env.TF_VAR_server_ipv4)).toEqual([OWN_IPV4, OWN_IPV4]);
    // Read-only: nothing applied anywhere; the server was only inspected.
    expect(s.engine.applies).toHaveLength(applies.engine);
    expect(s.host.applies).toHaveLength(applies.host);
    expect(s.handler.requests).toEqual([]);
    expect(s.deps.audit.entries.at(-2)).toMatchObject({
      kind: "remote-exec",
      action: "inspect host (read-only)",
      target: "own server",
    });
    const text = renderDriftReport(report);
    expect(text).toContain("your server is set up as OpsCrew left it");
    expect(
      `${text}\n${JSON.stringify(report)}\n${JSON.stringify(s.deps.audit.entries)}`,
    ).not.toContain(OWN_IPV4);
  });

  it("public mode with a forwarded login port: the deploy workflow matches (port 2222, sshd on 22)", async () => {
    const s = await ownProject();
    // A router forwards 2222 to the server's 22: OpsCrew logs in (and deploys) on 2222.
    await recordOwnServer(s.deps.paths, {
      host: OWN_IPV4,
      port: 2222,
      user: "root",
      agent: true,
      reachable: true,
    });
    await provisionOwn(s);
    const workflow = await readFile(
      join(s.root, ".github", "workflows", "opscrew-deploy.yml"),
      "utf8",
    );
    expect(workflow).toContain("2222");

    const report = await runDrift(s.deps, { services: s.services });
    expect(report.files).toEqual({ changed: [], created: [] });
    expect(report.clean).toBe(true);
  });

  it("tunnel mode keeps sshd's committed port, whatever port this computer logs in on", async () => {
    const s = await ownProject({ access: "tunnel" });
    await provisionOwn(s);
    // This computer now reaches the server through a forward on 2200; sshd still listens on 2222.
    await recordOwnServer(s.deps.paths, {
      host: LAN_IPV4,
      port: 2200,
      user: "alice",
      agent: false,
      keyPath: "~/.ssh/id_ed25519",
      reachable: false,
    });
    const report = await runDrift(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    expect(report.files).toEqual({ changed: [], created: [] });
  });

  it("reports SSH, firewall, deploy user, runtime and service changes plainly, and changes nothing", async () => {
    const s = await ownProject();
    await provisionOwn(s);
    const applied = s.host.applies.length;
    edit(s, (f) => {
      if (f.sshd) {
        f.sshd.passwordAuthentication = true;
        f.sshd.permitRootLogin = "yes";
        f.sshd.dropIn = null;
      }
      f.firewall.ufw = "inactive";
      f.deployUser?.keys.push(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExtraKeyForTestsOnly other@laptop",
      );
      f.dirs = f.dirs
        .filter((dir) => dir.path !== "/srv/data/shop")
        .map((dir) =>
          dir.path === "/srv/apps/shop"
            ? { ...dir, owner: "root", group: "root", mode: "755", entries: 3 }
            : dir,
        );
      f.fail2ban.active = false;
      f.autoUpgrades = false;
      f.apps = [];
    });

    const report = await runDrift(s.deps, { services: s.services });

    expect(report.clean).toBe(false);
    expect(details(report)).toEqual(
      expect.arrayContaining([
        "sshd: PermitRootLogin is yes; OpsCrew set prohibit-password.",
        "sshd: Password logins are on again.",
        "sshd: OpsCrew's SSH settings file /etc/ssh/sshd_config.d/10-opscrew.conf is missing.",
        "ufw: The firewall (ufw) is off.",
        "deploy-key: The deploy user's authorized_keys holds 2 keys; OpsCrew set up only the deploy key.",
        "app-dirs: /srv/apps/shop is owned by root:root with mode 755; OpsCrew set deploy:deploy and 750.",
        "app-dirs: /srv/data/shop is missing.",
        "fail2ban: fail2ban is not running.",
        "unattended-upgrades: Daily security updates are turned off in apt's settings.",
        "app-record: The app's record /etc/opscrew/apps/shop.json is missing.",
      ]),
    );
    const text = renderDriftReport(report);
    expect(text).toContain("Your server differs from what OpsCrew set up");
    expect(text).toContain("~ SSH settings: Password logins are on again.");
    expect(text).toContain("Nothing was changed: `opscrew drift` only reads.");
    // No provider wording: there is no "Your own server console".
    const steps = driftNextSteps(report).join("\n");
    expect(steps).toContain("on the server (ssh) or in the Cloudflare dashboard");
    expect(`${text}\n${steps}`).not.toMatch(/Your own server|console/);
    expect(s.host.applies).toHaveLength(applied);
    expect(s.handler.requests).toEqual([]);
  });

  it("with public SSH closed, SSH's rule on the private network's interface is no ufw drift", async () => {
    const s = await ownProject();
    await provisionOwn(s);
    // `secure --close-public-ssh` left SSH on the network's interface only.
    edit(s, (f) => {
      f.firewall.ufwRules = [
        ...f.firewall.ufwRules.filter((rule) => rule.comment !== "opscrew-ssh"),
        {
          rule: "allow in on wg-opscrew0 to any port 22 proto tcp",
          comment: "opscrew-network-ssh",
        },
      ];
    });
    const ufw = (report: DriftReport) =>
      (report.host?.differences ?? []).filter((d) => d.area === "ufw");
    // While the plan says public SSH is open, the missing public rule is drift.
    expect(ufw(await runDrift(s.deps, { services: s.services }))).not.toEqual([]);

    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeArtifact(
      "plan",
      s.deps.paths.files.plan,
      DeployPlanSchema.parse({
        ...plan,
        environment: { runner: "server" },
        security: { ...plan.security, sshAllowedCidrs: [] },
        network: {
          range: "10.200.4.0/24",
          members: [{ name: "app", address: "10.200.4.1", port: 51820, publicKey: WG_KEY }],
          publicSsh: false,
        },
      }),
    );
    expect(ufw(await runDrift(s.deps, { services: s.services }))).toEqual([]);
  });

  it("stops without a report when the server cannot be reached or inspected", async () => {
    const s = await ownProject();
    await provisionOwn(s);
    const checks = () => s.deps.audit.entries.filter((e) => e.action === "drift-check").length;
    const before = checks();

    // The login fails: ssh cannot reach the server.
    const unreachable = runDrift(s.deps, {
      services: {
        ...s.services,
        own: {
          ...s.services.own,
          remote: (connection) => ({
            host: connection.host,
            run: async () => ({ exitCode: 255, stdout: "", stderr: "Connection refused" }),
          }),
        },
      },
    });
    await expect(unreachable).rejects.toMatchObject({ code: "COMMAND_FAILED" });

    // The inspection fails.
    s.host.inspect = async () => {
      throw new OpsCrewError("COMMAND_FAILED", "The inspection of your server failed.");
    };
    await expect(runDrift(s.deps, { services: s.services })).rejects.toThrow(
      "The inspection of your server failed.",
    );
    // No drift check was recorded as done, so nothing reads as a clean report.
    expect(checks()).toBe(before);
    expect(s.host.applies).toHaveLength(1);
  });

  it("a deleted host record is a difference, and OpsCrew then no longer claims what it created", async () => {
    const s = await ownProject();
    await provisionOwn(s);
    edit(s, (f) => {
      f.record = null;
    });
    const report = await runDrift(s.deps, { services: s.services });
    expect(details(report)).toEqual(
      expect.arrayContaining([
        "record: is missing, so `opscrew destroy --undo-host` cannot tell what to put back.",
        expect.stringMatching(/^server: A user named "deploy" already exists/),
      ]),
    );
  });

  it("tunnel mode: compares the connector with the tunnel in the state; no address, no secret", async () => {
    const s = await ownProject({ access: "tunnel" });
    await provisionOwn(s);
    s.engine.plans.length = 0;
    const clean = await runDrift(s.deps, { services: s.services });
    expect(clean.host).toEqual({ differences: [] });
    expect(clean.clean).toBe(true);
    // No public address in tunnel mode: nothing reaches the engine.
    expect(s.engine.plans.every((p) => p.env.TF_VAR_server_ipv4 === undefined)).toBe(true);

    edit(s, (f) => {
      for (const tunnel of f.tunnels) tunnel.running = false;
      f.firewall.ufwRules.push({ rule: "allow 80/tcp", comment: "opscrew-web" });
    });
    const report = await runDrift(s.deps, { services: s.services });
    expect(details(report)).toEqual(
      expect.arrayContaining([
        "tunnel-connector: The tunnel connector is not running, so the app cannot be reached.",
        "ufw: ufw still lets web traffic in, although the app is served through the Cloudflare Tunnel.",
      ]),
    );
    const everything = `${renderDriftReport(report)}\n${JSON.stringify(report)}\n${everythingPrinted(s)}`;
    expect(everything).not.toContain(LAN_IPV4);
    for (const secret of Object.values(s.secrets)) expect(everything).not.toContain(secret);
  });

  describe("behind Cloudflare's proxy", () => {
    /** Cloudflare's ranges as the fake API answers them from now on. */
    function cloudflareAnswers(s: OwnProject, answer: () => { ipv4: string[]; ipv6: string[] }) {
      s.services.cloudflare = { ...ownCloudflare(), getIpRanges: async () => answer() };
    }

    it("a change in Cloudflare's ranges is host drift with a plain next step", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      // Provisioned with Cloudflare's ranges: clean.
      expect((await runDrift(s.deps, { services: s.services })).host).toEqual({
        differences: [],
      });

      cloudflareAnswers(s, () => ({ ipv4: [CF_V4[0] as string, "131.0.72.0/22"], ipv6: CF_V6 }));
      const report = await runDrift(s.deps, { services: s.services });
      expect(report.clean).toBe(false);
      expect(details(report)).toEqual([
        "web-filter: Cloudflare's IP ranges changed since the last provision (1 new, 1 no longer listed), and the filter still lets in only the old list. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
      ]);
      const text = renderDriftReport(report);
      expect(text).toContain(
        "~ Web filter (only Cloudflare reaches ports 80 and 443): Cloudflare's IP ranges changed",
      );
      expect(text).toContain("`opscrew provision` shows a host plan");
      expect(s.host.applies).toHaveLength(1);
      expect(s.handler.requests).toEqual([]);
      expect(`${text}\n${JSON.stringify(report)}`).not.toContain(OWN_IPV4);
    });

    it("reports a filter Docker no longer requires, a stopped unit, edited rules or a missing filter", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      edit(s, (f) => {
        f.webFilter.files.dropIn = null;
        f.webFilter.active = false;
        f.webFilter.rules4.dockerUser.leading = [];
      });
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        "web-filter: Docker no longer requires the web filter (the docker.service.d drop-in is missing), so after a restart Docker could publish the web ports without it. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
        "web-filter: The web filter's unit is not enabled and running. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
        "web-filter: OpsCrew's jumps are no longer the first rules of DOCKER-USER, so another rule may let visitors in around Cloudflare. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
      ]);
      edit(s, (f) => {
        f.webFilter.files.script = null;
        f.webFilter.rules4.chain = null;
      });
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        "web-filter: The web filter is missing, so visitors can reach your server around Cloudflare. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
      ]);
    });

    it("compares with the last provision's ranges when Cloudflare cannot be reached", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      let reads = 0;
      cloudflareAnswers(s, () => {
        reads++;
        // The file preview reads them first; the server comparison second.
        if (reads === 2) throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
        return { ipv4: CF_V4, ipv6: CF_V6 };
      });
      const report = await runDrift(s.deps, { services: s.services });
      expect(report.host).toEqual({ differences: [] });
      expect(s.deps.reporter.text()).toContain(
        "OpsCrew could not read Cloudflare's current IP ranges, so it compared the web filter with the ranges of the last provision.",
      );
    });

    it("a filter left on a server that now serves DNS only is drift", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...plan,
        dns: { ...plan.dns, proxied: false },
        security: { ...plan.security, httpAllowedFrom: "any" },
      });
      const report = await runDrift(s.deps, { services: s.services });
      expect(details(report)).toContain(
        "web-filter: OpsCrew's web filter is still on the server, although the site is no longer served directly behind Cloudflare's proxy, so visitors who do not come through Cloudflare cannot reach it.",
      );
    });
  });

  it("next steps name the server and the Cloudflare dashboard for own servers, the console otherwise", () => {
    expect(driftNextSteps({ clean: true, provider: "own" })).toEqual([
      "nothing to do; run `opscrew drift` again after changes on the server (ssh) or in the Cloudflare dashboard.",
    ]);
    expect(driftNextSteps({ clean: false, provider: "own" }).join("\n")).not.toMatch(
      /Your own server|console/,
    );
    // Servers OpsCrew creates keep the wording the CLI printed before.
    expect(driftNextSteps({ clean: true, provider: "digitalocean" })).toEqual([
      "nothing to do; run `opscrew drift` again after changes in the DigitalOcean or Cloudflare console.",
    ]);
    expect(driftNextSteps({ clean: false, provider: "hetzner" })).toEqual([
      "to undo changes made outside OpsCrew and apply pending code, run `opscrew provision` (it shows the plan first).",
      "to keep a change made in the console, update opscrew/plan.yaml to match before you provision again.",
    ]);
  });

  describe("the host summary", () => {
    const report = (differences: HostDifference[]): DriftReport => ({
      drift: [],
      pending: [],
      files: { changed: [], created: [] },
      foreignDnsRecords: [],
      host: { differences },
      clean: false,
      engine: { name: "tofu", version: "1.10.0", binary: "/usr/bin/tofu" },
      checkedAt: "2026-10-15T09:00:00.000Z",
      provider: "own",
    });
    const sshd: HostDifference = {
      area: "sshd",
      title: "SSH settings",
      detail: "Password logins are on again.",
      restoredByProvision: true,
    };
    const runtime: HostDifference = {
      area: "app",
      title: "OpsCrew's runtime files of the app",
      detail: "/srv/edge/sites/shop.caddy differs. Re-run the deploy workflow.",
      restoredByProvision: false,
    };
    const blocker: HostDifference = {
      area: "server",
      title: "What OpsCrew found",
      detail: "Another firewall manages this server. Turn it off.",
      restoredByProvision: false,
    };

    it("only differences provision puts back: one promise, no 'left alone' group", () => {
      const text = renderDriftReport(report([sshd]));
      expect(text).toContain(
        "Put back by `opscrew provision` (1):\n  ~ SSH settings: Password logins are on again.\n`opscrew provision` shows a host plan for these first",
      );
      expect(text).not.toContain("Left alone");
      expect(driftNextSteps(report([sshd]))[0]).toBe(
        "to undo changes made outside OpsCrew and apply pending code, run `opscrew provision` (it shows the plans first and changes nothing without your approval).",
      );
    });

    it("runtime files only: no promise that provision puts them back", () => {
      const text = renderDriftReport(report([runtime]));
      expect(text).not.toContain("Put back by");
      expect(text).not.toContain("shows a host plan");
      expect(text).toContain(
        "Left alone by `opscrew provision` (1):\n  ~ OpsCrew's runtime files of the app: /srv/edge/sites/shop.caddy differs. Re-run the deploy workflow.\n`opscrew provision` does not change these; where something needs doing, it is said with each.",
      );
    });

    it("with something that stops provision, says it changes nothing until that is fixed", () => {
      const text = renderDriftReport(report([sshd, blocker]));
      expect(text).toContain(
        "`opscrew provision` changes nothing on the server until what OpsCrew found (below) is fixed; then it shows a host plan for these, and nothing changes until you approve it.",
      );
      expect(text).toContain(
        "Left alone by `opscrew provision` (1):\n  ~ What OpsCrew found: Another firewall manages this server. Turn it off.",
      );
    });
  });

  it("keeps the password-login choice of the applied host plan", async () => {
    const s = await ownProject();
    await provisionOwn(s);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    const setup = await lastHostSetup(s.deps, plan);
    expect(setup?.purpose).toBe("setup");
    expect(passwordLoginChoice(setup)).toBe("off");
    expect(passwordLoginChoice(undefined, { sshd: null })).toBeUndefined();
    expect(
      passwordLoginChoice(undefined, {
        sshd: {
          ...(s.host.facts.sshd as NonNullable<OwnProject["host"]["facts"]["sshd"]>),
          dropIn: "# Managed by OpsCrew.\nPermitRootLogin no\n",
        },
      }),
    ).toBe("keep");
  });

  describe("OpsCrew's runtime files of the app (its folder and its site on the edge)", () => {
    const sum = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    /** The files the deploy workflow copies, as OpsCrew rendered them into the repository. */
    async function repoSums(s: OwnProject) {
      const read = (name: string) => readFile(join(s.root, "opscrew", "runtime", name), "utf8");
      return {
        compose: sum(await read("compose.yaml")),
        site: sum(await read("edge/sites/shop.caddy")),
      };
    }
    /** The server after a deploy: OpsCrew's files as the workflow wrote them. */
    async function deployed(s: OwnProject) {
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...plan,
        deployment: { ...plan.deployment, firstDeployAt: "2026-10-15T09:00:00.000Z" },
      });
      const sums = await repoSums(s);
      const file = (mode: string, sha256: string | null = null) => ({
        kind: "file" as const,
        owner: "deploy",
        group: "deploy",
        mode,
        sha256,
      });
      edit(s, (f) => {
        f.runtimeFiles = [
          { app: "shop", name: "compose.yaml", ...file("644", sums.compose) },
          { app: "shop", name: "site", ...file("644", sums.site) },
          { app: "shop", name: ".env", ...file("644") },
          { app: "shop", name: "app.env", ...file("600") },
          serviceOf(plan, "postgres")
            ? { app: "shop", name: "db.env", ...file("600") }
            : { app: "shop", name: "db.env", kind: "absent", sha256: null },
        ];
        f.containers.push({ name: "shop-app-1", project: plan.app.name, ports: "", running: true });
        if (serviceOf(plan, "postgres")) {
          f.containers.push({
            name: "shop-db-1",
            project: plan.app.name,
            ports: "",
            running: true,
          });
        }
      });
    }

    it("matches what OpsCrew renders from the plan (the repository's files): clean", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      const sums = await repoSums(s);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      const requirements = await readArtifact(
        "requirements",
        s.deps.paths.files.requirements,
      ).catch(() => undefined);
      // The site as provision renders it: with the app's origin TLS and Cloudflare's ranges.
      const expected = expectedRuntimeFiles(plan, {
        opscrewVersion: s.deps.version,
        ...(requirements?.contactEmail ? { acmeEmail: requirements.contactEmail } : {}),
        ...siteContext((await recordedEdge(s.deps, plan)).edge, { ipv4: CF_V4, ipv6: CF_V6 }),
      });
      expect(expected.rendered.site).toBeDefined();
      expect(expected.rendered).toEqual({ "compose.yaml": sums.compose, site: sums.site });
      await deployed(s);
      const report = await runDrift(s.deps, { services: s.services });
      expect(report.host).toEqual({ differences: [] });
    });

    it("reports a component that differs from the plan: one without its container, and one the plan no longer runs (FR-1331)", async () => {
      const base = ownPlan();
      const plan = DeployPlanSchema.parse({
        ...base,
        processes: {
          workers: [{ name: "worker", command: "node worker.js", source: "procfile", count: 2 }],
        },
        services: [
          ...base.services,
          { kind: "mysql", version: "8.4", memoryMb: 512, reason: "mysql2", licence: "GPL-2.0" },
          {
            kind: "valkey",
            version: "8",
            memoryMb: 128,
            enabled: false,
            options: { mode: "cache" },
            reason: "redis",
            licence: "BSD-3-Clause",
          },
        ],
      });
      const s = await ownProject({ plan });
      await provisionOwn(s);
      await deployed(s);
      edit(s, (f) => {
        for (const name of [
          "shop-worker-1",
          "shop-worker-2",
          "shop-cache-1",
          "shop-release-run-1a2b3c",
        ]) {
          f.containers.push({ name, project: "shop", ports: "", running: true });
        }
        f.runtimeFiles.push({
          app: "shop",
          name: "mysql.env",
          kind: "file",
          owner: "deploy",
          group: "deploy",
          mode: "600",
          sha256: null,
        });
      });
      const report = await runDrift(s.deps, { services: s.services });
      expect(details(report)).toEqual([
        "app: MySQL (mysql) is in opscrew/plan.yaml but has no container on the server. Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it starts every component.",
        "app: cache runs on the server but is not a component in opscrew/plan.yaml any more (turned off or removed there): the next deploy removes it.",
      ]);
      expect(report.clean).toBe(false);
    });

    it("a pin Dependabot updated in the committed Compose file is no drift on the server", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      const file = join(s.root, "opscrew", "runtime", "compose.yaml");
      const compose = await readFile(file, "utf8");
      const postgres = /postgres:17-alpine@sha256:[0-9a-f]{64}/.exec(compose)?.[0] as string;
      await writeFile(
        file,
        compose.replace(postgres, `postgres:17-alpine@sha256:${"e".repeat(64)}`),
      );
      // The deploy workflow copied the committed file to the server.
      await deployed(s);
      const report = await runDrift(s.deps, { services: s.services });
      expect(report.host).toEqual({ differences: [] });
    });

    it("with another app on the server, reads every app and reports only this app's parts", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      await deployed(s);
      s.host.facts = withOtherApp({ facts: s.host.facts });
      // What differs for the other app is for its own project's drift to report.
      edit(s, (f) => {
        f.containers = f.containers.map((c) =>
          c.project === "blog" ? { ...c, running: false } : c,
        );
        f.runtimeFiles.push({
          app: "blog",
          name: "site",
          kind: "file",
          owner: "deploy",
          group: "deploy",
          mode: "644",
          sha256: "0".repeat(64),
        });
        f.dirs = f.dirs.map((dir) =>
          dir.path === "/srv/apps/blog" ? { ...dir, mode: "777" } : dir,
        );
      });
      expect(s.host.facts.apps.map((app) => app.name)).toEqual(["blog", "shop"]);
      expect((await runDrift(s.deps, { services: s.services })).host).toEqual({ differences: [] });
      // This app's own site, edited on the server, is reported.
      edit(s, (f) => {
        const site = f.runtimeFiles.find((file) => file.app === "shop" && file.name === "site");
        Object.assign(site ?? {}, { sha256: "0".repeat(64) });
      });
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        "app: /srv/edge/sites/shop.caddy differs from what OpsCrew renders from opscrew/plan.yaml now: it was edited on the server, or the deploy workflow has not copied the current version yet. Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.",
      ]);
    });

    it("reports each edited, replaced or missing file and unsafe secret files, never contents", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      await deployed(s);
      edit(s, (f) => {
        const files = f.runtimeFiles;
        const named = (name: string) => files.find((file) => file.name === name);
        Object.assign(named("site") ?? {}, { sha256: "0".repeat(64) });
        Object.assign(named("compose.yaml") ?? {}, { kind: "link", sha256: null });
        Object.assign(named(".env") ?? {}, { kind: "absent" });
        Object.assign(named("app.env") ?? {}, { owner: "root", group: "root", mode: "644" });
      });
      const report = await runDrift(s.deps, { services: s.services });
      const redeploy =
        "Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.";
      expect(details(report)).toEqual([
        "app: /srv/apps/shop/compose.yaml is no longer a regular file (it is a symbolic link or something else), so OpsCrew does not look into it. Remove it on the server, then re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.",
        `app: /srv/edge/sites/shop.caddy differs from what OpsCrew renders from opscrew/plan.yaml now: it was edited on the server, or the deploy workflow has not copied the current version yet. ${redeploy}`,
        `app: /srv/apps/shop/.env (which names the image the app runs) is missing. ${redeploy}`,
        "app: /srv/apps/shop/app.env is owned by root:root, so the deploy workflow (which logs in as deploy) may not be able to replace it. Run `chown deploy:deploy /srv/apps/shop/app.env` as root on the server.",
        "app: /srv/apps/shop/app.env holds secrets but other users on the server can read it (mode 644). Run `chmod 600 /srv/apps/shop/app.env` on the server.",
      ]);
      expect(renderDriftReport(report)).toContain(
        "~ OpsCrew's runtime files of the app: /srv/edge/sites/shop.caddy differs",
      );
      expect(s.host.applies).toHaveLength(1);
    });

    it("renders the site for the server's proxy, with what provision renders it with", () => {
      const plan = DeployPlanSchema.parse({
        ...ownPlan(),
        target: { ...ownPlan().target, edge: "nginx" },
      });
      const ctx = {
        opscrewVersion: "0.0.0",
        ...siteContext({ originTls: { hostnames: ["shop.example.com"] } }, undefined),
      };
      const [site] = renderEdgeSite(plan, {
        ...ctx,
        github: { owner: "", repo: "" },
        deploySshPublicKey: "",
      });
      expect(site?.path).toBe("opscrew/runtime/edge/sites/shop.conf");
      expect(site?.content).toContain("ssl_verify_client on;");
      expect(expectedRuntimeFiles(plan, ctx).rendered.site).toBe(sum(site?.content ?? ""));
      // The server's site file, which drift names when it differs, is nginx's too.
      expect(expectedRuntimeFiles(plan, ctx).sitePath).toBe("/srv/edge/sites/shop.conf");
      expect(expectedRuntimeFiles(ownPlan(), ctx).sitePath).toBe("/srv/edge/sites/shop.caddy");
    });

    it("checks each service's env file as it checks app.env", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      await deployed(s);
      edit(s, (f) => {
        f.runtimeFiles.push({
          app: "shop",
          name: "search.env",
          kind: "file",
          owner: "deploy",
          group: "deploy",
          mode: "644",
          sha256: null,
        });
      });
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        "app: /srv/apps/shop/search.env holds secrets but other users on the server can read it (mode 644). Run `chmod 600 /srv/apps/shop/search.env` on the server.",
      ]);
    });

    it("a missing file counts only after the first deploy; db.env only with PostgreSQL", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      edit(s, (f) => {
        f.runtimeFiles = ["compose.yaml", "site", ".env", "app.env", "db.env"].map((name) => ({
          app: "shop",
          name: name as "app.env",
          kind: "absent" as const,
          sha256: null,
        }));
      });
      expect((await runDrift(s.deps, { services: s.services })).host).toEqual({
        differences: [],
      });
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      const expected = expectedRuntimeFiles(
        { ...plan, services: selfHostedServices({ postgres: true, redis: false }) },
        { opscrewVersion: "0.0.0" },
      );
      expect(expected.serviceEnvFiles).toEqual({
        "db.env": { title: "PostgreSQL", secret: "OPSCREW_SERVICE_DB_ENV" },
      });
      const none = expectedRuntimeFiles(
        { ...plan, services: selfHostedServices({ postgres: false, redis: true }) },
        { opscrewVersion: "0.0.0" },
      );
      expect(none.serviceEnvFiles).toEqual({
        "cache.env": { title: "Valkey", secret: "OPSCREW_SERVICE_CACHE_ENV" },
      });
    });

    it("reads each service's env file from the catalog: a missing one is reported once deployed", async () => {
      const base = ownPlan({ postgres: false });
      const plan = DeployPlanSchema.parse({
        ...base,
        services: [
          { kind: "mysql", version: "8.4", memoryMb: 512, reason: "mysql2", licence: "GPL-2.0" },
          { kind: "nats", version: "2.15", memoryMb: 64, reason: "nats", licence: "Apache-2.0" },
          {
            kind: "valkey",
            version: "8",
            memoryMb: 128,
            options: { mode: "cache" },
            reason: "redis",
            licence: "BSD-3-Clause",
          },
        ],
      });
      const s = await ownProject({ plan });
      await provisionOwn(s);
      await deployed(s);
      edit(s, (f) => {
        f.containers.push(
          ...["shop-mysql-1", "shop-nats-1", "shop-cache-1"].map((name) => ({
            name,
            project: "shop",
            ports: "",
            running: true,
          })),
        );
        // The inspection reports a service's env file only when it is there: mysql.env is.
        f.runtimeFiles.push({
          app: "shop",
          name: "mysql.env",
          kind: "file",
          owner: "deploy",
          group: "deploy",
          mode: "600",
          sha256: null,
        });
      });
      // NATS's token is in nats.env, Valkey's password in cache.env.
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        "app: /srv/apps/shop/nats.env (the settings of NATS from the GitHub secret OPSCREW_SERVICE_NATS_ENV) is missing. Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.",
        "app: /srv/apps/shop/cache.env (the settings of Valkey from the GitHub secret OPSCREW_SERVICE_CACHE_ENV) is missing. Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.",
      ]);
    });
  });

  describe("ufw since OpsCrew's setup", () => {
    /** OpsCrew's record of the ufw step: what ufw looked like before OpsCrew changed it. */
    function recordUfw(s: OwnProject, previous: Record<string, string | boolean>) {
      edit(s, (f) => {
        f.record?.changes.push({
          step: "ufw",
          purpose: "setup",
          at: "2026-10-14T12:00:00.000Z",
          previous,
        });
      });
    }

    it("reports rules added after setup, without addresses, and leaves earlier rules alone", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      recordUfw(s, {
        installed: true,
        active: false,
        rules: "allow 8080/tcp,allow 60000,61000/udp",
        defaultIncoming: "deny",
        defaultOutgoing: "allow",
        defaultRouted: "disabled",
      });
      edit(s, (f) => {
        f.firewall.ufwRules.push(
          { rule: "allow 8080/tcp", comment: null },
          { rule: "allow 60000,61000/udp", comment: null },
          { rule: "allow from 203.0.113.7 to any port 5432", comment: null },
          { rule: "allow 3000/tcp", comment: "mine" },
        );
      });
      const report = await runDrift(s.deps, { services: s.services });
      const next =
        "If you added it on purpose, nothing needs to change; otherwise find it with `sudo ufw status numbered` on the server and remove it with `sudo ufw delete <number>`.";
      expect(details(report)).toEqual([
        `ufw: ufw has a rule that was added after OpsCrew set the server up: allow from <address> to any port 5432. ${next}`,
        `ufw: ufw has a rule that was added after OpsCrew set the server up: allow 3000/tcp. ${next}`,
      ]);
      expect(JSON.stringify(report)).not.toContain("203.0.113.7");
      expect(renderDriftReport(report)).toContain("~ Firewall (ufw): ufw has a rule");
    });

    it("reports changed default policies against what OpsCrew left", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      // OpsCrew turned ufw on, so it set deny incoming and allow outgoing.
      recordUfw(s, {
        installed: true,
        active: false,
        rules: "",
        defaultIncoming: "allow",
        defaultOutgoing: "allow",
        defaultRouted: "deny",
      });
      edit(s, (f) => {
        f.firewall.ufwDefaults = { incoming: "allow", outgoing: "deny", routed: "allow" };
      });
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        "ufw: ufw's default policy for incoming traffic is allow; OpsCrew set deny. `opscrew provision` sets it to deny again.",
        "ufw: ufw's default policy for outgoing traffic is deny; OpsCrew set allow. If you changed it on purpose, nothing needs to change; otherwise put it back with `sudo ufw default allow outgoing` on the server.",
        "ufw: ufw's default policy for routed (forwarded) traffic is allow; it was deny when OpsCrew set the server up. If you changed it on purpose, nothing needs to change; otherwise put it back with `sudo ufw default deny routed` on the server.",
      ]);
    });

    it("ufw that was on but let everything in: OpsCrew set deny incoming, and that is the reference", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      // What the host adapter leaves: the record of the active ufw with "allow", and deny now.
      recordUfw(s, {
        installed: true,
        active: true,
        rules: "",
        defaultIncoming: "allow",
        defaultOutgoing: "allow",
        defaultRouted: "deny",
      });
      edit(s, (f) => {
        f.firewall.ufwDefaults = { incoming: "deny", outgoing: "allow", routed: "deny" };
      });
      expect((await runDrift(s.deps, { services: s.services })).host).toEqual({
        differences: [],
      });
      // Later someone runs `ufw default allow incoming` on the server.
      edit(s, (f) => {
        f.firewall.ufwDefaults = { incoming: "allow", outgoing: "allow", routed: "deny" };
      });
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        "ufw: ufw's default policy for incoming traffic is allow; OpsCrew set deny. `opscrew provision` sets it to deny again.",
      ]);
    });

    it("without OpsCrew's record of ufw, an incoming allow is still told plainly", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      edit(s, (f) => {
        f.firewall.ufwDefaults = { incoming: "allow", outgoing: "allow", routed: "disabled" };
      });
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        'ufw: ufw lets every incoming connection in: its default policy for incoming traffic is "allow". `opscrew provision` sets it to deny.',
      ]);
    });

    it("the summary promises `opscrew provision` only for what it puts back", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      // OpsCrew turned ufw on: deny incoming and allow outgoing are its own.
      recordUfw(s, {
        installed: true,
        active: false,
        rules: "",
        defaultIncoming: "allow",
        defaultOutgoing: "allow",
        defaultRouted: "deny",
      });
      edit(s, (f) => {
        if (f.sshd) f.sshd.passwordAuthentication = true;
        f.firewall.ufwRules.push({ rule: "allow 3000/tcp", comment: null });
        f.firewall.ufwDefaults = { incoming: "allow", outgoing: "deny", routed: "deny" };
      });
      const report = await runDrift(s.deps, { services: s.services });
      const restored = (report.host?.differences ?? []).map(
        (d) =>
          `${d.restoredByProvision ? "provision" : "left"} ${d.area}: ${d.detail.slice(0, 40)}`,
      );
      expect(restored).toEqual([
        "provision sshd: Password logins are on again.",
        "left ufw: ufw has a rule that was added after OpsC",
        "provision ufw: ufw's default policy for incoming traffi",
        "left ufw: ufw's default policy for outgoing traffi",
      ]);
      const text = renderDriftReport(report);
      expect(text).toContain(
        [
          "Your server differs from what OpsCrew set up (4).",
          "Put back by `opscrew provision` (2):",
          "  ~ SSH settings: Password logins are on again.",
          "  ~ Firewall (ufw): ufw's default policy for incoming traffic is allow; OpsCrew set deny. `opscrew provision` sets it to deny again.",
          "`opscrew provision` shows a host plan for these first, and nothing on the server changes until you approve it. If you changed one of them on purpose, keep in mind that the next provision undoes it.",
          "Left alone by `opscrew provision` (2):",
          "  ~ Firewall (ufw): ufw has a rule that was added after OpsCrew set the server up: allow 3000/tcp. If you added it on purpose, nothing needs to change; otherwise find it with `sudo ufw status numbered` on the server and remove it with `sudo ufw delete <number>`.",
          "  ~ Firewall (ufw): ufw's default policy for outgoing traffic is deny; OpsCrew set allow. If you changed it on purpose, nothing needs to change; otherwise put it back with `sudo ufw default allow outgoing` on the server.",
          "`opscrew provision` does not change these; where something needs doing, it is said with each.",
        ].join("\n"),
      );
      expect(driftNextSteps(report)).toEqual([
        "to undo what the report lists as put back by `opscrew provision` and apply pending code, run `opscrew provision` (it shows the plans first and changes nothing without your approval).",
        "for the differences on your server that `opscrew provision` leaves alone, follow the step the report gives with each.",
        "to keep a change made on the server (ssh) or in the Cloudflare dashboard, update opscrew/plan.yaml to match before you provision again.",
      ]);
    });

    it("ufw that was on already keeps its own policies as the reference", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      recordUfw(s, {
        installed: true,
        active: true,
        rules: "",
        defaultIncoming: "reject",
        defaultOutgoing: "allow",
        defaultRouted: "deny",
      });
      edit(s, (f) => {
        f.firewall.ufwDefaults = { incoming: "reject", outgoing: "allow", routed: "deny" };
      });
      expect((await runDrift(s.deps, { services: s.services })).host).toEqual({
        differences: [],
      });
    });
  });

  it("an own server without DNS or a tunnel has no cloud resources: only the server is checked", async () => {
    const s = await ownProject({ plan: ownPlan({ domain: null }) });
    await provisionOwn(s);
    // A configuration without resources may leave no state file behind.
    await rm(join(s.deps.paths.files.tfstateDir, "prod.tfstate"), { force: true });
    s.engine.plans.length = 0;

    const report = await runDrift(s.deps, { services: s.services });
    expect(report.notes?.[0]).toContain("no cloud resources to compare");
    expect(s.engine.plans).toEqual([]);
    expect(report.host).toEqual({ differences: [] });
    expect(report.clean).toBe(true);
  });
});
