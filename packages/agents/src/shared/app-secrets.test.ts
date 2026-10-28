import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, testPlan } from "../testing";
import { assembleAppEnv } from "./app-env";
import { generatedValuesFile, registerAppSecrets } from "./app-secrets";

/**
 * A plan on a domain with a host list, fixed production settings, a generated key, a value the
 * user gives, and Postgres and MySQL with their generated passwords.
 */
function laravelPlan() {
  const base = testPlan({ domain: "example.com", www: true });
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      env: [
        { name: "ALLOWED_HOSTS", secret: false, source: "derived" },
        { name: "APP_ENV", secret: false, source: "derived" },
        { name: "APP_DEBUG", secret: false, source: "derived" },
        { name: "APP_KEY", secret: true, source: "generated" },
        { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
      ],
    },
    services: [
      ...base.services,
      {
        name: "orders-db",
        kind: "mysql",
        version: "8.4",
        memoryMb: 512,
        enabled: true,
        options: {},
        reason: "The orders service uses MySQL.",
        licence: "GPL-2.0",
      },
    ],
  });
}

/** A value the user gives, shaped like no token the redactor knows by itself. */
const USER_VALUE = "user-given-value-0001";

/** True when the redactor masks `value`. */
function masked(redactor: { redact(text: string): string }, value: string): boolean {
  return !redactor.redact(`x ${value} y`).includes(value);
}

describe("registerAppSecrets with the environment provision assembled", () => {
  it("registers the app's values but host lists and fixed production words, and the services' secrets", async () => {
    const plan = laravelPlan();
    const stripe = USER_VALUE;
    const environment = await assembleAppEnv({ plan, dotenvText: `STRIPE_SECRET_KEY=${stripe}\n` });
    const deps = await createTestPhaseDeps();
    await registerAppSecrets(deps, plan, environment);

    const { app, services } = environment.values;
    expect(app.ALLOWED_HOSTS).toBe("example.com,www.example.com");
    expect(app.APP_ENV).toBe("production");
    expect(masked(deps.redactor, app.ALLOWED_HOSTS as string)).toBe(false);
    expect(masked(deps.redactor, "production")).toBe(false);
    expect(masked(deps.redactor, stripe)).toBe(true);
    expect(deps.redactor.redact(`${app.APP_KEY} in production`)).toBe(
      "[REDACTED:app-env] in production",
    );
    const secrets = Object.values(services).flatMap(Object.values);
    expect(secrets.length).toBeGreaterThanOrEqual(3);
    for (const value of secrets) expect(masked(deps.redactor, value)).toBe(true);
  });
});

describe("registerAppSecrets with the values this computer keeps", () => {
  async function kept(options: { file?: string } = {}) {
    const plan = laravelPlan();
    const stripe = USER_VALUE;
    const first = await assembleAppEnv({
      plan,
      dotenvText: `STRIPE_SECRET_KEY=${stripe}\nAPP_ENV=production\n`,
    });
    const deps = await createTestPhaseDeps();
    const file = generatedValuesFile(deps);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(first.generated)}\n`);
    const envFile = join(deps.paths.root, "production.env");
    await writeFile(
      envFile,
      `STRIPE_SECRET_KEY=${stripe}\nAPP_ENV=production\nOTHER=not-the-apps\n`,
    );
    if (options.file !== undefined) deps.env.OPSCREW_APP_ENV_FILE = options.file;
    return { plan, deps, first, stripe };
  }

  it("registers the generated values, and the production file's values when one is named", async () => {
    const { plan, deps, first, stripe } = await kept({ file: "production.env" });
    await registerAppSecrets(deps, plan);
    const { app, services } = first.values;
    expect(masked(deps.redactor, app.APP_KEY as string)).toBe(true);
    for (const value of Object.values(services).flatMap(Object.values)) {
      expect(masked(deps.redactor, value)).toBe(true);
    }
    expect(masked(deps.redactor, stripe)).toBe(true);
    expect(masked(deps.redactor, "production")).toBe(false);
    // Only the plan's variables: anything else in the file is not the app's.
    expect(masked(deps.redactor, "not-the-apps")).toBe(false);
  });

  it("registers only the generated values without a production file", async () => {
    const { plan, deps, first, stripe } = await kept();
    await registerAppSecrets(deps, plan);
    expect(masked(deps.redactor, first.values.app.APP_KEY as string)).toBe(true);
    expect(masked(deps.redactor, stripe)).toBe(false);
  });

  it("registers nothing, and fails nothing, before provision kept any value", async () => {
    const deps = await createTestPhaseDeps();
    await expect(registerAppSecrets(deps, laravelPlan())).resolves.toBeUndefined();
  });

  it("says so when OPSCREW_APP_ENV_FILE names a missing file", async () => {
    const { plan, deps } = await kept({ file: "missing.env" });
    await expect(registerAppSecrets(deps, plan)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "OPSCREW_APP_ENV_FILE points to missing.env, which does not exist.",
    });
  });
});
