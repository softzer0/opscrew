import { spawnSync } from "node:child_process";
import { sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { deployApp, FakeHost, scriptParams } from "./__fixtures__/fake-host";
import {
  applyApproved,
  DEPLOY_KEY,
  desiredFor,
  portainerDesired,
  portainerPassword,
  provision,
  removeApp,
  SH_AVAILABLE,
  SHOP_PROJECT,
  shSyntax,
  tunnelDesired,
  tunnelToken,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { sshdDropIn } from "./constants";
import { inspectHost, inspectScript, privilegeProbeScript } from "./inspect";
import { planHost, planPortainer, planTeardown, planUndo } from "./plan";
import { asLogin, asRoot } from "./shell";
import {
  armScript,
  cancelScript,
  readRecordScript,
  stepScripts,
  triggerScript,
  writeRecordScript,
} from "./steps";
import type { HostPlan } from "./types";
import { WEB_FILTER_DROP_IN_TEXT, WEB_FILTER_UNIT_TEXT, webFilterScript } from "./web-filter";

/** Every script of every step of `plan`, including the dead-man scripts. */
function allScripts(plan: HostPlan): Map<string, string> {
  const scripts = new Map<string, string>();
  for (const step of plan.steps) {
    if (step.state !== "change") continue;
    const set = stepScripts(plan, step);
    const key = `${plan.purpose}/${step.id}`;
    scripts.set(`${key}/check`, set.check);
    scripts.set(`${key}/apply`, set.apply);
    scripts.set(`${key}/verify`, set.verify);
    if (set.preApply) scripts.set(`${key}/preApply`, set.preApply);
    if (set.postApply) scripts.set(`${key}/postApply`, set.postApply);
    if (set.deadMan) {
      scripts.set(`${key}/arm`, armScript(set.deadMan, 180));
      scripts.set(`${key}/cancel`, cancelScript(set.deadMan.step));
      scripts.set(`${key}/trigger`, triggerScript(set.deadMan.step));
    }
  }
  return scripts;
}

/** Plans of every purpose and shape, from fake servers. */
async function everyPlan(): Promise<HostPlan[]> {
  const plans: HostPlan[] = [];
  const fresh = new FakeHost({ os: "debian-13", arch: "arm64" });
  fresh.packages.delete("ufw");
  fresh.dpkgInterrupted = true;
  plans.push(
    planHost(
      await inspectHost(fresh),
      desiredFor(fresh, { portainer: portainerDesired() }),
      "opscrew provision",
    ),
  );
  plans.push(
    planHost(
      await inspectHost(fresh),
      tunnelDesired(fresh, { disablePasswords: false }),
      "opscrew provision",
    ),
  );

  const used = new FakeHost();
  await provision(used, tunnelDesired(used, { portainer: portainerDesired() }), {
    secrets: { tunnelToken: tunnelToken(), portainerPassword: portainerPassword() },
  });
  deployApp(used, "shop", "tunnel");
  // Switching to public mode removes the tunnel connector and Portainer.
  plans.push(planHost(await inspectHost(used), desiredFor(used), "opscrew provision"));
  plans.push(
    planTeardown(
      await inspectHost(used),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    ),
  );
  await applyApproved(
    used,
    planTeardown(
      await inspectHost(used),
      { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    ),
  );
  plans.push(planUndo(await inspectHost(used), "opscrew destroy --undo-host"));

  // Two apps on one server: removing one takes its deploy key too.
  const shared = new FakeHost();
  await provision(shared);
  await provision(
    shared,
    desiredFor(shared, {
      app: "blog",
      projectId: "blog-1",
      hostnames: ["blog.example.com"],
      deploy: { user: "deploy", publicKey: DEPLOY_KEY.replace("opscrew-deploy", "blog-deploy") },
    }),
  );
  plans.push(
    planTeardown(
      await inspectHost(shared),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    ),
  );

  // Behind Cloudflare's proxy: the web filter, its removal and its undo.
  const filtered = new FakeHost();
  const webFilter = { ipv4: ["173.245.48.0/20", "103.21.244.0/22"] };
  const withFilter = planHost(
    await inspectHost(filtered),
    desiredFor(filtered, { webFilter }),
    "opscrew provision",
  );
  plans.push(withFilter);
  await applyApproved(filtered, withFilter);
  plans.push(planHost(await inspectHost(filtered), desiredFor(filtered), "opscrew provision"));
  await removeApp(filtered);
  plans.push(planUndo(await inspectHost(filtered), "opscrew destroy --undo-host"));
  plans.push(
    planPortainer({
      app: "shop",
      dir: "/home/deploy/opscrew/portainer",
      enable: { ...portainerDesired(), needsPassword: true },
    }),
    planPortainer({
      app: "shop",
      dir: "/home/deploy/opscrew/portainer",
      disable: { deleteData: true },
    }),
  );
  return plans;
}

describe("generated scripts", () => {
  it("cover every step of every purpose", async () => {
    const keys = new Set<string>();
    for (const plan of await everyPlan())
      for (const key of allScripts(plan).keys()) keys.add(key.split("/").slice(0, 2).join("/"));
    expect([...keys].sort()).toEqual(
      [
        "setup/package-repair",
        "setup/docker",
        "setup/docker-daemon",
        "setup/deploy-user",
        "setup/deploy-key",
        "setup/sshd",
        "setup/ufw",
        "setup/web-filter",
        "setup/fail2ban",
        "setup/unattended-upgrades",
        "setup/runtime-dirs",
        "setup/app-dirs",
        "setup/app-record",
        "setup/tunnel-connector",
        "setup/portainer",
        "teardown/app-dirs",
        "teardown/deploy-key",
        "teardown/edge",
        "teardown/tunnel-connector",
        "teardown/portainer",
        "teardown/app-record",
        "undo/runtime-dirs",
        "undo/unattended-upgrades",
        "undo/fail2ban",
        "undo/ufw",
        "undo/web-filter",
        "undo/sshd",
        "undo/deploy-user",
        "undo/docker-daemon",
        "undo/app-record",
      ].sort(),
    );
  });

  it.skipIf(!SH_AVAILABLE)(
    "all pass sh -n, alone and as the quoted command the login shell runs",
    async () => {
      const scripts = new Map<string, string>([
        ["inspect", inspectScript()],
        ["privilege", privilegeProbeScript()],
        ["record.read", readRecordScript()],
        ["record.write", writeRecordScript(JSON.stringify({ app: "shop", note: "it's quoted" }))],
      ]);
      for (const plan of await everyPlan())
        for (const [key, script] of allScripts(plan)) scripts.set(key, script);
      // Scripts that actually ran against fake servers, including failure paths.
      const fake = new FakeHost();
      await provision(fake, desiredFor(fake), { verifyLogin: async () => false }).catch(
        () => undefined,
      );
      for (const call of fake.calls) scripts.set(`ran/${call.name}`, call.script);

      const failures: string[] = [];
      for (const [key, script] of scripts) {
        const alone = shSyntax(script);
        if (alone && !alone.ok) failures.push(`${key}: ${alone.stderr}`);
        for (const command of [asRoot("root", script), asRoot("sudo", script), asLogin(script)]) {
          const wrapped = shSyntax(command);
          if (wrapped && !wrapped.ok) failures.push(`${key} (command): ${wrapped.stderr}`);
        }
      }
      expect(failures).toEqual([]);
      expect(scripts.size).toBeGreaterThan(60);
    },
    300_000,
  );

  it("use no bash-only syntax (Debian's sh is dash)", async () => {
    const scripts = [inspectScript(), privilegeProbeScript()];
    for (const plan of await everyPlan()) scripts.push(...allScripts(plan).values());
    for (const script of scripts) {
      expect(script).not.toMatch(
        /(^|\s)\[\[\s|<<<|\bfunction\s+\w+|\s\$'|\$\{\w+\/\/|\bsource\s|\w+\+=\(|\[ [^\]\n]*== |\bdeclare\s|\bpushd\b/m,
      );
    }
  });

  it("assign every parameter shell-quoted at the top, under a fixed header", async () => {
    for (const plan of await everyPlan()) {
      for (const [key, script] of allScripts(plan)) {
        const lines = script.split("\n");
        expect(lines[0], key).toMatch(/^# opscrew-host: [a-z0-9.-]+$/);
        // After the fixed environment (ending with umask) come only the quoted parameters.
        const params = lines.slice(lines.indexOf("umask 022") + 1);
        const end = params.findIndex((line) => !/^[A-Z][A-Z0-9_]*=/.test(line));
        for (const line of params.slice(0, end)) {
          expect(line, key).toMatch(/^[A-Z][A-Z0-9_]*='(?:[^']|'\\'')*'$/);
        }
      }
    }
  });
});

describe("sshd scripts", () => {
  it("write only a drop-in, check it with sshd -t before reloading, and never restrict users, forwarding or addresses", async () => {
    const fake = new FakeHost();
    const plan = planHost(await inspectHost(fake), desiredFor(fake), "opscrew provision");
    const sshd = plan.steps.find((step) => step.id === "sshd");
    if (!sshd) throw new Error("no sshd step");
    const { apply, deadMan } = stepScripts(plan, sshd);
    expect(apply).toContain("/etc/ssh/sshd_config.d/10-opscrew.conf");
    expect(apply.indexOf("sshd -t")).toBeGreaterThan(0);
    expect(apply.indexOf("sshd -t")).toBeLessThan(
      apply.lastIndexOf("try-reload-or-restart ssh.service"),
    );
    // The Portainer tunnel (ssh -L as deploy) and the Cloudflare Tunnel (ssh://localhost) keep working:
    // the drop-in sets only these three settings, and is written exactly as rendered.
    const p = scriptParams(apply);
    const written = Buffer.from(p.DROPIN_B64 ?? "", "base64").toString("utf8");
    expect(written).toBe(
      sshdDropIn({
        permitRootLogin: "prohibit-password",
        disablePasswords: true,
        kbdInteractiveOff: true,
      }),
    );
    expect(p.DROPIN_SHA256).toBe(sha256Hex(written));
    const settings = written
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(" ")[0])
      .sort();
    expect(settings).toEqual([
      "KbdInteractiveAuthentication",
      "PasswordAuthentication",
      "PermitRootLogin",
    ]);
    expect(apply).not.toMatch(
      /AllowUsers |AllowGroups |AllowTcpForwarding |ListenAddress |DenyUsers /,
    );
    expect(apply).not.toMatch(/sshd_config(?!\.d)/);
    expect(deadMan?.capture).toContain("sshd.undo.sh");

    await provision(fake);
    const dropIn = fake.files.get("/etc/ssh/sshd_config.d/10-opscrew.conf") ?? "";
    expect(dropIn).not.toMatch(/AllowUsers|AllowTcpForwarding|ListenAddress|Match/);
  });
});

describe("ufw scripts", () => {
  it("allow the SSH port before turning the firewall on, and open web ports only in public mode", async () => {
    const fake = new FakeHost();
    fake.sshdBase.port = [2222];
    fake.listeners = [{ proto: "tcp", address: "0.0.0.0", port: 2222, process: "sshd" }];
    const plan = planHost(await inspectHost(fake), tunnelDesired(fake), "opscrew provision");
    const ufw = plan.steps.find((step) => step.id === "ufw");
    if (!ufw) throw new Error("no ufw step");
    const { apply } = stepScripts(plan, ufw);
    expect(apply).toContain("SSH_PORTS='2222'");
    expect(apply).toContain("WEB='false'");
    expect(apply.indexOf('ufw allow "$port/tcp"')).toBeLessThan(
      apply.indexOf("ufw --force enable"),
    );
    expect(apply).not.toMatch(/ufw\s+allow\s+22\b/);
  });
});

/**
 * Runs `script` in bash with `stubs` (shell functions shadowing commands) defined first. bash,
 * not sh, because POSIX sh refuses function names such as `dpkg-query`.
 */
function runWithStubs(
  stubs: string,
  script: string,
): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("bash", ["-s"], { input: `${stubs}\n${script}`, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const BASH_AVAILABLE = spawnSync("bash", ["-c", "true"]).error === undefined;

async function stepOf(
  desired: (fake: FakeHost) => ReturnType<typeof desiredFor>,
  id: string,
  arrange?: (fake: FakeHost) => void,
) {
  const fake = new FakeHost();
  arrange?.(fake);
  const plan = planHost(await inspectHost(fake), desired(fake), "opscrew provision");
  const step = plan.steps.find((item) => item.id === id);
  if (!step) throw new Error(`no ${id} step`);
  return stepScripts(plan, step);
}

describe.skipIf(!BASH_AVAILABLE)("script behaviour in a real shell (commands stubbed)", () => {
  const UFW_STUB = `ufw_on=no
ufw() {
  case "$1" in
    status) if [ "$ufw_on" = yes ]; then echo 'Status: active'; else echo 'Status: inactive'; fi ;;
    show) printf '%s\\n' "Added user rules (see 'ufw status' for running firewall):" "ufw allow 80/tcp" "ufw allow 443/udp comment 'opscrew-web'" ;;
    *) echo "ufw $*" >&2; if [ "$1 $2" = "--force enable" ]; then ufw_on=yes; fi ;;
  esac
}`;

  it("ufw: the SSH rules come first, existing rules are kept, then ufw turns on", async () => {
    const fake = new FakeHost();
    fake.sshdBase.port = [22, 2222];
    const { apply } = await stepOf(
      (f) => desiredFor(f),
      "ufw",
      (f) => {
        f.sshdBase.port = [22, 2222];
        f.listeners = [{ proto: "tcp", address: "0.0.0.0", port: 2222, process: "sshd" }];
      },
    );
    const run = runWithStubs(UFW_STUB, apply);
    expect(run.status).toBe(0);
    expect(run.stderr.trim().split("\n")).toEqual([
      "ufw allow 22/tcp comment opscrew-ssh",
      "ufw allow 2222/tcp comment opscrew-ssh",
      "ufw allow 443/tcp comment opscrew-web",
      "ufw default deny incoming",
      "ufw default allow outgoing",
      "ufw --force enable",
    ]);
  });

  it("ufw in tunnel mode: removes only OpsCrew's own web rules and opens no web port", async () => {
    const { apply } = await stepOf((f) => tunnelDesired(f), "ufw");
    const run = runWithStubs(UFW_STUB, apply);
    expect(run.status).toBe(0);
    expect(run.stderr.trim().split("\n")).toEqual([
      "ufw allow 22/tcp comment opscrew-ssh",
      "ufw --force delete allow 443/udp",
      "ufw default deny incoming",
      "ufw default allow outgoing",
      "ufw --force enable",
    ]);
  });

  it("sshd: the check accepts without-password for prohibit-password and needs OpsCrew's drop-in", async () => {
    const { check } = await stepOf((f) => desiredFor(f), "sshd");
    const dropIn = sshdDropIn({
      permitRootLogin: "prohibit-password",
      disablePasswords: true,
      kbdInteractiveOff: true,
    });
    const h = new ShellHarness();
    try {
      const run = (password: string, content: string) => {
        h.stub(
          "sshd",
          `printf '%s\\n' 'port 22' 'permitrootlogin without-password' 'passwordauthentication ${password}' 'kbdinteractiveauthentication no'`,
        );
        h.stub("systemctl", "exit 3");
        h.write("/etc/ssh/sshd_config.d/10-opscrew.conf", content);
        return h.run(check).stdout;
      };
      expect(run("no", dropIn)).toContain("state=in-place");
      // Effective settings already right, but no OpsCrew drop-in: still a change (secure reads it).
      expect(run("no", "PermitRootLogin no\n")).toContain("state=change");
      // OpsCrew's drop-in byte for byte: an edited copy is a change too.
      expect(run("no", `${dropIn}\n`)).toContain("state=change");
      const changed = run("yes", dropIn);
      expect(changed).toContain("state=change");
      expect(changed).toContain("prev.permitRootLogin=without-password");
      expect(changed).toContain("prev.passwordAuthentication=yes");
    } finally {
      h.dispose();
    }
  });

  it("fail2ban: the jail covers every real SSH port and reads the systemd journal", async () => {
    const { apply } = await stepOf(
      (f) => desiredFor(f),
      "fail2ban",
      (f) => {
        f.sshdBase.port = [22, 2222];
      },
    );
    const jail = /^JAIL_B64='([^']*)'$/m.exec(apply)?.[1] ?? "";
    expect(Buffer.from(jail, "base64").toString("utf8")).toBe(
      "# Managed by OpsCrew: brute-force protection for SSH.\n[sshd]\nenabled = true\nport = 22,2222\nbackend = systemd\nmaxretry = 5\nbantime = 1h\n",
    );
  });

  it("docker-daemon: never overwrites an existing daemon.json and restarts Docker only when idle", async () => {
    const { apply } = await stepOf((f) => desiredFor(f), "docker-daemon");
    const start = apply.indexOf('if [ -e "$DAEMON_JSON" ] || own_settings; then exit 0; fi');
    expect(start).toBeGreaterThan(0);
    const body = apply.slice(start);
    expect(body.indexOf("exit 0")).toBeLessThan(body.indexOf('mv -f "$tmp" "$DAEMON_JSON"'));
    expect(body).toContain('dockerd --validate --config-file "$tmp"');
    expect(body).toMatch(
      /if busy; then[\s\S]*systemctl reload docker[\s\S]*else[\s\S]*systemctl restart docker/,
    );
  });

  it("docker: the check reads the engine's major version from the package version", async () => {
    const { check } = await stepOf((f) => desiredFor(f), "docker");
    const stubs = (
      version: string,
    ) => `dpkg-query() { case "$2" in *Version*) printf '%s' '${version}' ;; *Status*) printf 'install ok installed' ;; esac; }
systemctl() { return 0; }
docker() { echo 28.5.1; }`;
    expect(runWithStubs(stubs("5:28.5.1-1~ubuntu.24.04~noble"), check).stdout).toContain(
      "state=in-place",
    );
    const old = runWithStubs(stubs("5:27.3.1-1~ubuntu.24.04~noble"), check).stdout;
    expect(old).toContain("state=change");
    expect(old).toContain("prev.engine=5:27.3.1-1~ubuntu.24.04~noble");
  });

  it("the privilege probe tells passwordless sudo, sudo and sudo-rs password prompts apart", () => {
    const probe = (sudo: string) =>
      runWithStubs(
        `id() { echo 1000; }\nsudo() { ${sudo}; }`,
        privilegeProbeScript(),
      ).stdout.trim();
    expect(probe("echo 0")).toBe("sudo");
    expect(probe("echo 'sudo: a password is required' >&2; return 1")).toBe("sudo-password");
    expect(probe("echo 'sudo-rs: interactive authentication is required' >&2; return 1")).toBe(
      "sudo-password",
    );
    expect(probe("echo 'alice is not in the sudoers file.' >&2; return 1")).toBe("none");
  });
});

describe("dead-man scripts", () => {
  it("schedule the undo with systemd-run --on-active and refuse to go on without it", () => {
    const script = armScript({ step: "sshd", capture: ": capture", params: {} }, 180);
    expect(script).toContain("DELAY='180'");
    expect(script).toContain(`systemd-run --quiet --unit="$UNIT" --on-active="\${DELAY}s"`);
    expect(script).toContain("UNIT='opscrew-undo-sshd'");
    expect(script).toMatch(/is-active --quiet "\$UNIT.timer" \|\| fail/);
    expect(cancelScript("ufw")).toContain('systemctl stop "$UNIT.timer"');
  });
});

describe("secret handling in scripts", () => {
  it("read secrets from stdin into root-only files and never print them", async () => {
    const fake = new FakeHost();
    const plan = planHost(
      await inspectHost(fake),
      tunnelDesired(fake, { portainer: portainerDesired() }),
      "opscrew provision",
    );
    for (const id of ["tunnel-connector", "portainer"] as const) {
      const step = plan.steps.find((item) => item.id === id);
      if (!step) throw new Error(`no ${id} step`);
      const { apply, secret } = stepScripts(plan, step);
      expect(secret?.required).toBe(true);
      expect(apply).toMatch(/umask 077/);
      expect(apply).toMatch(/IFS= read -r (token|pw) \|\| true/);
      // The secret variable is only ever written to a root-only file with printf (a shell builtin).
      const uses = apply.split("\n").filter((line) => /\$(token|pw)\b|\$\{(token|pw)/.test(line));
      for (const line of uses)
        expect(line).toMatch(
          /^\s*(printf '[^']*' "\$(token|pw)" \| write_file "\$DIR\/(tunnel\.env|admin_password)" 0600|case "\$token" in|if \[ -n "\$(token|pw)" \]; then)$/,
        );
      expect(uses.some((line) => line.includes("| write_file"))).toBe(true);
    }
  });
});

describe("the web filter's script on the server", () => {
  const script = webFilterScript({ ipv4: ["103.21.244.0/22", "173.245.48.0/20"] });

  it.skipIf(!SH_AVAILABLE)("passes sh -n and uses no bash-only syntax", () => {
    expect(shSyntax(script)?.ok).toBe(true);
    expect(script).not.toMatch(/(^|\s)\[\[\s|<<<|\bfunction\s+\w+|\s\$'|\bdeclare\s/m);
  });

  it("filters only new IPv4 connections to published ports 80 and 443, and drops the rest", () => {
    expect(script).toContain("IPV4='103.21.244.0/22 173.245.48.0/20'");
    expect(script).toContain(
      'iptables -w -I DOCKER-USER 1 -p "$1" -m conntrack --ctstate DNAT --ctorigdstport "$2" --ctdir ORIGINAL -j OPSCREW-WEB',
    );
    expect(script).toContain("echo '-A OPSCREW-WEB -j DROP'");
    expect(script).toContain("iptables-restore -w --noflush");
    // IPv4 only: a kernel without IPv6 never stops Docker at boot.
    expect(script).not.toMatch(/ip6tables|IPV6/);
  });

  it("runs after every other firewall loader and before Docker", () => {
    expect(WEB_FILTER_UNIT_TEXT).toContain(
      "After=local-fs.target ufw.service firewalld.service nftables.service netfilter-persistent.service iptables.service ip6tables.service\nBefore=docker.service\n",
    );
    expect(WEB_FILTER_DROP_IN_TEXT).toContain(
      "Requires=opscrew-web-filter.service\nAfter=opscrew-web-filter.service\n",
    );
  });
});
