import { rm } from "node:fs/promises";
import { join } from "node:path";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { CF_V4, CF_V6 } from "../provision/__fixtures__/fakes";
import { ownCloudflare, ownPlan } from "../provision/__fixtures__/own";
import {
  everythingPrinted,
  LAN_IPV4,
  OWN_IPV4,
  type OwnProject,
  ownProject,
  provisionOwn,
} from "./__fixtures__/own-project";
import { lastHostSetup, passwordLoginChoice } from "./host";
import { driftNextSteps, renderDriftReport } from "./render";
import { runDrift } from "./run";

/** Changes the fake server's facts as someone working on the server would. */
function edit(s: OwnProject, change: (facts: OwnProject["host"]["facts"]) => void): void {
  const facts = structuredClone(s.host.facts);
  change(facts);
  s.host.facts = HostFactsSchema.parse(facts);
}

/** The web filter facts of a prepared server (inspection always reports them). */
function filterOf(facts: OwnProject["host"]["facts"]) {
  if (facts.webFilter === undefined) throw new Error("no web filter facts");
  return facts.webFilter;
}

const details = (report: Awaited<ReturnType<typeof runDrift>>) =>
  (report.host?.differences ?? []).map((d) => `${d.area}: ${d.detail}`);

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
      f.dirs = [
        { path: "/srv/app", kind: "dir", owner: "root", group: "root", mode: "755", entries: 3 },
        { path: "/srv/data", kind: "absent" },
      ];
      f.fail2ban.active = false;
      f.autoUpgrades = false;
      f.marker = null;
    });

    const report = await runDrift(s.deps, { services: s.services });

    expect(report.clean).toBe(false);
    expect(details(report)).toEqual(
      expect.arrayContaining([
        "sshd: PermitRootLogin is yes; OpsCrew set prohibit-password.",
        "sshd: Password logins are on again.",
        "sshd: OpsCrew's SSH settings file /etc/ssh/sshd_config.d/10-opscrew.conf is missing.",
        "ufw: The firewall (ufw) is off.",
        "deploy-user: The deploy user's authorized_keys holds 2 keys; OpsCrew set up only the deploy key.",
        "runtime-dirs: /srv/app is owned by root:root with mode 755; OpsCrew set deploy:deploy and 750.",
        "runtime-dirs: /srv/data is missing.",
        "fail2ban: fail2ban is not running.",
        "unattended-upgrades: Daily security updates are turned off in apt's settings.",
        "app-marker: The marker /etc/opscrew/app.json is missing.",
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
      f.tunnel.running = false;
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
        filterOf(f).files.dropIn = null;
        filterOf(f).active = false;
        filterOf(f).rules4.dockerUser.leading = [];
      });
      expect(details(await runDrift(s.deps, { services: s.services }))).toEqual([
        "web-filter: Docker no longer requires the web filter (the docker.service.d drop-in is missing), so after a restart Docker could publish the web ports without it. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
        "web-filter: The web filter's unit is not enabled and running. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
        "web-filter: OpsCrew's jumps are no longer the first rules of DOCKER-USER, so another rule may let visitors in around Cloudflare. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
      ]);
      edit(s, (f) => {
        filterOf(f).files.script = null;
        filterOf(f).rules4.chain = null;
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
    expect(driftNextSteps({ clean: false })).toEqual([
      "to undo changes made outside OpsCrew and apply pending code, run `opscrew provision` (it shows the plan first).",
      "to keep a change made in the console, update opscrew/plan.yaml to match before you provision again.",
    ]);
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
