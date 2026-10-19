import { canonicalJson, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
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
  removeApp,
  SHOP_PROJECT,
  TUNNEL_COMPOSE,
  TUNNEL_ID,
  tunnelDesired,
  tunnelToken,
} from "./__fixtures__/helpers";
import { hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planHost, planTeardown, planUndo } from "./plan";
import { appRecord } from "./steps";
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
    expect(hostPlanHash(plan)).toBe(sha256Hex(canonicalJson(plan)));
  });

  it("changes when any parameter changes", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    const a = planHost(facts, desiredFor(fake), "opscrew provision");
    const b = planHost(
      facts,
      desiredFor(fake, { deploy: { user: "deploy", publicKey: `${DEPLOY_KEY}2` } }),
      "opscrew provision",
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

    const off = planHost(
      await inspectHost(fake),
      desiredFor(fake, { disablePasswords: true }),
      "opscrew provision",
    );
    expect(codes(off)).toEqual([]);
    expect(paramsOf(off, "sshd")?.disablePasswords).toBe(true);
    const keep = planHost(
      await inspectHost(fake),
      desiredFor(fake, { disablePasswords: false }),
      "opscrew provision",
    );
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
      sshRulePorts: "2222",
      webRules: "80/tcp 443/tcp 443/udp",
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
      tunnelId: TUNNEL_ID,
      needsToken: true,
    });
    expect(plan.steps.find((step) => step.id === "tunnel-connector")?.title).toContain(
      "cloudflare/cloudflared:2026.5.1",
    );
  });

  it("writes OpsCrew's daemon.json only where there is none, and never overwrites the user's", async () => {
    const fresh = new FakeHost();
    const plan = await planFor(fresh);
    expect(stateOf(plan, "docker-daemon")).toBe("change");
    expect(plan.steps.find((step) => step.id === "docker-daemon")?.reason).toMatch(/restarts once/);

    const busy = new FakeHost();
    busy.packages.set("docker-ce", "5:28.5.1-1");
    busy.packages.set("docker-compose-plugin", "2.39.4");
    busy.packages.set("docker-buildx-plugin", "0.29.1");
    busy.dockerRunning = true;
    // Only OpsCrew's own containers run (see setup-steps.test.ts for the user's own).
    busy.containers.push({ name: "cloudflared", project: "opscrew-tunnel", ports: "" });
    expect((await planFor(busy)).steps.find((step) => step.id === "docker-daemon")?.reason).toMatch(
      /without restarting your running containers/,
    );

    busy.files.set("/etc/docker/daemon.json", '{ "data-root": "/mnt/docker" }\n');
    const kept = (await planFor(busy)).steps.find((step) => step.id === "docker-daemon");
    expect(kept?.state).toBe("in-place");
    expect(kept?.reason).toMatch(/kept your Docker settings/);

    busy.files.set(
      "/etc/docker/daemon.json",
      '{"live-restore":true,"no-new-privileges":true,"log-driver":"json-file","log-opts":{"max-file":"3","max-size":"10m"}}',
    );
    const same = (await planFor(busy)).steps.find((step) => step.id === "docker-daemon");
    expect(same).toMatchObject({ state: "in-place", reason: "Already set." });
  });

  it("guards every real SSH port with fail2ban, and leaves the user's own sshd jail alone", async () => {
    const fake = new FakeHost();
    fake.sshdBase.port = [22, 2222];
    expect(paramsOf(await planFor(fake), "fail2ban")).toEqual({
      sshPorts: "22 2222",
      install: true,
    });
    fake.packages.set("fail2ban", "1.0.2");
    fake.fail2banActive = true;
    fake.fail2banOwnJail = true;
    const own = (await planFor(fake)).steps.find((step) => step.id === "fail2ban");
    expect(own?.state).toBe("in-place");
    expect(own?.reason).toMatch(/your own settings/);
  });

  it("writes OpsCrew's sshd drop-in even when the settings are already right", async () => {
    const fake = new FakeHost();
    fake.sshdBase.passwordAuthentication = false;
    fake.sshdBase.permitRootLogin = "prohibit-password";
    expect(stateOf(await planFor(fake), "sshd")).toBe("change");
  });

  const directoryCases: [string, (fake: FakeHost) => void, string][] = [
    [
      "sss on the nsswitch passwd line",
      (fake) => {
        fake.nssSources.push("sss");
      },
      "sss in /etc/nsswitch.conf",
    ],
    [
      "pam_ldap",
      (fake) => {
        fake.pamModules.push("pam_ldap");
      },
      "pam_ldap in PAM",
    ],
    [
      "pam_krb5",
      (fake) => {
        fake.pamModules.push("pam_krb5");
      },
      "pam_krb5 in PAM",
    ],
    [
      "an AuthorizedKeysCommand",
      (fake) => {
        fake.sshdBase.authorizedKeysCommand = "/usr/bin/sss_ssh_authorizedkeys %u";
      },
      "sshd's AuthorizedKeysCommand",
    ],
  ];
  it.each(directoryCases)(
    "blocks turning passwords off with directory logins (%s) until chosen",
    async (_what, arrange, named) => {
      const fake = new FakeHost();
      arrange(fake);
      const plan = await planFor(fake);
      expect(codes(plan)).toEqual(["directory-logins"]);
      expect(plan.findings[0]?.message).toContain(named);
      expect(stateOf(plan, "sshd")).toBe("blocked");
      const chosen = planHost(
        await inspectHost(fake),
        desiredFor(fake, { disablePasswords: false }),
        "opscrew provision",
      );
      expect(codes(chosen)).toEqual([]);
      expect(paramsOf(chosen, "sshd")).toMatchObject({ disablePasswords: false });
      expect(chosen.steps.find((step) => step.id === "sshd")?.title).toContain(
        "password logins left as they are (you chose to keep them; users may come from a directory service)",
      );
    },
  );

  it("counts existing ufw rules for the SSH port, and says when OpsCrew widens a source limit", async () => {
    const limited = new FakeHost();
    limited.ufwActive = true;
    limited.ufwRules = [{ rule: "allow from 10.0.0.0/8 to any port 22 proto tcp", comment: null }];
    const publicPlan = await planFor(limited);
    expect(paramsOf(publicPlan, "ufw")).toMatchObject({ sshRulePorts: "22" });
    expect(publicPlan.steps.find((step) => step.id === "ufw")?.reason).toMatch(
      /only from some addresses .*opens it to every address, because GitHub Actions/,
    );
    // Tunnel mode: the user's rule covers SSH, so no world-open rule is added.
    const tunnelPlan = await planFor(limited, tunnelDesired(limited));
    expect(paramsOf(tunnelPlan, "ufw")).toMatchObject({ sshRulePorts: "", webRules: "" });
    expect(stateOf(tunnelPlan, "ufw")).toBe("in-place");

    const rateLimited = new FakeHost();
    rateLimited.ufwActive = true;
    rateLimited.ufwRules = [
      { rule: "limit 22/tcp", comment: null },
      { rule: "allow 80", comment: null },
    ];
    const plan = await planFor(rateLimited);
    expect(paramsOf(plan, "ufw")).toMatchObject({ sshRulePorts: "", webRules: "443/tcp 443/udp" });
    expect(plan.steps.find((step) => step.id === "ufw")?.reason).toMatch(
      /rate-limits SSH on port 22/,
    );
  });

  it("keeps the user's Docker settings given as dockerd flags or with an active Swarm", async () => {
    const flags = new FakeHost();
    flags.packages.set("docker-ce", "5:28.5.1-1");
    flags.packages.set("docker-compose-plugin", "2.39.4");
    flags.packages.set("docker-buildx-plugin", "0.29.1");
    flags.dockerRunning = true;
    flags.dockerdFlags = ["--log-driver=journald"];
    const kept = (await planFor(flags)).steps.find((step) => step.id === "docker-daemon");
    expect(kept).toMatchObject({ state: "in-place" });
    expect(kept?.reason).toMatch(/started with its own settings \(--log-driver\)/);
    flags.dockerdFlags = [];
    flags.swarm = true;
    const swarm = (await planFor(flags)).steps.find((step) => step.id === "docker-daemon");
    expect(swarm).toMatchObject({ state: "in-place" });
    expect(swarm?.reason).toMatch(/Swarm/);
  });

  it("plans the interrupted package installation first", async () => {
    const fake = new FakeHost();
    fake.dpkgInterrupted = true;
    const plan = await planFor(fake);
    expect(plan.steps[0]).toMatchObject({ id: "package-repair", state: "change" });
    await applyApproved(fake, plan);
    expect(fake.dpkgInterrupted).toBe(false);
    expect((await planFor(fake)).steps.some((step) => step.id === "package-repair")).toBe(false);
  });

  it("rewrites the deploy user's keys when another key is there", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const deploy = fake.users.get("deploy");
    deploy?.keys.push("ssh-ed25519 AAAAstale stale");
    const plan = await planFor(fake);
    expect(plan.steps.find((step) => step.id === "deploy-user")?.state).toBe("in-place");
    expect(plan.steps.find((step) => step.id === "deploy-key")).toMatchObject({
      state: "change",
      reason: expect.stringMatching(/exactly the deploy keys of the apps.*any other key/),
    });
    await applyApproved(fake, plan);
    expect(fake.users.get("deploy")?.keys).toEqual([DEPLOY_KEY]);
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
      "the same app name from another project",
      (fake) =>
        void fake.files.set(
          "/etc/opscrew/apps/shop.json",
          JSON.stringify(
            appRecord({
              app: "shop",
              projectId: "shop-other",
              access: "public",
              hostnames: [],
              services: ["web"],
              memoryMb: 256,
              deployKey: DEPLOY_KEY,
            }),
          ),
        ),
      "app-name-taken",
      undefined,
    ],
    [
      "a damaged app record",
      (fake) => void fake.files.set("/etc/opscrew/apps/blog.json", "{"),
      "app-record-damaged",
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
      "an existing /srv/data",
      (fake) =>
        void fake.dirs.set("/srv/data", { owner: "root", group: "root", mode: "755", entries: 2 }),
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

  it("says to run the command that made the plan again, not always opscrew provision", async () => {
    const sudo = new FakeHost({ login: "alice", sudo: "password" });
    const facts = await inspectHost(sudo);
    const hints = (plan: HostPlan) => plan.findings.map((finding) => finding.hint);
    expect(hints(planHost(facts, desiredFor(sudo), "opscrew dns"))).toEqual([
      expect.stringMatching(/, then run opscrew dns again\.$/),
    ]);
    expect(
      hints(
        planTeardown(
          facts,
          { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
          "opscrew destroy",
        ),
      ),
    ).toEqual([expect.stringMatching(/, then run opscrew destroy again\.$/)]);
    expect(hints(planUndo(facts, "opscrew destroy --undo-host"))).toEqual([
      expect.stringMatching(/, then run opscrew destroy --undo-host again\.$/),
    ]);
    const firewalled = new FakeHost();
    firewalled.firewalld = true;
    const enable = planHost(
      await inspectHost(firewalled),
      desiredFor(firewalled, { portainer: portainerDesired() }),
      "opscrew portainer enable",
    );
    expect(hints(enable)).toEqual([
      expect.stringMatching(/ Then run opscrew portainer enable again after the change\.$/),
    ]);
    expect(JSON.stringify(enable)).not.toContain("opscrew provision");
  });

  it("blocks a Compose project with the app's name that OpsCrew did not deploy", async () => {
    const fake = new FakeHost();
    fake.dockerRunning = true;
    fake.containers.push({ name: "shop-web-1", project: "shop", ports: "", stopped: true });
    expect(codes(await planFor(fake))).toEqual(["compose-project-exists"]);
    const volumes = new FakeHost();
    volumes.dockerRunning = true;
    volumes.volumes.set("shop", 1);
    expect(codes(await planFor(volumes))).toEqual(["compose-project-exists"]);
  });

  it("lets the same app come back after its own teardown kept the data", async () => {
    const fake = new FakeHost();
    await provision(fake);
    deployApp(fake, "shop");
    fake.volumes.set("shop", 2);
    await applyApproved(
      fake,
      planTeardown(
        await inspectHost(fake),
        { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
        "opscrew destroy",
      ),
    );
    expect(fake.volumes.get("shop")).toBe(2);
    const plan = await planFor(fake);
    expect(codes(plan)).toEqual([]);
    // The app-record apply checks the project again on the server; here it is OpsCrew's own.
    expect(paramsOf(plan, "app-record")).toMatchObject({ ownProject: true });
  });

  it("marks a fresh server's Compose project as not OpsCrew's own", async () => {
    const fake = new FakeHost();
    expect(paramsOf(await planFor(fake), "app-record")).toEqual({
      app: "shop",
      projectId: "shop-0123456789ab",
      access: "public",
      hostnames: "shop.example.com www.shop.example.com",
      services: "web",
      memoryMb: 512,
      deployKey: DEPLOY_KEY,
      ownProject: false,
    });
  });

  it("refuses to plan while an installed Docker is stopped, unless the server is already ours", async () => {
    const fake = new FakeHost();
    fake.packages.set("docker-ce", "5:28.5.1-1");
    fake.packages.set("docker-compose-plugin", "2.39.4");
    fake.packages.set("docker-buildx-plugin", "0.29.1");
    fake.dockerRunning = false;
    const plan = await planFor(fake);
    expect(codes(plan)).toEqual(["docker-stopped"]);
    expect(plan.findings[0]).toMatchObject({
      message: "Docker is installed but not running, so OpsCrew cannot see its containers.",
      hint: "Start Docker (`sudo systemctl start docker`), then plan again.",
    });
    // Inspection never started it.
    expect(fake.dockerRunning).toBe(false);

    const ours = new FakeHost();
    await provision(ours);
    ours.dockerRunning = false;
    const again = await planFor(ours);
    expect(codes(again)).toEqual([]);
    expect(again.steps.find((step) => step.id === "docker")?.params.action).toBe("start");
  });

  it("needs flock for the automatic undo", async () => {
    const fake = new FakeHost();
    fake.flock = false;
    expect(codes(await planFor(fake))).toEqual(["no-flock"]);
  });

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

  it("runs the tunnel connector in public mode for a Portainer subdomain, without tunnel-mode checks", async () => {
    const fake = new FakeHost();
    // sshd only on the public address and 18080 taken: both matter only in tunnel mode.
    fake.listeners = [
      { proto: "tcp", address: "203.0.113.10", port: 22, process: "sshd" },
      { proto: "tcp", address: "127.0.0.1", port: 18080, process: "node" },
    ];
    const desired = desiredFor(fake, {
      tunnel: { compose: TUNNEL_COMPOSE, tunnelId: TUNNEL_ID },
      portainer: portainerDesired(),
    });
    const plan = await planFor(fake, desired);
    expect(codes(plan)).toEqual([]);
    expect(stateOf(plan, "tunnel-connector")).toBe("change");
    expect(paramsOf(plan, "tunnel-connector")).toEqual({
      compose: TUNNEL_COMPOSE,
      tunnelId: TUNNEL_ID,
      needsToken: true,
    });
    expect(plan.steps.find((step) => step.id === "tunnel-connector")?.reason).toContain(
      "Portainer's subdomain",
    );
    // Without a tunnel the public-mode plan has no connector step at all.
    expect(stateOf(await planFor(fake, desiredFor(fake)), "tunnel-connector")).toBeUndefined();
  });

  it("keeps the connector in public mode on a re-run, and removes it once no tunnel is planned", async () => {
    const fake = new FakeHost();
    const desired = desiredFor(fake, {
      tunnel: { compose: TUNNEL_COMPOSE, tunnelId: TUNNEL_ID },
      portainer: portainerDesired(),
    });
    await provision(fake, desired, {
      secrets: { tunnelToken: tunnelToken(), portainerPassword: portainerPassword() },
    });
    expect(stateOf(await planFor(fake, desired), "tunnel-connector")).toBe("in-place");
    const without = await planFor(fake, desiredFor(fake, { portainer: portainerDesired() }));
    expect(stateOf(without, "tunnel-connector")).toBe("change");
    expect(paramsOf(without, "tunnel-connector")).toEqual({ remove: true });
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
    expect(() =>
      planHost(facts, desiredFor(fake, { app: "Not An App" }), "opscrew provision"),
    ).toThrow(/not valid/);
    expect(() =>
      planHost(
        facts,
        desiredFor(fake, { deploy: { user: "deploy", publicKey: fakeSecret("private-key-pem") } }),
        "opscrew provision",
      ),
    ).toThrow(/not valid/);
    expect(() =>
      planHost(facts, desiredFor(fake, { access: "tunnel" }), "opscrew provision"),
    ).toThrow(/tunnel/);
    expect(() =>
      planHost(
        facts,
        desiredFor(fake, { admin: { user: "alice", isRoot: false } }),
        "opscrew provision",
      ),
    ).toThrow(/inspected as root/);
  });
});

describe("planTeardown and planUndo", () => {
  it("removes the app's containers, folder and record; data only with deleteData", async () => {
    const fake = new FakeHost();
    await provision(fake, desiredFor(fake, { portainer: portainerDesired() }), {
      secrets: { portainerPassword: "Correct-Horse-Battery-9" },
    });
    deployApp(fake, "shop");
    const facts = await inspectHost(fake);
    const keep = planTeardown(
      facts,
      { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(keep.purpose).toBe("teardown");
    expect(keep.deleteData).toBe(false);
    expect(keep.steps.map((step) => [step.id, step.state])).toEqual([
      ["app-dirs", "change"],
      ["edge", "change"],
      ["portainer", "change"],
      ["app-record", "change"],
    ]);
    expect(keep.steps[0]?.title).toMatch(/data in \/srv\/data\/shop and Compose volumes stay/);
    expect(paramsOf(keep, "app-record")).toEqual({
      app: "shop",
      keepData: true,
      projectId: "shop-0123456789ab",
    });
    const wipe = planTeardown(
      facts,
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(wipe.steps[0]?.params).toEqual({ app: "shop", deleteData: true });
    expect(paramsOf(wipe, "app-record")).toEqual({
      app: "shop",
      keepData: false,
      projectId: SHOP_PROJECT,
    });
    expect(hostPlanHash(wipe)).not.toBe(hostPlanHash(keep));
    expect(JSON.stringify(keep)).not.toMatch(/docker|deploy-user|sshd|ufw/);
  });

  it("still removes the app by its Compose label and folder when its record is missing", async () => {
    const fake = new FakeHost();
    await provision(fake);
    deployApp(fake, "shop");
    fake.containers.push({ name: "grafana", project: "monitoring", ports: "" });
    fake.files.delete("/etc/opscrew/apps/shop.json");
    const facts = await inspectHost(fake);
    expect(facts.apps).toEqual([]);

    const plan = planTeardown(
      facts,
      { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(plan.app).toBe("shop");
    expect(codes(plan)).toEqual([]);
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["app-dirs", "change"],
      ["edge", "change"],
      // The host record still lists it.
      ["app-record", "change"],
    ]);
    expect(paramsOf(plan, "app-dirs")).toEqual({ app: "shop", deleteData: false });
    await applyApproved(fake, plan);
    expect(fake.containers.map((container) => container.name)).toEqual(["grafana"]);
    expect(fake.dirs.has("/srv/apps/shop")).toBe(false);
    expect(fake.appFiles.size).toBe(0);
    expect(JSON.parse(fake.files.get("/etc/opscrew/host.json") ?? "{}").apps).toEqual([]);
  });

  it("takes the plan's app name when neither its record nor the host record is there", async () => {
    const fake = new FakeHost();
    await provision(fake);
    deployApp(fake, "shop");
    fake.files.delete("/etc/opscrew/apps/shop.json");
    fake.files.delete("/etc/opscrew/host.json");
    const facts = await inspectHost(fake);
    const plan = planTeardown(
      facts,
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["app-dirs", "change"],
      ["edge", "change"],
    ]);
    expect(plan.steps[0]?.title).toMatch(/Remove the app "shop".*its data/);
  });

  it("never removes another app's containers: only the named app's project and folders", async () => {
    const fake = new FakeHost();
    await provision(fake);
    deployApp(fake, "shop");
    const facts = await inspectHost(fake);
    const other = planTeardown(
      facts,
      { deleteData: true, app: "blog", projectId: "blog-1" },
      "opscrew destroy",
    );
    expect(codes(other)).toEqual([]);
    // "shop" stays, so the edge and the deploy key of "shop" stay too.
    expect(other.steps.map((step) => [step.id, step.state])).toEqual([["app-dirs", "in-place"]]);
    expect(() =>
      planTeardown(
        facts,
        { deleteData: false, app: "Not An App", projectId: SHOP_PROJECT },
        "opscrew destroy",
      ),
    ).toThrow(/lower-case letters/);
  });

  it("refuses to undo the host while the app is still there", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const plan = planUndo(await inspectHost(fake), "opscrew destroy --undo-host");
    expect(codes(plan)).toEqual(["app-still-deployed"]);
  });

  it("reverses only OpsCrew's own changes and leaves Docker installed", async () => {
    const fake = new FakeHost();
    fake.packages.set("ufw", "0.36.2");
    fake.ufwRules = [{ rule: "allow 8080/tcp", comment: null }];
    await provision(fake);
    await removeApp(fake);
    const plan = planUndo(await inspectHost(fake), "opscrew destroy --undo-host");
    expect(codes(plan)).toEqual([]);
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["runtime-dirs", "change"],
      ["unattended-upgrades", "change"],
      ["fail2ban", "change"],
      ["ufw", "change"],
      ["sshd", "change"],
      ["deploy-user", "change"],
      ["docker-daemon", "change"],
      ["docker", "in-place"],
      ["app-record", "change"],
    ]);
    expect(plan.steps.every((step) => step.scope === "shared")).toBe(true);
    // The edge folder went with the last app.
    expect(paramsOf(plan, "runtime-dirs")).toEqual({
      dirs: "/srv/edge /srv/apps /srv/data /srv/app",
    });
    expect(fake.dirs.has("/srv/edge")).toBe(false);
    expect(paramsOf(plan, "ufw")).toEqual({
      removeRules: "22/tcp 80/tcp 443/tcp 443/udp",
      disable: true,
      removePackage: false,
      defaultIncoming: "deny",
      defaultOutgoing: "allow",
      defaultRouted: "deny",
    });
    // fail2ban was not installed before OpsCrew: it goes again. The service of automatic
    // updates was already enabled, so it stays enabled.
    expect(paramsOf(plan, "fail2ban")).toEqual({ removePackage: true, disableService: false });
    expect(paramsOf(plan, "unattended-upgrades")).toEqual({
      removePackage: false,
      disableService: false,
    });
    expect(plan.steps.find((step) => step.id === "docker")?.reason).toMatch(
      /does not remove Docker/,
    );
  });
});

describe("planHost: the web filter behind Cloudflare's proxy", () => {
  // A few of Cloudflare's published IPv4 ranges (public, not secret).
  const CF = { ipv4: ["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"] };
  const V4 = "103.21.244.0/22 104.16.0.0/13 173.245.48.0/20";
  const filtered = (fake: FakeHost, webFilter = CF) => desiredFor(fake, { webFilter });

  it("keeps every plan without the filter exactly as before (same steps, same hash)", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    // The hashes these fake servers give without the filter (pinned since 013's host layout).
    expect(hostPlanHash(planHost(facts, desiredFor(fake), "opscrew provision"))).toBe(
      "4db85a86433672d9f98d42f68bf2ee9d104fa2fa62af0669a48a2328e2cb3818",
    );
    expect(hostPlanHash(planHost(facts, tunnelDesired(fake), "opscrew provision"))).toBe(
      "4f7a6e6fb593f30ba8110b7f7d1540b50e8065f172456f93fb6cb0a86637932d",
    );
    const used = new FakeHost();
    await provision(used);
    expect(hostPlanHash(await planFor(used))).toBe(
      "5986f209c6f6610f75db80d374997a585cfe2ad0131b7d4b305cc959156521d1",
    );
    await removeApp(used);
    expect(hostPlanHash(planUndo(await inspectHost(used), "opscrew destroy --undo-host"))).toBe(
      "60d4db46202cb95df763e3e0de475ae208950326565f1a64ae35b6a4e8f7d94b",
    );
  });

  it("plans the IPv4 filter after ufw, with the ranges sorted, and leaves ufw as it is", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    const plain = planHost(facts, desiredFor(fake), "opscrew provision");
    const plan = planHost(facts, filtered(fake), "opscrew provision");
    expect(plan.steps.map((s) => s.id)).toEqual(
      plain.steps.flatMap((s) => (s.id === "ufw" ? ["ufw", "web-filter"] : [s.id])),
    );
    expect(plan.steps.find((s) => s.id === "ufw")).toEqual(plain.steps.find((s) => s.id === "ufw"));
    const filter = plan.steps.find((s) => s.id === "web-filter");
    expect(filter).toMatchObject({ state: "change", params: { ipv4: V4 } });
    expect(filter?.reason).toMatch(/Cloudflare's 3 IPv4 ranges/);
    expect(filter?.reason).toMatch(/published on IPv4 only/);
    expect(filter?.reason).toMatch(/Docker does not start \(fail closed\)/);
    expect(codes(plan)).toEqual([]);
    // The filter plan of this fake server, pinned.
    expect(hostPlanHash(plan)).toBe(
      "98b2c80f1e5e3fe2a703896bb5e334a1c5b94126e2a203f7d91eca73ab7fe69a",
    );
  });

  it("gives the same hash for the same ranges in any order or with duplicates", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    const a = planHost(facts, filtered(fake), "opscrew provision");
    const b = planHost(
      facts,
      filtered(fake, {
        ipv4: ["104.16.0.0/13", "173.245.48.0/20", "103.21.244.0/22", "104.16.0.9/13"],
      }),
      "opscrew provision",
    );
    expect(hostPlanHash(b)).toBe(hostPlanHash(a));
    const c = planHost(
      facts,
      filtered(fake, { ipv4: [...CF.ipv4, "131.0.72.0/22"] }),
      "opscrew provision",
    );
    expect(hostPlanHash(c)).not.toBe(hostPlanHash(a));
  });

  it("refuses ranges that are not IPv4 networks, no range, or a filter in tunnel mode", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    for (const webFilter of [
      { ipv4: [] },
      { ipv4: ["0.0.0.0/33"] },
      { ipv4: ["2400:cb00::/32"] },
      { ipv4: ["1.2.3.0/24; reboot"] },
      { ipv4: CF.ipv4, ipv6: ["2400:cb00::/32"] },
    ]) {
      expect(() =>
        planHost(facts, filtered(fake, webFilter as never), "opscrew provision"),
      ).toThrowError(/webFilter/);
    }
    expect(() =>
      planHost(facts, tunnelDesired(fake, { webFilter: CF }), "opscrew provision"),
    ).toThrowError(/only for a site served directly/);
  });

  it("refuses Docker's nftables backend and Docker without iptables, in plain words", async () => {
    const nft = new FakeHost();
    nft.files.set("/etc/docker/daemon.json", '{ "firewall-backend": "nftables" }\n');
    const nftPlan = planHost(await inspectHost(nft), filtered(nft), "opscrew provision");
    expect(codes(nftPlan)).toEqual(["docker-nftables"]);
    expect(stateOf(nftPlan, "web-filter")).toBe("blocked");

    const env = new FakeHost();
    env.dockerdFlags = ["}\nEnvironment=DOCKER_FIREWALL_BACKEND=nftables"];
    expect(codes(planHost(await inspectHost(env), filtered(env), "opscrew provision"))).toEqual([
      "docker-nftables",
    ]);

    const off = new FakeHost();
    off.files.set("/etc/docker/daemon.json", '{ "iptables": false }\n');
    expect(codes(planHost(await inspectHost(off), filtered(off), "opscrew provision"))).toEqual([
      "docker-no-iptables",
    ]);

    // IPv6 settings do not matter: the site is not published on IPv6.
    const v6 = new FakeHost();
    v6.files.set("/etc/docker/daemon.json", '{ "ip6tables": false }\n');
    v6.addresses.push(
      "2: eth0    inet6 2001:db8::20/64 scope global dynamic mngtmpaddr\\       valid_lft 86000sec preferred_lft 14000sec",
    );
    expect(codes(planHost(await inspectHost(v6), filtered(v6), "opscrew provision"))).toEqual([]);
  });

  it("is in place on a re-run, re-applies changed ranges, and keeps the user's DOCKER-USER rules", async () => {
    const fake = new FakeHost();
    fake.web4.dockerUserRules = ["-A DOCKER-USER -s 10.0.0.0/8 -j ACCEPT"];
    await provision(fake, filtered(fake));
    expect(stateOf(await planFor(fake, filtered(fake)), "web-filter")).toBe("in-place");

    const changed = { ipv4: ["104.16.0.0/13", "173.245.48.0/20", "131.0.72.0/22"] };
    const plan = await planFor(fake, filtered(fake, changed));
    const step = plan.steps.find((s) => s.id === "web-filter");
    expect(step?.state).toBe("change");
    expect(step?.reason).toMatch(/1 new range, 1 no longer listed/);
    expect(plan.steps.filter((s) => s.state === "change").map((s) => s.id)).toEqual(["web-filter"]);
    await applyApproved(fake, plan);
    expect(fake.web4.chain).toContain("-A OPSCREW-WEB -s 131.0.72.0/22 -j RETURN");
    expect(fake.web4.dockerUserRules.at(-1)).toBe("-A DOCKER-USER -s 10.0.0.0/8 -j ACCEPT");
    expect(stateOf(await planFor(fake, filtered(fake, changed)), "web-filter")).toBe("in-place");
    // Someone edited OpsCrew's chain: a change again.
    fake.web4.chain = ["-A OPSCREW-WEB -j ACCEPT"];
    expect(stateOf(await planFor(fake, filtered(fake, changed)), "web-filter")).toBe("change");
  });

  it("removes the filter when the site is no longer served behind the proxy, and on undo", async () => {
    const fake = new FakeHost();
    await provision(fake, filtered(fake));
    const dnsOnly = await planFor(fake, desiredFor(fake));
    expect(dnsOnly.steps.find((s) => s.id === "web-filter")).toMatchObject({
      state: "change",
      params: { remove: true },
    });
    await applyApproved(fake, dnsOnly);
    expect(fake.web4.chain).toBeNull();
    expect(fake.files.has("/etc/systemd/system/docker.service.d/opscrew-web-filter.conf")).toBe(
      false,
    );
    expect((await planFor(fake, desiredFor(fake))).steps.some((s) => s.id === "web-filter")).toBe(
      false,
    );

    const undone = new FakeHost();
    await provision(undone, filtered(undone));
    await removeApp(undone);
    const undo = planUndo(await inspectHost(undone), "opscrew destroy --undo-host");
    expect(undo.steps.map((s) => s.id)).toContain("web-filter");
    await applyApproved(undone, undo);
    expect(undone.web4.chain).toBeNull();
    expect(undone.files.has("/usr/local/sbin/opscrew-web-filter")).toBe(false);
  });
});
