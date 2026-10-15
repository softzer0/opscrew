/**
 * The `ufw` and `docker-daemon` setup steps on servers that already run things: an active ufw
 * that lets every incoming connection in (T927), and containers OpsCrew did not create (T929).
 */
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import { applyApproved, planFor, provision } from "./__fixtures__/helpers";
import { hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planUndo } from "./plan";
import type { HostPlan } from "./types";

const stepOf = (plan: HostPlan, id: string) => plan.steps.find((step) => step.id === id);
const WEB = ["22/tcp", "80/tcp", "443/tcp", "443/udp"].map((rule) => ({
  rule: `allow ${rule}`,
  comment: null,
}));

/** An Ubuntu server whose ufw is on with the given default incoming policy. */
function activeUfw(incoming: "allow" | "deny" | "reject"): FakeHost {
  const fake = new FakeHost();
  fake.ufwActive = true;
  fake.ufwDefaults = { incoming, outgoing: "allow", routed: "deny" };
  return fake;
}

/** A server with Docker Engine running (and the Compose and Buildx plugins). */
function withDocker(): FakeHost {
  const fake = new FakeHost();
  fake.packages.set("docker-ce", "5:28.5.1-1");
  fake.packages.set("docker-compose-plugin", "2.39.4");
  fake.packages.set("docker-buildx-plugin", "0.29.1");
  fake.dockerRunning = true;
  return fake;
}

describe("ufw that is on but lets everything in (T927)", () => {
  it("keeps plans where the default incoming policy already denies exactly as before", async () => {
    // The hashes these fake servers gave before OpsCrew looked at ufw's default policies.
    expect(hostPlanHash(await planFor(activeUfw("deny")))).toBe(
      "5919112415deba156e1a66479fc925943ec8d1dae6785e96e5ccdb6c473d9e2d",
    );
    const covered = activeUfw("deny");
    covered.ufwRules = WEB;
    const plan = await planFor(covered);
    expect(stepOf(plan, "ufw")).toMatchObject({ state: "in-place", reason: "Already set." });
    expect(hostPlanHash(plan)).toBe(
      "0f124c5ff740384710fb4ef27f5bfab9d87d3e934cec5f5f27f1e7b0e9d7a81d",
    );
    const reject = activeUfw("reject");
    reject.ufwRules = WEB;
    expect(stepOf(await planFor(reject), "ufw")?.state).toBe("in-place");
  });

  it("plans a change to deny incoming traffic and says plainly that ufw let everything in", async () => {
    const fake = activeUfw("allow");
    fake.ufwRules = WEB;
    const plan = await planFor(fake);
    expect(plan.findings).toEqual([]);
    const ufw = stepOf(plan, "ufw");
    expect(ufw?.state).toBe("change");
    expect(ufw?.params).toEqual({
      sshPorts: "22",
      sshRulePorts: "",
      webRules: "",
      web: true,
      enable: false,
      install: false,
      denyIncoming: true,
    });
    expect(ufw?.title).toBe(
      "Make the ufw firewall deny incoming traffic except SSH (port 22), HTTP and HTTPS",
    );
    expect(ufw?.reason).toMatch(/^ufw is on, but it lets everything in/);
    expect(ufw?.reason).toMatch(/SSH rule .* first/);
    expect(ufw?.reason).toMatch(/puts "allow" back on its own unless new logins work/);
    expect(ufw?.reason).toMatch(/opscrew destroy --undo-host/);
  });

  it("adds the missing SSH and web rules too", async () => {
    const plan = await planFor(activeUfw("allow"));
    expect(stepOf(plan, "ufw")?.params).toMatchObject({
      sshRulePorts: "22",
      webRules: "80/tcp 443/tcp 443/udp",
      denyIncoming: true,
    });
  });

  it("refuses when a public service would be cut off, unless a rule already lets it in", async () => {
    const fake = activeUfw("allow");
    fake.listeners.push({ proto: "tcp", address: "0.0.0.0", port: 8080, process: "node" });
    const plan = await planFor(fake);
    expect(stepOf(plan, "ufw")?.state).toBe("blocked");
    expect(plan.findings.map((finding) => finding.code)).toEqual(["firewall-would-block"]);
    expect(plan.findings[0]?.message).toMatch(/^ufw is on but lets every incoming connection in/);
    expect(plan.findings[0]?.message).toContain("8080/tcp (node)");
    expect(plan.findings[0]?.hint).toMatch(/sudo ufw allow 8080\/tcp/);

    fake.ufwRules = [{ rule: "allow from 10.0.0.0/8 to any port 8080", comment: null }];
    expect(stepOf(await planFor(fake), "ufw")?.state).toBe("blocked");
    fake.ufwRules = [{ rule: "allow 8080/tcp", comment: null }];
    const open = await planFor(fake);
    expect(open.findings).toEqual([]);
    expect(stepOf(open, "ufw")?.state).toBe("change");
  });

  it("sets deny under the dead-man switch, records the old default, and is in place afterwards", async () => {
    const fake = activeUfw("allow");
    const { result } = await provision(fake);
    expect(result.applied).toContain("ufw");
    expect(fake.ufwDefaults.incoming).toBe("deny");
    expect(fake.ufwActive).toBe(true);
    // The SSH rule comes before the default changes; the switch was armed for the change.
    expect(fake.ufwLog.indexOf("allow 22/tcp")).toBeGreaterThanOrEqual(0);
    expect(fake.ufwLog.indexOf("allow 22/tcp")).toBeLessThan(
      fake.ufwLog.indexOf("default deny incoming"),
    );
    expect(fake.armedSeconds.length).toBeGreaterThan(0);
    const facts = await inspectHost(fake);
    const entry = facts.record?.changes.find((change) => change.step === "ufw");
    expect(entry?.previous).toMatchObject({ active: true, defaultIncoming: "allow" });
    expect(stepOf(await planFor(fake), "ufw")?.state).toBe("in-place");
  });

  it("puts allow back when new logins fail", async () => {
    const fake = activeUfw("allow");
    const plan = await planFor(fake);
    // Logins work until the default turns to deny (the SSH change before it is kept).
    const verifyLogin = async () => fake.ufwDefaults.incoming !== "deny";
    await expect(applyApproved(fake, plan, { verifyLogin })).rejects.toThrow(/firewall/);
    expect(fake.ufwLog).toContain("default deny incoming");
    expect(fake.ufwLog.at(-1)).toBe("restored");
    expect(fake.ufwDefaults.incoming).toBe("allow");
    expect(fake.ufwActive).toBe(true);
  });

  it("undo puts the old default incoming policy back and leaves ufw on", async () => {
    const fake = activeUfw("allow");
    await provision(fake);
    fake.files.delete("/etc/opscrew/app.json");
    const undo = planUndo(await inspectHost(fake));
    const ufw = stepOf(undo, "ufw");
    expect(ufw?.state).toBe("change");
    expect(ufw?.params).toEqual({
      removeRules: "22/tcp 80/tcp 443/tcp 443/udp",
      disable: false,
      removePackage: false,
      defaultIncoming: "allow",
      defaultOutgoing: "",
      defaultRouted: "",
    });
    expect(ufw?.title).toBe(
      'Remove the firewall rules OpsCrew added and put the previous default policy for incoming traffic ("allow") back',
    );
    await applyApproved(fake, undo);
    expect(fake.ufwDefaults.incoming).toBe("allow");
    expect(fake.ufwActive).toBe(true);
  });
});

describe("Docker's daemon settings next to the user's containers (T929)", () => {
  it("keeps today's step on servers with only OpsCrew's containers or none", async () => {
    const idle = withDocker();
    expect(hostPlanHash(await planFor(idle))).toBe(
      "d4c09474ceda547df245340f0a38ecb996b612e44fe293b54ac0d956f114bd42",
    );
    // A server OpsCrew prepared whose daemon.json is gone again, running only the app.
    const own = withDocker();
    await provision(own);
    own.files.delete("/etc/docker/daemon.json");
    own.containers.push(
      { name: "shop-app-1", project: "shop", ports: "" },
      { name: "shop-caddy-1", project: "shop", ports: "0.0.0.0:443->443/tcp" },
    );
    const plan = await planFor(own);
    expect(stepOf(plan, "docker-daemon")?.state).toBe("change");
    expect(hostPlanHash(plan)).toBe(
      "7306045d1e23890bd83a1f43024928a3972b602c33a8e614892aeb699dca1a4b",
    );
    // OpsCrew's add-ons are its own too.
    own.containers.push(
      { name: "opscrew-tunnel-cloudflared-1", project: "opscrew-tunnel", ports: "" },
      { name: "opscrew-portainer-portainer-1", project: "opscrew-portainer", ports: "" },
    );
    expect(stepOf(await planFor(own), "docker-daemon")?.state).toBe("change");
  });

  it("leaves daemon.json alone, with a plain note, when the user's containers run here", async () => {
    const fake = withDocker();
    fake.containers.push(
      { name: "grafana", project: "monitoring", ports: "" },
      { name: "pihole", project: "", ports: "", stopped: true },
    );
    const plan = await planFor(fake);
    expect(stepOf(plan, "docker-daemon")).toEqual({
      id: "docker-daemon",
      title: "Docker daemon settings: log rotation, no-new-privileges, live-restore",
      state: "in-place",
      reason:
        "This server runs containers OpsCrew did not create (grafana, pihole), so OpsCrew leaves Docker's daemon settings alone and writes no daemon.json: your containers keep their behaviour. OpsCrew's own services set log rotation and no-new-privileges in their Compose files instead.",
      params: { path: "/etc/docker/daemon.json" },
    });
    const result = await applyApproved(fake, plan);
    expect(result.skipped).toContain("docker-daemon");
    expect(fake.files.has("/etc/docker/daemon.json")).toBe(false);
  });

  it("counts a Compose project of the user's that has only volumes, and shortens long lists", async () => {
    const fake = withDocker();
    fake.volumes.set("nextcloud", 2);
    expect(stepOf(await planFor(fake), "docker-daemon")?.reason).toContain(
      "(the volumes of the Compose project nextcloud)",
    );
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      fake.containers.push({ name, project: "", ports: "" });
    }
    expect(stepOf(await planFor(fake), "docker-daemon")?.reason).toContain(
      "(a, b, c, d, e, 3 more)",
    );
  });
});
