import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { SH_AVAILABLE, wireguardKeys } from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { dockerRootCommand } from "./privilege";
import { asRoot, pipedScript } from "./shell";
import { parseWireGuardPeers, readWireGuard, readWireGuardScript } from "./wireguard";

/** The shape of the pinned Caddy image (`IMAGES.caddy.ref`); the digest is a stand-in. */
const IMAGE = `caddy:2.11.7-alpine@sha256:${"0".repeat(63)}1`;

/** The keys of the fixture, made at runtime (never committed): `{{WG:<name>}}` in the file. */
const KEYS: Record<string, string> = {
  "own-private": wireguardKeys("own").privateKey,
  "own-public": wireguardKeys("own").publicKey,
  db: wireguardKeys("db").publicKey,
  backup: wireguardKeys("backup").publicKey,
  "backup-preshared": wireguardKeys("backup-preshared").privateKey,
  laptop: wireguardKeys("laptop").publicKey,
  phone: wireguardKeys("phone").publicKey,
};

/**
 * `wg show wg-opscrew0 dump` as wg prints it (tab-separated; the interface's line first, with its
 * private key), on a server with a db server, a backup server with a preshared key, and two
 * devices, one of which never connected.
 */
const DUMP = readFileSync(
  fileURLToPath(new URL("./__fixtures__/wg-show-dump.txt", import.meta.url)),
  "utf8",
).replace(/\{\{WG:([a-z-]+)\}\}/g, (_, name: string) => KEYS[name] ?? "");

/** What the read script prints for that dump: the peers' public parts only. */
const PEER_LINES = DUMP.split("\n")
  .slice(1)
  .filter((line) => line !== "")
  .map((line) => {
    const fields = line.split("\t");
    return [fields[0], fields[2], fields[3], fields[4]].join("\t");
  })
  .join("\n");

const PEERS = [
  {
    publicKey: KEYS.db,
    endpoint: "203.0.113.20:51820",
    latestHandshake: new Date(1_761_822_000_000),
    allowedIps: ["10.200.4.2/32"],
  },
  {
    publicKey: KEYS.backup,
    endpoint: "[2001:db8::7]:51821",
    latestHandshake: new Date(1_761_821_880_000),
    allowedIps: ["10.200.4.3/32", "10.200.9.0/24"],
  },
  {
    publicKey: KEYS.laptop,
    endpoint: "203.0.113.77:41234",
    latestHandshake: new Date(1_761_821_940_000),
    allowedIps: ["10.200.4.100/32"],
  },
  { publicKey: KEYS.phone, allowedIps: ["10.200.4.101/32"] },
];

/** A server that answers every command with `answer`, recording what it was sent. */
function recording(answer: CommandResult = { exitCode: 0, stdout: `${PEER_LINES}\n`, stderr: "" }) {
  const calls: { command: string; options?: RemoteRunOptions }[] = [];
  const remote: RemoteExec = {
    host: "203.0.113.10",
    async run(command, options) {
      calls.push({ command, ...(options === undefined ? {} : { options }) });
      return answer;
    },
  };
  return { remote, calls };
}

describe.skipIf(!SH_AVAILABLE)("readWireGuard's script in a real shell (wg stubbed)", () => {
  it("lets only the peers' public key, endpoint, allowed IPs and latest handshake leave the server", () => {
    const h = new ShellHarness();
    try {
      h.write("/state/dump", DUMP);
      h.stub(
        "wg",
        `if [ "$1 $3" = "show dump" ] && [ "$2" = wg-opscrew0 ]; then cat "$S/dump"; else exit 1; fi`,
      );
      const run = h.run(readWireGuardScript("wg-opscrew0"));
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`${PEER_LINES}\n`);
      expect(run.stdout).not.toContain(KEYS["own-private"]);
      expect(run.stdout).not.toContain(KEYS["backup-preshared"]);
      expect(parseWireGuardPeers(run.stdout)).toEqual(PEERS);

      const missing = h.run(readWireGuardScript("wg-opscrew1"));
      expect(missing.status).toBe(3);
      expect(missing.stderr).toContain(
        "opscrew: OpsCrew's WireGuard interface wg-opscrew1 is not up on the server.",
      );
    } finally {
      h.dispose();
    }
  });
});

describe("readWireGuard", () => {
  it("reads as root, through sudo, or through Docker with the script on the container's stdin", async () => {
    const script = readWireGuardScript("wg-opscrew0");
    expect(script).toMatchSnapshot();
    const root = recording();
    expect(await readWireGuard(root.remote, "wg-opscrew0", "root")).toEqual(PEERS);
    expect(root.calls).toEqual([
      { command: asRoot("root", script), options: { timeoutMs: 60_000 } },
    ]);

    const sudo = recording();
    await readWireGuard(sudo.remote, "wg-opscrew0", "sudo");
    expect(sudo.calls[0]?.command).toBe(asRoot("sudo", script));

    const docker = recording();
    expect(await readWireGuard(docker.remote, "wg-opscrew0", "docker", IMAGE)).toEqual(PEERS);
    expect(docker.calls).toEqual([
      {
        command: dockerRootCommand(IMAGE),
        options: { timeoutMs: 60_000, input: pipedScript(script, "") },
      },
    ]);
  });

  it("refuses the docker privilege without its image, and a name that is not OpsCrew's interface", async () => {
    const server = recording();
    await expect(readWireGuard(server.remote, "wg-opscrew0", "docker")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(readWireGuard(server.remote, "wg0; reboot", "root")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(server.calls).toEqual([]);
  });

  it("says plainly when the interface is not up", async () => {
    const server = recording({
      exitCode: 3,
      stdout: "",
      stderr: "opscrew: OpsCrew's WireGuard interface wg-opscrew0 is not up on the server.\n",
    });
    await expect(readWireGuard(server.remote, "wg-opscrew0", "root")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "OpsCrew's WireGuard interface wg-opscrew0 is not up on the server.",
    });
  });

  it("leaves out a line that is not a peer's", () => {
    expect(parseWireGuardPeers(`garbage\n${PEER_LINES}\nnot\ta\tpeer\t0\n`)).toEqual(PEERS);
  });
});
