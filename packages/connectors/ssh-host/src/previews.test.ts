// Feature 022: the preview environment's host plan (T2206): its recipe, values, key and cleanup.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { canonicalJson, sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  cloudServer,
  DEPLOY_KEY,
  desiredFor,
  ed25519PublicKey,
  everythingButStdin,
  onlyStep,
  provision,
  rejection,
  SH_AVAILABLE,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { keyFingerprint } from "./addons";
import { checkKeyLine, previewCronLine, previewKeyLine } from "./constants";
import { hostPlanHash } from "./hash";
import { inspectHost, PREVIEWS_SNIPPET } from "./inspect";
import { parsePreviews } from "./parse";
import { planAddon, planHost } from "./plan";
import { buildScript } from "./shell";
import { stepScripts } from "./steps";
import type { HostPlan } from "./types";

const APP = "shop-preview";
const REPOSITORY = "acme/shop";
const DIR = `/srv/apps/${APP}`;

/** A stand-in for the preview command: `down <n>` removes the preview's folder and says so. */
const COMMAND = `#!/bin/sh
here=$(dirname "$0")
echo "$*" >> "$here/../../downs.log"
if [ "$1" = down ]; then rm -rf "$here/../../${APP}-pr-$2"; echo "opscrew-preview: removed $2"; fi
`;

/** A recipe as `renderPreviewRecipe` would render it (stand-in texts). */
const RECIPE = {
  "bin/opscrew-preview": COMMAND,
  "settings.env": `APP=${APP}\nCAP=3\nLIFETIME_DAYS=7\n`,
  "template/compose.yaml": "services:\n  web:\n    image: ghcr.io/acme/shop\n",
  [`template/edge/sites/${APP}-pr-@N@.caddy`]: "pr-@N@.shop.example.com {\n}\n",
};

/** The preview values, made at runtime. */
function previewValues(): string {
  return `API_KEY=${randomBytes(16).toString("hex")}\nMODE=preview\n`;
}

/** The previews plan of `APP`: on with `key` and the recipe, or off. */
function previewsPlan(
  options: {
    runAs?: "root" | "login";
    facts?: Parameters<typeof planAddon>[1]["facts"];
    key?: string;
    files?: Record<string, string>;
    valueNames?: string[];
    off?: boolean;
    secretsChanged?: boolean;
  } = {},
): HostPlan {
  const base = {
    app: APP,
    runAs: options.runAs ?? "root",
    repository: REPOSITORY,
    ...(options.facts === undefined ? {} : { facts: options.facts }),
    ...(options.secretsChanged === undefined ? {} : { secretsChanged: options.secretsChanged }),
  };
  return options.off
    ? planAddon("previews", { ...base, disable: {} })
    : planAddon("previews", {
        ...base,
        enable: {
          files: options.files ?? RECIPE,
          publicKey: options.key ?? ed25519PublicKey(),
          valueNames: options.valueNames ?? ["API_KEY", "MODE"],
        },
      });
}

/** A server the user owns with only the preview environment's app set up on it. */
async function previewServer(): Promise<FakeHost> {
  const fake = new FakeHost();
  await provision(fake, desiredFor(fake, { app: APP, hostnames: [] }));
  return fake;
}

/** A preview's folder on the fake server, as the preview command makes it. */
function addPreview(fake: FakeHost, n: number): void {
  fake.dirs.set(`${DIR}-pr-${n}`, { owner: "deploy", group: "deploy", mode: "750", entries: 3 });
}

describe("the preview key and the cron line", () => {
  it("are OpsCrew's restricted line and an hourly line at a minute from the app's name, never 0", () => {
    const key = ed25519PublicKey();
    expect(previewKeyLine(key, REPOSITORY, APP)).toBe(
      `restrict,command="/srv/apps/shop-preview/bin/opscrew-preview" ${key} opscrew-preview:acme/shop:shop-preview`,
    );
    expect(previewCronLine(APP)).toMatch(
      /^([1-9]|[1-5][0-9]) \* \* \* \* \/srv\/apps\/shop-preview\/bin\/opscrew-preview gc$/,
    );
    const minutes = new Set(
      Array.from({ length: 500 }, (_, i) => Number(previewCronLine(`app-${i}`).split(" ")[0])),
    );
    expect(Math.min(...minutes)).toBe(1);
    expect(Math.max(...minutes)).toBe(59);
  });
});

describe('planAddon("previews")', () => {
  it("is one destroying step with the recipe and the key's fingerprint, and the values' names only", () => {
    const key = ed25519PublicKey();
    const plan = previewsPlan({ key: `${key} laptop` });
    expect(plan.deleteData).toBe(true);
    const step = onlyStep(plan);
    expect(step).toMatchObject({ id: "previews", state: "change", scope: "app" });
    expect(step.params).toMatchObject({
      runAs: "root",
      repository: REPOSITORY,
      publicKey: key,
      valueNames: "API_KEY MODE",
      "file:bin/opscrew-preview": COMMAND,
      [`file:template/edge/sites/${APP}-pr-@N@.caddy`]:
        RECIPE[`template/edge/sites/${APP}-pr-@N@.caddy`],
    });
    expect(step.title).toContain(keyFingerprint(key));
    expect(step.title).toContain(REPOSITORY);
    expect(step.reason).toContain("API_KEY and MODE");
    expect(step.reason).toContain(`minute ${previewCronLine(APP).split(" ")[0]} of every hour`);
    expect(step.reason).toContain("cron installed first");
    expect(step.reason).toContain("never part of this plan");
    expect(onlyStep(previewsPlan({ runAs: "login" })).reason).not.toContain("cron installed");
  });

  it("refuses a recipe without the preview command, odd paths, reserved names and files over 64 KiB", () => {
    const { "bin/opscrew-preview": _, ...noCommand } = RECIPE;
    expect(() => previewsPlan({ files: noCommand })).toThrow(/bin\/opscrew-preview/);
    for (const path of ["../x", "template/../x", ".env", "template/.hidden", "a b", "values.env"]) {
      expect(() => previewsPlan({ files: { ...RECIPE, [path]: "x\n" } }), path).toThrow(
        /file name/,
      );
    }
    expect(() =>
      previewsPlan({ files: { ...RECIPE, "template/big.yaml": "x".repeat(64 * 1024 + 1) } }),
    ).toThrow(/file template\/big\.yaml/);
    expect(() => previewsPlan({ valueNames: ["A", "A"] })).toThrow(/settings are not valid/);
    expect(() => previewsPlan({ valueNames: ["NOT-A-NAME"] })).toThrow(/settings are not valid/);
  });

  it("needs the repository, and the facts to turn previews off", () => {
    expect(() =>
      planAddon("previews", {
        app: APP,
        runAs: "root",
        enable: { files: RECIPE, publicKey: ed25519PublicKey(), valueNames: [] },
      }),
    ).toThrow(/repository is not valid/);
    expect(() => previewsPlan({ off: true })).toThrow(/inspected facts/);
  });

  it("is refused on a server whose facts show another app", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const facts = await inspectHost(fake);
    expect(() => previewsPlan({ facts })).toThrow(
      /This server also holds "shop", and a preview server runs nothing but its previews/,
    );
    // A runner of another app counts too.
    const own = await previewServer();
    own.runners.set("blog-staging", {
      version: "2.338.0",
      registered: true,
      active: true,
      label: "opscrew-blog-staging",
      url: "https://github.com/acme/blog",
    });
    const ownFacts = await inspectHost(own);
    expect(() => previewsPlan({ facts: ownFacts })).toThrow(/"blog-staging"/);
  });

  it("is refused by the apply in a plan that does not delete data, before anything runs", async () => {
    const fake = await previewServer();
    const on = previewsPlan({ facts: await inspectHost(fake) });
    await applyApproved(fake, on, { secrets: { previewValues: previewValues() } });
    const off = previewsPlan({ facts: await inspectHost(fake), off: true });
    for (const plan of [on, off]) {
      expect(onlyStep(plan).state).toBe("change");
      const { deleteData: _, ...sneaky } = plan;
      fake.calls.length = 0;
      const refused = await rejection(
        applyApproved(fake, sneaky, { secrets: { previewValues: previewValues() } }),
      );
      expect(refused.code).toBe("INVALID_INPUT");
      expect(refused.message).toContain("deleteData");
      expect(fake.calls).toEqual([]);
    }
  });

  it("checks the preview values before anything is sent, and needs them", async () => {
    const fake = await previewServer();
    const plan = previewsPlan({ facts: await inspectHost(fake) });
    fake.calls.length = 0;
    for (const previewValues of ["not a line\n", "A=1\nA=2\n", `A=${"x".repeat(64 * 1024)}`]) {
      const refused = await rejection(applyApproved(fake, plan, { secrets: { previewValues } }));
      expect(refused.code).toBe("INVALID_INPUT");
      expect(refused.message).toContain("NAME=value");
    }
    const missing = await rejection(applyApproved(fake, plan));
    expect(missing.message).toContain("needs the preview values");
    expect(fake.calls).toEqual([]);
  });
});

describe("previews on a server the user owns", () => {
  it("installs cron as root, then the recipe, values, key and cron line as deploy; in place on the next plan", async () => {
    const fake = await previewServer();
    fake.cron = false;
    const key = ed25519PublicKey();
    const values = previewValues();
    const plan = previewsPlan({ facts: await inspectHost(fake), key });
    fake.calls.length = 0;
    const result = await applyApproved(fake, plan, { secrets: { previewValues: values } });
    expect(result).toEqual({ applied: ["previews"], skipped: [] });
    const calls = fake.calls.filter((call) => call.name.startsWith("previews"));
    expect(calls.map((call) => [call.name, call.asUser ?? "root"])).toEqual([
      ["previews.check", "deploy"],
      ["previews.cron.apply", "root"],
      ["previews.apply", "deploy"],
      ["previews.verify", "deploy"],
    ]);
    expect(fake.cron).toBe(true);
    // The values on stdin first (one line of base64), then the recipe's files.
    const input = calls.find((call) => call.name === "previews.apply")?.input ?? "";
    expect(input.split("\n")[0]).toBe(Buffer.from(values).toString("base64"));
    expect(fake.files.get(`${DIR}/values.env`)).toBe(values);
    expect(fake.files.get(`${DIR}/bin/opscrew-preview`)).toBe(COMMAND);
    expect(fake.users.get("deploy")?.keys).toContain(previewKeyLine(key, REPOSITORY, APP));
    expect(fake.crontab).toEqual([previewCronLine(APP)]);
    // No value in the plan, its hash input, the commands or the host record.
    const secret = values.split("\n")[0]?.split("=")[1] ?? "";
    expect(everythingButStdin(fake, plan)).not.toContain(secret);
    expect(canonicalJson(plan)).not.toContain(secret);

    // The facts show the recipe and keep the preview key apart from the deploy keys.
    const facts = await inspectHost(fake);
    expect(facts.previews).toEqual([
      {
        app: APP,
        files: Object.fromEntries(
          Object.entries(RECIPE).map(([path, text]) => [path, sha256Hex(text)]),
        ),
        values: true,
        cron: [previewCronLine(APP)],
        numbers: [],
      },
    ]);
    expect(facts.deployUser?.previewKeys).toEqual([previewKeyLine(key, REPOSITORY, APP)]);
    expect(facts.deployUser?.keys).not.toContain(previewKeyLine(key, REPOSITORY, APP));
    const same = previewsPlan({ facts, key });
    expect(onlyStep(same).state).toBe("in-place");
    expect(await applyApproved(fake, same)).toEqual({ applied: [], skipped: ["previews"] });

    // Changed values are a change, even with everything else in place.
    const rewrite = previewsPlan({ facts, key, secretsChanged: true });
    expect(onlyStep(rewrite)).toMatchObject({ state: "change", params: { rewrite: true } });
    expect(hostPlanHash(rewrite)).not.toBe(hostPlanHash(same));
    const next = previewValues();
    await applyApproved(fake, rewrite, { secrets: { previewValues: next } });
    expect(fake.files.get(`${DIR}/values.env`)).toBe(next);

    // A changed recipe, or another key, is a change too.
    const changed = { ...RECIPE, "settings.env": `APP=${APP}\nCAP=5\nLIFETIME_DAYS=7\n` };
    expect(onlyStep(previewsPlan({ facts, key, files: changed })).state).toBe("change");
    expect(onlyStep(previewsPlan({ facts, key: ed25519PublicKey() })).state).toBe("change");
  });

  it("is a change while the app has a key line not in OpsCrew's form, or a renamed repository's", async () => {
    const fake = await previewServer();
    const key = ed25519PublicKey();
    const install = async () =>
      applyApproved(fake, previewsPlan({ facts: await inspectHost(fake), key }), {
        secrets: { previewValues: previewValues() },
      });
    const state = async () => onlyStep(previewsPlan({ facts: await inspectHost(fake), key })).state;
    await install();
    expect(await state()).toBe("in-place");
    const deploy = fake.users.get("deploy");
    const line = previewKeyLine(key, REPOSITORY, APP);
    for (const extra of [
      `${ed25519PublicKey()} opscrew-preview:acme/shop:shop-preview`,
      `command="${DIR}/bin/opscrew-preview" ${ed25519PublicKey()} laptop`,
      previewKeyLine(ed25519PublicKey(), "acme/old-shop", APP),
    ]) {
      deploy?.keys.push(extra);
      expect(await state(), extra).toBe("change");
      await install();
      expect(deploy?.keys).toEqual([DEPLOY_KEY, line]);
      expect(await state()).toBe("in-place");
    }
  });

  it("redacts each preview value on its own in what the apply reports", async () => {
    const fake = await previewServer();
    const plan = previewsPlan({ facts: await inspectHost(fake) });
    const value = randomBytes(12).toString("hex");
    fake.failScripts.set("previews.apply", `the server printed ${value} back`);
    const refused = await rejection(
      applyApproved(fake, plan, { secrets: { previewValues: `API_KEY=${value}\nMODE=preview\n` } }),
    );
    expect(refused.message).toContain("the server printed");
    expect(refused.message).not.toContain(value);
  });

  it("keeps the preview key through the deploy-key step, which writes exactly the apps' deploy keys", async () => {
    const fake = await previewServer();
    const key = ed25519PublicKey();
    await applyApproved(
      fake,
      previewsPlan({ facts: await inspectHost(fake), key, valueNames: [] }),
      { secrets: { previewValues: "" } },
    );
    expect(fake.files.get(`${DIR}/values.env`)).toBe("");
    const desired = desiredFor(fake, { app: APP, hostnames: [] });
    const same = planHost(await inspectHost(fake), desired, "opscrew provision");
    expect(same.steps.find((step) => step.id === "deploy-key")?.state).toBe("in-place");
    const rotated = DEPLOY_KEY.replace("FAKEFAKEFAKE", "ROTATEDROTAT");
    await provision(fake, { ...desired, deploy: { user: "deploy", publicKey: rotated } });
    expect(fake.users.get("deploy")?.keys).toEqual([rotated, previewKeyLine(key, REPOSITORY, APP)]);
  });

  it("lists the previews; off, removes each one, then the recipe, key and cron line; repeatable", async () => {
    const fake = await previewServer();
    const key = ed25519PublicKey();
    await applyApproved(fake, previewsPlan({ facts: await inspectHost(fake), key }), {
      secrets: { previewValues: previewValues() },
    });
    addPreview(fake, 42);
    addPreview(fake, 7);
    fake.crontab?.unshift("0 3 * * * /usr/local/bin/backup");
    const check = checkKeyLine(ed25519PublicKey(), REPOSITORY);
    fake.users.get("deploy")?.keys.push(check);
    const facts = await inspectHost(fake);
    expect(facts.previews[0]?.numbers).toEqual([7, 42]);
    // A preview environment's own previews are no other app.
    expect(onlyStep(previewsPlan({ facts, key })).state).toBe("in-place");

    const off = previewsPlan({ facts, off: true });
    expect(off.deleteData).toBe(true);
    const step = onlyStep(off);
    expect(step.title).toBe(
      `Remove the previews of "${APP}" (pr-7 and pr-42) with their data, their recipe and values, the preview key of ${REPOSITORY} and the hourly cleanup`,
    );
    expect(step.params).toEqual({
      remove: true,
      runAs: "root",
      repository: REPOSITORY,
      numbers: "7 42",
    });
    expect((await applyApproved(fake, off)).applied).toEqual(["previews"]);
    expect(fake.previewDowns).toEqual([`${APP} 7`, `${APP} 42`]);
    expect([...fake.files.keys()].some((path) => path.startsWith(`${DIR}/`))).toBe(false);
    expect(fake.users.get("deploy")?.keys).toEqual([DEPLOY_KEY, check]);
    expect(fake.crontab).toEqual(["0 3 * * * /usr/local/bin/backup"]);

    const after = await inspectHost(fake);
    expect(after.previews).toEqual([]);
    const again = previewsPlan({ facts: after, off: true });
    expect(onlyStep(again)).toMatchObject({ state: "in-place", params: { numbers: "" } });
    expect(await applyApproved(fake, again)).toEqual({ applied: [], skipped: ["previews"] });
  });

  it("runs as the deploy login on a server OpsCrew created, with no root and no host record", async () => {
    const fake = cloudServer();
    fake.users.set("deploy", {
      uid: 1000,
      password: false,
      keys: [DEPLOY_KEY],
      groups: ["deploy"],
    });
    const plan = previewsPlan({ runAs: "login", facts: await inspectHost(fake) });
    fake.calls.length = 0;
    const result = await applyApproved(fake, plan, { secrets: { previewValues: previewValues() } });
    expect(result.applied).toEqual(["previews"]);
    expect(fake.names()).toEqual(["previews.check", "previews.apply", "previews.verify"]);
    expect(fake.calls.every((call) => !call.sudo && call.asUser === undefined)).toBe(true);
    expect(fake.files.has("/etc/opscrew/host.json")).toBe(false);
  });
});

describe.skipIf(!SH_AVAILABLE)("the previews step's scripts in a real shell", () => {
  const KEYS = "/home/deploy/.ssh/authorized_keys";

  /** A harness with the deploy user's home under its root, and a crontab kept in its state. */
  function harness(): ShellHarness {
    const h = new ShellHarness();
    h.stub("getent", `echo "deploy:x:1000:1000::${h.root}/home/deploy:/bin/sh"`, { log: false });
    h.stub("id", `case "$1" in -un) echo deploy ;; *) echo 1000 ;; esac`, { log: false });
    h.stub(
      "crontab",
      `case "$1" in
  -l) if [ -f "$S/crontab" ]; then cat "$S/crontab"; else echo "no crontab for deploy" >&2; exit 1; fi ;;
  -) cat > "$S/crontab" ;;
esac`,
    );
    // Git Bash keeps no Unix modes; elsewhere the real stat reads the mode chmod set.
    if (process.platform === "win32") h.stub("stat", "echo 600", { log: false });
    return h;
  }
  const scriptsOf = (plan: HostPlan) => stepScripts(plan, onlyStep(plan));
  /** Under the harness's root, as the scripts see a path there. */
  const rooted = (h: ShellHarness, text: string) => text.replaceAll("/srv/", `${h.root}/srv/`);
  const stdin = (values: string, plan: HostPlan) =>
    `${Buffer.from(values).toString("base64")}\n${scriptsOf(plan).payload ?? ""}`;

  it("writes the recipe, the values, the key line and the cron line, replacing only their own", () => {
    const key = ed25519PublicKey();
    const plan = previewsPlan({ runAs: "login", key });
    const scripts = scriptsOf(plan);
    const h = harness();
    try {
      const other = rooted(h, previewKeyLine(ed25519PublicKey(), REPOSITORY, "blog-preview"));
      const check = checkKeyLine(ed25519PublicKey(), REPOSITORY);
      // The app's line from before the repository was renamed, and a broken one with the comment.
      const renamed = rooted(h, previewKeyLine(ed25519PublicKey(), "acme/old-shop", APP));
      h.write(
        KEYS,
        `${DEPLOY_KEY}\n${ed25519PublicKey()} opscrew-preview:acme/shop:shop-preview\n${renamed}\n${other}\n${check}\n`,
      );
      h.write(
        "/state/crontab",
        `0 3 * * * backup\n7 * * * * ${rooted(h, DIR)}/bin/opscrew-preview gc\n`,
      );
      h.write(`${DIR}/template/old/stale.yaml`, "old\n");
      h.write(`${DIR}/previews.log`, "a line\n");
      expect(h.run(scripts.check).stdout).toContain("state=change");
      const values = previewValues();
      const applied = h.run(scripts.apply, stdin(values, plan));
      expect(applied.status, applied.stderr).toBe(0);
      for (const [path, text] of Object.entries(RECIPE))
        expect(h.read(`${DIR}/${path}`)).toBe(text);
      expect(h.read(`${DIR}/values.env`)).toBe(values);
      // Git Bash keeps no Unix modes.
      if (process.platform !== "win32") {
        const mode = (path: string) => statSync(h.native(`${DIR}/${path}`)).mode & 0o777;
        expect([mode("bin/opscrew-preview"), mode("settings.env"), mode("values.env")]).toEqual([
          0o755, 0o644, 0o600,
        ]);
      }
      expect(h.exists(`${DIR}/template/old`)).toBe(false);
      expect(h.read(`${DIR}/previews.log`)).toBe("a line\n");
      expect(h.read(KEYS)).toBe(
        `${DEPLOY_KEY}\n${other}\n${check}\n${rooted(h, previewKeyLine(key, REPOSITORY, APP))}\n`,
      );
      expect(h.read("/state/crontab")).toBe(
        `0 3 * * * backup\n${rooted(h, previewCronLine(APP))}\n`,
      );
      expect(h.run(scripts.verify).status).toBe(0);
      expect(h.run(scripts.check).stdout).toContain("state=in-place");
      // With new values the check never skips the step.
      const rewrite = scriptsOf(previewsPlan({ runAs: "login", key, secretsChanged: true }));
      expect(h.run(rewrite.check).stdout).toContain("state=change");
    } finally {
      h.dispose();
    }
  });

  it("changes nothing when the values supplied are not the ones the plan lists", () => {
    const plan = previewsPlan({ runAs: "login", valueNames: ["API_KEY", "MODE"] });
    const h = harness();
    try {
      for (const values of ["MODE=preview\nAPI_KEY=x\n", "API_KEY=x\n", ""]) {
        const refused = h.run(scriptsOf(plan).apply, stdin(values, plan));
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain("not the ones this plan lists");
        expect(h.exists(DIR)).toBe(false);
        expect(h.exists(KEYS)).toBe(false);
      }
      // No values at all: an empty values file.
      const none = previewsPlan({ runAs: "login", valueNames: [] });
      const applied = h.run(scriptsOf(none).apply, stdin("", none));
      expect(applied.status, applied.stderr).toBe(0);
      expect(h.read(`${DIR}/values.env`)).toBe("");
    } finally {
      h.dispose();
    }
  });

  it("off: runs down for each listed preview, then removes the key line, cron line and folder", async () => {
    const key = ed25519PublicKey();
    const on = previewsPlan({ runAs: "login", key });
    const fake = new FakeHost();
    fake.dirs.set(`${DIR}-pr-42`, { owner: "deploy", group: "deploy", mode: "750", entries: 1 });
    fake.dirs.set(`${DIR}-pr-7`, { owner: "deploy", group: "deploy", mode: "750", entries: 1 });
    for (const [path, text] of Object.entries(RECIPE)) fake.files.set(`${DIR}/${path}`, text);
    const off = previewsPlan({ runAs: "login", facts: await inspectHost(fake), off: true });
    expect(onlyStep(off).params.numbers).toBe("7 42");
    const h = harness();
    try {
      h.write(KEYS, `${DEPLOY_KEY}\n`);
      h.write("/state/crontab", "0 3 * * * backup\n");
      expect(h.run(scriptsOf(on).apply, stdin(previewValues(), on)).status).toBe(0);
      // A line of the app's from before the repository was renamed goes too.
      const renamed = rooted(h, previewKeyLine(ed25519PublicKey(), "acme/old-shop", APP));
      h.write(KEYS, `${h.read(KEYS)}${renamed}\n`);
      h.write(`/srv/apps/${APP}-pr-42/compose.yaml`, "x\n");
      h.write(`/srv/apps/${APP}-pr-7/compose.yaml`, "x\n");
      const removal = scriptsOf(off);
      expect(h.run(removal.check).stdout).toContain("state=change");
      const removed = h.run(removal.apply);
      expect(removed.status, removed.stderr).toBe(0);
      expect(h.read("/srv/apps/downs.log")).toBe("down 7\ndown 42\n");
      expect(h.exists(DIR)).toBe(false);
      expect(h.exists(`/srv/apps/${APP}-pr-42`)).toBe(false);
      expect(h.read(KEYS)).toBe(`${DEPLOY_KEY}\n`);
      expect(h.read("/state/crontab")).toBe("0 3 * * * backup\n");
      expect(h.run(removal.verify).status).toBe(0);
      // Repeatable: everything is gone, so the check finds it in place and the apply does nothing.
      expect(h.run(removal.check).stdout).toContain("state=in-place");
      expect(h.run(removal.apply).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("off: stops before removing any preview when one started after the plan was made", async () => {
    const on = previewsPlan({ runAs: "login" });
    const fake = new FakeHost();
    fake.dirs.set(`${DIR}-pr-42`, { owner: "deploy", group: "deploy", mode: "750", entries: 1 });
    for (const [path, text] of Object.entries(RECIPE)) fake.files.set(`${DIR}/${path}`, text);
    const removal = scriptsOf(
      previewsPlan({ runAs: "login", facts: await inspectHost(fake), off: true }),
    );
    const h = harness();
    try {
      h.write(KEYS, `${DEPLOY_KEY}\n`);
      expect(h.run(scriptsOf(on).apply, stdin(previewValues(), on)).status).toBe(0);
      h.write(`/srv/apps/${APP}-pr-42/compose.yaml`, "x\n");
      h.write(`/srv/apps/${APP}-pr-9/compose.yaml`, "x\n");
      const stopped = h.run(removal.apply);
      expect(stopped.status).not.toBe(0);
      expect(stopped.stderr).toContain(
        "A preview started after this plan was made (pr-9), so OpsCrew removed only the preview key and the cleanup. Make the plan again.",
      );
      // No new request can arrive, and nothing else went.
      expect(h.read(KEYS)).toBe(`${DEPLOY_KEY}\n`);
      expect(h.read("/state/crontab")).toBe("");
      expect(h.exists("/srv/apps/downs.log")).toBe(false);
      expect(h.exists(`/srv/apps/${APP}-pr-42/compose.yaml`)).toBe(true);
      expect(h.exists(`${DIR}/values.env`)).toBe(true);
      expect(h.run(removal.verify).status).not.toBe(0);
      expect(h.run(removal.check).stdout).toContain("state=change");
    } finally {
      h.dispose();
    }
  });

  it("off: stops when a preview can't be removed, with the command's last line", () => {
    const on = previewsPlan({
      runAs: "login",
      files: {
        ...RECIPE,
        "bin/opscrew-preview": "#!/bin/sh\necho 'opscrew-preview: busy 600'\nexit 6\n",
      },
    });
    const off: HostPlan = {
      ...on,
      steps: [
        {
          ...onlyStep(on),
          params: { remove: true, runAs: "login", repository: REPOSITORY, numbers: "3" },
        },
      ],
    };
    const h = harness();
    try {
      expect(h.run(scriptsOf(on).apply, stdin(previewValues(), on)).status).toBe(0);
      const failed = h.run(scriptsOf(off).apply);
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain(
        "could not remove the preview pr-3 (opscrew-preview: busy 600)",
      );
      expect(h.exists(`${DIR}/values.env`)).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("the deploy-key step keeps every preview key and check key", async () => {
    const fake = new FakeHost();
    const plan = planHost(await inspectHost(fake), desiredFor(fake), "opscrew provision");
    const step = plan.steps.find((item) => item.id === "deploy-key");
    if (step === undefined) throw new Error("no deploy-key step");
    const deployKey = stepScripts(plan, step);
    const check = checkKeyLine(ed25519PublicKey(), REPOSITORY);
    const h = harness();
    try {
      // The step's pattern names /srv/apps, which the harness moves under its root.
      const preview = rooted(h, previewKeyLine(ed25519PublicKey(), REPOSITORY, APP));
      h.write(KEYS, `ssh-ed25519 AAAAold old-key\n${preview}\n${check}\n`);
      expect(h.run(deployKey.apply).status).toBe(0);
      expect(h.read(KEYS)).toBe(`${DEPLOY_KEY}\n${preview}\n${check}\n`);
      expect(h.run(deployKey.verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("inspection's snippet lists each recipe's files, values, cron lines and previews", () => {
    const h = harness();
    try {
      for (const [path, text] of Object.entries(RECIPE)) h.write(`${DIR}/${path}`, text);
      h.write(`${DIR}/values.env`, "A=1\n");
      h.write(`${DIR}/previews.log`, "a line\n");
      h.write(`${DIR}/.lock`, "");
      h.write(`/srv/apps/${APP}-pr-42/compose.yaml`, "x\n");
      h.write(`/srv/apps/${APP}-pr-007/compose.yaml`, "x\n");
      h.write(`/srv/apps/${APP}-pr-x/compose.yaml`, "x\n");
      h.write("/srv/apps/shop/compose.yaml", "x\n");
      h.write("/state/crontab", `0 3 * * * backup\n${rooted(h, previewCronLine(APP))}\n`);
      const run = h.run(buildScript("previews.inspect", {}, PREVIEWS_SNIPPET, { tolerant: true }));
      expect(run.status, run.stderr).toBe(0);
      expect(parsePreviews(run.stdout.replaceAll(`${h.root}/srv/`, "/srv/"))).toEqual([
        {
          app: APP,
          files: Object.fromEntries(
            Object.entries(RECIPE).map(([path, text]) => [path, sha256Hex(text)]),
          ),
          values: true,
          cron: [previewCronLine(APP)],
          numbers: [42],
        },
      ]);
    } finally {
      h.dispose();
    }
  });
});
