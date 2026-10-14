/**
 * The host scripts' behaviour in a real POSIX shell: real files under a temporary root, stubbed
 * commands for everything that would change the machine (see `__fixtures__/shell-harness.ts`).
 */
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { portainerDesired, portainerPassword } from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { DOCKER_DAEMON_JSON } from "./constants";
import { inspectScript, privilegeProbeScript } from "./inspect";
import {
  armScript,
  cancelScript,
  planPortainer,
  type StepScripts,
  stepScripts,
  triggerScript,
} from "./steps";
import type { HostPlan, HostStep } from "./types";

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK opscrew-deploy";

function scriptsFor(
  purpose: HostPlan["purpose"],
  id: HostStep["id"],
  params: HostStep["params"],
  extra: Partial<HostPlan> = {},
): StepScripts {
  const step: HostStep = { id, title: id, state: "change", params };
  const plan: HostPlan = {
    schemaVersion: 1,
    purpose,
    app: "shop",
    steps: [step],
    findings: [],
    ...extra,
  };
  return stepScripts(plan, step);
}

/** systemctl: units are "active" while `$S/active.<unit>` exists; everything else succeeds. */
const SYSTEMCTL = `case "$1" in
  is-active)
    unit=$2; if [ "$unit" = --quiet ]; then unit=$3; fi
    if [ -e "$S/busy.$unit" ]; then
      n=$(cat "$S/busy.$unit")
      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$S/busy.$unit"; exit 0; fi
      exit 3
    fi
    [ -e "$S/active.$unit" ] ;;
  stop) rm -f "$S/active.$2"; exit 0 ;;
  restart)
    if [ -e "$S/fail-restart" ]; then rm -f "$S/fail-restart"; exit 1; fi
    exit 0 ;;
  show) cat "$S/execstart" 2>/dev/null || echo 'ExecStart={ argv[]=/usr/bin/dockerd -H fd:// }' ;;
  *) exit 0 ;;
esac`;

const SYSTEMD_RUN = `for a do case "$a" in --unit=*) u=\${a#--unit=} ;; esac; done
touch "$S/active.$u.timer"`;

const UFW = `case "$1" in
  status) if [ -e "$S/ufw-active" ]; then echo 'Status: active'; else echo 'Status: inactive'; fi ;;
  show) if [ -e "$S/ufw-added" ]; then cat "$S/ufw-added"; else echo '(None)'; fi ;;
  *) exit 0 ;;
esac`;

/** docker: containers, networks and volumes of the project live in state files. */
const DOCKER = `case "$1 $2" in
  "ps -aq") cat "$S/containers" 2>/dev/null || true ;;
  "ps -q") cat "$S/running" 2>/dev/null || true ;;
  "rm -f") : > "$S/containers" ;;
  "network ls") cat "$S/networks" 2>/dev/null || true ;;
  "network rm") : > "$S/networks" ;;
  "volume ls") cat "$S/volumes" 2>/dev/null || true ;;
  "volume rm") if [ ! -e "$S/volumes-stick" ]; then : > "$S/volumes"; fi ;;
  "compose -p") : > "$S/containers"; case "$*" in *--volumes*) : > "$S/volumes" ;; esac ;;
  "info --format")
    case "$3" in
      *LiveRestore*) cat "$S/liverestore" 2>/dev/null || echo true ;;
      *) cat "$S/swarm" 2>/dev/null || echo inactive ;;
    esac ;;
  *) exit 0 ;;
esac`;

// Each test starts real shells, which is slow on Windows when every package tests at once.
describe.skipIf(!BASH_AVAILABLE)("host scripts in a real shell", { timeout: 60_000 }, () => {
  let h: ShellHarness;
  const harness = () => {
    h = new ShellHarness();
    h.stub("systemctl", SYSTEMCTL);
    h.stub("systemd-run", SYSTEMD_RUN);
    return h;
  };
  afterEach(() => h?.dispose());

  describe("dead-man switch", () => {
    const sshd = () =>
      scriptsFor("setup", "sshd", {
        permitRootLogin: "no",
        disablePasswords: true,
        kbdInteractiveOff: true,
      });
    const DROPIN = "/etc/ssh/sshd_config.d/10-opscrew.conf";
    const DM = "/etc/opscrew/deadman";

    it("arms with systemd-run and its undo.sh restores the drop-in and brings ssh back", () => {
      const h = harness();
      h.write(DROPIN, "PermitRootLogin yes\n");
      const deadMan = sshd().deadMan;
      if (!deadMan) throw new Error("no dead-man");
      const arm = h.run(armScript(deadMan, 180));
      expect(arm.status, arm.stderr).toBe(0);
      expect(arm.stdout).toContain("armed");
      expect(h.calls()).toContain(
        `systemd-run --quiet --unit=opscrew-undo-sshd --on-active=180s --timer-property=AccuracySec=1s /bin/sh ${h.posix(`${DM}/sshd.undo.sh`)}`,
      );

      h.write(DROPIN, "PermitRootLogin no\nPasswordAuthentication no\n");
      h.clearCalls();
      const undo = h.runFile(`${DM}/sshd.undo.sh`);
      expect(undo.status).toBe(0);
      expect(h.read(DROPIN)).toBe("PermitRootLogin yes\n");
      expect(h.exists(`${DM}/sshd.fired`)).toBe(true);
      expect(h.calls()).toEqual([
        "systemctl reset-failed ssh.service sshd.service",
        "systemctl reload-or-restart ssh.service",
      ]);
    });

    it("undo.sh removes a drop-in that did not exist before", () => {
      const h = harness();
      const deadMan = sshd().deadMan;
      if (!deadMan) throw new Error("no dead-man");
      expect(h.run(armScript(deadMan, 180)).status).toBe(0);
      h.write(DROPIN, "PermitRootLogin no\n");
      h.runFile(`${DM}/sshd.undo.sh`);
      expect(h.exists(DROPIN)).toBe(false);
    });

    it("cancel stops a waiting timer, reports cancelled, and a late undo then does nothing", () => {
      const h = harness();
      h.write(DROPIN, "PermitRootLogin yes\n");
      const deadMan = sshd().deadMan;
      if (!deadMan) throw new Error("no dead-man");
      expect(h.run(armScript(deadMan, 180)).status).toBe(0);
      // Keep a copy of the undo: systemd may have started it just before the timer was stopped.
      const undo = h.read(`${DM}/sshd.undo.sh`) ?? "";
      h.write(DROPIN, "PermitRootLogin no\n");
      const cancel = h.run(cancelScript("sshd"));
      expect(cancel.stdout.trim()).toBe("cancelled");
      expect(h.calls()).toContain("systemctl stop opscrew-undo-sshd.timer");
      expect(h.exists("/state/active.opscrew-undo-sshd.timer")).toBe(false);
      expect(h.exists(`${DM}/sshd.cancelled`)).toBe(true);
      // The late undo takes the lock after the cancel, sees the cancelled mark and changes nothing.
      h.write("/late-undo.sh", undo);
      h.clearCalls();
      expect(h.runFile("/late-undo.sh").status).toBe(0);
      expect(h.read(DROPIN)).toBe("PermitRootLogin no\n");
      expect(h.exists(`${DM}/sshd.fired`)).toBe(false);
      expect(h.calls()).toEqual([]);
    });

    it("cancel after an undo that already ran reports fired", () => {
      const h = harness();
      h.write(DROPIN, "PermitRootLogin yes\n");
      const deadMan = sshd().deadMan;
      if (!deadMan) throw new Error("no dead-man");
      h.run(armScript(deadMan, 180));
      h.write(DROPIN, "PermitRootLogin no\n");
      // The timer elapsed and the undo took the lock first.
      h.write("/state/active.opscrew-undo-sshd.timer", "");
      expect(h.runFile(`${DM}/sshd.undo.sh`).status).toBe(0);
      const cancel = h.run(cancelScript("sshd"));
      expect(cancel.stdout.trim()).toBe("fired");
      expect(h.read(DROPIN)).toBe("PermitRootLogin yes\n");
      expect(h.exists(`${DM}/sshd.cancelled`)).toBe(false);
      expect(h.exists(`${DM}/sshd.fired`)).toBe(false);
    });

    it("cancel takes the lock with a timeout and arm clears the marks", () => {
      const cancel = cancelScript("sshd");
      expect(cancel).toContain('exec 9>"/etc/opscrew/deadman/$STEP.lock"');
      expect(cancel).toContain("if flock -w 80 9; then");
      const deadMan = sshd().deadMan;
      if (!deadMan) throw new Error("no dead-man");
      expect(armScript(deadMan, 180)).toContain(
        'rm -f "/etc/opscrew/deadman/$STEP.fired" "/etc/opscrew/deadman/$STEP.cancelled"',
      );
      expect(deadMan.capture).toMatch(
        /exec 9>\/etc\/opscrew\/deadman\/sshd\.lock\nflock 9\nif \[ -e \/etc\/opscrew\/deadman\/sshd\.cancelled \]; then exit 0; fi\ntouch \/etc\/opscrew\/deadman\/sshd\.fired/,
      );
    });

    it("trigger runs the undo now (stubs reach the child script) and cleans up", () => {
      const h = harness();
      h.write(DROPIN, "PermitRootLogin yes\n");
      const deadMan = sshd().deadMan;
      if (!deadMan) throw new Error("no dead-man");
      h.run(armScript(deadMan, 120));
      h.write(DROPIN, "broken\n");
      const trigger = h.run(triggerScript("sshd"));
      expect(trigger.stdout.trim()).toBe("restored");
      expect(h.read(DROPIN)).toBe("PermitRootLogin yes\n");
      expect(h.calls()).toContain("systemctl reload-or-restart ssh.service");
      expect(h.exists(`${DM}/sshd.undo.sh`)).toBe(false);
    });

    it("the ufw undo turns ufw off again, restores the default policies and deletes only new rules", () => {
      const h = harness();
      h.stub("ufw", UFW);
      h.write(
        "/state/ufw-added",
        "Added user rules (see 'ufw status' for running firewall):\nufw allow 80/tcp\n",
      );
      h.write(
        "/etc/default/ufw",
        'IPV6=yes\nDEFAULT_INPUT_POLICY="ACCEPT"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\nDEFAULT_FORWARD_POLICY="DROP"\n',
      );
      const { deadMan } = scriptsFor("setup", "ufw", {
        sshPorts: "22",
        sshRulePorts: "22",
        webRules: "80/tcp 443/tcp 443/udp",
        web: true,
        enable: true,
        install: false,
      });
      if (!deadMan) throw new Error("no dead-man");
      const arm = h.run(armScript(deadMan, 180));
      expect(arm.status, arm.stderr).toBe(0);
      h.clearCalls();
      h.runFile(`${DM}/ufw.undo.sh`);
      expect(h.calls()).toEqual([
        "ufw --force disable",
        "ufw default allow incoming",
        "ufw default allow outgoing",
        "ufw default deny routed",
        "ufw --force delete allow 22/tcp",
        "ufw --force delete allow 443/tcp",
        "ufw --force delete allow 443/udp",
      ]);
      expect(h.exists(`${DM}/ufw.fired`)).toBe(true);
    });
  });

  describe("ufw", () => {
    it("adds no world-open SSH rule when an existing rule covers the port (tunnel mode)", () => {
      const h = harness();
      h.stub("ufw", UFW);
      const { apply } = scriptsFor("setup", "ufw", {
        sshPorts: "22",
        sshRulePorts: "",
        webRules: "",
        web: false,
        enable: true,
        install: false,
      });
      const run = h.run(`${apply}`);
      // ufw stays "inactive" in the stub, so the script reports it; the calls are what matter.
      expect(run.stderr).toContain("ufw did not turn on");
      expect(h.calls().filter((call) => call.startsWith("ufw allow"))).toEqual([]);
      expect(h.calls()).toContain("ufw --force enable");
    });

    it("the undo puts the previous default policies back before turning ufw off", () => {
      const h = harness();
      h.stub("ufw", UFW);
      const { apply } = scriptsFor("undo", "ufw", {
        removeRules: "22/tcp 80/tcp",
        disable: true,
        removePackage: false,
        defaultIncoming: "allow",
        defaultOutgoing: "allow",
        defaultRouted: "",
      });
      expect(h.run(apply).status).toBe(0);
      expect(h.calls()).toEqual([
        "ufw --force delete allow 22/tcp",
        "ufw --force delete allow 80/tcp",
        "ufw default allow incoming",
        "ufw default allow outgoing",
        "ufw --force disable",
      ]);
    });
  });

  describe("teardown", () => {
    const teardown = (deleteData: boolean) =>
      scriptsFor("teardown", "runtime-dirs", { app: "shop", deleteData }, { deleteData });

    it("removes the app through its own compose file, never one in the working directory", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/containers", "c1\nc2\n");
      h.write("/state/volumes", "shop_caddy_data\n");
      h.write("/srv/app/compose.yaml", "name: shop\n");
      h.write("/srv/app/app.env", "SECRET=x\n");
      h.write("/srv/data/postgres/PG_VERSION", "17\n");
      h.write("/work/compose.yaml", "name: decoy\n");
      const { apply, verify } = teardown(true);
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.calls()).toContain(
        `docker compose -p shop --project-directory ${h.posix("/srv/app")} -f ${h.posix("/srv/app/compose.yaml")} down --remove-orphans --volumes`,
      );
      expect(h.calls().some((call) => call.includes("/work"))).toBe(false);
      expect(h.exists("/srv/app/compose.yaml")).toBe(false);
      expect(h.exists("/srv/data/postgres")).toBe(false);
      expect(h.exists("/srv/app")).toBe(true);
      expect(h.run(verify).status).toBe(0);
    });

    it("without a compose file, removes only what carries the project label, and keeps data", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/containers", "c1\n");
      h.write("/state/networks", "n1\n");
      h.write("/state/volumes", "shop_caddy_data\n");
      h.write("/srv/data/postgres/PG_VERSION", "17\n");
      h.write("/work/compose.yaml", "name: decoy\n");
      const run = h.run(teardown(false).apply);
      expect(run.status, run.stderr).toBe(0);
      const calls = h.calls();
      expect(calls.some((call) => call.startsWith("docker compose"))).toBe(false);
      expect(calls).toContain("docker ps -aq --filter label=com.docker.compose.project=shop");
      expect(calls).toContain("docker rm -f c1");
      expect(calls).toContain("docker network rm n1");
      expect(calls.some((call) => call.startsWith("docker volume rm"))).toBe(false);
      expect(h.read("/srv/data/postgres/PG_VERSION")).toBe("17\n");
    });

    it("fails when a volume with the app's label is still there after deleting data", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/volumes", "shop_db\n");
      h.write("/state/volumes-stick", "");
      const run = h.run(teardown(true).apply);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("Some Docker volumes of the app could not be removed.");
    });

    it("removes an add-on through its own compose file", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/srv/opscrew/portainer/compose.yaml", "name: opscrew-portainer\n");
      h.write("/work/compose.yaml", "name: decoy\n");
      const { apply } = scriptsFor(
        "teardown",
        "portainer",
        { remove: true, deleteData: true },
        { deleteData: true },
      );
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.calls()).toContain(
        `docker compose -p opscrew-portainer --project-directory ${h.posix("/srv/opscrew/portainer")} -f ${h.posix("/srv/opscrew/portainer/compose.yaml")} down --remove-orphans --volumes`,
      );
      expect(h.exists("/srv/opscrew")).toBe(false);
    });

    it("removes an add-on without a compose file by its label only (Hetzner login, no root)", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/containers", "p1\n");
      const plan = planPortainer({
        app: "shop",
        dir: "/home/deploy/opscrew/portainer",
        disable: { deleteData: false },
      });
      const step = plan.steps[0];
      if (!step) throw new Error("no step");
      const run = h.run(stepScripts(plan, step).apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.calls().some((call) => call.startsWith("docker compose"))).toBe(false);
      expect(h.calls()).toContain("docker rm -f p1");
    });
  });

  describe("Portainer without an admin account", () => {
    const enable = () => {
      const plan = planPortainer({
        app: "shop",
        dir: "/home/deploy/opscrew/portainer",
        enable: { ...portainerDesired(), needsPassword: false },
      });
      const step = plan.steps[0];
      if (!step) throw new Error("no step");
      return stepScripts(plan, step).apply;
    };

    it("points to disable --delete-data when no password reached the server", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.stub("curl", "printf 404");
      h.stub("sleep", "exit 0");
      const run = h.run(enable());
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("no admin password reached the server");
      expect(run.stderr).toContain("opscrew portainer disable --delete-data");
      expect(h.exists("/home/deploy/opscrew/portainer/admin_password")).toBe(false);
    });

    it("asks to turn it on again when a password was sent, and leaves no password file", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.stub("curl", "printf 404");
      h.stub("sleep", "exit 0");
      const run = h.run(enable(), `${portainerPassword()}\n`);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(
        "Turn Portainer on again so OpsCrew can set the admin password.",
      );
      expect(run.stderr).not.toContain("disable --delete-data");
      expect(h.exists("/home/deploy/opscrew/portainer/admin_password")).toBe(false);
    });
  });

  describe("app marker", () => {
    const marker = (ownProject: boolean) =>
      scriptsFor("setup", "app-marker", { app: "shop", projectId: "shop-1", ownProject });

    it("is not written over a Compose project of that name that OpsCrew did not deploy", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/volumes", "shop_pgdata\n");
      const run = h.run(marker(false).apply);
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("Compose project named shop that OpsCrew did not deploy");
      expect(h.exists("/etc/opscrew/app.json")).toBe(false);
      expect(h.calls()).toContain(
        "docker volume ls -q --filter label=com.docker.compose.project=shop",
      );
    });

    it("is not written while Docker is stopped (its containers cannot be seen)", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      const run = h.run(marker(false).apply);
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("Docker is installed but not running");
      expect(h.calls().some((call) => call.startsWith("docker "))).toBe(false);
      expect(h.exists("/etc/opscrew/app.json")).toBe(false);
    });

    it("is written when the project is OpsCrew's own (data kept by an earlier teardown)", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/volumes", "shop_caddy_data\n");
      const run = h.run(marker(true).apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.read("/etc/opscrew/app.json")).toBe('{"app":"shop","projectId":"shop-1"}\n');
      expect(h.exists("/var/lib/opscrew-ready")).toBe(true);
    });

    it("is written on a server without any project of that name", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      expect(h.run(marker(false).apply).status).toBe(0);
      expect(h.exists("/etc/opscrew/app.json")).toBe(true);
    });
  });

  describe("deploy user", () => {
    it("writes authorized_keys atomically with exactly the current key (old keys revoked)", () => {
      const h = harness();
      // getent prints the home under the harness root.
      h.stub(
        "getent",
        `case "$1 $2" in
  "passwd deploy") echo "deploy:x:1001:1001::${h.posix("/home/deploy")}:/bin/bash" ;;
  "group docker") echo "docker:x:999:" ;;
  *) exit 2 ;;
esac`,
      );
      h.stub("id", `echo "deploy docker"`);
      h.write(
        "/home/deploy/.ssh/authorized_keys",
        "ssh-ed25519 AAAAold old-deploy\nssh-rsa AAAAother someone\n",
      );
      const { apply, verify } = scriptsFor("setup", "deploy-user", {
        user: "deploy",
        publicKey: KEY,
      });
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.read("/home/deploy/.ssh/authorized_keys")).toBe(`${KEY}\n`);
      expect(h.calls()).toContain("usermod -aG docker deploy");
      expect(h.calls().some((call) => call.startsWith("useradd"))).toBe(false);
      expect(h.run(verify).status).toBe(0);
    });
  });

  describe("Docker", () => {
    const setup = (h: ShellHarness) => {
      h.write(
        "/etc/os-release",
        'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n',
      );
      h.write(
        "/etc/apt/sources.list.d/ubuntu.sources",
        "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n",
      );
      h.stub("dpkg", "echo amd64");
      h.stub("dpkg-query", "exit 1");
      h.stub("curl", `for a do if [ "$prev" = -o ]; then echo KEY > "$a"; fi; prev=$a; done`);
      h.stub(
        "apt-get",
        `case "$*" in *docker-ce*) echo 'E: Unable to locate package docker-ce'; exit 100 ;; esac`,
      );
    };

    it("a failed install removes the repository and key OpsCrew just added", () => {
      const h = harness();
      setup(h);
      const { apply } = scriptsFor("setup", "docker", { distro: "ubuntu", action: "install" });
      const run = h.run(apply);
      expect(run.status).toBe(3);
      expect(run.stderr).toContain(
        "Installing Docker failed, so OpsCrew removed the repository it added",
      );
      expect(run.stderr).toContain("Unable to locate package docker-ce");
      expect(h.exists("/etc/apt/sources.list.d/docker.sources")).toBe(false);
      expect(h.exists("/etc/apt/keyrings/docker.asc")).toBe(false);
      expect(h.read("/var/log/opscrew/apt.log")).toContain("Unable to locate package docker-ce");
    });

    it("keeps a signing key that was there before", () => {
      const h = harness();
      setup(h);
      h.write("/etc/apt/keyrings/docker.asc", "USER KEY\n");
      const run = h.run(
        scriptsFor("setup", "docker", { distro: "ubuntu", action: "install" }).apply,
      );
      expect(run.status).toBe(3);
      expect(h.exists("/etc/apt/sources.list.d/docker.sources")).toBe(false);
      // The key that was there before is back, exactly as it was.
      expect(h.read("/etc/apt/keyrings/docker.asc")).toBe("USER KEY\n");
      expect(h.exists("/etc/apt/keyrings/.docker.asc.opscrew-old")).toBe(false);
    });

    it("a failed key download never cuts an existing key short", () => {
      const h = harness();
      setup(h);
      h.write("/etc/apt/keyrings/docker.asc", "USER KEY\n");
      // curl writes part of the key, then fails.
      h.stub(
        "curl",
        `for a do if [ "$prev" = -o ]; then printf 'PART' > "$a"; fi; prev=$a; done; exit 22`,
      );
      const run = h.run(
        scriptsFor("setup", "docker", { distro: "ubuntu", action: "install" }).apply,
      );
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("could not download Docker's signing key");
      expect(h.read("/etc/apt/keyrings/docker.asc")).toBe("USER KEY\n");
      const keyrings = h.native("/etc/apt/keyrings");
      expect(readdirSync(keyrings)).toEqual(["docker.asc"]);
      expect(h.exists("/etc/apt/sources.list.d/docker.sources")).toBe(false);
    });

    const daemon = (h: ShellHarness) => {
      h.stub("docker", DOCKER);
      h.stub("dockerd", "exit 0");
      h.write("/state/active.docker", "");
      return scriptsFor("setup", "docker-daemon", { path: "/etc/docker/daemon.json" });
    };

    it("docker-daemon: a failed restart removes the file and restarts Docker as before", () => {
      const h = harness();
      const { apply } = daemon(h);
      h.write("/state/fail-restart", "");
      const run = h.run(apply);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(
        "Docker did not start with the new settings, so OpsCrew removed them again",
      );
      expect(h.exists("/etc/docker/daemon.json")).toBe(false);
      expect(h.calls().filter((call) => call === "systemctl restart docker")).toHaveLength(2);
      expect(h.calls()).toContain("systemctl reset-failed docker");
    });

    it("docker-daemon: writes the file and restarts an idle Docker; reloads a busy one", () => {
      const h = harness();
      const { apply } = daemon(h);
      expect(h.run(apply).status).toBe(0);
      expect(h.read("/etc/docker/daemon.json")).toBe(DOCKER_DAEMON_JSON);
      expect(h.calls()).toContain("systemctl restart docker");

      const busy = harness();
      const scripts = daemon(busy);
      busy.write("/state/running", "c1\n");
      expect(busy.run(scripts.apply).status).toBe(0);
      expect(busy.calls()).toContain("systemctl reload docker");
      expect(busy.calls()).not.toContain("systemctl restart docker");
      busy.dispose();
    });

    it("docker-daemon: a reload Docker does not act on removes the file again and fails", () => {
      const h = harness();
      const { apply } = daemon(h);
      h.write("/state/running", "c1\n");
      h.write("/state/liverestore", "false\n");
      const run = h.run(apply);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(
        "Docker did not take the new settings, so OpsCrew removed them again",
      );
      expect(h.exists("/etc/docker/daemon.json")).toBe(false);
      expect(h.calls().filter((call) => call === "systemctl reload docker")).toHaveLength(2);
      expect(h.calls()).not.toContain("systemctl restart docker");
      expect(h.calls()).toContain("docker info --format {{.LiveRestoreEnabled}}");
    });

    it("docker-daemon: a restart that does not pick up the file is rolled back too", () => {
      const h = harness();
      const { apply } = daemon(h);
      h.write("/state/liverestore", "false\n");
      const run = h.run(apply);
      expect(run.status).not.toBe(0);
      expect(h.exists("/etc/docker/daemon.json")).toBe(false);
      expect(h.calls().filter((call) => call === "systemctl restart docker")).toHaveLength(2);
    });

    it("docker-daemon: dockerd flags or an active Swarm count as the user's own settings", () => {
      const h = harness();
      const { apply, verify } = daemon(h);
      h.write(
        "/state/execstart",
        "ExecStart={ argv[]=/usr/bin/dockerd -H fd:// --log-driver=journald }\n",
      );
      expect(h.run(apply).status).toBe(0);
      expect(h.exists("/etc/docker/daemon.json")).toBe(false);
      expect(h.run(verify).status).toBe(0);

      const swarm = harness();
      const scripts = daemon(swarm);
      swarm.write("/state/swarm", "active\n");
      expect(swarm.run(scripts.apply).status).toBe(0);
      expect(swarm.exists("/etc/docker/daemon.json")).toBe(false);
      swarm.dispose();
    });

    it("docker-daemon undo removes only the file exactly as OpsCrew wrote it", () => {
      const h = harness();
      const undo = scriptsFor("undo", "docker-daemon", {});
      h.write("/etc/docker/daemon.json", DOCKER_DAEMON_JSON);
      expect(h.run(undo.apply).status).toBe(0);
      expect(h.exists("/etc/docker/daemon.json")).toBe(false);
      h.write("/etc/docker/daemon.json", '{ "log-driver": "journald" }\n');
      expect(h.run(undo.apply).status).toBe(0);
      expect(h.read("/etc/docker/daemon.json")).toBe('{ "log-driver": "journald" }\n');
    });
  });

  describe("packages", () => {
    it("package-repair waits for the dpkg lock, then finishes the interrupted run", () => {
      const h = harness();
      h.write("/var/lib/dpkg/updates/0001", "x");
      h.write("/state/dpkg-tries", "0");
      h.stub(
        "dpkg",
        `if IFS= read -r line; then echo "$line" >> "$S/dpkg-stdin"; fi
n=$(cat "$S/dpkg-tries"); echo $((n + 1)) > "$S/dpkg-tries"
if [ "$n" -lt 2 ]; then echo 'dpkg: error: dpkg frontend lock is locked by another process'; exit 2; fi
rm -f '${h.posix("/var/lib/dpkg/updates/0001")}'`,
      );
      const { check, apply, verify } = scriptsFor("setup", "package-repair", {});
      expect(h.run(check).stdout).toContain("state=change");
      // Whatever the session sends on stdin never reaches dpkg (no conffile prompt can block).
      const run = h.run(apply, "y\ny\ny\n");
      expect(run.status, run.stderr).toBe(0);
      expect(
        h.calls().filter((call) => call === "dpkg --force-confdef --force-confold --configure -a"),
      ).toHaveLength(3);
      expect(h.exists("/state/dpkg-stdin")).toBe(false);
      expect(h.run(verify).status).toBe(0);
      expect(h.read("/var/log/opscrew/apt.log")).toContain("frontend lock");
    });

    it("package steps ignore a dropped session and send apt's output to a log, not the session", () => {
      for (const scripts of [
        scriptsFor("setup", "docker", { distro: "ubuntu", action: "install" }),
        scriptsFor("setup", "fail2ban", { sshPorts: "22", install: true }),
        scriptsFor("setup", "unattended-upgrades", { install: true }),
        scriptsFor("setup", "package-repair", {}),
      ]) {
        expect(scripts.apply).toMatch(/\ntrap '' HUP PIPE\n/);
        // apt-get runs only inside apt_get, whose output goes to the log file.
        const aptLines = scripts.apply.split("\n").filter((line) => /\bapt-get -q\b/.test(line));
        if (scripts !== undefined) expect(scripts.apply).toContain("apt-get -q");
        for (const line of aptLines) expect(line).toContain(">>'/var/log/opscrew/apt.log' 2>&1");
      }
    });

    it("a dropped session (SIGHUP) does not stop a package step", () => {
      const h = harness();
      h.stub("dpkg-query", "exit 1");
      h.stub(
        "apt-get",
        'kill -HUP $PPID 2>/dev/null; kill -HUP "$(cat "$S/script.pid")" 2>/dev/null; exit 0',
      );
      h.write("/etc/apt/apt.conf.d/.keep", "");
      h.stub(
        "apt-config",
        `echo 'APT::Periodic::Update-Package-Lists "1";'; echo 'APT::Periodic::Unattended-Upgrade "1";'`,
      );
      const { apply } = scriptsFor("setup", "unattended-upgrades", { install: true });
      // The script records its pid so the apt stub can send it SIGHUP mid-install.
      const run = h.run(
        apply.replace(
          "trap '' HUP PIPE",
          `trap '' HUP PIPE\necho $$ > "${h.root}/state/script.pid"`,
        ),
      );
      expect(run.status, run.stderr).toBe(0);
      expect(h.calls()).toContain("systemctl enable --now unattended-upgrades.service");
    });
  });

  describe("read-only probes", () => {
    it("the privilege probe ignores sudo's warnings on stderr", () => {
      const h = harness();
      h.stub("id", `if [ "$1" = -u ]; then echo 1000; else echo alice; fi`);
      const probe = (sudo: string) => {
        h.stub("sudo", sudo);
        return h.run(privilegeProbeScript()).stdout.trim();
      };
      expect(
        probe(
          `if [ "$*" = "-n sh -c id -u" ]; then echo 'sudo: unable to resolve host box: Name or service not known' >&2; echo 0; fi`,
        ),
      ).toBe("sudo");
      expect(probe(`echo 'sudo: a password is required' >&2; exit 1`)).toBe("sudo-password");
      expect(probe(`echo 'sudo-rs: interactive authentication is required' >&2; exit 1`)).toBe(
        "sudo-password",
      );
      expect(probe(`echo 'alice is not in the sudoers file.' >&2; exit 1`)).toBe("none");
    });

    it("inspection never talks to a stopped dockerd (no socket activation)", () => {
      const h = harness();
      h.stub("docker", 'echo "Docker version 28.5.1, build e180ab8"');
      for (const name of [
        "sshd",
        "ss",
        "ip",
        "ufw",
        "iptables-save",
        "ip6tables-save",
        "nft",
        "snap",
        "fail2ban-client",
        "apt-config",
        "dpkg-query",
        "getent",
      ]) {
        h.stub(name, "exit 1");
      }
      const run = h.run(inspectScript());
      expect(run.status).toBe(0);
      const docker = h.calls().filter((call) => call.startsWith("docker "));
      expect(docker).toEqual([
        "docker --version",
        "docker compose version --short",
        "docker buildx version",
      ]);
    });
  });
});
