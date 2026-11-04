import { isAbsolute, join } from "node:path";
import { OpsCrewError, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import { type DeployPlan, WireGuardKeySchema } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { type AppEnvironment, fixedProductionValue, hostListKind, parseDotenv } from "./app-env";
import { readValidJson } from "./files";

/** Private file (0600) beside the deploy key holding generated values between runs. */
export function generatedValuesFile(deps: Pick<PhaseDeps, "paths">): string {
  return join(deps.paths.projectHomeDir, "generated_values.json");
}

/**
 * The self-hosted monitoring's values in the generated values (`monitoring`): its two passwords,
 * each generated once, and the monitoring server of another environment this one has an interface
 * on, so provision can take it off again once monitoring is off there.
 */
export const MonitoringValuesSchema = z.strictObject({
  /** Grafana's admin password, of the stack this environment owns: letters, digits, `-`, `_`. */
  grafanaAdminPassword: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .optional(),
  /** The Postgres monitoring login's (`opscrew_monitor`) password: letters and digits. */
  postgresPassword: z
    .string()
    .regex(/^[A-Za-z0-9]{16,128}$/)
    .optional(),
  /**
   * The login may be on a Postgres of this environment with a password not kept yet: set before
   * its grant is applied, replaced by `postgresPassword` once Alloy runs with it, so turning
   * monitoring off removes the login either way.
   */
  login: z.literal(true).optional(),
  /** The other environment's plan file, its monitoring server, and this network's interface there. */
  owner: z.strictObject({ plan: z.string(), server: z.string(), interface: z.string() }).optional(),
});

/** The generated values provision keeps (`generated_values.json`), as far as they are secrets. */
export const GeneratedValuesSchema = z.object({
  dbPassword: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  services: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
  /** The private network's WireGuard private keys, by member (`app` or an extra server's name). */
  network: z.record(z.string(), z.string().min(1)).optional(),
  /** Each device login's password, by `<device>/<service>`. */
  grants: z.record(z.string(), z.string().min(1)).optional(),
  /** The self-hosted monitoring's values; damaged ones read as none (writing them stops). */
  monitoring: MonitoringValuesSchema.optional().catch(undefined),
});

/**
 * The generated values file as an object, with every other value kept as it is; what OpsCrew writes
 * into `network` must be WireGuard keys.
 */
const GeneratedFileSchema = z.looseObject({
  network: z.record(z.string(), WireGuardKeySchema).optional(),
  grants: GeneratedValuesSchema.shape.grants,
  monitoring: MonitoringValuesSchema.optional(),
});

/** The app's values by name, and the services' secrets. */
interface AppSecrets {
  named: Record<string, string>;
  secrets: string[];
}

/**
 * Registers the app's values with the redactor, so none shows in OpsCrew's text: every app and
 * build value except host lists and fixed production words, each service's generated secrets, and
 * the private network's keys, the device logins' passwords and the self-hosted monitoring's
 * passwords this computer keeps.
 * `environment` is the one provision just assembled. Without it, the values this computer keeps:
 * the generated values, and the production values in the file `OPSCREW_APP_ENV_FILE` names.
 * @throws OpsCrewError `INVALID_INPUT` when `OPSCREW_APP_ENV_FILE` names a file that does not exist.
 */
export async function registerAppSecrets(
  deps: Pick<PhaseDeps, "redactor" | "paths" | "env">,
  plan: DeployPlan,
  environment?: Pick<AppEnvironment, "values">,
): Promise<void> {
  const generated = (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
  const { named, secrets } =
    environment === undefined
      ? await keptSecrets(deps, plan, generated)
      : assembledSecrets(environment);
  for (const [name, value] of Object.entries(named)) {
    // Host lists hold the domain (or the address), which OpsCrew's own messages show as usual, and
    // a fixed production setting is a plain word (`production`), masked nowhere.
    if (hostListKind(name) === undefined && fixedProductionValue(name) !== value) {
      deps.redactor.addLiteral(value, "app-env");
    }
  }
  // Each service's generated secrets (Postgres's password among them).
  for (const value of secrets) deps.redactor.addLiteral(value, "app-env");
  for (const key of Object.values(generated.network ?? {})) {
    deps.redactor.addLiteral(key, "network-key");
  }
  for (const password of Object.values(generated.grants ?? {})) {
    deps.redactor.addLiteral(password, "app-env");
  }
  const { grafanaAdminPassword, postgresPassword } = generated.monitoring ?? {};
  for (const password of [grafanaAdminPassword, postgresPassword]) {
    if (password !== undefined) deps.redactor.addLiteral(password, "monitoring-password");
  }
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
  generated: z.output<typeof GeneratedValuesSchema>,
): Promise<AppSecrets> {
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

/**
 * Writes `edit` of the generated values (`{}` without the file) over them (0600).
 * @throws OpsCrewError `ARTIFACT_INVALID` when the file is there but damaged (not a JSON object, or
 * a value OpsCrew writes not as it writes it): its values are never overwritten.
 */
export async function changeGenerated(
  deps: Pick<PhaseDeps, "paths">,
  edit: (values: z.output<typeof GeneratedFileSchema>) => Record<string, unknown>,
): Promise<void> {
  const file = generatedValuesFile(deps);
  const text = await readTextIfExists(file);
  let json: unknown = {};
  if (text !== undefined) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  const parsed = GeneratedFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `OpsCrew's generated values (${file}) are damaged, so OpsCrew wrote nothing into them.`,
      {
        hint: "Fix the JSON in that file, or restore it from your recovery copy, then run the command again.",
      },
    );
  }
  await writeFileAtomic(file, `${JSON.stringify(edit(parsed.data))}\n`);
}

/**
 * Sets the entries of the generated values' `network` (member → WireGuard private key) or
 * `grants` (`<device>/<service>` → password), or removes those given as `undefined`, keeping
 * every other value of the file (0600).
 * @throws OpsCrewError `ARTIFACT_INVALID` when the file is damaged ({@link changeGenerated}).
 */
export async function recordGeneratedEntries(
  deps: Pick<PhaseDeps, "paths">,
  field: "network" | "grants",
  entries: Record<string, string | undefined>,
): Promise<void> {
  await changeGenerated(deps, (values) => {
    const next: Record<string, string | undefined> = { ...values[field], ...entries };
    for (const [name, value] of Object.entries(next)) if (value === undefined) delete next[name];
    return { ...values, [field]: next };
  });
}
