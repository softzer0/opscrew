/**
 * The host scripts' behaviour in a real POSIX shell: real files under a temporary root, stubbed
 * commands for everything that would change the machine (see `__fixtures__/shell-harness.ts`).
 */
import { readdirSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { portainerDesired, portainerPassword } from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { DOCKER_DAEMON_JSON, sshdDropIn } from "./constants";
import { inspectScript, privilegeProbeScript } from "./inspect";
import { planPortainer } from "./plan";
import { armScript, cancelScript, type StepScripts, stepScripts, triggerScript } from "./steps";
import type { HostPlan, HostStep } from "./types";

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK opscrew-deploy";

function scriptsFor(
  purpose: HostPlan["purpose"],
  id: HostStep["id"],
  params: HostStep["params"],
  extra: Partial<HostPlan> = {},
): StepScripts {
  const step: HostStep = { id, title: id, state: "change", scope: "shared", params };
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

/** A stock /etc/ssh/moduli in miniature: its comment, a 2048-bit group and two 3072-bit ones. */
const MODULI_STRONG = ["20231002031514 2 6 100 3071 2 F0A1", "20231002031530 2 6 100 3071 5 F0B2"];
const MODULI = [
  "# $OpenBSD: moduli,v 1.36 2023/10/02 20:39:37 dtucker Exp $",
  "# Time Type Tests Tries Size Generator Modulus",
  "20231002030805 2 6 100 2047 5 C9A1",
  ...MODULI_STRONG,
  "",
].join("\n");

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
    h.write("/etc/ssh/moduli", MODULI);
    return h;
  };
  afterEach(() => h?.dispose());

  describe("dead-man switch", () => {
    const sshd = () =>
      scriptsFor("setup", "sshd", {
        permitRootLogin: "no",
        disablePasswords: true,
        kbdInteractiveOff: true,
        moduliFile: true,
      });
    const DROPIN = "/etc/ssh/sshd_config.d/10-opscrew.conf";
    const DM = "/etc/opscrew/deadman";

    it("arms with systemd-run and its undo.sh restores the drop-in, removes a new moduli copy and brings ssh back", () => {
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
      h.write("/etc/ssh/moduli.opscrew", "filtered\n");
      h.clearCalls();
      const undo = h.runFile(`${DM}/sshd.undo.sh`);
      expect(undo.status).toBe(0);
      expect(h.read(DROPIN)).toBe("PermitRootLogin yes\n");
      expect(h.exists("/etc/ssh/moduli.opscrew")).toBe(false);
      expect(h.read("/etc/ssh/moduli")).toBe(MODULI);
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

    describe("on a ufw that is on but lets everything in", () => {
      const DEADMAN = "/etc/opscrew/deadman";
      const ACCEPT_ALL =
        'IPV6=yes\nDEFAULT_INPUT_POLICY="ACCEPT"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\nDEFAULT_FORWARD_POLICY="DROP"\n';
      const deny = {
        sshPorts: "22",
        sshRulePorts: "22",
        webRules: "",
        web: false,
        enable: false,
        install: false,
        denyIncoming: true,
      };
      const activeUfw = (policies: string) => {
        const h = harness();
        h.stub("ufw", UFW);
        h.write("/state/ufw-active", "");
        h.write("/etc/default/ufw", policies);
        return h;
      };
      const changes = (h: ShellHarness) =>
        h.calls().filter((call) => /^ufw (allow|default|--force)/.test(call));

      it("adds the SSH rule first, then sets deny incoming, and never turns ufw off or on", () => {
        const h = activeUfw(ACCEPT_ALL);
        const { apply } = scriptsFor("setup", "ufw", deny);
        const run = h.run(apply);
        expect(run.status, run.stderr).toBe(0);
        expect(changes(h)).toEqual([
          "ufw allow 22/tcp comment opscrew-ssh",
          "ufw default deny incoming",
        ]);
      });

      it("keeps a default of reject (it already turns connections away)", () => {
        const h = activeUfw(ACCEPT_ALL.replace('INPUT_POLICY="ACCEPT"', 'INPUT_POLICY="REJECT"'));
        const run = h.run(scriptsFor("setup", "ufw", deny).apply);
        expect(run.status, run.stderr).toBe(0);
        expect(changes(h)).toEqual(["ufw allow 22/tcp comment opscrew-ssh"]);
      });

      it("counts as a change until the default denies", () => {
        const h = activeUfw(ACCEPT_ALL);
        h.write(
          "/state/ufw-added",
          "Added user rules (see 'ufw status' for running firewall):\nufw allow 22/tcp comment 'opscrew-ssh'\n",
        );
        const { check } = scriptsFor("setup", "ufw", deny);
        expect(h.run(check).stdout).toContain("state=change");
        h.write(
          "/etc/default/ufw",
          ACCEPT_ALL.replace('INPUT_POLICY="ACCEPT"', 'INPUT_POLICY="DROP"'),
        );
        expect(h.run(check).stdout).toContain("state=in-place");
      });

      it("the dead-man undo puts allow back and leaves ufw on", () => {
        const h = activeUfw(ACCEPT_ALL);
        const { deadMan } = scriptsFor("setup", "ufw", deny);
        if (!deadMan) throw new Error("no dead-man");
        const arm = h.run(armScript(deadMan, 180));
        expect(arm.status, arm.stderr).toBe(0);
        h.clearCalls();
        h.runFile(`${DEADMAN}/ufw.undo.sh`);
        expect(h.calls()).toEqual([
          "ufw default allow incoming",
          "ufw default allow outgoing",
          "ufw default deny routed",
          "ufw --force delete allow 22/tcp",
        ]);
      });
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
      // Policies first, then the rules (SSH is never closed in between), ufw off last.
      expect(h.calls()).toEqual([
        "ufw default allow incoming",
        "ufw default allow outgoing",
        "ufw --force delete allow 22/tcp",
        "ufw --force delete allow 80/tcp",
        "ufw --force disable",
      ]);
    });

    it("the undo on a ufw that stays on lets everything in again before removing the SSH rule", () => {
      const h = harness();
      h.stub("ufw", UFW);
      const { apply } = scriptsFor("undo", "ufw", {
        removeRules: "22/tcp 80/tcp 443/tcp 443/udp",
        disable: false,
        removePackage: false,
        defaultIncoming: "allow",
        defaultOutgoing: "",
        defaultRouted: "",
      });
      expect(h.run(apply).status).toBe(0);
      expect(h.calls()).toEqual([
        "ufw default allow incoming",
        "ufw --force delete allow 22/tcp",
        "ufw --force delete allow 80/tcp",
        "ufw --force delete allow 443/tcp",
        "ufw --force delete allow 443/udp",
      ]);
    });
  });

  describe("web filter (DOCKER-USER)", () => {
    /**
     * iptables over files: `$S/iptables/<chain>` holds the chain's rules. With `$S/insert-at`, the
     * n-th listing of DOCKER-USER first inserts another program's rule at its top.
     */
    const IPTABLES = `fam=$(basename "$0")
d="$S/$fam"
mkdir -p "$d"
if [ "$1" = -w ]; then shift; fi
if [ "$1" = -n ]; then shift; fi
op=$1
chain=$2
shift 2
f="$d/$chain"
case "$op" in
  -L) [ -e "$f" ] ;;
  -N) [ ! -e "$f" ] || exit 1; : > "$f" ;;
  -S)
    [ -e "$f" ] || exit 1
    if [ "$chain" = DOCKER-USER ] && [ -e "$S/insert-at" ]; then
      n=$(( $(cat "$S/list-count" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$S/list-count"
      if [ "$n" = "$(cat "$S/insert-at")" ]; then
        { echo "-A DOCKER-USER -s 192.0.2.0/24 -j ACCEPT"; cat "$f"; } > "$f.new"; mv "$f.new" "$f"
      fi
    fi
    echo "-N $chain"; cat "$f" ;;
  -C) [ -e "$f" ] && grep -qxF -- "-A $chain $*" "$f" ;;
  -I) shift; [ -e "$f" ] || exit 1; { echo "-A $chain $*"; cat "$f"; } > "$f.new"; mv "$f.new" "$f" ;;
  -D)
    [ -e "$f" ] || exit 1
    case "$1" in
      [0-9]*) awk -v n="$1" 'NR != n' "$f" > "$f.new" ;;
      *) awk -v r="-A $chain $*" 'done || $0 != r { print; next } { done = 1 }' "$f" > "$f.new" ;;
    esac
    mv "$f.new" "$f" ;;
  -F) : > "$f" ;;
  -X) if [ -s "$f" ] || grep -rqs -- "-j $chain\\$" "$d"; then exit 1; fi; rm -f "$f" ;;
  *) exit 2 ;;
esac`;
    const RESTORE = `fam=$(basename "$0" | sed 's/-restore$//')
d="$S/$fam"
mkdir -p "$d"
[ ! -e "$S/fail-restore" ] || exit 1
while IFS= read -r line; do
  case "$line" in
    :*) chain=\${line#:}; chain=\${chain%% *}; : > "$d/$chain" ;;
    "-A "*) chain=$(printf '%s\\n' "$line" | cut -d ' ' -f 2); printf '%s\\n' "$line" >> "$d/$chain" ;;
  esac
done`;
    /** systemctl over files; `show docker` prints `$S/docker-unit` (ExecStart and Environment). */
    const SYSTEMCTL_UNITS = `case "$1" in
  is-enabled) if [ -e "$S/enabled.$2" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) unit=$2; if [ "$unit" = --quiet ]; then unit=$3; fi; [ -e "$S/active.$unit" ] ;;
  enable) touch "$S/enabled.$2" ;;
  disable) rm -f "$S/enabled.$2" ;;
  start) touch "$S/active.$2" ;;
  stop) rm -f "$S/active.$2" ;;
  show) cat "$S/docker-unit" 2>/dev/null || echo 'ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// }' ;;
  *) exit 0 ;;
esac`;
    const PARAMS = { ipv4: "103.21.244.0/22 173.245.48.0/20" };
    const USER_RULE = "-A DOCKER-USER -s 10.0.0.0/8 -j ACCEPT";
    const JUMPS = [
      "-A DOCKER-USER -p tcp -m conntrack --ctstate DNAT --ctorigdstport 80 --ctdir ORIGINAL -j OPSCREW-WEB",
      "-A DOCKER-USER -p tcp -m conntrack --ctstate DNAT --ctorigdstport 443 --ctdir ORIGINAL -j OPSCREW-WEB",
      "-A DOCKER-USER -p udp -m conntrack --ctstate DNAT --ctorigdstport 443 --ctdir ORIGINAL -j OPSCREW-WEB",
    ];
    /** Runs the script on the server as systemd does at boot (the stubs first on PATH). */
    const BOOT =
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\nsh /usr/local/sbin/opscrew-web-filter";
    const lines = (h: ShellHarness, path: string) =>
      (h.read(path) ?? "").split("\n").filter((line) => line !== "");
    /** A server whose Docker runs (DOCKER-USER exists, with one rule of the user's). */
    const filterHarness = () => {
      const h = harness();
      h.stub("systemctl", SYSTEMCTL_UNITS);
      h.stub("iptables", IPTABLES);
      h.stub("iptables-restore", RESTORE);
      h.write("/state/active.docker", "");
      h.write("/state/iptables/DOCKER-USER", `${USER_RULE}\n`);
      return h;
    };
    const iptablesCalls = (h: ShellHarness) =>
      h.calls().filter((call) => /^ip6?tables(-restore)? /.test(call) && !/ -(L|S|C) /.test(call));

    it("installs the chain and the jumps first in DOCKER-USER (IPv4 only), then makes Docker require the unit", () => {
      const h = filterHarness();
      const { check, apply, verify } = scriptsFor("setup", "web-filter", PARAMS);
      expect(h.run(check).stdout).toContain("state=change");
      h.clearCalls();
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(iptablesCalls(h)).toEqual([
        "iptables-restore -w --noflush",
        "iptables -w -I DOCKER-USER 1 -p udp -m conntrack --ctstate DNAT --ctorigdstport 443 --ctdir ORIGINAL -j OPSCREW-WEB",
        "iptables -w -I DOCKER-USER 1 -p tcp -m conntrack --ctstate DNAT --ctorigdstport 443 --ctdir ORIGINAL -j OPSCREW-WEB",
        "iptables -w -I DOCKER-USER 1 -p tcp -m conntrack --ctstate DNAT --ctorigdstport 80 --ctdir ORIGINAL -j OPSCREW-WEB",
      ]);
      expect(lines(h, "/state/iptables/OPSCREW-WEB")).toEqual([
        "-A OPSCREW-WEB -s 103.21.244.0/22 -j RETURN",
        "-A OPSCREW-WEB -s 173.245.48.0/20 -j RETURN",
        "-A OPSCREW-WEB -j DROP",
      ]);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([...JUMPS, USER_RULE]);
      // The unit runs the script before Docker; Docker requires it (fail closed).
      expect(h.read("/etc/systemd/system/docker.service.d/opscrew-web-filter.conf")).toContain(
        "Requires=opscrew-web-filter.service\nAfter=opscrew-web-filter.service",
      );
      expect(h.read("/etc/systemd/system/opscrew-web-filter.service")).toContain(
        "Before=docker.service",
      );
      const systemctl = h.calls().filter((call) => call.startsWith("systemctl "));
      expect(systemctl).toEqual(
        expect.arrayContaining([
          "systemctl daemon-reload",
          "systemctl enable opscrew-web-filter.service",
          "systemctl start opscrew-web-filter.service",
        ]),
      );
      expect(systemctl.some((call) => /restart|stop/.test(call))).toBe(false);
      expect(h.run(verify).status).toBe(0);
      expect(h.run(check).stdout).toContain("state=in-place");

      // A second run changes nothing but the chain (in one restore): no new jumps.
      h.clearCalls();
      expect(h.run(apply).status).toBe(0);
      expect(iptablesCalls(h)).toEqual(["iptables-restore -w --noflush"]);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([...JUMPS, USER_RULE]);
    });

    it("new ranges replace the chain; jumps a rule of the user's pushed down move back to the top", () => {
      const h = filterHarness();
      const first = scriptsFor("setup", "web-filter", PARAMS);
      expect(h.run(first.apply).status).toBe(0);
      h.write(
        "/state/iptables/DOCKER-USER",
        `-A DOCKER-USER -i eth1 -j ACCEPT\n${[...JUMPS, USER_RULE].join("\n")}\n`,
      );
      const next = scriptsFor("setup", "web-filter", { ipv4: "131.0.72.0/22 173.245.48.0/20" });
      expect(h.run(next.check).stdout).toContain("state=change");
      const run = h.run(next.apply);
      expect(run.status, run.stderr).toBe(0);
      expect(lines(h, "/state/iptables/OPSCREW-WEB")).toEqual([
        "-A OPSCREW-WEB -s 131.0.72.0/22 -j RETURN",
        "-A OPSCREW-WEB -s 173.245.48.0/20 -j RETURN",
        "-A OPSCREW-WEB -j DROP",
      ]);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([
        ...JUMPS,
        "-A DOCKER-USER -i eth1 -j ACCEPT",
        USER_RULE,
      ]);
      expect(h.run(next.verify).status).toBe(0);
    });

    it("deletes an old jump only while the rule at its number still is one (the chain may change)", () => {
      const h = filterHarness();
      expect(h.run(scriptsFor("setup", "web-filter", PARAMS).apply).status).toBe(0);
      const other = "-A DOCKER-USER -i eth1 -j ACCEPT";
      h.write("/state/iptables/DOCKER-USER", `${[other, ...JUMPS, USER_RULE].join("\n")}\n`);
      // Another program inserts a rule at the top between the listing and the first delete
      // (the boot script lists DOCKER-USER twice before it deletes anything).
      h.write("/state/insert-at", "3");
      h.clearCalls();
      const boot = h.run(BOOT);
      expect(boot.status, boot.stderr).toBe(0);
      const inserted = "-A DOCKER-USER -s 192.0.2.0/24 -j ACCEPT";
      // Rules 7 and 6 were still OpsCrew's jumps and went; rule 5 had become the user's rule and
      // stayed. Nothing but OpsCrew's jumps was deleted.
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([
        inserted,
        ...JUMPS,
        other,
        JUMPS[2],
        USER_RULE,
      ]);
      expect(h.calls().filter((call) => call.includes(" -D "))).toEqual([
        "iptables -w -D DOCKER-USER 7",
        "iptables -w -D DOCKER-USER 6",
      ]);
    });

    it("at boot, before Docker, the script creates DOCKER-USER itself", () => {
      const h = filterHarness();
      const { apply } = scriptsFor("setup", "web-filter", PARAMS);
      expect(h.run(apply).status).toBe(0);
      // A reboot: no rules at all, Docker not started yet.
      rmSync(h.native("/state/iptables"), { recursive: true, force: true });
      const boot = h.run(BOOT);
      expect(boot.status, boot.stderr).toBe(0);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual(JUMPS);
      expect(lines(h, "/state/iptables/OPSCREW-WEB")).toHaveLength(3);
    });

    it("at boot, fails (so Docker does not start) when Docker's unit picks nftables or turns iptables off", () => {
      for (const unit of [
        "ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd --firewall-backend=nftables }",
        "ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// }\nEnvironment=DOCKER_FIREWALL_BACKEND=nftables",
        "ExecStart={ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd --iptables=false }",
      ]) {
        const h = filterHarness();
        expect(h.run(scriptsFor("setup", "web-filter", PARAMS).apply).status).toBe(0);
        h.write("/state/docker-unit", `${unit}\n`);
        h.clearCalls();
        const boot = h.run(BOOT);
        expect(boot.status, unit).not.toBe(0);
        expect(boot.stderr).toMatch(/opscrew-web-filter: Docker's service/);
        expect(iptablesCalls(h), unit).toEqual([]);
        h.dispose();
      }
    });

    it("refuses Docker's nftables backend before changing anything", () => {
      const h = filterHarness();
      h.write("/etc/docker/daemon.json", '{ "firewall-backend": "nftables" }\n');
      const run = h.run(scriptsFor("setup", "web-filter", PARAMS).apply);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("nftables firewall backend");
      expect(iptablesCalls(h)).toEqual([]);
      expect(h.exists("/usr/local/sbin/opscrew-web-filter")).toBe(false);
    });

    it("when the rules cannot be installed, Docker is not made to require the filter", () => {
      const h = filterHarness();
      h.write("/state/fail-restore", "");
      const run = h.run(scriptsFor("setup", "web-filter", PARAMS).apply);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("could not install its web filter");
      expect(h.exists("/etc/systemd/system/docker.service.d/opscrew-web-filter.conf")).toBe(false);
      expect(h.calls()).not.toContain("systemctl enable opscrew-web-filter.service");
    });

    it("removal: Docker stops requiring the filter first, then OpsCrew's rules and files go", () => {
      const h = filterHarness();
      expect(h.run(scriptsFor("setup", "web-filter", PARAMS).apply).status).toBe(0);
      h.clearCalls();
      const remove = scriptsFor("undo", "web-filter", { remove: true });
      const run = h.run(remove.apply);
      expect(run.status, run.stderr).toBe(0);
      const calls = h.calls().filter((call) => !/ -(L|S|C) /.test(call));
      expect(calls.indexOf("systemctl daemon-reload")).toBeLessThan(
        calls.indexOf("systemctl stop opscrew-web-filter.service"),
      );
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([USER_RULE]);
      expect(h.exists("/state/iptables/OPSCREW-WEB")).toBe(false);
      expect(h.exists("/etc/systemd/system/docker.service.d/opscrew-web-filter.conf")).toBe(false);
      expect(h.exists("/etc/systemd/system/opscrew-web-filter.service")).toBe(false);
      expect(h.exists("/usr/local/sbin/opscrew-web-filter")).toBe(false);
      expect(h.run(remove.verify).status).toBe(0);
    });
  });

  describe("teardown", () => {
    const teardown = (deleteData: boolean) =>
      scriptsFor("teardown", "app-dirs", { app: "shop", deleteData }, { deleteData });

    it("removes the app through its own compose file, never one in the working directory", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/containers", "c1\nc2\n");
      h.write("/state/volumes", "shop_db\n");
      h.write("/srv/apps/shop/compose.yaml", "name: shop\n");
      h.write("/srv/apps/shop/app.env", "SECRET=x\n");
      h.write("/srv/data/shop/postgres/PG_VERSION", "17\n");
      h.write("/srv/data/blog/postgres/PG_VERSION", "17\n");
      h.write("/work/compose.yaml", "name: decoy\n");
      const { apply, verify } = teardown(true);
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.calls()).toContain(
        `docker compose -p shop --project-directory ${h.posix("/srv/apps/shop")} -f ${h.posix("/srv/apps/shop/compose.yaml")} down --remove-orphans --volumes`,
      );
      expect(h.calls().some((call) => call.includes("/work"))).toBe(false);
      expect(h.exists("/srv/apps/shop")).toBe(false);
      expect(h.exists("/srv/data/shop")).toBe(false);
      // Another app's data stays.
      expect(h.read("/srv/data/blog/postgres/PG_VERSION")).toBe("17\n");
      expect(h.exists("/srv/apps")).toBe(true);
      expect(h.run(verify).status).toBe(0);
    });

    it("without a compose file, removes only what carries the project label, and keeps data", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/containers", "c1\n");
      h.write("/state/networks", "n1\n");
      h.write("/state/volumes", "shop_db\n");
      h.write("/srv/data/shop/postgres/PG_VERSION", "17\n");
      h.write("/work/compose.yaml", "name: decoy\n");
      const run = h.run(teardown(false).apply);
      expect(run.status, run.stderr).toBe(0);
      const calls = h.calls();
      expect(calls.some((call) => call.startsWith("docker compose"))).toBe(false);
      expect(calls).toContain("docker ps -aq --filter label=com.docker.compose.project=shop");
      expect(calls).toContain("docker rm -f c1");
      expect(calls).toContain("docker network rm n1");
      expect(calls.some((call) => call.startsWith("docker volume rm"))).toBe(false);
      expect(h.read("/srv/data/shop/postgres/PG_VERSION")).toBe("17\n");
    });

    it("removes the shared edge with its containers, network, volumes and folder", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/containers", "e1\ne2\n");
      h.write("/state/volumes", "opscrew-edge_caddy_data\n");
      h.write("/srv/edge/compose.yaml", "name: opscrew-edge\n");
      h.write("/srv/edge/sites/shop.caddy", "shop.example.com {\n}\n");
      const { apply } = scriptsFor("teardown", "edge", { removeDir: true }, { deleteData: false });
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.calls()).toContain(
        `docker compose -p opscrew-edge --project-directory ${h.posix("/srv/edge")} -f ${h.posix("/srv/edge/compose.yaml")} down --remove-orphans --volumes`,
      );
      expect(h.calls()).toContain("docker network inspect opscrew-edge");
      expect(h.calls()).toContain("docker network rm opscrew-edge");
      expect(h.exists("/srv/edge")).toBe(false);
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

  describe("app record", () => {
    const params = (ownProject: boolean, projectId = "shop-1") => ({
      app: "shop",
      projectId,
      access: "public",
      hostnames: "shop.example.com www.shop.example.com",
      services: "web",
      memoryMb: 512,
      deployKey: KEY,
      ownProject,
    });
    const record = (ownProject: boolean, projectId?: string) =>
      scriptsFor("setup", "app-record", params(ownProject, projectId));
    const RECORD = "/etc/opscrew/apps/shop.json";

    it("is not written over a Compose project of that name that OpsCrew did not deploy", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/volumes", "shop_pgdata\n");
      const run = h.run(record(false).apply);
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("Compose project named shop that OpsCrew did not deploy");
      expect(h.exists(RECORD)).toBe(false);
      expect(h.calls()).toContain(
        "docker volume ls -q --filter label=com.docker.compose.project=shop",
      );
    });

    it("is not written while Docker is stopped (its containers cannot be seen)", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      const run = h.run(record(false).apply);
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("Docker is installed but not running");
      expect(h.calls().some((call) => call.startsWith("docker "))).toBe(false);
      expect(h.exists(RECORD)).toBe(false);
    });

    it("is written when the project is OpsCrew's own (data kept by an earlier teardown)", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      h.write("/state/volumes", "shop_db\n");
      const { apply, verify } = record(true);
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      // The harness moves every /srv path under its root, the record's folders too.
      expect(JSON.parse(h.read(RECORD) ?? "null")).toMatchObject({
        app: "shop",
        projectId: "shop-1",
        state: "active",
        hostnames: ["shop.example.com", "www.shop.example.com"],
        folders: { app: h.posix("/srv/apps/shop"), data: h.posix("/srv/data/shop") },
      });
      expect(h.exists("/var/lib/opscrew-ready")).toBe(true);
      expect(h.run(verify).status).toBe(0);
    });

    it("is written on a server without any project of that name", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      expect(h.run(record(false).apply).status).toBe(0);
      expect(h.exists(RECORD)).toBe(true);
    });

    it("is never written over another project's app of that name", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      expect(h.run(record(false, "shop-other").apply).status).toBe(0);
      const run = h.run(record(true).apply);
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("Another project's OpsCrew app named shop");
      expect(h.read(RECORD)).toContain('"projectId":"shop-other"');
    });

    it("refuses the reserved name and bad hostnames before writing a script", () => {
      expect(() =>
        scriptsFor("setup", "app-record", { ...params(false), app: "opscrew-edge" }),
      ).toThrow(/invalid parameters/);
      expect(() =>
        scriptsFor("setup", "app-record", { ...params(false), hostnames: "shop.example.com;x" }),
      ).toThrow(/invalid parameters/);
    });

    it("a teardown never removes or rewrites another project's record of that name", () => {
      const h = harness();
      h.stub("docker", DOCKER);
      h.write("/state/active.docker", "");
      expect(h.run(record(false, "shop-other").apply).status).toBe(0);
      const before = h.read(RECORD);
      for (const keepData of [false, true]) {
        const teardown = scriptsFor(
          "teardown",
          "app-record",
          { app: "shop", keepData, projectId: "shop-1" },
          { deleteData: !keepData },
        );
        const run = h.run(teardown.apply);
        expect(run.status).toBe(3);
        expect(run.stderr).toContain("Another project's OpsCrew app named shop");
        expect(h.read(RECORD)).toBe(before);
      }
    });

    it("undo refuses while an app is still set up", () => {
      const h = harness();
      h.write(RECORD, '{"state":"active"}\n');
      const run = h.run(scriptsFor("undo", "app-record", {}).apply);
      expect(run.status).toBe(3);
      expect(h.exists(RECORD)).toBe(true);
      h.write(RECORD, '{"state":"data-kept"}\n');
      expect(h.run(scriptsFor("undo", "app-record", {}).apply).status).toBe(0);
      expect(h.exists("/etc/opscrew")).toBe(false);
    });
  });

  describe("sshd", () => {
    const SETTINGS = {
      permitRootLogin: "no",
      disablePasswords: true,
      kbdInteractiveOff: true,
      moduliFile: true,
    };
    /** A harness whose sshd -T shows SETTINGS in effect; `extra` adds a case (`-t) exit 255 ;;`). */
    const sshdHarness = (extra = "") => {
      const h = harness();
      h.stub(
        "sshd",
        `case "$1" in
  ${extra}
  -T) printf '%s\\n' 'port 22' 'permitrootlogin no' 'passwordauthentication no' 'kbdinteractiveauthentication no' ;;
esac`,
      );
      return h;
    };

    it("writes the planned drop-in byte for byte, keeps the user's own file once, filters the moduli, and reloads ssh", () => {
      const h = sshdHarness();
      h.write("/etc/ssh/sshd_config.d/10-opscrew.conf", "X11Forwarding no\n");
      const { check, apply, verify } = scriptsFor("setup", "sshd", SETTINGS);
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.read("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(sshdDropIn(SETTINGS));
      expect(h.read("/etc/opscrew/backup/10-opscrew.conf")).toBe("X11Forwarding no\n");
      // Written beside the file and renamed over it: no temporary file is left behind.
      expect(readdirSync(h.native("/etc/ssh/sshd_config.d"))).toEqual(["10-opscrew.conf"]);
      expect(h.calls()).toContain("systemctl try-reload-or-restart ssh.service");
      expect(h.run(verify).status).toBe(0);
      // sshd reads only the groups of 3072 bits and more, from OpsCrew's copy; the conffile stays.
      const moduli = h.read("/etc/ssh/moduli.opscrew") ?? "";
      expect(moduli).not.toContain(" 2047 ");
      for (const group of MODULI_STRONG) expect(moduli).toContain(group);
      expect(h.read("/etc/ssh/moduli")).toBe(MODULI);
      expect(readdirSync(h.native("/etc/ssh")).sort()).toEqual([
        "moduli",
        "moduli.opscrew",
        "sshd_config.d",
      ]);
      expect(h.run(check).stdout).toContain("state=in-place");
      // Again: nothing changes.
      expect(h.run(apply).status).toBe(0);
      expect(h.read("/etc/ssh/moduli.opscrew")).toBe(moduli);
      // OpsCrew's copy gone or with weak groups: the check sees a change.
      h.write("/etc/ssh/moduli.opscrew", MODULI);
      expect(h.run(check).stdout).toContain("state=change");
    });

    it("writes no moduli copy where OpenSSH has no ModuliFile", () => {
      const h = sshdHarness();
      const settings = { ...SETTINGS, moduliFile: false };
      const { apply, verify } = scriptsFor("setup", "sshd", settings);
      expect(h.run(apply).status).toBe(0);
      expect(h.exists("/etc/ssh/moduli.opscrew")).toBe(false);
      expect(h.read("/etc/ssh/sshd_config.d/10-opscrew.conf")).not.toContain("ModuliFile");
      expect(h.run(verify).status).toBe(0);
    });

    it("leaves the old settings in place, without a moduli copy, when sshd -t refuses the new ones", () => {
      const h = sshdHarness("-t) exit 255 ;;");
      const before = "PermitRootLogin yes\n";
      h.write("/etc/ssh/sshd_config.d/10-opscrew.conf", before);
      const { apply, deadMan } = scriptsFor("setup", "sshd", SETTINGS);
      if (!deadMan) throw new Error("no dead-man");
      expect(h.run(armScript(deadMan, 180)).status).toBe(0);
      h.clearCalls();
      const run = h.run(apply);
      expect(run.status).toBe(4);
      expect(run.stderr).toContain("did not pass sshd -t");
      expect(h.read("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(before);
      expect(h.exists("/etc/ssh/moduli.opscrew")).toBe(false);
      expect(h.read("/etc/ssh/moduli")).toBe(MODULI);
      expect(h.calls()).not.toContain("systemctl try-reload-or-restart ssh.service");
    });

    it("undo removes the drop-in with its ModuliFile line, and the moduli copy", () => {
      const h = sshdHarness();
      expect(h.run(scriptsFor("setup", "sshd", SETTINGS).apply).status).toBe(0);
      expect(h.exists("/etc/ssh/moduli.opscrew")).toBe(true);
      const undo = scriptsFor("undo", "sshd", {});
      expect(h.run(undo.check).stdout).toContain("state=change");
      const run = h.run(undo.apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.exists("/etc/ssh/sshd_config.d/10-opscrew.conf")).toBe(false);
      expect(h.exists("/etc/ssh/moduli.opscrew")).toBe(false);
      expect(h.read("/etc/ssh/moduli")).toBe(MODULI);
      expect(h.run(undo.verify).status).toBe(0);
    });
  });

  describe("deploy user and the apps' deploy keys", () => {
    const deployHarness = () => {
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
      return h;
    };

    it("gives an existing deploy user Docker access and leaves its keys to the deploy-key step", () => {
      const h = deployHarness();
      h.write("/home/deploy/.ssh/authorized_keys", `${KEY}\n`);
      const { apply, verify } = scriptsFor("setup", "deploy-user", { user: "deploy" });
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.calls()).toContain("usermod -aG docker deploy");
      expect(h.calls().some((call) => call.startsWith("useradd"))).toBe(false);
      expect(h.read("/home/deploy/.ssh/authorized_keys")).toBe(`${KEY}\n`);
      expect(h.run(verify).status).toBe(0);
    });

    it("writes authorized_keys atomically with exactly the apps' keys (old keys revoked)", () => {
      const h = deployHarness();
      h.write(
        "/home/deploy/.ssh/authorized_keys",
        "ssh-ed25519 AAAAold old-deploy\nssh-rsa AAAAother someone\n",
      );
      const blog = KEY.replace("opscrew-deploy", "blog-deploy");
      const keys = [blog, KEY].sort().join("\n");
      const { check, apply, verify } = scriptsFor("setup", "deploy-key", { user: "deploy", keys });
      expect(h.run(check).stdout).toContain("state=change");
      const run = h.run(apply);
      expect(run.status, run.stderr).toBe(0);
      expect(h.read("/home/deploy/.ssh/authorized_keys")).toBe(`${keys}\n`);
      expect(readdirSync(h.native("/home/deploy/.ssh"))).toEqual(["authorized_keys"]);
      expect(h.run(verify).status).toBe(0);
      expect(h.run(check).stdout).toContain("state=in-place");
      // A teardown keeps only the other apps' keys.
      const removal = scriptsFor("teardown", "deploy-key", { user: "deploy", keys: blog });
      expect(h.run(removal.apply).status).toBe(0);
      expect(h.read("/home/deploy/.ssh/authorized_keys")).toBe(`${blog}\n`);
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
