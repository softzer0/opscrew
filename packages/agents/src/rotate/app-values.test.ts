// Feature 025 (T2509): the app's own secrets in a rotation: which a name takes, their new values,
// the previous value kept where the framework reads it, the drop, the app's settings with either
// side, and the plan's words (US4, FR-2507, research R8 and R9).
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { assembleAppEnv, dotenvLine } from "../shared/app-env";
import { generatedValuesFile } from "../shared/app-secrets";
import { createTestPhaseDeps, type TestPhaseDeps, testPlan } from "../testing";
import {
  appConsequence,
  appSecretLines,
  appSecretNames,
  appSuccessNote,
  dropPreviousNames,
  newAppValues,
  withAppEnv,
  withAppRecord,
} from "./app-values";
import { type RotationPlan, rotationHash } from "./plan";
import type { RotationValues } from "./values-pending";

const hex = () => randomBytes(32).toString("hex");
const laravelKey = () => `base64:${randomBytes(32).toString("base64")}`;

/** `shop` with Laravel's key, Better Auth's secret, a session secret and the cron jobs' secret. */
function plan(): DeployPlan {
  const base = testPlan({ deployed: true });
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      env: [
        ...base.app.env,
        { name: "APP_KEY", secret: true, source: "generated" },
        { name: "BETTER_AUTH_SECRET", secret: true, source: "generated" },
        { name: "CRON_SECRET", secret: true, source: "generated" },
      ],
    },
  });
}

/** An environment whose generated values hold `env`. */
async function keeping(env: Record<string, string>): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps({});
  await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
  await writeFile(generatedValuesFile(deps), `${JSON.stringify({ env })}\n`);
  return deps;
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("appSecretNames", () => {
  it("takes `app` as each generated secret kept here, `app:<NAME>` as one, and a kept previous value's drop", async () => {
    const p = plan();
    const deps = await keeping({
      SESSION_SECRET: hex(),
      APP_KEY: laravelKey(),
      CRON_SECRET: hex(),
      APP_PREVIOUS_KEYS: laravelKey(),
    });
    // BETTER_AUTH_SECRET is planned but not kept here (a value the user set is theirs).
    expect(await appSecretNames(deps, p, ["app"])).toEqual([
      "app:SESSION_SECRET",
      "app:APP_KEY",
      "app:CRON_SECRET",
    ]);
    expect(await appSecretNames(deps, p, ["app:CRON_SECRET"])).toEqual(["app:CRON_SECRET"]);
    expect(await appSecretNames(deps, p, ["app:APP_PREVIOUS_KEYS"])).toEqual([
      "app:APP_PREVIOUS_KEYS",
    ]);
    expect(await dropPreviousNames(deps, p)).toEqual(["app:APP_PREVIOUS_KEYS"]);

    for (const [names, said] of [
      [["app:BETTER_AUTH_SECRET"], "BETTER_AUTH_SECRET is no secret OpsCrew generated"],
      [["app:STRIPE_SECRET_KEY"], "STRIPE_SECRET_KEY is no secret OpsCrew generated"],
      [["app:BETTER_AUTH_SECRETS"], "keeps no previous value of BETTER_AUTH_SECRET"],
      [["app:APP_KEY", "app:APP_PREVIOUS_KEYS"], "can't be rotated and its previous values"],
    ] as const) {
      const error = await failure(appSecretNames(deps, p, names));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain(said);
      expect(error.message).toContain("Nothing was changed.");
    }
  });

  it("refuses `app` with no generated secret, and a drop with no previous value", async () => {
    const deps = await keeping({});
    expect((await failure(appSecretNames(deps, plan(), ["app"]))).message).toContain(
      "shop has no secret OpsCrew generated",
    );
    expect((await failure(dropPreviousNames(deps, plan()))).message).toContain("nothing to drop");
  });

  it("drops Better Auth's while either variable holds an older value, and not once both hold only the current one", async () => {
    const [one, two] = [hex(), hex()];
    for (const env of [
      { BETTER_AUTH_SECRET: one, BETTER_AUTH_SECRETS: `2:${two},1:${one}` },
      // Its versions dropped by hand, BETTER_AUTH_SECRET still the fallback's old value.
      { BETTER_AUTH_SECRET: one, BETTER_AUTH_SECRETS: `2:${two}` },
    ]) {
      expect(await dropPreviousNames(await keeping(env), plan())).toEqual([
        "app:BETTER_AUTH_SECRETS",
      ]);
    }
    for (const env of [
      { BETTER_AUTH_SECRET: two, BETTER_AUTH_SECRETS: `2:${two}` },
      // Never rotated: BETTER_AUTH_SECRET alone.
      { BETTER_AUTH_SECRET: one },
    ] as Record<string, string>[]) {
      const deps = await keeping(env);
      expect((await failure(dropPreviousNames(deps, plan()))).message).toContain("nothing to drop");
      expect(
        (await failure(appSecretNames(deps, plan(), ["app:BETTER_AUTH_SECRETS"]))).message,
      ).toContain("keeps no previous value of BETTER_AUTH_SECRET");
    }
  });
});

describe("rotationHash", () => {
  it("stays the same for services and device logins, and binds the app's name beside its secrets' values", async () => {
    const deps = await createTestPhaseDeps({ environment: "staging" });
    const p = plan();
    const input = (values: RotationValues): RotationPlan => ({
      services: [],
      values,
      runs: [],
      secrets: [],
    });
    // Fixed values, so this hash is the one before the app's secrets joined the plan (T2506).
    const services = input({
      names: ["db", "grant:laptop/cache"],
      services: { db: { password: { old: "a", new: "b" } } },
      grants: { "laptop/cache": { old: "c", new: "d" } },
    });
    expect(rotationHash(deps, p, services)).toBe(
      sha256Hex(
        canonicalJson({
          rotation: "services",
          environment: "staging",
          app: p.app.name,
          services: [],
          values: [
            {
              service: "db",
              secrets: [{ secret: "password", old: sha256Hex("a"), new: sha256Hex("b") }],
            },
          ],
          servers: [],
          secrets: [],
          grants: [{ grant: "laptop/cache", old: sha256Hex("c"), new: sha256Hex("d") }],
        }),
      ),
    );
    const app = input({
      names: ["app:SESSION_SECRET"],
      services: {},
      app: { SESSION_SECRET: { old: "e", new: "f" } },
    });
    const other = DeployPlanSchema.parse({ ...p, app: { ...p.app, name: "shop-two" } });
    expect(rotationHash(deps, p, app)).not.toBe(rotationHash(deps, other, app));
  });
});

describe("newAppValues", () => {
  it("keeps Laravel's old key first in APP_PREVIOUS_KEYS, and Better Auth's new secret first in BETTER_AUTH_SECRETS with BETTER_AUTH_SECRET as it is", async () => {
    const key = laravelKey();
    const earlier = laravelKey();
    const auth = hex();
    const deps = await keeping({
      APP_KEY: key,
      APP_PREVIOUS_KEYS: earlier,
      BETTER_AUTH_SECRET: auth,
    });
    const values = await newAppValues(deps, plan(), ["app:APP_KEY", "app:BETTER_AUTH_SECRET"]);
    const fresh = values.APP_KEY?.new as string;
    expect(values.APP_KEY?.old).toBe(key);
    expect(fresh).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
    expect(values.APP_PREVIOUS_KEYS).toEqual({ old: earlier, new: `${key},${earlier}` });
    // BETTER_AUTH_SECRET stays Better Auth's fallback for data from before the versioned envelope.
    expect(values.BETTER_AUTH_SECRET).toEqual({ old: auth, new: auth });
    const secrets = values.BETTER_AUTH_SECRETS?.new as string;
    const secret = secrets.split(",")[0]?.slice("2:".length) as string;
    expect(secret).not.toBe("");
    expect(secret).not.toBe(auth);
    expect(values.BETTER_AUTH_SECRETS).toEqual({ old: "", new: `2:${secret},1:${auth}` });

    // The next rotation's version follows the current one; BETTER_AUTH_SECRET stays the first.
    const next = await keeping({
      BETTER_AUTH_SECRET: auth,
      BETTER_AUTH_SECRETS: `2:${secret},1:${auth}`,
    });
    const again = await newAppValues(next, plan(), ["app:BETTER_AUTH_SECRET"]);
    expect(again.BETTER_AUTH_SECRET).toEqual({ old: auth, new: auth });
    const third = again.BETTER_AUTH_SECRETS?.new.split(",")[0]?.slice("3:".length) as string;
    expect(third).not.toBe(secret);
    expect(again.BETTER_AUTH_SECRETS?.new).toBe(`3:${third},2:${secret},1:${auth}`);
    // Every value is registered with the redactor.
    expect(deps.redactor.redact(`${fresh} ${secret} ${key}`)).not.toContain(fresh);
    expect(deps.redactor.redact(secret)).not.toContain(secret);
  });

  it("drops all but the current one: APP_PREVIOUS_KEYS unset, Better Auth's current version kept and BETTER_AUTH_SECRET its value", async () => {
    const earlier = laravelKey();
    const [one, two] = [hex(), hex()];
    const deps = await keeping({
      APP_PREVIOUS_KEYS: earlier,
      BETTER_AUTH_SECRET: one,
      BETTER_AUTH_SECRETS: `2:${two},1:${one}`,
    });
    const values = await newAppValues(deps, plan(), [
      "app:APP_PREVIOUS_KEYS",
      "app:BETTER_AUTH_SECRETS",
    ]);
    expect(values).toEqual({
      APP_PREVIOUS_KEYS: { old: earlier, new: "" },
      BETTER_AUTH_SECRETS: { old: `2:${two},1:${one}`, new: `2:${two}` },
      BETTER_AUTH_SECRET: { old: one, new: two },
    });
    // Dropping loses what the earlier values encrypted: the app's name is typed.
    const consequence = appConsequence(plan(), values);
    expect(consequence?.line).toBe(
      "What is still encrypted with the dropped previous values can no longer be read (app:APP_PREVIOUS_KEYS and app:BETTER_AUTH_SECRETS). To go ahead, type the app's name, shop.",
    );
    expect(consequence?.guard.confirmPhrase).toBe("shop");
    expect(appSecretLines(values)).toEqual([
      "app:APP_PREVIOUS_KEYS: the earlier values of APP_KEY are dropped; sessions, cookies and data still encrypted with them can no longer be read.",
      "app:BETTER_AUTH_SECRETS: the earlier values of BETTER_AUTH_SECRET are dropped; sessions, cookies and data still encrypted with them can no longer be read.",
    ]);
    expect(appSuccessNote(values)).toBe("");
    const kept = {
      APP_KEY: "k",
      APP_PREVIOUS_KEYS: earlier,
      BETTER_AUTH_SECRET: one,
      BETTER_AUTH_SECRETS: `2:${two},1:${one}`,
    };
    expect(withAppRecord(kept, values, "new")).toEqual({
      APP_KEY: "k",
      BETTER_AUTH_SECRET: two,
      BETTER_AUTH_SECRETS: `2:${two}`,
    });

    // Its versions already alone: the drop sets BETTER_AUTH_SECRET only.
    const fallback = await newAppValues(
      await keeping({ BETTER_AUTH_SECRET: one, BETTER_AUTH_SECRETS: `2:${two}` }),
      plan(),
      ["app:BETTER_AUTH_SECRETS"],
    );
    expect(fallback).toEqual({
      BETTER_AUTH_SECRETS: { old: `2:${two}`, new: `2:${two}` },
      BETTER_AUTH_SECRET: { old: one, new: two },
    });
    expect(appConsequence(plan(), fallback)?.line).toContain("(app:BETTER_AUTH_SECRETS)");
  });

  it("refuses a secret this computer keeps no value of", async () => {
    const error = await failure(newAppValues(await keeping({}), plan(), ["app:APP_KEY"]));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain("opscrew secrets restore");
  });
});

describe("the plan's words", () => {
  it("says first that users are logged out, and needs the app's name only then", async () => {
    const deps = await keeping({
      SESSION_SECRET: hex(),
      APP_KEY: laravelKey(),
      CRON_SECRET: hex(),
    });
    const seamless = await newAppValues(deps, plan(), ["app:APP_KEY", "app:CRON_SECRET"]);
    expect(appConsequence(plan(), seamless)).toBeUndefined();
    expect(appSecretLines(seamless)).toEqual([
      expect.stringMatching(
        /^app:APP_KEY: seamless: the new value is current, and the old one stays beside it in APP_PREVIOUS_KEYS.*--drop-previous/,
      ),
      "app:CRON_SECRET: seamless: the app and its cron jobs get the new value in the same switch.",
    ]);
    const logout = await newAppValues(deps, plan(), ["app:SESSION_SECRET"]);
    expect(appConsequence(plan(), logout)).toEqual({
      line: "Every user of shop is logged out, or the tokens it issued stop working (app:SESSION_SECRET). To go ahead, type the app's name, shop.",
      guard: { allowDestroy: true, confirmPhrase: "shop" },
    });
  });

  it("says first that Better Auth's users are logged out, and that its old secret stays for its data", async () => {
    const deps = await keeping({ APP_KEY: laravelKey(), BETTER_AUTH_SECRET: hex() });
    const values = await newAppValues(deps, plan(), ["app:APP_KEY", "app:BETTER_AUTH_SECRET"]);
    expect(appConsequence(plan(), values)).toEqual({
      line: "Every user of shop is logged out, or the tokens it issued stop working (app:BETTER_AUTH_SECRET). To go ahead, type the app's name, shop.",
      guard: { allowDestroy: true, confirmPhrase: "shop" },
    });
    expect(appSecretLines(values)).toEqual([
      expect.stringMatching(/^app:APP_KEY: seamless: /),
      "app:BETTER_AUTH_SECRET: every user of the app is logged out, as Better Auth checks sessions with the current secret only. The new secret is current in BETTER_AUTH_SECRETS and the old one stays there; BETTER_AUTH_SECRET, Better Auth's fallback for data from before its versions, stays as it is, so what they encrypted stays readable until `opscrew rotate app --drop-previous`.",
    ]);
    expect(appSuccessNote(values)).toBe(
      " The old value of APP_KEY and BETTER_AUTH_SECRET stays as the previous one (APP_PREVIOUS_KEYS and BETTER_AUTH_SECRETS) until `opscrew rotate app --drop-previous`.",
    );
  });
});

describe("withAppEnv and withAppRecord", () => {
  const key = laravelKey();
  const fresh = laravelKey();
  const values = {
    APP_KEY: { old: key, new: fresh },
    APP_PREVIOUS_KEYS: { old: "", new: key },
  };
  const before = [dotenvLine("APP_KEY", key), "APP_URL=https://shop.example", "ZED=1"].join("\n");

  it("replaces a value, adds a variable in its sorted place, and goes back to the old side", () => {
    const after = withAppEnv(`${before}\n`, values, "new");
    expect(after).toBe(
      `${[dotenvLine("APP_KEY", fresh), dotenvLine("APP_PREVIOUS_KEYS", key), "APP_URL=https://shop.example", "ZED=1"].join("\n")}\n`,
    );
    // A run again finds it done; an undo puts the old side back.
    expect(withAppEnv(after, values, "new")).toBe(after);
    expect(withAppEnv(after, values, "old")).toBe(`${before}\n`);
    expect(withAppRecord({ APP_KEY: key, ZED: "1" }, values, "new")).toEqual({
      APP_KEY: fresh,
      APP_PREVIOUS_KEYS: key,
      ZED: "1",
    });
    expect(withAppRecord({ APP_KEY: fresh, APP_PREVIOUS_KEYS: key }, values, "old")).toEqual({
      APP_KEY: key,
    });
  });

  it("refuses a variable that holds a value of the user's own", () => {
    const own = `${dotenvLine("APP_KEY", laravelKey())}\n`;
    for (const run of [
      () => withAppEnv(own, values, "new"),
      () => withAppRecord({ APP_KEY: "theirs" }, values, "new"),
    ]) {
      expect(run).toThrow(/hold APP_KEY in a way OpsCrew doesn't write it/);
    }
  });
});

describe("assembleAppEnv", () => {
  it("carries the previous values a rotation kept while OpsCrew generates the secret", async () => {
    const p = plan();
    const key = laravelKey();
    const earlier = laravelKey();
    const previous = {
      env: { SESSION_SECRET: hex(), APP_KEY: key, APP_PREVIOUS_KEYS: earlier, CRON_SECRET: hex() },
    };
    const assembled = await assembleAppEnv({
      plan: p,
      previous,
      dotenvText: `STRIPE_SECRET_KEY=${hex()}\nBETTER_AUTH_SECRET=${hex()}\n`,
    });
    expect(assembled.values.app.APP_PREVIOUS_KEYS).toBe(earlier);
    expect(assembled.appEnv).toContain(`${dotenvLine("APP_PREVIOUS_KEYS", earlier)}\n`);
    expect(assembled.generated.env?.APP_PREVIOUS_KEYS).toBe(earlier);
    // Better Auth's secret is the user's here: no previous value of OpsCrew's goes with it.
    expect(assembled.values.app.BETTER_AUTH_SECRETS).toBeUndefined();

    // A key the user sets is theirs: OpsCrew's previous keys are not carried with it.
    const theirs = await assembleAppEnv({
      plan: p,
      previous,
      dotenvText: `STRIPE_SECRET_KEY=${hex()}\nAPP_KEY=${laravelKey()}\nBETTER_AUTH_SECRET=${hex()}\n`,
    });
    expect(theirs.values.app.APP_PREVIOUS_KEYS).toBeUndefined();
    expect(theirs.generated.env?.APP_PREVIOUS_KEYS).toBeUndefined();
  });
});
