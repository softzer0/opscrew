// Feature 025 (T2506): a rotation's values, kept beside the old ones until it is done (FR-2512).
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { exists } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, type PlanService } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { assembleAppEnv } from "../shared/app-env";
import { generatedValuesFile } from "../shared/app-secrets";
import { stagingPlan } from "../snapshot/__fixtures__/world";
import { createTestPhaseDeps, type TestPhaseDeps } from "../testing";
import { readCredentialsRecord, recordRotation } from "./record";
import { completePendingRotation, newRotationValues, serviceValues, swapAppEnv } from "./values";
import {
  dropPendingRotation,
  keepPendingRotation,
  type PendingRotation,
  pendingRotationFile,
  readPendingRotation,
} from "./values-pending";

/** A value made at run time, as OpsCrew makes one. */
const value = (bytes = 32) => randomBytes(bytes).toString("hex");

/** PostgreSQL `db` and Garage `files` (its key and RPC secret), the app on one server. */
function plan(): DeployPlan {
  const base = stagingPlan([
    { kind: "postgres", name: "db" },
    { kind: "garage", name: "files" },
  ]);
  return DeployPlanSchema.parse({
    ...base,
    storage: {
      objectStorage: {
        provider: "garage",
        bucket: "shop-uploads",
        region: "garage",
        expected: { storageGb: 10, egressGbPerMonth: 50 },
        price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
      },
    },
  });
}

/** The generated values provision keeps, with values of other kinds beside the services'. */
const KEPT = {
  dbPassword: value(),
  env: { SESSION_SECRET: value() },
  services: {
    files: { "rpc-secret": value(), "key-id": `GK${value(12)}`, "secret-key": value() },
  },
  grants: { "laptop/cache": value() },
  monitoring: { grafanaAdminPassword: value(16) },
  generations: { db: 1 },
};

async function withValues(values: object = KEPT): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps({ environment: "staging" });
  await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
  await writeFile(generatedValuesFile(deps), `${JSON.stringify(values)}\n`);
  return deps;
}

const services = (p: DeployPlan, ...names: string[]) =>
  p.services.filter((s) => names.includes(s.name)) as PlanService[];

/** `values` as the environment's unfinished rotation, planned under `hash`. */
const planned = (values: Awaited<ReturnType<typeof newRotationValues>>): PendingRotation => ({
  ...values,
  hash: "a".repeat(64),
  step: "planned",
});

describe("the pending rotation", () => {
  it("makes a new value of each secret in the catalog's format beside the old, kept in a file of its own", async () => {
    const deps = await withValues();
    const p = plan();
    const values = await newRotationValues(deps, services(p, "db", "files"));
    expect(values.names).toEqual(["db", "files"]);
    expect(values.services.db?.password?.old).toBe(KEPT.dbPassword);
    expect(values.services.db?.password?.new).toMatch(/^[0-9a-f]{64}$/);
    expect(values.services.files?.["key-id"]?.new).toMatch(/^GK[0-9a-f]{24}$/);
    expect(Object.keys(values.services.files ?? {}).sort()).toEqual(
      serviceSpec("garage")
        .secrets.map((s) => s.name)
        .sort(),
    );
    expect(deps.redactor.redact(`a ${values.services.db?.password?.new} b`)).not.toContain(
      values.services.db?.password?.new,
    );
    expect(await readPendingRotation(deps)).toBeUndefined();

    await keepPendingRotation(deps, planned(values));
    expect(await readPendingRotation(deps)).toEqual(planned(values));
    if (process.platform !== "win32") {
      expect((await stat(pendingRotationFile(deps))).mode & 0o777).toBe(0o600);
    }
    // The generated values, which provision rewrites and the recovery copy holds, stay as they are.
    expect(JSON.parse(await readFile(generatedValuesFile(deps), "utf8"))).toEqual(KEPT);
  });

  it("refuses a service this computer keeps no value of", async () => {
    const deps = await withValues({ env: {} });
    await expect(newRotationValues(deps, services(plan(), "db"))).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: expect.stringContaining("opscrew secrets restore"),
    });
  });

  it("refuses a damaged unfinished rotation rather than start again", async () => {
    const deps = await withValues();
    await writeFile(pendingRotationFile(deps), `${JSON.stringify({ names: [] })}\n`);
    await expect(readPendingRotation(deps)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });

  it("makes the new values the services' own once done, the old kept by the record's generation, or drops them on an undo", async () => {
    const p = plan();
    const deps = await withValues();
    const values = await newRotationValues(deps, services(p, "db", "files"));
    await keepPendingRotation(deps, planned(values));
    await dropPendingRotation(deps);
    expect(await exists(pendingRotationFile(deps))).toBe(false);
    expect(JSON.parse(await readFile(generatedValuesFile(deps), "utf8"))).toEqual(KEPT);

    // `files` was rotated twice before: its values now are its generation 3, db's its first.
    await recordRotation(deps, ["files"]);
    await recordRotation(deps, ["files"]);
    await keepPendingRotation(deps, planned(values));
    await completePendingRotation(deps, p, values);
    expect(await exists(pendingRotationFile(deps))).toBe(false);
    // The rotation is recorded too: each credential one generation on.
    const record = (await readCredentialsRecord(deps)).environments.staging ?? {};
    expect([record.db?.generation, record.files?.generation]).toEqual([2, 4]);
    const pending = values;
    const done = JSON.parse(await readFile(generatedValuesFile(deps), "utf8"));
    expect(done.dbPassword).toBe(pending.services.db?.password?.new);
    expect(done.services.db).toBeUndefined();
    expect(done.services.files["secret-key"]).toBe(pending.services.files?.["secret-key"]?.new);
    expect(done.history).toEqual({
      db: { "1": { password: KEPT.dbPassword } },
      files: { "3": KEPT.services.files },
    });
    expect(done.grants).toEqual(KEPT.grants);
    expect(done.env).toEqual(KEPT.env);
  });
});

describe("swapAppEnv", () => {
  it("gives every variable that holds a rotated value as OpsCrew writes it the new one: addresses, aliases and split settings", async () => {
    const base = plan();
    const p = DeployPlanSchema.parse({
      ...base,
      app: {
        ...base.app,
        env: [
          ...base.app.env,
          { name: "DATABASE_URI", secret: true, source: "derived" },
          { name: "DB_HOST", secret: false, source: "derived" },
          { name: "DB_PASSWORD", secret: true, source: "derived" },
        ],
      },
    });
    const deps = await withValues();
    const pending = await newRotationValues(deps, services(p, "db", "files"));
    const old = await serviceValues(deps, p, pending, "old");
    const fresh = await serviceValues(deps, p, pending, "new");
    const dotenv = `STRIPE_SECRET_KEY=${value()}\n`;
    const assembled = async (values: typeof old) =>
      (
        await assembleAppEnv({
          plan: p,
          dotenvText: dotenv,
          previous: {
            dbPassword: values.db?.password as string,
            env: KEPT.env,
            services: { files: values.files as Record<string, string> },
          },
        })
      ).appEnv;
    const before = await assembled(old);
    expect(before).toContain(`DB_PASSWORD=${KEPT.dbPassword}`);
    expect(swapAppEnv(p, before, pending, old, fresh)).toBe(await assembled(fresh));
    expect(swapAppEnv(p, await assembled(fresh), pending, fresh, old)).toBe(before);
  });
});
