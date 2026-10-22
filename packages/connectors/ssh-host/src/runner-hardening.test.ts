/**
 * A runner machine's opt-in hardening (FR-1536): the server's SSH hardening (`harden.ssh`) and
 * OpsCrew's own nftables table for port 22 (`harden.firewall`), each on its own, with their
 * lockout refusals, turning one part off, and the machine's undo.
 */
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import { applyApproved, SHOP_REPOSITORY } from "./__fixtures__/helpers";
import { SSHD_DROP_IN } from "./constants";
import { hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planRunnerHost, planUndo } from "./plan";
import { SSH_FIREWALL_RULES, SSH_FIREWALL_UNIT, sshFirewallListing } from "./ssh-firewall";
import type { DesiredRunnerHost, HostPlan } from "./types";

const ADD = "opscrew runner host add home";
const REMOVE = "opscrew runner host remove home";
const FIREWALL = { sshFrom: ["198.51.100.0/24"] };

/** A machine the user owns, reached as "ana" with passwordless sudo from 198.51.100.20. */
function machine(): FakeHost {
  return new FakeHost({ login: "ana" });
}

async function machinePlan(
  fake: FakeHost,
  extra: Partial<DesiredRunnerHost> = {},
  command = ADD,
): Promise<HostPlan> {
  return planRunnerHost(
    await inspectHost(fake),
    { repositoryUrl: SHOP_REPOSITORY, runners: [], ...extra },
    command,
  );
}

const SSH = { harden: { ssh: true }, hostKeyType: "ssh-ed25519" } as const;

/** Each step as `[id, state]`. */
const outline = (plan: HostPlan) => plan.steps.map((step) => [step.id, step.state]);

describe("a runner machine without hardening", () => {
  it("has the plan it had before: no SSH or firewall step, with or without an empty harden", async () => {
    const fake = machine();
    const plain = await machinePlan(fake);
    expect(outline(plain)).toEqual([
      ["docker", "change"],
      ["deploy-user", "change"],
    ]);
    expect(hostPlanHash(await machinePlan(fake, { harden: {} }))).toBe(hostPlanHash(plain));
    // The address OpsCrew connects from is no part of a plan that does not need it.
    expect(JSON.stringify(plain)).not.toContain("198.51.100.20");
  });
});

describe("harden.ssh on a runner machine", () => {
  it("is the server's sshd step for OpsCrew's login, with root logins off and the automatic undo", async () => {
    const fake = machine();
    // Only ana may log in: on a runner machine the deploy user never logs in over SSH.
    fake.sshdBase.allowUsers = ["ana"];
    const plan = await machinePlan(fake, SSH);
    expect(plan.findings).toEqual([]);
    expect(outline(plan)).toEqual([
      ["docker", "change"],
      ["deploy-user", "change"],
      ["sshd", "change"],
    ]);
    const sshd = plan.steps[2];
    expect(sshd?.title).toBe(
      "Harden SSH: password logins off, root cannot log in over SSH, modern algorithms only",
    );
    expect(sshd?.params).toEqual({
      permitRootLogin: "no",
      disablePasswords: true,
      kbdInteractiveOff: true,
      moduliFile: true,
    });
    expect(sshd?.reason).toContain("unless a new login as ana works afterwards");

    let logins = 0;
    const result = await applyApproved(fake, plan, {
      command: ADD,
      verifyLogin: async () => {
        logins += 1;
        return true;
      },
    });
    expect(result.applied).toEqual(["docker", "deploy-user", "sshd"]);
    expect(logins).toBe(1);
    expect(fake.armedSeconds).toEqual([180]);
    expect(fake.effectiveSshd()).toMatchObject({
      permitrootlogin: "no",
      passwordauthentication: "no",
    });
    expect(outline(await machinePlan(fake, SSH))).toEqual([
      ["docker", "in-place"],
      ["deploy-user", "in-place"],
      ["sshd", "in-place"],
    ]);
  });

  it("keeps the ECDSA host key offered when that is the key the project pinned", async () => {
    const plan = await machinePlan(machine(), { ...SSH, hostKeyType: "ecdsa-sha2-nistp256" });
    expect(plan.steps.find((step) => step.id === "sshd")?.params.ecdsaHostKey).toBe(
      "ecdsa-sha2-nistp256",
    );
  });

  it("is refused while OpsCrew logs in as root, which root logins off would lock out", async () => {
    const fake = new FakeHost({ login: "root" });
    const plan = await machinePlan(fake, SSH);
    expect(plan.findings.map((finding) => finding.code)).toEqual(["ssh-hardening-root-login"]);
    expect(plan.findings[0]?.hint).toBe(
      `Connect as a user with passwordless sudo instead of root, or leave SSH hardening off, then run ${ADD} again.`,
    );
    expect(plan.steps.find((step) => step.id === "sshd")).toMatchObject({ state: "blocked" });
    await expect(applyApproved(fake, plan, { command: ADD })).rejects.toThrow(
      "OpsCrew cannot change this server yet",
    );
    expect(fake.files.has(SSHD_DROP_IN)).toBe(false);
  });

  it("is refused while a login has a password and no SSH key, which no passwords would lock out", async () => {
    const fake = machine();
    const ana = fake.users.get("ana");
    if (ana) ana.keys = [];
    const plan = await machinePlan(fake, SSH);
    expect(plan.findings.map((finding) => finding.code)).toEqual(["password-users-without-keys"]);
    expect(plan.findings[0]?.message).toContain("ana logs in with a password and has no SSH key");
    expect(plan.steps.find((step) => step.id === "sshd")).toMatchObject({ state: "blocked" });
    // A runner machine has no choice to keep password logins: the hint offers none.
    expect(plan.findings[0]?.hint).toBe(
      `Give each of them an SSH key first, or leave SSH hardening off for this machine, then run ${ADD} again.`,
    );
  });

  it("needs the pinned host key's algorithm and flock", async () => {
    const facts = await inspectHost(machine());
    expect(() =>
      planRunnerHost(
        facts,
        { repositoryUrl: SHOP_REPOSITORY, runners: [], harden: { ssh: true } },
        ADD,
      ),
    ).toThrow(
      "The runner machine's settings are not valid (hostKeyType: is needed to harden SSH).",
    );
    const fake = machine();
    fake.flock = false;
    expect((await machinePlan(fake, SSH)).findings.map((finding) => finding.code)).toEqual([
      "no-flock",
    ]);
  });
});

describe("harden.firewall on a runner machine", () => {
  it("adds OpsCrew's own table for port 22, applied from an address the sources let in", async () => {
    const fake = machine();
    const plan = await machinePlan(fake, {
      harden: { firewall: { sshFrom: ["2001:DB8:0:0::/32", "198.51.100.0/24", "203.0.113.7/32"] } },
    });
    expect(plan.findings).toEqual([]);
    const step = plan.steps.find((item) => item.id === "ssh-firewall");
    expect(step).toMatchObject({
      state: "change",
      scope: "shared",
      title: "SSH firewall: port 22 only from 198.51.100.0/24, 203.0.113.7 and 2001:db8::/32",
      params: {
        sources: "198.51.100.0/24 203.0.113.7 2001:db8::/32",
        ports: "22",
        from: "198.51.100.20",
      },
    });
    expect(step?.reason).toContain("OpsCrew applies it from 198.51.100.20");
    expect(step?.reason).toContain("No other port, rule, table or default policy changes");

    const result = await applyApproved(fake, plan, { command: ADD });
    expect(result.applied).toEqual(["docker", "deploy-user", "ssh-firewall"]);
    expect(fake.sshFirewall).toEqual({
      table: sshFirewallListing({
        sources: ["198.51.100.0/24", "203.0.113.7", "2001:db8::/32"],
        ports: [22],
      }),
      enabled: true,
    });
    expect(fake.files.get(SSH_FIREWALL_RULES)).toContain(
      "\t\tip6 saddr 2001:db8::/32 tcp dport 22 accept\n\t\ttcp dport 22 drop\n",
    );
    // No ufw, no firewalld, no SSH settings: only OpsCrew's table.
    expect(fake.ufwActive).toBe(false);
    expect(fake.ufwRules).toEqual([]);
    expect(fake.files.has(SSHD_DROP_IN)).toBe(false);
    // The same sources in another order: in place, and the address is no longer part of it.
    const again = await machinePlan(fake, {
      harden: { firewall: { sshFrom: ["203.0.113.7", "2001:db8::/32", "198.51.100.0/24"] } },
    });
    expect(again.steps.find((item) => item.id === "ssh-firewall")).toMatchObject({
      state: "in-place",
      params: { sources: "198.51.100.0/24 203.0.113.7 2001:db8::/32", ports: "22" },
    });
    // New sources replace the table.
    const changed = await machinePlan(fake, {
      harden: { firewall: { sshFrom: ["198.51.100.20"] } },
    });
    expect(changed.steps.find((item) => item.id === "ssh-firewall")?.state).toBe("change");
  });

  it("is refused when the sources leave out the address OpsCrew connects from", async () => {
    const fake = machine();
    const plan = await machinePlan(fake, { harden: { firewall: { sshFrom: ["203.0.113.0/24"] } } });
    expect(plan.findings).toEqual([
      {
        code: "ssh-firewall-locks-out",
        message:
          "OpsCrew connects to this machine from 198.51.100.20, which is not among the sources the SSH firewall would let in (203.0.113.0/24), so it would lock OpsCrew out.",
        hint: `Add 198.51.100.20 or a network that holds it to the SSH sources, then run ${ADD} again.`,
      },
    ]);
    expect(plan.steps.find((step) => step.id === "ssh-firewall")?.state).toBe("blocked");
    await expect(applyApproved(fake, plan, { command: ADD })).rejects.toThrow(
      "OpsCrew cannot change this server yet",
    );
    expect(fake.sshFirewall.table).toBeNull();
  });

  it("is refused when OpsCrew's own address is unknown, or without nft", async () => {
    const unknown = machine();
    unknown.sshClient = null;
    expect(
      (await machinePlan(unknown, { harden: { firewall: FIREWALL } })).findings.map((f) => f.code),
    ).toEqual(["ssh-client-unknown"]);
    const bare = machine();
    bare.nftInstalled = false;
    const plan = await machinePlan(bare, { harden: { firewall: FIREWALL } });
    expect(plan.findings.map((finding) => finding.message)).toEqual([
      "This machine has no nft command (from the nftables package), which OpsCrew's SSH firewall needs.",
    ]);
    expect(plan.steps.find((step) => step.id === "ssh-firewall")?.state).toBe("blocked");
  });

  it("changes nothing when OpsCrew connects from another address at apply than when planned", async () => {
    const fake = machine();
    const plan = await machinePlan(fake, { harden: { firewall: FIREWALL } });
    fake.sshClient = { address: "198.51.100.77", port: 22 };
    await expect(applyApproved(fake, plan, { command: ADD })).rejects.toThrow(
      "OpsCrew now connects from 198.51.100.77, not from 198.51.100.20 as when the plan was made, so it did not turn the SSH firewall on.",
    );
    expect(fake.sshFirewall).toEqual({ table: null, enabled: false });
    expect(fake.files.has(SSH_FIREWALL_RULES)).toBe(false);
  });

  it("restricts the ports sshd listens on, and the one OpsCrew's connection reaches", async () => {
    const fake = machine();
    fake.sshdBase.port = [2222];
    fake.sshClient = { address: "198.51.100.20", port: 2222 };
    const plan = await machinePlan(fake, { harden: { firewall: FIREWALL } });
    expect(plan.steps.find((step) => step.id === "ssh-firewall")).toMatchObject({
      state: "change",
      title: "SSH firewall: port 2222 only from 198.51.100.0/24",
      params: { ports: "2222" },
    });
    await applyApproved(fake, plan, { command: ADD });
    expect(fake.files.get(SSH_FIREWALL_RULES)).toContain(
      "\t\tip saddr 198.51.100.0/24 tcp dport 2222 accept\n\t\ttcp dport 2222 drop\n",
    );

    // ListenAddress ports win over Port; a port systemd's ssh.socket serves is added.
    const facts = await inspectHost(machine());
    if (facts.sshd === null) throw new Error("no sshd facts");
    const listening = {
      ...facts,
      sshd: { ...facts.sshd, ports: [22], listenPorts: [2200] },
      sshClient: { address: "198.51.100.20", port: 2300 },
    };
    const step = planRunnerHost(
      listening,
      { repositoryUrl: SHOP_REPOSITORY, runners: [], harden: { firewall: FIREWALL } },
      ADD,
    ).steps.find((item) => item.id === "ssh-firewall");
    expect(step).toMatchObject({
      title: "SSH firewall: ports 2200 and 2300 only from 198.51.100.0/24",
      params: { ports: "2200 2300" },
    });
  });

  it("is refused when sshd's settings cannot be read: there is no guess at port 22", async () => {
    const facts = { ...(await inspectHost(machine())), sshd: null };
    const plan = planRunnerHost(
      facts,
      { repositoryUrl: SHOP_REPOSITORY, runners: [], harden: { firewall: FIREWALL } },
      ADD,
    );
    expect(plan.findings.map((finding) => finding.code)).toEqual(["ssh-ports-unknown"]);
    expect(plan.steps.find((step) => step.id === "ssh-firewall")).toMatchObject({
      state: "blocked",
      params: { sources: "198.51.100.0/24" },
    });
  });

  it("is applied under the automatic undo: without a working new login the table goes again", async () => {
    const fake = machine();
    const plan = await machinePlan(fake, { harden: { firewall: FIREWALL } });
    await expect(
      applyApproved(fake, plan, { command: ADD, verifyLogin: async () => false }),
    ).rejects.toThrow(
      "New SSH logins did not work after turning on OpsCrew's SSH firewall, so OpsCrew put the previous SSH firewall settings back.",
    );
    expect(fake.armedSeconds).toEqual([180]);
    expect(fake.sshFirewall).toEqual({ table: null, enabled: false });
    expect(fake.files.has(SSH_FIREWALL_RULES)).toBe(false);
    expect(fake.files.has(SSH_FIREWALL_UNIT)).toBe(false);

    // Over a firewall OpsCrew put there before, the earlier rules come back.
    await applyApproved(fake, await machinePlan(fake, { harden: { firewall: FIREWALL } }), {
      command: ADD,
    });
    const before = { rules: fake.files.get(SSH_FIREWALL_RULES), firewall: { ...fake.sshFirewall } };
    const wider = await machinePlan(fake, {
      harden: { firewall: { sshFrom: ["198.51.100.0/24", "203.0.113.0/24"] } },
    });
    await expect(
      applyApproved(fake, wider, { command: ADD, verifyLogin: async () => false }),
    ).rejects.toThrow("put the previous SSH firewall settings back");
    expect(fake.files.get(SSH_FIREWALL_RULES)).toBe(before.rules);
    expect(fake.sshFirewall).toEqual(before.firewall);
  });

  it("is a change while an automatic undo from an interrupted run still waits", async () => {
    const fake = machine();
    await applyApproved(fake, await machinePlan(fake, { harden: { firewall: FIREWALL } }), {
      command: ADD,
    });
    fake.timers.set("ssh-firewall", () => fake.timers.delete("ssh-firewall"));
    const plan = await machinePlan(fake, { harden: { firewall: FIREWALL } });
    expect(plan.steps.find((step) => step.id === "ssh-firewall")?.state).toBe("change");
    fake.flock = false;
    expect(
      (await machinePlan(fake, { harden: { firewall: FIREWALL } })).findings.map((f) => f.code),
    ).toEqual(["no-flock"]);
  });

  it.each([
    "shop.example.com",
    "0.0.0.0/0",
    "::ffff:198.51.100.20",
    "198.51.100.0/33",
    "2001:db8::1::2",
  ])("refuses %s as an SSH source", async (source) => {
    const facts = await inspectHost(machine());
    expect(() =>
      planRunnerHost(
        facts,
        {
          repositoryUrl: SHOP_REPOSITORY,
          runners: [],
          harden: { firewall: { sshFrom: [source] } },
        },
        ADD,
      ),
    ).toThrow(
      "The runner machine's settings are not valid (harden.firewall.sshFrom.0: must be an IPv4 or IPv6 address or network such as 203.0.113.7, 198.51.100.0/24 or 2001:db8::/32).",
    );
  });
});

describe("turning a part of a runner machine's hardening off", () => {
  async function hardened(fake: FakeHost) {
    const plan = await machinePlan(fake, { ...SSH, harden: { ssh: true, firewall: FIREWALL } });
    await applyApproved(fake, plan, { command: ADD });
  }

  it("removes only that part: the SSH settings first, then OpsCrew's table", async () => {
    const fake = machine();
    await hardened(fake);
    const table = fake.sshFirewall.table;

    const noSsh = await machinePlan(fake, { harden: { firewall: FIREWALL } });
    expect(outline(noSsh)).toEqual([
      ["docker", "in-place"],
      ["deploy-user", "in-place"],
      ["sshd", "change"],
      ["ssh-firewall", "in-place"],
    ]);
    expect(noSsh.steps[2]).toMatchObject({
      title:
        "Remove OpsCrew's SSH settings file (10-opscrew.conf) and its moduli file (moduli.opscrew)",
      params: { remove: true },
    });
    const armed = fake.armedSeconds.length;
    expect((await applyApproved(fake, noSsh, { command: ADD })).applied).toEqual(["sshd"]);
    // The SSH settings go back under the automatic undo, as they came.
    expect(fake.armedSeconds.length).toBe(armed + 1);
    expect(fake.files.has(SSHD_DROP_IN)).toBe(false);
    expect(fake.sshFirewall.table).toBe(table);

    const none = await machinePlan(fake);
    expect(outline(none)).toEqual([
      ["docker", "in-place"],
      ["deploy-user", "in-place"],
      ["ssh-firewall", "change"],
    ]);
    expect(none.steps[2]).toMatchObject({
      title: "Remove OpsCrew's SSH firewall (its nftables table inet opscrew)",
      params: { remove: true },
    });
    expect((await applyApproved(fake, none, { command: ADD })).applied).toEqual(["ssh-firewall"]);
    expect(fake.sshFirewall).toEqual({ table: null, enabled: false });
    expect(fake.files.has(SSH_FIREWALL_RULES)).toBe(false);
    expect(fake.files.has(SSH_FIREWALL_UNIT)).toBe(false);

    // Nothing of the hardening is left, so the plan is the plain one again.
    expect(outline(await machinePlan(fake))).toEqual([
      ["docker", "in-place"],
      ["deploy-user", "in-place"],
    ]);
  });

  it("leaves the hardening alone in a plan that only removes runners", async () => {
    const fake = machine();
    await hardened(fake);
    const plan = await machinePlan(fake, { runners: [{ app: "shop-staging" }] });
    expect(plan.steps.map((step) => step.id)).toEqual([]);
  });
});

describe("a hardened runner machine's undo", () => {
  it("deletes OpsCrew's table and puts the SSH settings from before back", async () => {
    const fake = machine();
    fake.files.set(SSHD_DROP_IN, "PermitRootLogin prohibit-password\n");
    const plan = await machinePlan(fake, { ...SSH, harden: { ssh: true, firewall: FIREWALL } });
    await applyApproved(fake, plan, { command: ADD });
    const undo = planUndo(await inspectHost(fake), { repositoryUrl: SHOP_REPOSITORY }, REMOVE);
    expect(outline(undo)).toEqual([
      ["ssh-firewall", "change"],
      ["sshd", "change"],
      ["deploy-user", "change"],
      ["docker", "in-place"],
      ["app-record", "change"],
    ]);
    expect(undo.steps[1]?.title).toBe(
      "Put back the SSH settings file that was there before OpsCrew, and remove OpsCrew's moduli file (moduli.opscrew)",
    );
    await applyApproved(fake, undo, { command: REMOVE });
    expect(fake.sshFirewall).toEqual({ table: null, enabled: false });
    expect(fake.files.has(SSH_FIREWALL_RULES)).toBe(false);
    expect(fake.files.get(SSHD_DROP_IN)).toBe("PermitRootLogin prohibit-password\n");
  });
});
