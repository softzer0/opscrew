// Feature 017: the scheduled check's key and the Beszel and Grafana Alloy add-ons (T1706).
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  ALLOY_FILES,
  addonSecrets,
  applyApproved,
  BESZEL_AGENT_FILES,
  BESZEL_HUB,
  BESZEL_HUB_FILES,
  cloudServer,
  DEPLOY_KEY,
  desiredFor,
  ed25519PublicKey,
  provision,
  SHOP_PROJECT,
  SHOP_REPOSITORY,
  TUNNEL_COMPOSE,
  TUNNEL_ID,
  tunnelToken,
} from "./__fixtures__/helpers";
import { keyFingerprint } from "./addons";
import { applyHostPlan } from "./apply";
import { checkKeyLine } from "./constants";
import { hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planAddon, planHost, planTeardown } from "./plan";
import type { HostPlan } from "./types";

const BESZEL_DIR = "/srv/opscrew/addons/beszel";
const ALLOY_DIR = "/srv/opscrew/addons/alloy";
const HUB = BESZEL_HUB;

async function rejection(
  promise: Promise<unknown>,
): Promise<Error & { code?: string; hint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string; hint?: string };
  }
  throw new Error("expected a rejection");
}

/** A server the user owns with "shop" set up on it. */
async function ownServer(): Promise<FakeHost> {
  const fake = new FakeHost();
  await provision(fake);
  return fake;
}

/** A second app, "blog", on the same server. */
async function addBlog(fake: FakeHost): Promise<void> {
  await provision(
    fake,
    desiredFor(fake, {
      app: "blog",
      projectId: "blog-1",
      hostnames: ["blog.example.com"],
      deploy: { user: "deploy", publicKey: DEPLOY_KEY.replace("opscrew-deploy", "blog-deploy") },
    }),
  );
}

function hostRecord(fake: FakeHost): { addons?: Record<string, string> } {
  return JSON.parse(fake.files.get("/etc/opscrew/host.json") ?? "{}");
}

/** Every text of the plan and of the commands that ran (stdin aside), and the host record. */
function everythingButStdin(fake: FakeHost, plan: HostPlan): string {
  return [
    JSON.stringify(plan),
    ...fake.calls.map((call) => call.command),
    fake.files.get("/etc/opscrew/host.json") ?? "",
  ].join("\n");
}

/** The test project's repository, as the check key's comment names it. */
const REPOSITORY = "acme/shop";

/** The check key plan of `REPOSITORY` (or another repository) on a server. */
function checkKeyPlan(
  runAs: "root" | "login",
  change: { publicKey: string } | "off",
  repository = REPOSITORY,
) {
  return change === "off"
    ? planAddon("check-key", { app: "shop", runAs, repository, disable: {} })
    : planAddon("check-key", { app: "shop", runAs, repository, enable: change });
}

describe("check-key", () => {
  it("adds the restricted line as the deploy user, shows only the key's fingerprint, and re-applies as a no-op", async () => {
    const fake = await ownServer();
    const check = ed25519PublicKey();
    const plan = checkKeyPlan("root", { publicKey: `${check} a-comment` });
    expect(plan.steps.map((step) => step.id)).toEqual(["check-key"]);
    const [step] = plan.steps;
    expect(step?.title).toContain(keyFingerprint(check));
    expect(step?.title).toContain(REPOSITORY);
    expect(`${step?.title} ${step?.reason}`).not.toContain(check.split(" ")[1]);
    expect(JSON.stringify(plan)).not.toContain("PRIVATE KEY");

    const result = await applyApproved(fake, plan);
    expect(result.applied).toEqual(["check-key"]);
    const line = `restrict,command="df -P -B1 /" ${check} opscrew-check:acme/shop`;
    expect(checkKeyLine(check, REPOSITORY)).toBe(line);
    expect(fake.users.get("deploy")?.keys).toEqual([DEPLOY_KEY, line]);
    const calls = fake.calls.filter((call) => call.name.startsWith("check-key"));
    expect(calls.map((call) => call.name)).toEqual([
      "check-key.check",
      "check-key.apply",
      "check-key.verify",
    ]);
    expect(calls.every((call) => call.asUser === "deploy")).toBe(true);

    const again = await applyApproved(fake, plan);
    expect(again).toEqual({ applied: [], skipped: ["check-key"] });
  });

  it("replaces only the line with its repository's comment; another repository's key stays", async () => {
    const fake = await ownServer();
    const deploy = fake.users.get("deploy");
    const other = checkKeyLine(ed25519PublicKey(), "acme/blog");
    deploy?.keys.push(`${ed25519PublicKey()} opscrew-check:acme/shop`, other);
    const check = ed25519PublicKey();
    await applyApproved(fake, checkKeyPlan("root", { publicKey: check }));
    expect(deploy?.keys).toEqual([DEPLOY_KEY, other, checkKeyLine(check, REPOSITORY)]);
    await applyApproved(fake, checkKeyPlan("root", "off"));
    expect(deploy?.keys).toEqual([DEPLOY_KEY, other]);
  });

  it("survives the deploy-key step, which writes exactly the apps' deploy keys", async () => {
    const fake = await ownServer();
    const check = ed25519PublicKey();
    const other = checkKeyLine(ed25519PublicKey(), "acme/blog");
    fake.users.get("deploy")?.keys.push(other);
    await applyApproved(fake, checkKeyPlan("root", { publicKey: check }));
    // Inspection keeps the check keys apart, so the deploy keys stay in place.
    const facts = await inspectHost(fake);
    expect(facts.deployUser).toMatchObject({
      keys: [DEPLOY_KEY],
      checkKeys: ["acme/blog", "acme/shop"],
    });
    const same = planHost(facts, desiredFor(fake), "opscrew provision");
    expect(same.steps.find((step) => step.id === "deploy-key")?.state).toBe("in-place");
    // A rotated deploy key rewrites the file, and every check key stays.
    const rotated = DEPLOY_KEY.replace("FAKEFAKEFAKE", "ROTATEDROTAT");
    await provision(fake, desiredFor(fake, { deploy: { user: "deploy", publicKey: rotated } }));
    expect(fake.users.get("deploy")?.keys).toEqual([
      rotated,
      other,
      checkKeyLine(check, REPOSITORY),
    ]);
  });

  it("is removed alone by its undo, and by the last app's teardown (its own repository's only)", async () => {
    const fake = await ownServer();
    const on = checkKeyPlan("root", { publicKey: ed25519PublicKey() });
    await applyApproved(fake, on);
    expect((await applyApproved(fake, checkKeyPlan("root", "off"))).applied).toEqual(["check-key"]);
    expect(fake.users.get("deploy")?.keys).toEqual([DEPLOY_KEY]);

    await applyApproved(fake, on);
    const other = checkKeyLine(ed25519PublicKey(), "acme/blog");
    fake.users.get("deploy")?.keys.push(other);
    const teardown = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    expect(teardown.steps.filter((step) => step.id === "check-key")).toHaveLength(1);
    await applyApproved(fake, teardown, { command: "opscrew destroy" });
    expect(fake.users.get("deploy")?.keys).toEqual([DEPLOY_KEY, other]);
  });

  it("runs as the deploy login on a server OpsCrew created", async () => {
    const fake = cloudServer();
    fake.users.set("deploy", {
      uid: 1000,
      password: false,
      keys: [DEPLOY_KEY],
      groups: ["deploy"],
    });
    const plan = checkKeyPlan("login", { publicKey: ed25519PublicKey() });
    expect((await applyApproved(fake, plan)).applied).toEqual(["check-key"]);
    expect(fake.calls.every((call) => !call.sudo && call.asUser === undefined)).toBe(true);
    expect(fake.files.has("/etc/opscrew/host.json")).toBe(false);
  });

  it("needs the repository as owner/repo", () => {
    for (const repository of [undefined, "acme", "acme/shop/x", "-acme/shop"]) {
      expect(() =>
        planAddon("check-key", {
          app: "shop",
          runAs: "root",
          ...(repository === undefined ? {} : { repository }),
          enable: { publicKey: ed25519PublicKey() },
        }),
      ).toThrow(/repository is not valid/);
    }
  });
});

describe("beszel", () => {
  it("hub mode: writes the files, the secrets and the hub's key, starts it, and records the app", async () => {
    const fake = await ownServer();
    const { secrets } = addonSecrets();
    const plan = planAddon("beszel", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: HUB,
    });
    expect(plan.steps.map((step) => step.id)).toEqual(["beszel"]);
    const result = await applyApproved(fake, plan, { secrets });
    expect(result.applied).toEqual(["beszel"]);
    expect(fake.names().filter((name) => name.startsWith("beszel"))).toEqual([
      "beszel.check",
      "beszel.apply",
      "beszel.verify",
    ]);

    const file = (name: string) => fake.files.get(`${BESZEL_DIR}/${name}`);
    expect(file("compose.yaml")).toBe(BESZEL_HUB_FILES["compose.yaml"]);
    expect(file("Caddyfile")).toBe(BESZEL_HUB_FILES.Caddyfile);
    expect(file("config.yml")).toContain(`token: "${secrets.beszelToken}"`);
    expect(file("hub.env")).toBe(
      `USER_EMAIL=ops@example.com\nUSER_PASSWORD=${secrets.beszelPassword}\n`,
    );
    expect(file("agent.env")).toBe(`TOKEN=${secrets.beszelToken}\nKEY=${HUB.hubKey}\n`);
    expect(file("data/id_ed25519")).toBe(secrets.beszelHubKey);
    const uid = fake.users.get("deploy")?.uid;
    expect(file(".env")).toBe(`OPSCREW_DEPLOY_UID=${uid}\nOPSCREW_DEPLOY_GID=${uid}\n`);
    expect(fake.madeDirs.has(`${BESZEL_DIR}/data`)).toBe(true);
    expect(fake.madeDirs.has(`${BESZEL_DIR}/agent_data`)).toBe(true);
    expect(hostRecord(fake).addons).toEqual({ beszel: "shop" });

    // The secrets went on stdin only, in order, the hub's key as base64.
    const apply = fake.calls.find((call) => call.name === "beszel.apply");
    expect(apply?.input).toBe(
      `${[
        secrets.beszelPassword,
        secrets.beszelToken,
        Buffer.from(secrets.beszelHubKey).toString("base64"),
      ].join("\n")}\n`,
    );
    const seen = everythingButStdin(fake, plan);
    for (const value of Object.values(secrets)) expect(seen).not.toContain(value);
    expect(seen).not.toContain(Buffer.from(secrets.beszelHubKey).toString("base64"));
  });

  it("re-applying changes nothing", async () => {
    const fake = await ownServer();
    const { secrets } = addonSecrets();
    const plan = planAddon("beszel", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: HUB,
    });
    await applyApproved(fake, plan, { secrets });
    const again = await applyApproved(fake, plan, { secrets });
    expect(again).toEqual({ applied: [], skipped: ["beszel"] });
    expect(fake.addonUps.get("opscrew-beszel")).toBe(1);
    expect(fake.calls.filter((call) => call.name === "beszel.apply")).toHaveLength(1);
  });

  it("agent mode on a server OpsCrew created: the deploy login, the token only, no host record", async () => {
    const fake = cloudServer();
    const { secrets } = addonSecrets();
    const plan = planAddon("beszel", {
      app: "shop",
      runAs: "login",
      enable: { mode: "agent", files: BESZEL_AGENT_FILES },
    });
    const result = await applyApproved(fake, plan, {
      secrets: { beszelToken: secrets.beszelToken },
    });
    expect(result.applied).toEqual(["beszel"]);
    const dir = "/home/deploy/opscrew/addons/beszel";
    expect(fake.files.get(`${dir}/agent.env`)).toBe(`TOKEN=${secrets.beszelToken}\n`);
    expect(fake.files.has(`${dir}/hub.env`)).toBe(false);
    expect(fake.madeDirs.has(`${dir}/data`)).toBe(false);
    expect(fake.calls.every((call) => !call.sudo)).toBe(true);
    expect(fake.files.has("/etc/opscrew/host.json")).toBe(false);

    // Off: the agent keeps no history, so its removal deletes no data (no typed name); the hub's
    // removal without keepData does.
    const off = planAddon("beszel", { app: "shop", runAs: "login", disable: { mode: "agent" } });
    expect(off.deleteData).toBeUndefined();
    expect(off.steps[0]?.title).toBe("Remove Beszel's agent");
    expect((await applyApproved(fake, off)).applied).toEqual(["beszel"]);
    expect(fake.files.has(`${dir}/agent.env`)).toBe(false);
    const hubOff = planAddon("beszel", { app: "shop", runAs: "login", disable: { mode: "hub" } });
    expect(hubOff.deleteData).toBe(true);
    expect(planAddon("beszel", { app: "shop", runAs: "login", disable: {} }).deleteData).toBe(true);
  });

  it("runs the tunnel connector of its subdomain first on a server OpsCrew created, and removes it", async () => {
    const fake = cloudServer();
    const { secrets } = addonSecrets();
    const connectorDir = "/home/deploy/opscrew/cloudflared";
    const plan = planAddon("beszel", {
      app: "shop",
      runAs: "login",
      enable: HUB,
      connector: {
        dir: connectorDir,
        compose: TUNNEL_COMPOSE,
        tunnelId: TUNNEL_ID,
        needsToken: true,
      },
    });
    expect(plan.steps.map((step) => step.id)).toEqual(["tunnel-connector", "beszel"]);
    expect(plan.steps[0]?.title).toContain("Beszel's subdomain");
    const token = tunnelToken();
    const result = await applyApproved(fake, plan, { secrets: { ...secrets, tunnelToken: token } });
    expect(result.applied).toEqual(["tunnel-connector", "beszel"]);
    expect(fake.calls.every((call) => !call.sudo)).toBe(true);
    expect(fake.files.get(`${connectorDir}/tunnel.env`)).toBe(`TUNNEL_TOKEN=${token}\n`);
    expect(JSON.stringify(plan)).not.toContain(token);

    const off = planAddon("beszel", {
      app: "shop",
      runAs: "login",
      disable: { keepData: true },
      connector: { dir: connectorDir, remove: true },
    });
    expect(off.steps.map((step) => step.id)).toEqual(["tunnel-connector", "beszel"]);
    const removed = await applyApproved(fake, off);
    expect(removed.applied).toEqual(["tunnel-connector", "beszel"]);
    expect(fake.files.has(`${connectorDir}/tunnel.env`)).toBe(false);
  });

  it("turned off with keepData keeps only its history; without, everything goes", async () => {
    const fake = await ownServer();
    const { secrets } = addonSecrets();
    await applyApproved(
      fake,
      planAddon("beszel", {
        app: "shop",
        runAs: "root",
        facts: await inspectHost(fake),
        enable: HUB,
      }),
      { secrets },
    );
    const keep = planAddon("beszel", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      disable: { keepData: true },
    });
    expect(keep.deleteData).toBeUndefined();
    expect(keep.steps[0]?.title).toContain("its history in /srv/opscrew/addons/beszel/data stays");
    expect((await applyApproved(fake, keep)).applied).toEqual(["beszel"]);
    const left = [...fake.files.keys()].filter((path) => path.startsWith(`${BESZEL_DIR}/`));
    expect(left).toEqual([`${BESZEL_DIR}/data/id_ed25519`]);
    expect(fake.containers.some((container) => container.project === "opscrew-beszel")).toBe(false);
    expect(fake.volumes.has("opscrew-beszel")).toBe(false);
    // The kept history is still the app's.
    expect(hostRecord(fake).addons).toEqual({ beszel: "shop" });
    expect((await inspectHost(fake)).addons.beszel).toMatchObject({
      installed: false,
      secretFile: true,
    });

    const gone = planAddon("beszel", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      disable: {},
    });
    // Deleting the history is a destroying plan: allowDestroy and the typed app name.
    expect(gone.deleteData).toBe(true);
    await applyApproved(fake, gone);
    expect(hostRecord(fake).addons).toEqual({});
    expect([...fake.files.keys()].some((path) => path.startsWith(`${BESZEL_DIR}/`))).toBe(false);
    expect(fake.madeDirs.size).toBe(0);
  });

  it("is refused for another app on the server, naming the app that has it, at plan and at apply time", async () => {
    const fake = await ownServer();
    await addBlog(fake);
    const before = await inspectHost(fake);
    const { secrets } = addonSecrets();
    // Planned for "blog" before "shop" turned it on: the apply refuses it.
    const late = planAddon("beszel", { app: "blog", runAs: "root", facts: before, enable: HUB });
    await applyApproved(
      fake,
      planAddon("beszel", { app: "shop", runAs: "root", facts: before, enable: HUB }),
      { secrets },
    );
    const now = await inspectHost(fake);
    for (const options of [{ enable: HUB }, { disable: { keepData: true } }]) {
      let error: (Error & { code?: string; hint?: string }) | undefined;
      try {
        planAddon("beszel", { app: "blog", runAs: "root", facts: now, ...options });
      } catch (caught) {
        error = caught as Error & { code?: string; hint?: string };
      }
      expect(error?.code).toBe("PHASE_PRECONDITION");
      expect(error?.message).toContain('for the app "shop"');
      expect(error?.hint).toContain('in the project of "shop"');
    }
    fake.calls.length = 0;
    const refused = await rejection(applyApproved(fake, late, { secrets }));
    expect(refused.message).toContain('for the app "shop"');
    expect(fake.names().some((name) => name.startsWith("beszel"))).toBe(false);
    // Alloy is another add-on: "blog" may turn it on.
    const alloy = planAddon("alloy", {
      app: "blog",
      runAs: "root",
      facts: now,
      enable: { files: ALLOY_FILES },
    });
    await applyApproved(fake, alloy, { secrets: { grafanaCloudToken: secrets.grafanaCloudToken } });
    expect(hostRecord(fake).addons).toEqual({ beszel: "shop", alloy: "blog" });
  });

  it("is recorded before its setup runs, and stays recorded when a setup or a removal fails", async () => {
    const fake = await ownServer();
    const { secrets } = addonSecrets();
    const on = planAddon("beszel", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: HUB,
    });
    fake.failScripts.set("beszel.apply", "Beszel did not start (docker compose up failed).");
    await rejection(applyApproved(fake, on, { secrets }));
    expect(hostRecord(fake).addons).toEqual({ beszel: "shop" });
    fake.failScripts.clear();
    await applyApproved(fake, on, { secrets });

    const off = planAddon("beszel", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      disable: {},
    });
    fake.failScripts.set("beszel.remove.apply", "Docker is not running.");
    await rejection(applyApproved(fake, off));
    expect(hostRecord(fake).addons).toEqual({ beszel: "shop" });
    fake.failScripts.clear();
    await applyApproved(fake, off);
    expect(hostRecord(fake).addons).toEqual({});
  });

  it("left by an app that is gone: another app may only turn it off, and the hint says so", async () => {
    const fake = await ownServer();
    await addBlog(fake);
    const { secrets } = addonSecrets();
    await applyApproved(
      fake,
      planAddon("beszel", {
        app: "shop",
        runAs: "root",
        facts: await inspectHost(fake),
        enable: HUB,
      }),
      { secrets },
    );
    // "shop" goes with its data kept: Beszel's history stays, still recorded as its.
    await applyApproved(
      fake,
      planTeardown(
        await inspectHost(fake),
        { deleteData: false, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
        "opscrew destroy",
      ),
      { command: "opscrew destroy" },
    );
    const facts = await inspectHost(fake);
    let refused: (Error & { hint?: string }) | undefined;
    try {
      planAddon("beszel", { app: "blog", runAs: "root", facts, enable: HUB });
    } catch (error) {
      refused = error as Error & { hint?: string };
    }
    expect(refused?.message).toContain('for the app "shop"');
    expect(refused?.hint).toContain('"shop" is no longer set up on this server');
    expect(refused?.hint).toContain("opscrew addon disable beszel` in this project");

    const off = planAddon("beszel", { app: "blog", runAs: "root", facts, disable: {} });
    await applyApproved(fake, off);
    expect(hostRecord(fake).addons).toEqual({});
    const on = planAddon("beszel", {
      app: "blog",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: HUB,
    });
    await applyApproved(fake, on, { secrets });
    expect(hostRecord(fake).addons).toEqual({ beszel: "blog" });
  });

  it("goes with the app that turned it on: a teardown keeps its history unless it deletes the data", async () => {
    const fake = await ownServer();
    await addBlog(fake);
    const { secrets } = addonSecrets();
    await applyApproved(
      fake,
      planAddon("beszel", {
        app: "shop",
        runAs: "root",
        facts: await inspectHost(fake),
        enable: HUB,
      }),
      { secrets },
    );
    const teardown = (app: string, deleteData: boolean) =>
      inspectHost(fake).then((facts) =>
        planTeardown(
          facts,
          {
            deleteData,
            app,
            projectId: app === "shop" ? SHOP_PROJECT : "blog-1",
            repositoryUrl: SHOP_REPOSITORY,
          },
          "opscrew destroy",
        ),
      );
    // Another app's teardown leaves it alone.
    expect((await teardown("blog", true)).steps.map((step) => step.id)).not.toContain("beszel");
    const kept = await teardown("shop", false);
    expect(kept.steps.find((step) => step.id === "beszel")?.params).toEqual({
      remove: true,
      runAs: "root",
      keepData: true,
    });
    await applyApproved(fake, kept, { command: "opscrew destroy" });
    expect([...fake.files.keys()].filter((path) => path.startsWith(`${BESZEL_DIR}/`))).toEqual([
      `${BESZEL_DIR}/data/id_ed25519`,
    ]);
    expect(hostRecord(fake).addons).toEqual({ beszel: "shop" });
    // With the data, the kept history goes too.
    const removed = await teardown("shop", true);
    expect(removed.steps.find((step) => step.id === "beszel")?.params).toMatchObject({
      keepData: false,
    });
    await applyApproved(fake, removed, { command: "opscrew destroy" });
    expect(fake.madeDirs.size).toBe(0);
    expect(hostRecord(fake).addons).toEqual({});
  });
});

describe("the add-ons' secrets", () => {
  it("are checked by name before anything is sent, and never shown", async () => {
    const fake = await ownServer();
    const { secrets } = addonSecrets();
    const plan = planAddon("beszel", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: HUB,
    });
    fake.calls.length = 0;
    const missing = await rejection(
      applyApproved(fake, plan, { secrets: { ...secrets, beszelHubKey: undefined } }),
    );
    expect(missing.message).toBe(
      "Applying this plan needs Beszel's hub key, and none was supplied.",
    );
    const notEd25519 = await rejection(
      applyApproved(fake, plan, { secrets: { ...secrets, beszelHubKey: "not a key at all" } }),
    );
    expect(notEd25519.message).toContain("unencrypted OpenSSH private key");
    const badToken = await rejection(
      applyApproved(fake, plan, { secrets: { ...secrets, beszelToken: "short" } }),
    );
    expect(badToken.code).toBe("INVALID_INPUT");
    expect(fake.calls).toEqual([]);
    for (const error of [missing, notEd25519, badToken]) {
      for (const value of Object.values(secrets)) expect(error.message).not.toContain(value);
    }
  });

  it("refuses a plan that is not the approved one", async () => {
    const fake = await ownServer();
    const plan = planAddon("alloy", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: { files: ALLOY_FILES },
    });
    const error = await rejection(
      applyHostPlan(fake, plan, {
        approvedHash: hostPlanHash({ ...plan, app: "blog" }),
        command: "opscrew addon enable grafana-cloud",
        verifyLogin: async () => true,
      }),
    );
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
  });
});

describe("planAddon input", () => {
  const options = { app: "shop", runAs: "login" } as const;

  it("refuses files the step writes itself, odd names, files over the Compose text cap, and a config.yml without the token placeholder", () => {
    const files = (extra: Record<string, string>) => ({ ...BESZEL_HUB_FILES, ...extra });
    for (const extra of <Record<string, string>[]>[
      { "hub.env": "USER_PASSWORD=x\n" },
      { "../escape": "x" },
      { Caddyfile: "x".repeat(16 * 1024 + 1) },
      { "config.yml": "systems: []\n" },
    ]) {
      expect(() =>
        planAddon("beszel", { ...options, enable: { ...HUB, files: files(extra) } }),
      ).toThrow(/not valid|invalid parameters/);
    }
    const { "compose.yaml": _, ...noCompose } = ALLOY_FILES;
    expect(() => planAddon("alloy", { ...options, enable: { files: noCompose } })).toThrow(
      /compose\.yaml/,
    );
  });

  it("needs the server's facts on a server the user owns, keeps data only for Beszel, and takes one of on or off", () => {
    expect(() =>
      planAddon("alloy", { app: "shop", runAs: "root", enable: { files: ALLOY_FILES } }),
    ).toThrow(/inspected facts/);
    // The hub's public key is a plain input, checked only for its shape.
    for (const hubKey of ["ssh-rsa AAAAB3Nza", `${HUB.hubKey} hub@home`]) {
      expect(() => planAddon("beszel", { ...options, enable: { ...HUB, hubKey } })).toThrow(
        /hubKey: must be the hub's public key/,
      );
    }
    expect(() => planAddon("alloy", { ...options, disable: { keepData: true } })).toThrow(
      /Only Beszel/,
    );
    expect(() => planAddon("check-key", { ...options })).toThrow(/either on or off/);
    expect(() =>
      planAddon("check-key", { ...options, enable: { publicKey: "-----BEGIN PRIVATE KEY-----" } }),
    ).toThrow(/not valid/);
  });
});

describe("alloy", () => {
  it("writes its token, a never-matching masking file when there is none, and removes everything when off", async () => {
    const fake = await ownServer();
    const { secrets } = addonSecrets();
    const plan = planAddon("alloy", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: { files: ALLOY_FILES },
    });
    const result = await applyApproved(fake, plan, {
      secrets: { grafanaCloudToken: secrets.grafanaCloudToken },
    });
    expect(result.applied).toEqual(["alloy"]);
    expect(fake.files.get(`${ALLOY_DIR}/grafana_cloud_credential`)).toBe(secrets.grafanaCloudToken);
    expect(fake.files.get(`${ALLOY_DIR}/config.alloy`)).toBe(ALLOY_FILES["config.alloy"]);
    expect(fake.files.get("/srv/apps/shop/mask.re")).toBe("[^\\s\\S]");
    expect(fake.madeDirs.has(`${ALLOY_DIR}/data`)).toBe(true);
    expect(hostRecord(fake).addons).toEqual({ alloy: "shop" });
    expect(everythingButStdin(fake, plan)).not.toContain(secrets.grafanaCloudToken);
    expect(fake.calls.find((call) => call.name === "alloy.apply")?.input).toBe(
      `${secrets.grafanaCloudToken}\n`,
    );

    const off = planAddon("alloy", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      disable: {},
    });
    // Its storage is a buffer, not the user's data: no typed confirmation.
    expect(off.deleteData).toBeUndefined();
    await applyApproved(fake, off);
    expect([...fake.files.keys()].some((path) => path.startsWith(`${ALLOY_DIR}/`))).toBe(false);
    expect(fake.files.has("/srv/apps/shop/mask.re")).toBe(false);
    expect(fake.volumes.has("opscrew-alloy")).toBe(false);
    expect(hostRecord(fake).addons).toEqual({});
  });

  it("keeps a masking file the deploy job wrote", async () => {
    const fake = await ownServer();
    fake.files.set("/srv/apps/shop/mask.re", "the deploy job's pattern");
    const { secrets } = addonSecrets();
    await applyApproved(
      fake,
      planAddon("alloy", {
        app: "shop",
        runAs: "root",
        facts: await inspectHost(fake),
        enable: { files: ALLOY_FILES },
      }),
      { secrets: { grafanaCloudToken: secrets.grafanaCloudToken } },
    );
    expect(fake.files.get("/srv/apps/shop/mask.re")).toBe("the deploy job's pattern");
  });
});
