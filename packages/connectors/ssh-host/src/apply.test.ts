import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { deployApp, FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  DEPLOY_KEY,
  desiredFor,
  planFor,
  portainerDesired,
  portainerPassword,
  provision,
  TUNNEL_COMPOSE,
  TUNNEL_ID,
  tunnelDesired,
  tunnelToken,
} from "./__fixtures__/helpers";
import { applyHostPlan } from "./apply";
import { DOCKER_DAEMON_JSON } from "./constants";
import { HostRecordSchema } from "./facts";
import { hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planHost, planTeardown, planUndo } from "./plan";
import { planPortainer } from "./steps";
import type { HostPlan } from "./types";

const STEP_SCRIPTS = /\.(check|apply|verify)$|^deadman\./;

function record(fake: FakeHost) {
  return HostRecordSchema.parse(JSON.parse(fake.files.get("/etc/opscrew/host.json") ?? "null"));
}

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpsCrewError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("applyHostPlan on a fresh server", () => {
  it("prepares the server, records previous values first, and a re-run changes nothing", async () => {
    const fake = new FakeHost({ os: "debian-12" });
    fake.upgradesServiceEnabled = false;
    const { plan, result } = await provision(fake, desiredFor(fake), {
      version: "1.4.0",
      now: () => new Date("2026-10-14T12:00:00.000Z"),
    });
    expect(result).toEqual({
      applied: [
        "docker",
        "docker-daemon",
        "deploy-user",
        "sshd",
        "ufw",
        "fail2ban",
        "unattended-upgrades",
        "runtime-dirs",
        "app-marker",
      ],
      skipped: [],
    });
    // Parity with servers OpsCrew creates (what `opscrew secure` checks).
    expect(fake.files.get("/etc/docker/daemon.json")).toBe(DOCKER_DAEMON_JSON);
    expect(fake.dockerRestarts).toBe(1);
    expect(fake.files.get("/etc/fail2ban/jail.d/opscrew.local")).toContain("port = 22\n");
    expect(fake.fail2banActive).toBe(true);
    expect(fake.upgradesServiceEnabled).toBe(true);
    expect(fake.files.has("/var/lib/opscrew-ready")).toBe(true);

    // Docker 28+ from Docker's repository with the deb822 sources file.
    expect(fake.packages.get("docker-ce")).toMatch(/^5:29\./);
    expect(fake.files.get("/etc/apt/sources.list.d/docker.sources")).toContain(
      "URIs: https://download.docker.com/linux/debian\nSuites: bookworm\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc",
    );
    // Deploy user with the key and Docker access; root keeps key-only logins.
    expect(fake.users.get("deploy")).toMatchObject({
      keys: [DEPLOY_KEY],
      groups: ["deploy", "docker"],
    });
    expect(fake.files.get("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(
      "# Managed by OpsCrew. `opscrew destroy --undo-host` puts the previous setting back.\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n",
    );
    // ufw installed (Debian), the SSH rule first, then web, then on.
    expect(fake.ufwLog).toEqual([
      "install",
      "allow 22/tcp",
      "allow 80/tcp",
      "allow 443/tcp",
      "allow 443/udp",
      "enable",
    ]);
    expect(fake.files.has("/etc/apt/apt.conf.d/21opscrew-auto-upgrades")).toBe(true);
    expect(fake.dirs.get("/srv/app")).toMatchObject({
      owner: "deploy",
      group: "deploy",
      mode: "750",
    });
    expect(fake.files.get("/etc/opscrew/app.json")).toBe(
      '{"app":"shop","projectId":"shop-0123456789ab"}',
    );

    // The record holds the previous value of each step, written before the step's change.
    const host = record(fake);
    expect(host).toMatchObject({
      app: "shop",
      projectId: "shop-0123456789ab",
      opscrewVersion: "1.4.0",
    });
    expect(host.changes.map((entry) => entry.step)).toEqual(plan.steps.map((step) => step.id));
    expect(new Set(host.changes.map((entry) => entry.at))).toEqual(
      new Set(["2026-10-14T12:00:00.000Z"]),
    );
    expect(host.changes.find((entry) => entry.step === "docker-daemon")?.previous).toEqual({
      file: "absent",
    });
    expect(host.changes.find((entry) => entry.step === "fail2ban")?.previous).toEqual({
      installed: false,
      active: false,
      jail: "absent",
    });
    expect(
      host.changes.find((entry) => entry.step === "unattended-upgrades")?.previous,
    ).toMatchObject({ serviceEnabled: false });
    expect(host.changes.find((entry) => entry.step === "sshd")?.previous).toEqual({
      dropIn: "absent",
      permitRootLogin: "yes",
      passwordAuthentication: "yes",
    });
    expect(host.changes.find((entry) => entry.step === "ufw")?.previous).toMatchObject({
      installed: false,
      active: false,
    });
    expect(host.changes.find((entry) => entry.step === "deploy-user")?.previous).toMatchObject({
      existed: false,
    });
    const names = fake.names();
    for (const id of ["docker", "sshd", "ufw"]) {
      const write = names.findIndex(
        (name, index) => name === "record.write" && names[index - 1] === `${id}.check`,
      );
      expect(write).toBeGreaterThan(0);
      expect(names.indexOf(id === "ufw" ? "ufw.install.apply" : `${id}.apply`)).toBeGreaterThan(
        write,
      );
    }

    // Re-run: everything is in place and nothing runs on the server but reads.
    fake.calls.length = 0;
    const again = await planFor(fake);
    expect(again.steps.every((step) => step.state === "in-place")).toBe(true);
    const second = await applyApproved(fake, again);
    expect(second.applied).toEqual([]);
    expect(fake.names()).toEqual(["privilege", "inspect"]);
  });

  it("runs every step through sudo -n for a sudo login", async () => {
    const fake = new FakeHost({ login: "alice", sudo: "nopasswd" });
    await provision(fake);
    const stepCalls = fake.calls.filter(
      (call) => STEP_SCRIPTS.test(call.name) || call.name.startsWith("record."),
    );
    expect(stepCalls.length).toBeGreaterThan(20);
    expect(stepCalls.every((call) => call.command.startsWith("sudo -n sh -c '"))).toBe(true);
    expect(fake.files.get("/etc/ssh/sshd_config.d/10-opscrew.conf")).toContain(
      "PermitRootLogin no\n",
    );
  });

  it("upgrades an older Docker from Docker's repository and records the old version", async () => {
    const fake = new FakeHost();
    fake.packages.set("docker-ce", "5:27.3.1-1~ubuntu.24.04~noble");
    fake.packages.set("docker-compose-plugin", "2.29.7");
    fake.packages.set("docker-buildx-plugin", "0.17.1");
    fake.files.set(
      "/etc/apt/sources.list.d/docker.list",
      "deb https://download.docker.com/linux/ubuntu noble stable",
    );
    fake.dockerRunning = true;
    await provision(fake);
    expect(fake.packages.get("docker-ce")).toMatch(/^5:29\./);
    expect(fake.files.has("/etc/apt/sources.list.d/docker.sources")).toBe(false);
    expect(record(fake).changes[0]?.previous).toEqual({
      engine: "5:27.3.1-1~ubuntu.24.04~noble",
      repository: "present",
    });
  });

  it("fails plainly when Docker's repository offers nothing new enough", async () => {
    const fake = new FakeHost();
    fake.dockerRepoMajor = 27;
    const error = await rejection(provision(fake));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toMatch(
      /installing Docker Engine: Docker's repository did not offer Docker Engine 28/,
    );
    expect(fake.users.has("deploy")).toBe(false);
  });

  it("serves through the tunnel without web ports, with the token only on stdin", async () => {
    const fake = new FakeHost();
    const token = tunnelToken();
    const { plan, result } = await provision(fake, tunnelDesired(fake), {
      secrets: { tunnelToken: token },
    });
    expect(result.applied).toContain("tunnel-connector");
    expect(fake.ufwRules.map((rule) => rule.rule)).toEqual(["allow 22/tcp"]);
    expect(fake.files.get("/srv/opscrew/cloudflared/tunnel.env")).toBe(`TUNNEL_TOKEN=${token}\n`);
    expect(fake.files.get("/srv/opscrew/cloudflared/compose.yaml")).toContain(
      "env_file: [tunnel.env]",
    );
    const carriers = fake.calls.filter((call) => call.input?.includes(token));
    expect(carriers.map((call) => call.name)).toEqual(["tunnel-connector.apply"]);
    for (const call of fake.calls) expect(call.command).not.toContain(token);
    expect(JSON.stringify(plan)).not.toContain(token);
    expect(fake.files.get("/etc/opscrew/host.json")).not.toContain(token);

    // A re-run needs no token: the connector is in place.
    const again = await planFor(fake, tunnelDesired(fake));
    expect(again.steps.every((step) => step.state === "in-place")).toBe(true);
  });

  it("turns Portainer on with the password only on stdin and deletes the password file", async () => {
    const fake = new FakeHost();
    const password = portainerPassword();
    await provision(fake, desiredFor(fake, { portainer: portainerDesired() }), {
      secrets: { portainerPassword: password },
    });
    expect(fake.files.has("/srv/opscrew/portainer/admin_password")).toBe(false);
    expect(fake.files.get("/srv/opscrew/portainer/compose.yaml")).not.toContain("admin_password");
    expect(
      fake.calls.filter((call) => call.input?.includes(password)).map((call) => call.name),
    ).toEqual(["portainer.apply"]);
    for (const call of fake.calls) expect(call.command).not.toContain(password);
    // Once the admin exists, a new plan needs no password.
    const again = await planFor(fake, desiredFor(fake, { portainer: portainerDesired() }));
    expect(again.steps.find((step) => step.id === "portainer")).toMatchObject({
      state: "in-place",
    });
  });
});

describe("tunnel replaced", () => {
  it("writes the new tunnel's token and restarts the connector, even with the same Compose file", async () => {
    const fake = new FakeHost();
    const first = tunnelToken();
    await provision(fake, tunnelDesired(fake), { secrets: { tunnelToken: first } });
    expect(fake.files.get("/srv/opscrew/cloudflared/tunnel.id")).toBe(`${TUNNEL_ID}\n`);

    const replaced = tunnelDesired(fake, {
      tunnel: { compose: TUNNEL_COMPOSE, tunnelId: "0a1b2c3d-2222-4e5f-8a9b-abcdefabcdef" },
    });
    const plan = await planFor(fake, replaced);
    const step = plan.steps.find((item) => item.id === "tunnel-connector");
    expect(step).toMatchObject({ state: "change", params: { needsToken: true } });
    expect(step?.reason).toMatch(/tunnel was replaced/);
    expect(plan.steps.filter((item) => item.state === "change").map((item) => item.id)).toEqual([
      "tunnel-connector",
    ]);

    // The new token is needed: refused without it, before anything changes.
    fake.calls.length = 0;
    await expect(applyApproved(fake, plan)).rejects.toThrow(/needs the tunnel token/);
    expect(fake.calls).toEqual([]);

    const second = `${tunnelToken()}SECOND`;
    const result = await applyApproved(fake, plan, { secrets: { tunnelToken: second } });
    expect(result.applied).toEqual(["tunnel-connector"]);
    expect(fake.files.get("/srv/opscrew/cloudflared/tunnel.env")).toBe(`TUNNEL_TOKEN=${second}\n`);
    expect(fake.files.get("/srv/opscrew/cloudflared/tunnel.id")).toBe(
      "0a1b2c3d-2222-4e5f-8a9b-abcdefabcdef\n",
    );
    expect(fake.tunnelRecreates).toBe(1);
    expect(fake.calls.filter((call) => call.input !== undefined).map((call) => call.name)).toEqual([
      "tunnel-connector.apply",
    ]);
    for (const call of fake.calls) expect(call.command).not.toContain(second);

    const settled = await planFor(fake, replaced);
    expect(settled.steps.every((item) => item.state === "in-place")).toBe(true);
  });
});

describe("docker daemon settings", () => {
  it("reload Docker instead of restarting it while containers run", async () => {
    const fake = new FakeHost();
    fake.packages.set("docker-ce", "5:28.5.1-1");
    fake.packages.set("docker-compose-plugin", "2.39.4");
    fake.packages.set("docker-buildx-plugin", "0.29.1");
    fake.dockerRunning = true;
    fake.containers.push({ name: "grafana", project: "monitoring", ports: "" });
    await provision(fake);
    expect(fake.files.get("/etc/docker/daemon.json")).toBe(DOCKER_DAEMON_JSON);
    expect(fake.dockerRestarts).toBe(0);
    expect(fake.dockerReloads).toBe(1);
  });

  it("are never overwritten, even when the user writes them between plan and apply", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake);
    expect(plan.steps.find((step) => step.id === "docker-daemon")?.state).toBe("change");
    fake.files.set("/etc/docker/daemon.json", '{ "data-root": "/mnt/docker" }\n');
    const result = await applyApproved(fake, plan);
    expect(result.skipped).toContain("docker-daemon");
    expect(fake.files.get("/etc/docker/daemon.json")).toBe('{ "data-root": "/mnt/docker" }\n');
  });

  it("stay when the user changed OpsCrew's file before undo", async () => {
    const fake = new FakeHost();
    await provision(fake);
    fake.files.delete("/etc/opscrew/app.json");
    fake.files.set("/etc/docker/daemon.json", '{ "log-driver": "journald" }\n');
    const undo = planUndo(await inspectHost(fake));
    expect(undo.steps.find((step) => step.id === "docker-daemon")).toMatchObject({
      state: "in-place",
    });
    await applyApproved(fake, undo);
    expect(fake.files.get("/etc/docker/daemon.json")).toBe('{ "log-driver": "journald" }\n');
  });
});

describe("claims", () => {
  it("refuses at apply time when another app claimed the server after the plan was made", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake);
    fake.files.set("/etc/opscrew/app.json", '{"app":"blog","projectId":"blog-1"}');
    fake.calls.length = 0;
    const error = await rejection(applyApproved(fake, plan));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/already runs the OpsCrew app "blog"/);
    expect(fake.names()).toEqual(["privilege", "marker.read"]);
    expect(fake.files.get("/etc/opscrew/app.json")).toBe('{"app":"blog","projectId":"blog-1"}');
  });

  it("refuses to take over the host record of another app", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake);
    fake.files.set(
      "/etc/opscrew/host.json",
      JSON.stringify({
        schemaVersion: 1,
        app: "blog",
        projectId: "blog-1",
        opscrewVersion: "0.1.0",
        changes: [],
      }),
    );
    fake.calls.length = 0;
    const error = await rejection(applyApproved(fake, plan));
    expect(error.message).toMatch(/still belongs to "blog"/);
    expect(fake.names()).toEqual(["privilege", "marker.read", "record.read"]);
    expect(JSON.parse(fake.files.get("/etc/opscrew/host.json") ?? "{}").app).toBe("blog");
  });
});

describe("host record", () => {
  it("keeps the project id when a plan without an app marker runs as root", async () => {
    const fake = new FakeHost();
    await provision(fake, desiredFor(fake, { portainer: portainerDesired() }), {
      secrets: { portainerPassword: portainerPassword() },
    });
    const off = planPortainer({
      app: "shop",
      dir: "/srv/opscrew/portainer",
      runAs: "root",
      disable: { deleteData: false },
    });
    await applyApproved(fake, off);
    expect(record(fake)).toMatchObject({ app: "shop", projectId: "shop-0123456789ab" });
  });
});

describe("ufw default policies", () => {
  it("go back to what they were when the host changes are undone", async () => {
    const fake = new FakeHost();
    fake.ufwDefaults = { incoming: "allow", outgoing: "allow", routed: "reject" };
    await provision(fake);
    expect(fake.ufwDefaults).toMatchObject({ incoming: "deny", outgoing: "allow" });
    expect(record(fake).changes.find((entry) => entry.step === "ufw")?.previous).toMatchObject({
      defaultIncoming: "allow",
      defaultOutgoing: "allow",
      defaultRouted: "reject",
    });
    fake.files.delete("/etc/opscrew/app.json");
    await applyApproved(fake, planUndo(await inspectHost(fake)));
    expect(fake.ufwDefaults).toEqual({ incoming: "allow", outgoing: "allow", routed: "reject" });
    expect(fake.ufwActive).toBe(false);
  });
});

describe("applyHostPlan refuses", () => {
  it("a plan whose hash is not the approved one, before touching the server", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake);
    fake.calls.length = 0;
    const tampered: HostPlan = {
      ...plan,
      steps: plan.steps.map((step) =>
        step.id === "sshd" ? { ...step, params: { ...step.params, permitRootLogin: "no" } } : step,
      ),
    };
    const error = await rejection(
      applyHostPlan(fake, tampered, {
        approvedHash: hostPlanHash(plan),
        verifyLogin: async () => true,
      }),
    );
    // The same code as the IaC engine's hash-bound apply.
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toMatch(/not the one that was approved/);
    expect(fake.calls).toEqual([]);
    const malformed = await rejection(
      applyHostPlan(fake, plan, { approvedHash: "not-a-hash", verifyLogin: async () => true }),
    );
    expect(malformed.code).toBe("PLAN_HASH_MISMATCH");
    expect(fake.calls).toEqual([]);
  });

  it("accepts the approved hash in upper case", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake);
    await expect(
      applyHostPlan(fake, plan, {
        approvedHash: hostPlanHash(plan).toUpperCase(),
        verifyLogin: async () => true,
      }),
    ).resolves.toMatchObject({ skipped: [] });
  });

  it("a server that already serves the web or uses another firewall, changing nothing (SC-904)", async () => {
    for (const arrange of [
      (fake: FakeHost) =>
        fake.listeners.push({ proto: "tcp", address: "0.0.0.0", port: 80, process: "nginx" }),
      (fake: FakeHost) => {
        fake.firewalld = true;
      },
    ]) {
      const fake = new FakeHost();
      arrange(fake);
      const plan = await planFor(fake);
      fake.calls.length = 0;
      const error = await rejection(applyApproved(fake, plan));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toMatch(/cannot change this server yet/);
      expect(error.hint?.length).toBeGreaterThan(10);
      expect(fake.calls).toEqual([]);
    }
  });

  it("a plan that needs a secret nobody supplied", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake, tunnelDesired(fake));
    fake.calls.length = 0;
    const error = await rejection(applyApproved(fake, plan));
    expect(error.message).toMatch(/needs the tunnel token/);
    expect(fake.calls).toEqual([]);
  });

  it("a login that cannot become root", async () => {
    const fake = new FakeHost({ login: "alice", sudo: "nopasswd" });
    const plan = await planFor(fake);
    fake.sudo = "password";
    const error = await rejection(applyApproved(fake, plan));
    expect(error.message).toMatch(/needs a password for sudo/);
    expect(fake.names().filter((name) => STEP_SCRIPTS.test(name))).toEqual([]);
  });
});

describe("dead-man switch around SSH and firewall changes", () => {
  it("schedules the undo before the change and cancels it only after new logins work", async () => {
    const fake = new FakeHost();
    const order: string[] = [];
    const verifyLogin = async () => {
      order.push(`verifyLogin after ${fake.names().at(-1)}`);
      return true;
    };
    await provision(fake, desiredFor(fake), { verifyLogin, deadManSeconds: 240 });
    const names = fake.names().filter((name) => /^(sshd|ufw)\.|^deadman\./.test(name));
    expect(names).toEqual([
      "sshd.check",
      "deadman.arm.sshd",
      "sshd.apply",
      "deadman.cancel.sshd",
      "sshd.verify",
      "ufw.check",
      "deadman.arm.ufw",
      "ufw.apply",
      "deadman.cancel.ufw",
      "ufw.verify",
    ]);
    expect(order).toEqual(["verifyLogin after sshd.apply", "verifyLogin after ufw.apply"]);
    expect(fake.armedSeconds).toEqual([240, 240]);
    expect(fake.timers.size).toBe(0);
  });

  it("puts the previous SSH settings back when new logins fail, and stops there", async () => {
    const fake = new FakeHost();
    fake.files.set("/etc/ssh/sshd_config.d/10-opscrew.conf", "PermitRootLogin yes\n");
    const error = await rejection(
      provision(fake, desiredFor(fake), { verifyLogin: async () => false }),
    );
    expect(error.message).toMatch(
      /New SSH logins .* did not work after changing the SSH settings, so OpsCrew put the previous SSH settings back/,
    );
    expect(fake.files.get("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe("PermitRootLogin yes\n");
    expect(fake.names()).toContain("deadman.trigger.sshd");
    expect(fake.names()).not.toContain("ufw.apply");
    expect(fake.ufwActive).toBe(false);
  });

  it("treats a verifyLogin that throws as a failed login", async () => {
    const fake = new FakeHost();
    const error = await rejection(
      provision(fake, desiredFor(fake), {
        verifyLogin: async () => {
          throw new Error("ssh: connect to host port 22: Connection refused");
        },
      }),
    );
    expect(error.message).toMatch(/put the previous SSH settings back/);
    expect(fake.files.has("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(false);
  });

  it("turns the firewall back off when logins fail after enabling it", async () => {
    const fake = new FakeHost();
    let calls = 0;
    const verifyLogin = async () => {
      calls += 1;
      return calls === 1; // sshd fine, ufw breaks logins
    };
    const error = await rejection(provision(fake, desiredFor(fake), { verifyLogin }));
    expect(error.message).toMatch(
      /after setting up the ufw firewall, so OpsCrew put the previous firewall settings back/,
    );
    expect(fake.ufwActive).toBe(false);
    expect(fake.ufwRules).toEqual([]);
    expect(fake.files.has("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(true);
  });

  it("says the server undoes the change on its own when it cannot be reached", async () => {
    const fake = new FakeHost();
    fake.dropOn.add("deadman.trigger.sshd");
    const error = await rejection(
      provision(fake, desiredFor(fake), { verifyLogin: async () => false }),
    );
    expect(error.message).toMatch(/could not reach the server .* within 180 seconds/);
    expect(fake.timers.has("sshd")).toBe(true);
  });

  it("refuses to keep a change whose undo already fired", async () => {
    const fake = new FakeHost();
    fake.fireBeforeCancel = true;
    const error = await rejection(provision(fake));
    expect(error.message).toMatch(
      /took longer than 180 seconds, so the server already put the previous SSH settings back/,
    );
    expect(fake.files.has("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(false);
  });

  it("restores the settings when sshd -t rejects them", async () => {
    const fake = new FakeHost();
    fake.sshdTestFails = true;
    const error = await rejection(provision(fake));
    expect(error.message).toMatch(/did not pass sshd -t.*The previous SSH settings are back/);
    expect(fake.files.has("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(false);
    expect(fake.timers.size).toBe(0);
  });

  it("refuses when an earlier sshd file overrides OpsCrew's settings", async () => {
    const fake = new FakeHost();
    fake.sshdEarlierDropIn = { passwordauthentication: "yes" };
    const error = await rejection(provision(fake));
    expect(error.message).toMatch(/takes precedence/);
    expect(fake.files.has("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(false);
  });
});

describe("resuming after an interruption", () => {
  it("continues where it stopped and keeps the first previous values", async () => {
    const fake = new FakeHost();
    fake.dropOn.add("unattended-upgrades.apply");
    const error = await rejection(provision(fake));
    expect(error.message).toMatch(
      /lost the connection to the server while turning on automatic security updates/,
    );

    const plan = await planFor(fake);
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["docker", "in-place"],
      ["docker-daemon", "in-place"],
      ["deploy-user", "in-place"],
      ["sshd", "in-place"],
      ["ufw", "in-place"],
      ["fail2ban", "in-place"],
      ["unattended-upgrades", "change"],
      ["runtime-dirs", "change"],
      ["app-marker", "change"],
    ]);
    const result = await applyApproved(fake, plan);
    expect(result.applied).toEqual(["unattended-upgrades", "runtime-dirs", "app-marker"]);
    const upgrades = record(fake).changes.filter((entry) => entry.step === "unattended-upgrades");
    expect(upgrades).toHaveLength(1);
  });

  it("puts back a change whose dead-man was still waiting, then applies it again", async () => {
    const fake = new FakeHost();
    fake.dropOn.add("deadman.cancel.sshd");
    await rejection(provision(fake));
    expect(fake.timers.has("sshd")).toBe(true);
    const facts = await inspectHost(fake);
    expect(facts.pendingUndo.sshd).toBe(true);
    const plan = planHost(facts, desiredFor(fake));
    expect(plan.steps.find((step) => step.id === "sshd")?.state).toBe("change");
    await applyApproved(fake, plan);
    expect(fake.timers.size).toBe(0);
    expect(fake.files.get("/etc/ssh/sshd_config.d/10-opscrew.conf")).toContain(
      "PasswordAuthentication no",
    );
    expect(record(fake).changes.filter((entry) => entry.step === "sshd")).toHaveLength(1);
  });
});

describe("secrets", () => {
  it("never appear in errors, even when the server echoes its input", async () => {
    const fake = new FakeHost();
    const token = tunnelToken();
    fake.echoStdinOn = "tunnel-connector.apply";
    const error = await rejection(
      provision(fake, tunnelDesired(fake), { secrets: { tunnelToken: token } }),
    );
    expect(error.message).not.toContain(token);
    expect(
      JSON.stringify({ message: error.message, hint: error.hint, cause: String(error.cause) }),
    ).not.toContain(token);
    expect(error.message).toContain("[REDACTED");
    expect(error.cause).toBeUndefined();
  });

  it("fail safely when the transport drops stdin: no empty token file", async () => {
    const fake = new FakeHost();
    const deaf: RemoteExec = {
      host: fake.host,
      run: (command: string, options?: { timeoutMs?: number }): Promise<CommandResult> =>
        fake.run(command, { timeoutMs: options?.timeoutMs }),
    };
    const plan = await planFor(fake, tunnelDesired(fake));
    const error = await rejection(
      applyHostPlan(deaf, plan, {
        approvedHash: hostPlanHash(plan),
        verifyLogin: async () => true,
        secrets: { tunnelToken: tunnelToken() },
      }),
    );
    expect(error.message).toMatch(/No tunnel token arrived on standard input/);
    expect(fake.files.has("/srv/opscrew/cloudflared/tunnel.env")).toBe(false);
  });

  it("are checked before anything changes", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake, tunnelDesired(fake));
    fake.calls.length = 0;
    const error = await rejection(
      applyApproved(fake, plan, { secrets: { tunnelToken: "has spaces in it, not a token" } }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).not.toContain("has spaces");
    expect(fake.calls).toEqual([]);
  });
});

describe("teardown", () => {
  async function deployed(withPortainer = false) {
    const fake = new FakeHost();
    const desired = desiredFor(fake, withPortainer ? { portainer: portainerDesired() } : {});
    await provision(fake, desired, { secrets: { portainerPassword: portainerPassword() } });
    deployApp(fake, "shop");
    fake.containers.push({
      name: "grafana",
      project: "monitoring",
      ports: "0.0.0.0:3000->3000/tcp",
    });
    return fake;
  }

  it("removes the app but keeps its data without deleteData, and never touches other containers", async () => {
    const fake = await deployed(true);
    const plan = planTeardown(await inspectHost(fake), { deleteData: false });
    const result = await applyApproved(fake, plan);
    expect(result.applied).toEqual(["runtime-dirs", "portainer", "app-marker"]);
    expect(fake.containers.map((container) => container.name)).toEqual(["grafana"]);
    expect(fake.dirs.get("/srv/app")?.entries).toBe(0);
    expect(fake.dirs.get("/srv/data")?.entries).toBe(1);
    expect(fake.volumes.get("opscrew-portainer")).toBe(1);
    expect(fake.files.has("/etc/opscrew/app.json")).toBe(false);
    // Host settings stay: deploy user, SSH, firewall.
    expect(fake.users.has("deploy")).toBe(true);
    expect(fake.ufwActive).toBe(true);
    expect(
      record(fake)
        .changes.filter((entry) => entry.purpose === "teardown")
        .map((entry) => entry.step),
    ).toEqual(["runtime-dirs", "portainer", "app-marker"]);
  });

  it("deletes the data only with deleteData", async () => {
    const fake = await deployed(true);
    const plan = planTeardown(await inspectHost(fake), { deleteData: true });
    await applyApproved(fake, plan);
    expect(fake.dirs.get("/srv/data")?.entries).toBe(0);
    expect(fake.volumes.has("opscrew-portainer")).toBe(false);
  });
});

describe("undo", () => {
  it("reverses OpsCrew's host changes and leaves the rest of the server alone", async () => {
    const fake = new FakeHost();
    fake.ufwRules = [{ rule: "allow 8080/tcp", comment: null }];
    fake.users.set("alice", {
      uid: 1000,
      password: true,
      keys: ["ssh-ed25519 AAAAalice"],
      groups: ["alice"],
    });
    await provision(fake);
    deployApp(fake, "shop");
    await applyApproved(fake, planTeardown(await inspectHost(fake), { deleteData: true }));

    const undo = planUndo(await inspectHost(fake));
    expect(undo.findings).toEqual([]);
    const result = await applyApproved(fake, undo);
    expect(result).toEqual({
      applied: [
        "runtime-dirs",
        "unattended-upgrades",
        "fail2ban",
        "ufw",
        "sshd",
        "deploy-user",
        "docker-daemon",
        "app-marker",
      ],
      skipped: ["docker"],
    });
    expect(fake.files.has("/etc/docker/daemon.json")).toBe(false);
    expect(fake.files.has("/etc/fail2ban/jail.d/opscrew.local")).toBe(false);
    expect(fake.packages.has("fail2ban")).toBe(false);
    expect(fake.files.has("/var/lib/opscrew-ready")).toBe(false);
    expect(fake.users.has("deploy")).toBe(false);
    expect(fake.users.has("alice")).toBe(true);
    expect(fake.files.has("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(false);
    expect(fake.ufwActive).toBe(false);
    expect(fake.ufwRules).toEqual([{ rule: "allow 8080/tcp", comment: null }]);
    expect(fake.files.has("/etc/apt/apt.conf.d/21opscrew-auto-upgrades")).toBe(false);
    expect(fake.dirs.size).toBe(0);
    expect([...fake.files.keys()].filter((path) => path.startsWith("/etc/opscrew"))).toEqual([]);
    // Docker stays installed.
    expect(fake.packages.has("docker-ce")).toBe(true);
    // SSH and firewall undo ran under the dead-man switch too.
    expect(fake.names()).toContain("deadman.arm.sshd");
    expect(fake.names()).toContain("deadman.cancel.ufw");
  });

  it("puts back the sshd drop-in that was there before OpsCrew", async () => {
    const fake = new FakeHost();
    fake.files.set("/etc/ssh/sshd_config.d/10-opscrew.conf", "X11Forwarding no\n");
    await provision(fake);
    expect(fake.files.get("/etc/opscrew/backup/10-opscrew.conf")).toBe("X11Forwarding no\n");
    fake.files.delete("/etc/opscrew/app.json");
    await applyApproved(fake, planUndo(await inspectHost(fake)));
    expect(fake.files.get("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe("X11Forwarding no\n");
  });
});

describe("planPortainer (servers OpsCrew created)", () => {
  it("runs as the login without root and writes no host record", async () => {
    const fake = new FakeHost({ login: "deploy", sudo: "none" });
    const plan = planPortainer({
      app: "shop",
      dir: "/home/deploy/opscrew/portainer",
      enable: { ...portainerDesired(), needsPassword: true },
    });
    const password = portainerPassword();
    const result = await applyApproved(fake, plan, { secrets: { portainerPassword: password } });
    expect(result.applied).toEqual(["portainer"]);
    expect(fake.calls.every((call) => !call.sudo)).toBe(true);
    expect(fake.names()).toEqual(["portainer.check", "portainer.apply", "portainer.verify"]);
    expect(fake.files.has("/home/deploy/opscrew/portainer/admin_password")).toBe(false);
    expect(fake.files.has("/etc/opscrew/host.json")).toBe(false);

    const off = planPortainer({
      app: "shop",
      dir: "/home/deploy/opscrew/portainer",
      disable: { deleteData: true },
    });
    await applyApproved(fake, off);
    expect(fake.volumes.has("opscrew-portainer")).toBe(false);
  });

  it("turns Portainer off and deletes its data on a server the user owns (root)", async () => {
    const fake = new FakeHost();
    await provision(fake, desiredFor(fake, { portainer: portainerDesired() }), {
      secrets: { portainerPassword: portainerPassword() },
    });
    const off = planPortainer({
      app: "shop",
      dir: "/srv/opscrew/portainer",
      runAs: "root",
      disable: { deleteData: true },
    });
    const result = await applyApproved(fake, off);
    expect(result.applied).toEqual(["portainer"]);
    expect(fake.containers.some((container) => container.project === "opscrew-portainer")).toBe(
      false,
    );
    expect(fake.volumes.has("opscrew-portainer")).toBe(false);
    expect(fake.files.has("/srv/opscrew/portainer/compose.yaml")).toBe(false);
    expect(() =>
      planPortainer({
        app: "shop",
        dir: "/home/deploy/portainer",
        runAs: "root",
        disable: { deleteData: false },
      }),
    ).toThrow(/invalid parameters/);
  });

  it("refuses a root Portainer outside OpsCrew's directory and odd paths", () => {
    expect(() =>
      planPortainer({ app: "shop", dir: "/home/deploy/../../etc", disable: { deleteData: false } }),
    ).toThrow(/invalid parameters/);
  });
});
