import { rm } from "node:fs/promises";
import type { CheckResult, CommandResult } from "@opscrew/contracts";
import { writeArtifact } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { APP_HOST, DATA_HOST, splitWorld } from "../status/__fixtures__/split";
import { ScriptedRunner } from "../testing";
import { type RunSecureOptions, runSecure } from "./run";
import type { NetworkFilterReader } from "./servers";

const HARDENED_SSHD = [
  "PasswordAuthentication no",
  "KbdInteractiveAuthentication no",
  "PermitRootLogin no",
  "MaxAuthTries 3",
  "X11Forwarding no",
  "AllowUsers deploy",
].join("\n");

/** A hardened server's answers to the host checks; `undefined` for any other command. */
function hardened(command: string): CommandResult | undefined {
  const ok = (stdout: string): CommandResult => ({
    exitCode: 0,
    stdout: `${stdout}\n`,
    stderr: "",
  });
  switch (command) {
    case "cat /etc/ssh/sshd_config.d/10-opscrew.conf":
      return ok(HARDENED_SSHD);
    case "systemctl is-active fail2ban":
    case "grep -qx 'ENABLED=yes' /etc/ufw/ufw.conf":
      return ok("active");
    case "systemctl is-enabled unattended-upgrades":
      return ok("enabled");
    case "ss -H -tln":
      return ok("LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*");
    case "df -P /":
      return ok(
        "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/sda1         39000000 4200000  33000000      12% /",
      );
    case "test -f /var/lib/opscrew-ready && echo yes || echo no":
      return ok("yes");
    case "test -f /var/run/reboot-required && echo yes || echo no":
      return ok("no");
    case "apt list --upgradable 2>/dev/null | grep -ci security || true":
      return ok("0");
    default:
      if (command.includes("docker inspect")) return ok("POSTGRES_PASSWORD");
      return undefined;
  }
}

/** Outside view: the app's server answers 22, 80 and 443; server data only 22. */
const outside: TcpConnect = async (host, port) =>
  host === DATA_HOST ? port === 22 : [22, 80, 443].includes(port);

/** The split app ready for `secure`: its plan written, both servers hardened. */
async function secureWorld(world: { grant?: boolean; data?: "cloud" | "own" } = {}) {
  const runner = new ScriptedRunner((command, args) =>
    command === "ssh" && args.includes("PubkeyAuthentication=no")
      ? { exitCode: 255, stdout: "", stderr: "Permission denied (publickey)." }
      : { exitCode: 1, stdout: "", stderr: "not a git repository" },
  );
  const w = await splitWorld({
    runner,
    data: world.data ?? "cloud",
    network: (network) =>
      world.grant
        ? { ...network, grants: [{ device: "laptop", service: "db", access: "full" }] }
        : network,
  });
  for (const server of Object.values(w.servers)) server.other = hardened;
  await writeArtifact("plan", w.deps.paths.files.plan, w.plan);
  const filter: NetworkFilterReader = async () => [{ port: 5432, sources: [`${w.prefix}.1`] }];
  const options = (extra: Partial<RunSecureOptions> = {}): RunSecureOptions => ({
    scanners: [],
    offline: true,
    tcpConnect: outside,
    remote: w.remote(APP_HOST),
    serverRemote: w.remote,
    readNetworkFilter: filter,
    ...extra,
  });
  return { ...w, options };
}

function find(checks: readonly CheckResult[], id: string): CheckResult {
  const check = checks.find((c) => c.id === id);
  if (check === undefined) throw new Error(`no check ${id}: ${checks.map((c) => c.id).join(", ")}`);
  return check;
}

describe("secure across an app's servers", () => {
  it("checks every server as the app's, each named, and passes a hardened split app", async () => {
    const w = await secureWorld();
    const result = await runSecure(w.deps, w.options());

    expect(result.problems).toEqual([]);
    expect(result.passed).toBe(true);
    // The app's server: today's checks, named, without the service placed elsewhere.
    expect(find(result.hostChecks, "ufw").title).toBe("Server app: Host firewall (ufw) is enabled");
    expect(result.hostChecks.some((c) => c.id === "service-db-port")).toBe(false);
    // Server data: the same hardening checks, and its service's login.
    expect(find(result.hostChecks, "server-data-ufw")).toMatchObject({
      title: "Server data: Host firewall (ufw) is enabled",
      message: "On server data: ufw is enabled.",
      status: "pass",
      target: "server data",
    });
    expect(find(result.hostChecks, "server-data-service-db-login").status).toBe("pass");
    // Its Postgres is published on the private address, which replaces the "no port" check.
    expect(result.hostChecks.some((c) => c.id === "server-data-service-db-port")).toBe(false);
    expect(find(result.hostChecks, "service-db-private")).toMatchObject({
      status: "pass",
      message: `PostgreSQL (db) on server data is published only on ${w.prefix}.2:5432, and the network's filter admits only server app (${w.prefix}.1).`,
    });
    // From outside: no web or service port on server data, and SSH refuses passwords.
    expect(find(result.probes, "server-data-port-80-closed").status).toBe("pass");
    expect(find(result.probes, "server-data-port-5432-closed").status).toBe("pass");
    expect(find(result.probes, "server-data-ssh-password-login-disabled").status).toBe("pass");
    // The grants and public SSH are listed.
    expect(find(result.settings, "network-grants").message).toBe(
      "No device has access to a database or cache.",
    );
    expect(find(result.settings, "public-ssh").message).toContain("SSH is open");
    // The committed report never holds server data's address.
    expect(result.report).not.toContain(DATA_HOST);
    expect(result.report).toContain("Server data: Host firewall (ufw) is enabled");
  });

  it("finds a service published outside its private address, or without the filter's rule", async () => {
    const w = await secureWorld();
    const data = w.servers[DATA_HOST];
    if (data !== undefined) data.ports = "db|0.0.0.0:5432->5432/tcp\n";
    const open = await runSecure(w.deps, w.options());
    expect(find(open.hostChecks, "service-db-private")).toMatchObject({
      status: "fail",
      severity: "critical",
      message:
        "PostgreSQL (db) on server data is published on 0.0.0.0:5432, so it can be reached outside the private network.",
    });
    expect(open.passed).toBe(false);

    const v = await secureWorld();
    const noRule = await runSecure(v.deps, v.options({ readNetworkFilter: async () => undefined }));
    expect(find(noRule.hostChecks, "service-db-private")).toMatchObject({
      status: "fail",
      remediation:
        "Run `opscrew provision`: it shows the network-filter host plan for server data.",
    });

    const u = await secureWorld();
    const { readNetworkFilter: _r, ...withoutReader } = u.options();
    const unchecked = await runSecure(u.deps, withoutReader);
    expect(find(unchecked.hostChecks, "service-db-private")).toMatchObject({
      status: "warn",
      message: `PostgreSQL (db) on server data is published only on ${u.prefix}.2:5432; the network's filter in front of it was not checked.`,
    });
  });

  it("fails a filter that admits more than the app's server and the granted devices", async () => {
    const w = await secureWorld();
    const result = await runSecure(
      w.deps,
      w.options({
        readNetworkFilter: async () => [
          { port: 5432, sources: [`${w.prefix}.1`, `${w.prefix}.100`] },
        ],
      }),
    );
    expect(find(result.hostChecks, "service-db-private")).toMatchObject({
      status: "fail",
      message: `PostgreSQL (db) on server data is published only on ${w.prefix}.2:5432, but the network's filter also admits device laptop (${w.prefix}.100) on port 5432.`,
      remediation:
        "Run `opscrew provision`: it shows the network-filter host plan for server data.",
    });

    // Granted, the laptop is expected; a filter without it leaves the laptop out.
    const g = await secureWorld({ grant: true });
    const granted = await runSecure(g.deps, g.options());
    expect(find(granted.hostChecks, "service-db-private")).toMatchObject({
      status: "warn",
      message: `PostgreSQL (db) on server data is published only on ${g.prefix}.2:5432, but the network's filter does not admit device laptop (${g.prefix}.100), so it can't reach it.`,
    });
  });

  it("checks an own server whose login reaches Docker only through sudo", async () => {
    const w = await secureWorld({ data: "own" });
    const data = w.servers[DATA_HOST];
    if (data !== undefined) {
      data.privilege = "sudo";
      data.dockerThroughSudo = true;
    }
    const result = await runSecure(w.deps, w.options());
    expect(find(result.hostChecks, "server-data-service-db-login").status).toBe("pass");
    expect(find(result.hostChecks, "service-db-private").status).toBe("pass");
    const onData = w.commands.filter((c) => c.host === DATA_HOST).map((c) => c.command);
    expect(onData.find((c) => c.includes("docker inspect"))).toMatch(/^sudo -n sh -c /);
  });

  it("skips the extra servers' host checks with the app's when the deploy key is missing", async () => {
    const w = await secureWorld();
    await rm(w.deps.paths.files.deployKey);
    const { remote: _r, ...options } = w.options();
    const result = await runSecure(w.deps, options);
    expect(result.hostChecks.filter((c) => c.target === "server data")).toEqual([]);
    expect(find(result.probes, "server-data-port-5432-closed").status).toBe("pass");
    expect(w.commands.filter((c) => c.host === DATA_HOST)).toEqual([]);
  });

  it("names a server it cannot reach", async () => {
    const w = await secureWorld();
    w.offline.add(DATA_HOST);
    const result = await runSecure(w.deps, w.options());
    expect(find(result.hostChecks, "server-data-ssh-hardening")).toMatchObject({
      status: "fail",
      target: "server data",
    });
    expect(find(result.hostChecks, "server-data-private-ports")).toMatchObject({
      status: "warn",
      message: expect.stringMatching(/^OpsCrew could not read the ports server data publishes\. /),
    });
  });

  it("lists each grant by device, service and access", async () => {
    const w = await secureWorld({ grant: true });
    const result = await runSecure(w.deps, w.options());
    expect(find(result.settings, "network-grants").message).toBe(
      "device laptop to PostgreSQL (db), full.",
    );
  });
});
