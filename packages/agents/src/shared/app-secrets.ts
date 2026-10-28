import { isAbsolute, join } from "node:path";
import { OpsCrewError, readTextIfExists } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { generatedValuesFile } from "../provision/secrets";
import { type AppEnvironment, fixedProductionValue, hostListKind, parseDotenv } from "./app-env";
import { readValidJson } from "./files";

/** The generated values provision keeps (`generated_values.json`), as far as they are secrets. */
const GeneratedValuesSchema = z.object({
  dbPassword: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  services: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

/** The app's values by name, and the services' secrets. */
interface AppSecrets {
  named: Record<string, string>;
  secrets: string[];
}

/**
 * Registers the app's values with the redactor, so none shows in OpsCrew's text: every app and
 * build value except host lists and fixed production words, and each service's generated secrets.
 * `environment` is the one provision just assembled. Without it, the values this computer keeps:
 * the generated values, and the production values in the file `OPSCREW_APP_ENV_FILE` names.
 * @throws OpsCrewError `INVALID_INPUT` when `OPSCREW_APP_ENV_FILE` names a file that does not exist.
 */
export async function registerAppSecrets(
  deps: Pick<PhaseDeps, "redactor" | "paths" | "env">,
  plan: DeployPlan,
  environment?: Pick<AppEnvironment, "values">,
): Promise<void> {
  const { named, secrets } =
    environment === undefined ? await keptSecrets(deps, plan) : assembledSecrets(environment);
  for (const [name, value] of Object.entries(named)) {
    // Host lists hold the domain (or the address), which OpsCrew's own messages show as usual, and
    // a fixed production setting is a plain word (`production`), masked nowhere.
    if (hostListKind(name) === undefined && fixedProductionValue(name) !== value) {
      deps.redactor.addLiteral(value, "app-env");
    }
  }
  // Each service's generated secrets (Postgres's password among them).
  for (const value of secrets) deps.redactor.addLiteral(value, "app-env");
}

function assembledSecrets({ values }: Pick<AppEnvironment, "values">): AppSecrets {
  return {
    named: { ...values.app, ...values.build },
    secrets: Object.values(values.services).flatMap(Object.values),
  };
}

/** The app's values on this computer, without asking for any. */
async function keptSecrets(
  deps: Pick<PhaseDeps, "paths" | "env">,
  plan: DeployPlan,
): Promise<AppSecrets> {
  const generated = (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
  const named: Record<string, string> = { ...generated.env };
  const file = deps.env.OPSCREW_APP_ENV_FILE?.trim();
  if (file) {
    const text = await readTextIfExists(isAbsolute(file) ? file : join(deps.paths.root, file));
    if (text === undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `OPSCREW_APP_ENV_FILE points to ${file}, which does not exist.`,
      );
    }
    const values = parseDotenv(text);
    for (const { name } of plan.app.env) {
      const value = values.get(name);
      if (value !== undefined) named[name] = value;
    }
  }
  const services = Object.values(generated.services ?? {}).flatMap(Object.values);
  const db = generated.dbPassword === undefined ? [] : [generated.dbPassword];
  return { named, secrets: [...services, ...db] };
}
