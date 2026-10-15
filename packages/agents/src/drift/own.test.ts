import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
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
import { expectedRuntimeFiles, lastHostSetup, passwordLoginChoice } from "./host";
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

  describe("OpsCrew's runtime files in /srv/app", () => {
    const sum = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    /** The files the deploy workflow copies, as OpsCrew rendered them into the repository. */
    async function repoSums(s: OwnProject) {
      const read = (name: string) => readFile(join(s.root, "opscrew", "runtime", name), "utf8");
      return { compose: sum(await read("compose.yaml")), caddy: sum(await read("Caddyfile")) };
    }
    /** The server after a deploy: OpsCrew's files as the workflow wrote them. */
    async function deployed(s: OwnProject) {
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...plan,
        deployment: { ...plan.deployment, lastDeployAt: "2026-10-15T09:00:00.000Z" },
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
          { name: "compose.yaml", ...file("644", sums.compose) },
          { name: "Caddyfile", ...file("644", sums.caddy) },
          { name: ".env", ...file("644") },
          { name: "app.env", ...file("600") },
          plan.services.postgres
            ? { name: "db.env", ...file("600") }
            : { name: "db.env", kind: "absent", sha256: null },
        ];
        f.containers.push({ name: "shop-app-1", project: plan.app.name, ports: "", running: true });
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
      const expected = expectedRuntimeFiles(plan, {
        opscrewVersion: s.deps.version,
        ...(requirements?.contactEmail ? { acmeEmail: requirements.contactEmail } : {}),
      });
      expect(expected.rendered).toEqual({ "compose.yaml": sums.compose, Caddyfile: sums.caddy });
      await deployed(s);
      const report = await runDrift(s.deps, { services: s.services });
      expect(report.host).toEqual({ differences: [] });
    });

    it("reports each edited, replaced or missing file and unsafe secret files, never contents", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      await deployed(s);
      edit(s, (f) => {
        const files = f.runtimeFiles ?? [];
        const named = (name: string) => files.find((file) => file.name === name);
        Object.assign(named("Caddyfile") ?? {}, { sha256: "0".repeat(64) });
        Object.assign(named("compose.yaml") ?? {}, { kind: "link", sha256: null });
        Object.assign(named(".env") ?? {}, { kind: "absent" });
        Object.assign(named("app.env") ?? {}, { owner: "root", group: "root", mode: "644" });
      });
      const report = await runDrift(s.deps, { services: s.services });
      const redeploy =
        "Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.";
      expect(details(report)).toEqual([
        "app: /srv/app/compose.yaml is no longer a regular file (it is a symbolic link or something else), so OpsCrew does not look into it. Remove it on the server, then re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.",
        `app: /srv/app/Caddyfile differs from what OpsCrew renders from opscrew/plan.yaml now: it was edited on the server, or the deploy workflow has not copied the current version yet. ${redeploy}`,
        `app: /srv/app/.env (which names the image the app runs) is missing. ${redeploy}`,
        "app: /srv/app/app.env is owned by root:root, so the deploy workflow (which logs in as deploy) may not be able to replace it. Run `chown deploy:deploy /srv/app/app.env` as root on the server.",
        "app: /srv/app/app.env holds secrets but other users on the server can read it (mode 644). Run `chmod 600 /srv/app/app.env` on the server.",
      ]);
      expect(renderDriftReport(report)).toContain(
        "~ OpsCrew's runtime files in /srv/app: /srv/app/Caddyfile differs",
      );
      expect(s.host.applies).toHaveLength(1);
    });

    it("a missing file counts only after the first deploy; db.env only with PostgreSQL", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      edit(s, (f) => {
        f.runtimeFiles = ["compose.yaml", "Caddyfile", ".env", "app.env", "db.env"].map((name) => ({
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
        { ...plan, services: { ...plan.services, postgres: true } },
        { opscrewVersion: "0.0.0" },
      );
      expect(expected.dbEnv).toBe(true);
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
        "ufw: ufw's default policy for incoming traffic is allow; OpsCrew set deny. If you changed it on purpose, nothing needs to change; otherwise put it back with `sudo ufw default deny incoming` on the server.",
        "ufw: ufw's default policy for outgoing traffic is deny; OpsCrew set allow. If you changed it on purpose, nothing needs to change; otherwise put it back with `sudo ufw default allow outgoing` on the server.",
        "ufw: ufw's default policy for routed (forwarded) traffic is allow; it was deny when OpsCrew set the server up. If you changed it on purpose, nothing needs to change; otherwise put it back with `sudo ufw default deny routed` on the server.",
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
