import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  ED25519,
  ED25519_FINGERPRINT,
  freshFacts,
  hostKeyBlob,
  LAN_IPV4,
  OWN_IPV4,
  ownRunner,
  placeholderKey,
  RSA,
} from "../provision/__fixtures__/own";
import { createTestPhaseDeps, ScriptedApprovalHandler, ScriptedRunner } from "../testing";
import {
  connectOwnServer,
  inspectOwnServer,
  OWN_SERVER_DAMAGED_HINT,
  ownServerFacts,
  ownServerLoginCheck,
  ownServerPublicAddress,
} from "./own-server";
import { sshArgs } from "./remote";
import {
  type OwnServerConnectionInput,
  readOwnServer,
  recordOwnServer,
  serverAddressesFile,
} from "./server-address";
import { hostKeyFingerprint, knownHostsName, scanHostKeys, writeKnownHost } from "./wait";

const OTHER = hostKeyBlob("ssh-ed25519", "someone-else");

describe("sshArgs for servers the user owns", () => {
  it("keeps the deploy user's arguments exactly as before", () => {
    expect(sshArgs({ host: "203.0.113.10", keyFile: "k", knownHostsFile: "kh" })).toEqual([
      "-i",
      "k",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=kh",
      "-o",
      "ConnectTimeout=10",
      "-p",
      "22",
      "deploy@203.0.113.10",
    ]);
  });

  it("uses the SSH agent without -i, another login and port, and never reuses a connection", () => {
    const args = sshArgs({
      host: LAN_IPV4,
      user: "alice",
      port: 2222,
      knownHostsFile: "kh",
      fresh: true,
      keepAliveSeconds: 15,
    });
    expect(args).not.toContain("-i");
    expect(args).not.toContain("IdentitiesOnly=yes");
    expect(args).toEqual(
      expect.arrayContaining([
        "ControlMaster=no",
        "ControlPath=none",
        "ServerAliveInterval=15",
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
      ]),
    );
    expect(args.slice(-3)).toEqual(["-p", "2222", `alice@${LAN_IPV4}`]);
  });
});

describe("host keys", () => {
  it("fingerprints a key like ssh-keygen -lf (SHA256, unpadded base64)", () => {
    const expected = createHash("sha256").update(Buffer.from(ED25519, "base64")).digest("base64");
    expect(hostKeyFingerprint(ED25519)).toBe(`SHA256:${expected.replace(/=+$/, "")}`);
    expect(hostKeyFingerprint(ED25519)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(hostKeyFingerprint(OTHER)).not.toBe(hostKeyFingerprint(ED25519));
  });

  it("names a server in known_hosts with its port unless it is 22", () => {
    expect(knownHostsName(OWN_IPV4)).toBe(OWN_IPV4);
    expect(knownHostsName(OWN_IPV4, 2222)).toBe(`[${OWN_IPV4}]:2222`);
    expect(knownHostsName("2001:db8::1", 2222)).toBe("[2001:db8::1]:2222");
  });

  it("scans the port the user gave and lists Ed25519 first", async () => {
    const runner = ownRunner([
      { type: "ssh-rsa", key: RSA },
      { type: "ssh-ed25519", key: ED25519 },
    ]);
    const keys = await scanHostKeys({ host: LAN_IPV4, port: 2222, runner });
    expect(keys.map((k) => k.type)).toEqual(["ssh-ed25519", "ssh-rsa"]);
    expect(keys[0]?.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(runner.calls[0]?.args).toEqual([
      "-T",
      "10",
      "-p",
      "2222",
      "-t",
      "ed25519,ecdsa,rsa",
      LAN_IPV4,
    ]);
  });

  it("replaces one server's entry in known_hosts and keeps the others", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "opscrew-kh-")), "known_hosts");
    await writeFile(file, `198.51.100.7 ssh-ed25519 ${OTHER}\n[${LAN_IPV4}]:2222 ssh-rsa ${RSA}\n`);
    const lines = await writeKnownHost(file, `[${LAN_IPV4}]:2222`, [
      { type: "ssh-ed25519", key: ED25519 },
    ]);
    expect(lines).toBe(`[${LAN_IPV4}]:2222 ssh-ed25519 ${ED25519}\n`);
    expect(await readFile(file, "utf8")).toBe(
      `198.51.100.7 ssh-ed25519 ${OTHER}\n[${LAN_IPV4}]:2222 ssh-ed25519 ${ED25519}\n`,
    );
  });
});

interface ConnectSetup {
  own?: OwnServerConnectionInput | null;
  interactive?: boolean;
  answer?: boolean;
  keys?: { type: string; key: string }[];
}

async function connectSetup(o: ConnectSetup = {}) {
  const runner = ownRunner(o.keys ?? [{ type: "ssh-ed25519", key: ED25519 }]);
  const handler = new ScriptedApprovalHandler(() => o.answer ?? true);
  const deps = await createTestPhaseDeps({
    runner,
    approvalHandler: handler,
    interactive: o.interactive ?? false,
  });
  deps.env.HOME = join(deps.paths.root, "home");
  if (o.own !== null) {
    await recordOwnServer(
      deps.paths,
      o.own ?? { host: OWN_IPV4, port: 22, user: "root", agent: true, reachable: true },
    );
  }
  return { deps, runner, handler };
}

describe("connectOwnServer", () => {
  it("asks to confirm the host key on the first connection, then pins it", async () => {
    const { deps, handler, runner } = await connectSetup({ interactive: true });
    const session = await connectOwnServer(deps);
    expect(handler.requests).toHaveLength(1);
    const request = handler.requests[0];
    expect(request?.kind).toBe("remote-exec");
    expect(request?.details).toContain(ED25519_FINGERPRINT);
    // The title is audited and names no address.
    expect(request?.title).not.toContain(OWN_IPV4);
    expect(session.pinned).toBe(true);
    expect(session.connection.hostKey).toBe(ED25519_FINGERPRINT);
    expect((await readOwnServer(deps.paths))?.hostKey).toBe(ED25519_FINGERPRINT);
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(
      `${OWN_IPV4} ssh-ed25519 ${ED25519}\n`,
    );

    // The admin shell: the recorded login, the agent (no -i), pinned key, a new connection.
    await session.remote.run("true");
    const call = runner.calls.find((c) => c.command === "ssh");
    expect(call?.args).toEqual(
      expect.arrayContaining([
        "StrictHostKeyChecking=yes",
        `UserKnownHostsFile=${deps.paths.files.knownHosts}`,
        "ControlMaster=no",
        "ControlPath=none",
        `root@${OWN_IPV4}`,
      ]),
    );
    expect(call?.args).not.toContain("-i");
  });

  it("changes nothing when the user does not confirm the host key", async () => {
    const { deps } = await connectSetup({ interactive: true, answer: false });
    await expect(connectOwnServer(deps)).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
    expect((await readOwnServer(deps.paths))?.hostKey).toBeUndefined();
    await expect(readFile(deps.paths.files.knownHosts, "utf8")).rejects.toThrow();
  });

  it("needs --host-key on the first connection when nobody can answer", async () => {
    const { deps, handler } = await connectSetup();
    const error = await connectOwnServer(deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("PHASE_PRECONDITION");
    expect((error as OpsCrewError).hint).toContain("--host-key");
    expect((error as OpsCrewError).hint).toContain("ssh-keygen -lf");
    expect(handler.requests).toHaveLength(0);
    expect((await readOwnServer(deps.paths))?.hostKey).toBeUndefined();
  });

  it("pins the key named with --host-key without asking", async () => {
    const { deps, handler } = await connectSetup();
    const session = await connectOwnServer(deps, { hostKey: ED25519_FINGERPRINT });
    expect(handler.requests).toHaveLength(0);
    expect(session.hostKey.key).toBe(ED25519);
    expect((await readOwnServer(deps.paths))?.hostKey).toBe(ED25519_FINGERPRINT);
  });

  it("pins the RSA key when that is the one named with --host-key", async () => {
    const { deps } = await connectSetup({
      keys: [
        { type: "ssh-ed25519", key: ED25519 },
        { type: "ssh-rsa", key: RSA },
      ],
    });
    const session = await connectOwnServer(deps, { hostKey: hostKeyFingerprint(RSA) });
    expect(session.hostKey.type).toBe("ssh-rsa");
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(
      `${OWN_IPV4} ssh-rsa ${RSA}\n`,
    );
  });

  it("refuses a --host-key the server does not present", async () => {
    const { deps } = await connectSetup();
    await expect(
      connectOwnServer(deps, { hostKey: hostKeyFingerprint(OTHER) }),
    ).rejects.toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((await readOwnServer(deps.paths))?.hostKey).toBeUndefined();
  });

  it("refuses a malformed --host-key", async () => {
    const { deps } = await connectSetup();
    await expect(connectOwnServer(deps, { hostKey: "MD5:aa:bb" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("connects without asking when the server presents the pinned key", async () => {
    const { deps, handler } = await connectSetup({
      own: {
        host: OWN_IPV4,
        port: 22,
        user: "root",
        agent: true,
        hostKey: ED25519_FINGERPRINT,
      },
    });
    const session = await connectOwnServer(deps);
    expect(session.pinned).toBe(false);
    expect(handler.requests).toHaveLength(0);
    // The known_hosts entry is written again (it may be missing on this computer).
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toContain(ED25519);
  });

  it("stops with a plain warning and changes nothing when the host key changed", async () => {
    const pinned = hostKeyFingerprint(OTHER);
    const { deps, handler } = await connectSetup({
      interactive: true,
      own: { host: OWN_IPV4, port: 22, user: "root", agent: true, hostKey: pinned },
    });
    const error = (await connectOwnServer(deps).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("changed since you confirmed it");
    expect(error.message).toContain(pinned);
    expect(error.message).toContain(ED25519_FINGERPRINT);
    expect(error.hint).toContain("intercepting");
    expect(handler.requests).toHaveLength(0);
    expect((await readOwnServer(deps.paths))?.hostKey).toBe(pinned);
    await expect(readFile(deps.paths.files.knownHosts, "utf8")).rejects.toThrow();
  });

  it("trusts a new key only when the user names it with --host-key", async () => {
    const { deps } = await connectSetup({
      own: {
        host: OWN_IPV4,
        port: 22,
        user: "root",
        agent: true,
        hostKey: hostKeyFingerprint(OTHER),
      },
    });
    const session = await connectOwnServer(deps, { hostKey: ED25519_FINGERPRINT });
    expect(session.pinned).toBe(true);
    expect((await readOwnServer(deps.paths))?.hostKey).toBe(ED25519_FINGERPRINT);
    expect(deps.reporter.text()).toContain("Trusting the new SSH host key");
  });

  it("says how to set up the login (never a token) when none is recorded", async () => {
    const { deps } = await connectSetup({ own: null });
    const error = (await connectOwnServer(deps).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain("opscrew interview");
    expect(`${error.message} ${error.hint}`).not.toMatch(/replace the token|create a new one/i);
  });

  it("never says to delete a damaged server.json", async () => {
    const { deps } = await connectSetup();
    await writeFile(serverAddressesFile(deps.paths), "{ not json");
    const error = (await connectOwnServer(deps).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("ARTIFACT_INVALID");
    expect(error.hint).toBe(OWN_SERVER_DAMAGED_HINT);
    expect(error.hint).not.toMatch(/\bdelete \.opscrew\/server\.json/i);
  });

  it("stops when the key file is not on this computer", async () => {
    const { deps } = await connectSetup({
      own: { host: OWN_IPV4, port: 22, user: "root", agent: false, keyPath: "~/.ssh/missing" },
    });
    await expect(connectOwnServer(deps)).rejects.toMatchObject({ code: "PHASE_PRECONDITION" });
  });

  it("uses the key file with -i (~ expanded) and the recorded port", async () => {
    const { deps, runner } = await connectSetup({
      own: {
        host: LAN_IPV4,
        port: 2222,
        user: "alice",
        agent: false,
        keyPath: "~/.ssh/id_ed25519",
      },
    });
    const key = await placeholderKey(deps.env.HOME as string);
    const session = await connectOwnServer(deps, { hostKey: ED25519_FINGERPRINT });
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(
      `[${LAN_IPV4}]:2222 ssh-ed25519 ${ED25519}\n`,
    );
    await session.remote.run("true");
    const call = runner.calls.find((c) => c.command === "ssh");
    expect(call?.args).toEqual(
      expect.arrayContaining(["-i", key, "IdentitiesOnly=yes", "-p", "2222", `alice@${LAN_IPV4}`]),
    );
  });

  it("says the server cannot be reached when it presents no key", async () => {
    const { deps } = await connectSetup({ keys: [] });
    await expect(connectOwnServer(deps)).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });
});

describe("ownServerLoginCheck", () => {
  it("opens NEW connections as deploy (deploy key) and as the admin login", async () => {
    const runner = new ScriptedRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const check = ownServerLoginCheck(
      { runner, env: {} },
      {
        connection: { host: OWN_IPV4, port: 2222, user: "root", agent: true, hostKey: "x" },
        knownHostsFile: "kh",
      },
      { deployKeyFile: "/home/u/.opscrew/deploy_key" },
    );
    expect(await check()).toBe(true);
    expect(runner.calls).toHaveLength(2);
    const [deploy, admin] = runner.calls;
    for (const call of [deploy, admin]) {
      expect(call?.args).toEqual(
        expect.arrayContaining(["ControlMaster=no", "ControlPath=none", "-p", "2222"]),
      );
      expect(call?.args.at(-1)).toBe("true");
    }
    expect(deploy?.args).toEqual(
      expect.arrayContaining(["-i", "/home/u/.opscrew/deploy_key", `deploy@${OWN_IPV4}`]),
    );
    expect(admin?.args).toContain(`root@${OWN_IPV4}`);
    expect(admin?.args).not.toContain("-i");
  });

  it("is false when either login fails", async () => {
    const runner = new ScriptedRunner((_command, args) => ({
      exitCode: args.includes(`root@${OWN_IPV4}`) ? 255 : 0,
      stdout: "",
      stderr: "",
    }));
    const check = ownServerLoginCheck(
      { runner, env: {} },
      {
        connection: { host: OWN_IPV4, port: 22, user: "root", agent: true, hostKey: "x" },
        knownHostsFile: "kh",
      },
      { deployKeyFile: "dk" },
    );
    expect(await check()).toBe(false);
  });
});

describe("inspection facts for design", () => {
  it("maps the host facts to design's OwnServerFacts", async () => {
    const facts = freshFacts();
    const inspected = await inspectOwnServer(
      { remote: { host: OWN_IPV4, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } },
      { inspect: async () => facts },
    );
    expect(inspected.facts).toBe(facts);
    expect(inspected.server).toEqual({
      arch: "amd64",
      vcpus: 2,
      memoryGb: 4,
      diskFreeGb: 40,
      os: "Ubuntu 24.04.3 LTS",
    });
  });

  it("refuses an architecture OpsCrew cannot build for", () => {
    expect(() => ownServerFacts(freshFacts({ arch: "armhf" }))).toThrow(/amd64 and arm64/);
  });
});

describe("ownServerPublicAddress", () => {
  it("prefers the recorded address, then a public address OpsCrew connects to, then inspection", () => {
    const facts = freshFacts({
      addresses: [
        { interface: "eth0", family: "ipv4", address: "198.51.100.30", public: true },
        { interface: "eth0", family: "ipv6", address: "2001:db8::30", public: true },
      ],
    });
    expect(ownServerPublicAddress({ host: LAN_IPV4, publicIpv4: OWN_IPV4 }, facts)).toEqual({
      ipv4: OWN_IPV4,
      ipv6: "2001:db8::30",
    });
    expect(ownServerPublicAddress({ host: OWN_IPV4 }, facts)?.ipv4).toBe(OWN_IPV4);
    expect(ownServerPublicAddress({ host: LAN_IPV4 }, facts)?.ipv4).toBe("198.51.100.30");
    expect(ownServerPublicAddress({ host: "server.example.com" }, facts)?.ipv4).toBe(
      "198.51.100.30",
    );
  });

  it("finds none behind a router", () => {
    const facts = freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    });
    expect(ownServerPublicAddress({ host: LAN_IPV4 }, facts)).toBeUndefined();
  });
});
