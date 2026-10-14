import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { deployApp, FakeHost } from "./__fixtures__/fake-host";
import {
  DEPLOY_KEY,
  desiredFor,
  planFor,
  portainerDesired,
  provision,
  TUNNEL_COMPOSE,
  tunnelDesired,
} from "./__fixtures__/helpers";
import { canonicalJson, hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planHost, planTeardown, planUndo } from "./plan";
import type { HostPlan } from "./types";

const codes = (plan: HostPlan) => plan.findings.map((finding) => finding.code);
const stateOf = (plan: HostPlan, id: string) => plan.steps.find((step) => step.id === id)?.state;
const paramsOf = (plan: HostPlan, id: string) => plan.steps.find((step) => step.id === id)?.params;

describe("hostPlanHash", () => {
  it("is the SHA-256 of canonical JSON, whatever the key order", async () => {
    const plan = await planFor(new FakeHost());
    const { findings, steps, ...rest } = plan;
    const reordered = JSON.parse(JSON.stringify({ findings, steps, ...rest })) as HostPlan;
    expect(Object.keys(reordered)[0]).toBe("findings");
    expect(hostPlanHash(reordered)).toBe(hostPlanHash(plan));
    expect(hostPlanHash(plan)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [true, null], c: undefined })).toBe('{"a":[true,null],"b":1}');
  });

  it("changes when any parameter changes", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    const a = planHost(facts, desiredFor(fake));
    const b = planHost(
      facts,
      desiredFor(fake, { deploy: { user: "deploy", publicKey: `${DEPLOY_KEY}2` } }),
    );
    expect(hostPlanHash(a)).not.toBe(hostPlanHash(b));
  });
});

describe("planHost: steps", () => {
  it("keeps root on key-only logins when the user connects as root", async () => {
    const plan = await planFor(new FakeHost({ login: "root" }));
    expect(paramsOf(plan, "sshd")).toEqual({
      permitRootLogin: "prohibit-password",
      disablePasswords: true,
      kbdInteractiveOff: true,
    });
    expect(plan.steps.find((step) => step.id === "sshd")?.title).toMatch(
      /root keeps key-only logins/,
    );
  });

  it("turns root logins off when the user connects with sudo", async () => {
    const fake = new FakeHost({ login: "alice", sudo: "nopasswd" });
    expect(paramsOf(await planFor(fake), "sshd")?.permitRootLogin).toBe("no");
  });

  it("leaves keyboard-interactive alone when AuthenticationMethods is customised", async () => {
    const fake = new FakeHost();
    fake.sshdBase.authenticationMethods = "publickey,keyboard-interactive";
    expect(paramsOf(await planFor(fake), "sshd")?.kbdInteractiveOff).toBe(false);
  });

  it("needs an explicit choice before turning passwords off for users without keys", async () => {
    const fake = new FakeHost();
    fake.users.set("bob", { uid: 1001, password: true, keys: [], groups: ["bob"] });
    const plan = await planFor(fake);
    expect(stateOf(plan, "sshd")).toBe("blocked");
    expect(codes(plan)).toEqual(["password-users-without-keys"]);
    expect(plan.findings[0]?.message).toContain("bob");

    const off = planHost(await inspectHost(fake), desiredFor(fake, { disablePasswords: true }));
    expect(codes(off)).toEqual([]);
    expect(paramsOf(off, "sshd")?.disablePasswords).toBe(true);
    const keep = planHost(await inspectHost(fake), desiredFor(fake, { disablePasswords: false }));
    expect(paramsOf(keep, "sshd")).toMatchObject({
      disablePasswords: false,
      kbdInteractiveOff: false,
    });
  });

  it("opens the SSH port sshd really uses, and web ports only in public mode", async () => {
    const fake = new FakeHost();
    fake.sshdBase.port = [2222];
    fake.listeners = [{ proto: "tcp", address: "0.0.0.0", port: 2222, process: "sshd" }];
    const publicPlan = await planFor(fake, desiredFor(fake, { sshPort: 2222 }));
    expect(paramsOf(publicPlan, "ufw")).toEqual({
      sshPorts: "2222",
      web: true,
      enable: true,
      install: false,
    });
    expect(publicPlan.steps.find((step) => step.id === "ufw")?.title).toContain(
      "SSH (port 2222), HTTP and HTTPS",
    );
    const tunnelPlan = await planFor(fake, tunnelDesired(fake, { sshPort: 2222 }));
    expect(paramsOf(tunnelPlan, "ufw")).toMatchObject({ sshPorts: "2222", web: false });
  });

  it("also allows the port systemd's ssh.socket really listens on", async () => {
    const fake = new FakeHost();
    fake.listeners = [{ proto: "tcp", address: "0.0.0.0", port: 2200, process: "systemd" }];
    const plan = await planFor(fake, desiredFor(fake, { sshPort: 2200 }));
    expect(paramsOf(plan, "ufw")?.sshPorts).toBe("22 2200");
    expect(codes(plan)).toEqual([]);
  });

  it("installs ufw when it is missing (Debian)", async () => {
    const fake = new FakeHost({ os: "debian-12" });
    fake.packages.delete("ufw");
    expect(paramsOf(await planFor(fake), "ufw")).toMatchObject({ install: true, enable: true });
  });

  it("plans the tunnel connector with the caller's Compose file and no secret", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake, tunnelDesired(fake));
    expect(paramsOf(plan, "tunnel-connector")).toEqual({
      compose: TUNNEL_COMPOSE,
      needsToken: true,
    });
    expect(plan.steps.find((step) => step.id === "tunnel-connector")?.title).toContain(
      "cloudflare/cloudflared:2026.5.1",
    );
  });

  it("plans Portainer only when asked, local-only, with a password needed only for a new install", async () => {
    const fake = new FakeHost();
    expect(paramsOf(await planFor(fake), "portainer")).toBeUndefined();
    const plan = await planFor(fake, desiredFor(fake, { portainer: portainerDesired() }));
    expect(paramsOf(plan, "portainer")).toMatchObject({
      version: "2.33.1",
      dir: "/srv/opscrew/portainer",
      runAs: "root",
      needsPassword: true,
    });
    expect(plan.steps.find((step) => step.id === "portainer")?.title).toContain("127.0.0.1:9443");
  });

  it("plans a Docker upgrade from the repository for Docker older than 28, and says containers restart", async () => {
    const fake = new FakeHost();
    fake.packages.set("docker-ce", "5:27.3.1-1~ubuntu.24.04~noble");
    fake.packages.set("docker-compose-plugin", "2.29.7");
    fake.packages.set("docker-buildx-plugin", "0.17.1");
    fake.dockerRunning = true;
    const plan = await planFor(fake);
    const docker = plan.steps.find((step) => step.id === "docker");
    expect(docker?.state).toBe("change");
    expect(docker?.params.action).toBe("upgrade");
    expect(docker?.reason).toMatch(/older than 28.*restart/s);
  });

  it("keeps a Docker 28+ install from the repository in place", async () => {
    const fake = new FakeHost();
    fake.packages.set("docker-ce", "5:28.5.1-1~ubuntu.24.04~noble");
    fake.packages.set("docker-compose-plugin", "2.39.4");
    fake.packages.set("docker-buildx-plugin", "0.29.1");
    fake.dockerRunning = true;
    expect(stateOf(await planFor(fake), "docker")).toBe("in-place");
  });
});

describe("planHost: conflicts block with a plain message and a hint", () => {
  const cases: [
    string,
    (fake: FakeHost) => void,
    string,
    ReturnType<typeof desiredFor> | undefined,
  ][] = [
    [
      "another web server on port 80",
      (fake) => {
        fake.webUnits = ["nginx"];
        fake.listeners.push({ proto: "tcp", address: "0.0.0.0", port: 80, process: "nginx" });
      },
      "web-ports-in-use",
      undefined,
    ],
    [
      "a container publishing port 443",
      (fake) => {
        fake.packages.set("docker-ce", "5:28.5.1-1");
        fake.packages.set("docker-compose-plugin", "2.39.4");
        fake.packages.set("docker-buildx-plugin", "0.29.1");
        fake.dockerRunning = true;
        fake.containers.push({ name: "traefik", project: "proxy", ports: "0.0.0.0:443->443/tcp" });
        fake.listeners.push({
          proto: "tcp",
          address: "0.0.0.0",
          port: 443,
          process: "docker-proxy",
        });
      },
      "web-ports-in-use",
      undefined,
    ],
    [
      "firewalld",
      (fake) => {
        fake.firewalld = true;
      },
      "other-firewall",
      undefined,
    ],
    [
      "iptables INPUT rules",
      (fake) => {
        fake.iptables =
          "*filter\n:INPUT ACCEPT [0:0]\n-A INPUT -p tcp --dport 22 -j ACCEPT\n-A INPUT -j DROP\nCOMMIT";
      },
      "other-firewall",
      undefined,
    ],
    [
      "Docker from Snap",
      (fake) => {
        fake.snapDocker = true;
      },
      "docker-snap",
      undefined,
    ],
    [
      "Podman",
      (fake) => void fake.packages.set("podman-docker", "4.9.3"),
      "docker-podman",
      undefined,
    ],
    [
      "the distribution's docker.io",
      (fake) => void fake.packages.set("docker.io", "26.1.3"),
      "docker-distro",
      undefined,
    ],
    [
      "a manual Docker install",
      (fake) => {
        fake.strayDocker = true;
      },
      "docker-unknown-install",
      undefined,
    ],
    [
      "the distribution's containerd",
      (fake) => void fake.packages.set("containerd", "1.7.12"),
      "docker-conflicting-packages",
      undefined,
    ],
    [
      "another OpsCrew app",
      (fake) => void fake.files.set("/etc/opscrew/app.json", '{"app":"blog","projectId":"blog-1"}'),
      "another-app",
      undefined,
    ],
    [
      "the same app from another project",
      (fake) =>
        void fake.files.set("/etc/opscrew/app.json", '{"app":"shop","projectId":"shop-other"}'),
      "another-project",
      undefined,
    ],
    [
      "a damaged marker",
      (fake) => void fake.files.set("/etc/opscrew/app.json", "{"),
      "marker-damaged",
      undefined,
    ],
    [
      "a deploy user OpsCrew did not create",
      (fake) =>
        void fake.users.set("deploy", { uid: 1005, password: false, keys: [], groups: ["deploy"] }),
      "deploy-user-exists",
      undefined,
    ],
    [
      "AllowUsers without deploy",
      (fake) => {
        fake.sshdBase.allowUsers = ["alice"];
      },
      "sshd-blocks-deploy",
      undefined,
    ],
    [
      "an existing /srv/app",
      (fake) =>
        void fake.dirs.set("/srv/app", { owner: "root", group: "root", mode: "755", entries: 2 }),
      "runtime-dir-exists",
      undefined,
    ],
    [
      "public services ufw would cut off",
      (fake) => {
        fake.listeners.push(
          { proto: "tcp", address: "0.0.0.0", port: 25565, process: "java" },
          { proto: "udp", address: "0.0.0.0", port: 51820, process: "" },
        );
      },
      "firewall-would-block",
      undefined,
    ],
    [
      "sshd ignoring its drop-in directory",
      (fake) => {
        fake.sshdIncludesDropIns = false;
      },
      "sshd-dropin-ignored",
      undefined,
    ],
  ];

  for (const [what, arrange, code, desired] of cases) {
    it(`${what} → ${code}`, async () => {
      const fake = new FakeHost();
      arrange(fake);
      const plan = await planFor(fake, desired ?? desiredFor(fake));
      expect(codes(plan)).toContain(code);
      const finding = plan.findings.find((item) => item.code === code);
      expect(finding?.message.length).toBeGreaterThan(20);
      expect(finding?.hint.length).toBeGreaterThan(20);
    });
  }

  it("names what listens on the web ports", async () => {
    const fake = new FakeHost();
    fake.listeners.push({ proto: "tcp", address: "0.0.0.0", port: 443, process: "apache2" });
    const plan = await planFor(fake);
    expect(plan.findings[0]?.message).toContain("apache2 on port 443/tcp");
    expect(plan.findings[0]?.hint).toMatch(/Cloudflare Tunnel/);
  });

  it("does not need ports 80/443 in tunnel mode, but needs 18080 free on the server itself", async () => {
    const fake = new FakeHost();
    fake.listeners.push({ proto: "tcp", address: "0.0.0.0", port: 80, process: "nginx" });
    fake.ufwActive = true;
    fake.packages.set("ufw", "0.36.2");
    const plan = await planFor(fake, tunnelDesired(fake));
    expect(codes(plan)).toEqual([]);
    fake.listeners.push({ proto: "tcp", address: "127.0.0.1", port: 18080, process: "node" });
    expect(codes(await planFor(fake, tunnelDesired(fake)))).toEqual(["tunnel-port-in-use"]);
  });

  it("needs sshd on localhost in tunnel mode (the tunnel reaches ssh://localhost:<port>)", async () => {
    const fake = new FakeHost();
    fake.listeners = [{ proto: "tcp", address: "203.0.113.10", port: 22, process: "sshd" }];
    const plan = await planFor(fake, tunnelDesired(fake));
    expect(codes(plan)).toEqual(["sshd-not-local"]);
    expect(plan.findings[0]?.message).toContain("203.0.113.10:22");
    // Public mode does not need it.
    expect(codes(await planFor(fake))).toEqual([]);
  });

  it("needs SSH local forwarding for the Portainer tunnel command", async () => {
    const fake = new FakeHost();
    fake.sshdBase.allowTcpForwarding = "no";
    const plan = await planFor(fake, desiredFor(fake, { portainer: portainerDesired() }));
    expect(codes(plan)).toEqual(["ssh-forwarding-off"]);
    expect(plan.findings[0]?.hint).toContain("Match User deploy");
    expect(stateOf(plan, "portainer")).toBe("blocked");
    // Without Portainer it does not matter.
    expect(codes(await planFor(fake))).toEqual([]);
  });

  it("needs port 9443 free for Portainer", async () => {
    const fake = new FakeHost();
    fake.listeners.push({ proto: "tcp", address: "127.0.0.1", port: 9443, process: "python3" });
    const plan = await planFor(fake, desiredFor(fake, { portainer: portainerDesired() }));
    expect(codes(plan)).toEqual(["portainer-port-in-use"]);
    expect(stateOf(plan, "portainer")).toBe("blocked");
  });

  it("lets OpsCrew's own app keep ports 80/443 on a re-run", async () => {
    const fake = new FakeHost();
    await provision(fake);
    deployApp(fake, "shop");
    const plan = await planFor(fake);
    expect(codes(plan)).toEqual([]);
    expect(plan.steps.every((step) => step.state === "in-place")).toBe(true);
  });

  it("never sets AllowUsers or disables root's key login for a root user", async () => {
    const plan = await planFor(new FakeHost());
    expect(JSON.stringify(plan.steps.map((step) => step.params))).not.toMatch(/allow ?users/i);
    expect(paramsOf(plan, "sshd")?.permitRootLogin).not.toBe("no");
  });

  it("refuses inconsistent input", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    expect(() => planHost(facts, desiredFor(fake, { app: "Not An App" }))).toThrow(/not valid/);
    expect(() =>
      planHost(
        facts,
        desiredFor(fake, { deploy: { user: "deploy", publicKey: fakeSecret("private-key-pem") } }),
      ),
    ).toThrow(/not valid/);
    expect(() => planHost(facts, desiredFor(fake, { access: "tunnel" }))).toThrow(/tunnel/);
    expect(() =>
      planHost(facts, desiredFor(fake, { admin: { user: "alice", isRoot: false } })),
    ).toThrow(/inspected as root/);
  });
});

describe("planTeardown and planUndo", () => {
  it("removes the app's containers, files and marker; data only with deleteData", async () => {
    const fake = new FakeHost();
    await provision(fake, desiredFor(fake, { portainer: portainerDesired() }), {
      secrets: { portainerPassword: "Correct-Horse-Battery-9" },
    });
    deployApp(fake, "shop");
    const facts = await inspectHost(fake);
    const keep = planTeardown(facts, { deleteData: false });
    expect(keep.purpose).toBe("teardown");
    expect(keep.deleteData).toBe(false);
    expect(keep.steps.map((step) => [step.id, step.state])).toEqual([
      ["runtime-dirs", "change"],
      ["portainer", "change"],
      ["app-marker", "change"],
    ]);
    expect(keep.steps[0]?.title).toMatch(/data in \/srv\/data and Compose volumes stay/);
    const wipe = planTeardown(facts, { deleteData: true });
    expect(wipe.steps[0]?.params).toEqual({ app: "shop", deleteData: true });
    expect(hostPlanHash(wipe)).not.toBe(hostPlanHash(keep));
    expect(JSON.stringify(keep)).not.toMatch(/docker|deploy-user|sshd|ufw/);
  });

  it("refuses to undo the host while the app is still there", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const plan = planUndo(await inspectHost(fake));
    expect(codes(plan)).toEqual(["app-still-deployed"]);
  });

  it("reverses only OpsCrew's own changes and leaves Docker installed", async () => {
    const fake = new FakeHost();
    fake.packages.set("ufw", "0.36.2");
    fake.ufwRules = [{ rule: "allow 8080/tcp", comment: null }];
    await provision(fake);
    fake.files.delete("/etc/opscrew/app.json");
    const plan = planUndo(await inspectHost(fake));
    expect(codes(plan)).toEqual([]);
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["runtime-dirs", "change"],
      ["unattended-upgrades", "change"],
      ["ufw", "change"],
      ["sshd", "change"],
      ["deploy-user", "change"],
      ["docker", "in-place"],
      ["app-marker", "change"],
    ]);
    expect(paramsOf(plan, "ufw")).toEqual({
      removeRules: "22/tcp 80/tcp 443/tcp 443/udp",
      disable: true,
      removePackage: false,
    });
    expect(plan.steps.find((step) => step.id === "docker")?.reason).toMatch(
      /does not remove Docker/,
    );
  });
});
