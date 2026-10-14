import { describe, expect, it } from "vitest";
import { deployApp, FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  desiredFor,
  portainerDesired,
  portainerPassword,
  provision,
  SH_AVAILABLE,
  shSyntax,
  tunnelDesired,
  tunnelToken,
} from "./__fixtures__/helpers";
import { inspectHost, inspectScript, privilegeProbeScript } from "./inspect";
import { planHost, planTeardown, planUndo } from "./plan";
import { asLogin, asRoot } from "./shell";
import {
  armScript,
  cancelScript,
  planPortainer,
  readRecordScript,
  stepScripts,
  triggerScript,
  writeRecordScript,
} from "./steps";
import type { HostPlan } from "./types";

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
  plans.push(
    planHost(await inspectHost(fresh), desiredFor(fresh, { portainer: portainerDesired() })),
  );
  plans.push(planHost(await inspectHost(fresh), tunnelDesired(fresh, { disablePasswords: false })));

  const used = new FakeHost();
  await provision(used, tunnelDesired(used, { portainer: portainerDesired() }), {
    secrets: { tunnelToken: tunnelToken(), portainerPassword: portainerPassword() },
  });
  deployApp(used, "shop", "tunnel");
  // Switching to public mode removes the tunnel connector and Portainer.
  plans.push(planHost(await inspectHost(used), desiredFor(used)));
  plans.push(planTeardown(await inspectHost(used), { deleteData: true }));
  await applyApproved(used, planTeardown(await inspectHost(used), { deleteData: false }));
  plans.push(planUndo(await inspectHost(used)));
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
        "setup/docker",
        "setup/deploy-user",
        "setup/sshd",
        "setup/ufw",
        "setup/unattended-upgrades",
        "setup/runtime-dirs",
        "setup/app-marker",
        "setup/tunnel-connector",
        "setup/portainer",
        "teardown/runtime-dirs",
        "teardown/tunnel-connector",
        "teardown/portainer",
        "teardown/app-marker",
        "undo/runtime-dirs",
        "undo/unattended-upgrades",
        "undo/ufw",
        "undo/sshd",
        "undo/deploy-user",
        "undo/app-marker",
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
        expect(lines[0], key).toMatch(/^# opscrew-host: [a-z.-]+$/);
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
    const plan = planHost(await inspectHost(fake), desiredFor(fake));
    const sshd = plan.steps.find((step) => step.id === "sshd");
    if (!sshd) throw new Error("no sshd step");
    const { apply, deadMan } = stepScripts(plan, sshd);
    expect(apply).toContain("/etc/ssh/sshd_config.d/10-opscrew.conf");
    expect(apply.indexOf("sshd -t")).toBeGreaterThan(0);
    expect(apply.indexOf("sshd -t")).toBeLessThan(
      apply.lastIndexOf("try-reload-or-restart ssh.service"),
    );
    // The Portainer tunnel (ssh -L as deploy) and the Cloudflare Tunnel (ssh://localhost) keep working:
    // the drop-in sets only these three settings.
    const written = apply.slice(
      apply.indexOf("{\n  printf '%s\\n' \"$HEADER\""),
      apply.indexOf('} > "$tmp"'),
    );
    const settings = [
      ...written.matchAll(/printf '([A-Z]\w+) /g),
      ...written.matchAll(/'([A-Z]\w+) no'/g),
    ]
      .map((match) => match[1])
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
    const plan = planHost(await inspectHost(fake), tunnelDesired(fake));
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
    );
    for (const id of ["tunnel-connector", "portainer"] as const) {
      const step = plan.steps.find((item) => item.id === id);
      if (!step) throw new Error(`no ${id} step`);
      const { apply, secret } = stepScripts(plan, step);
      expect(secret?.required).toBe(true);
      expect(apply).toMatch(/umask 077/);
      expect(apply).toMatch(/IFS= read -r (token|pw) \|\| true/);
      expect(apply).toMatch(/chmod 0600 "\$tmp"/);
      // The secret variable is only ever written to a file with printf (a shell builtin).
      const uses = apply.split("\n").filter((line) => /\$(token|pw)\b|\$\{(token|pw)/.test(line));
      for (const line of uses)
        expect(line).toMatch(
          /^\s*(printf '[^']*' "\$(token|pw)" > "\$tmp"|case "\$token" in|if \[ -n "\$(token|pw)" \]; then)$/,
        );
    }
  });
});
