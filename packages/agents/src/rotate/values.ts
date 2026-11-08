/**
 * The values of a rotation of services (025 plan.md 2.–3., FR-2504, FR-2512): new values made on
 * this computer in the catalog's formats, kept beside the old ones in the environment's unfinished
 * rotation (`./values-pending`) until it is done or undone; then the new values become the
 * services' own in the generated values, and the old ones stay there by their generation
 * (`history`) for restores of older snapshots. The services' env files and the app's settings with
 * either side of them. No value is ever shown, logged or audited.
 */
import { randomBytes } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import { type GeneratedSecret, serviceSpec } from "@opscrew/iac-templates";
import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { serviceEnvFiles, withGrantHashes } from "../provision/secrets";
import { dotenvLine, serviceAppVariables } from "../shared/app-env";
import { changeGenerated, GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { randomPassword } from "../shared/ssh-keys";
import { passwordKey } from "../vpn/grants";
import { appEnvAfter } from "./app-values";
import {
  dropPendingRotation,
  type RotationValues,
  readStrict,
  registerRotationValues,
} from "./values-pending";

/**
 * The values each credential had at its earlier generations, by its name, then the generation
 * (`"1"`, `"2"`…), then the secret: what a restore of an older snapshot logs in with (T2514).
 */
const HistorySchema = z.record(
  z.string(),
  z.record(z.string(), z.record(z.string(), z.string().min(1))),
);

/** The generated values a rotation reads: the services' own and the earlier generations. */
const KeptValuesSchema = GeneratedValuesSchema.extend({ history: HistorySchema.optional() });

type KeptValues = z.infer<typeof KeptValuesSchema>;

/** Each running service's secrets by service name, then the catalog's secret name. */
export type ServiceValues = Record<string, Record<string, string>>;

/**
 * The generated values of the environment of `deps.paths` (none without the file).
 * @throws OpsCrewError `ARTIFACT_INVALID` when they are damaged.
 */
async function readKept(deps: Pick<PhaseDeps, "paths">): Promise<KeptValues> {
  return (await readStrict(generatedValuesFile(deps), KeptValuesSchema)) ?? {};
}

/** True for the secret kept as `dbPassword` rather than under `services`. */
function isDbPassword(service: Pick<PlanService, "kind">, secret: string): boolean {
  return service.kind === "postgres" && secret === "password";
}

/** The value `service` has for `secret` on this computer, if any. */
function keptValue(values: KeptValues, service: PlanService, secret: string) {
  return isDbPassword(service, secret)
    ? values.dbPassword
    : values.services?.[service.name]?.[secret];
}

/** A new value in the catalog's `format`: 32 random bytes as hex, or `GK` and 12 as hex. */
function newValue(format: GeneratedSecret["format"]): string {
  return format === "garage-key-id"
    ? `GK${randomBytes(12).toString("hex")}`
    : randomBytes(32).toString("hex");
}

/** A device's own login to a service (018's grants), which a rotation gives a new password. */
export interface GrantLogin {
  device: string;
  service: PlanService;
}

/** The name `opscrew rotate` takes for `grant`'s login: `grant:<device>/<service>`. */
export function grantName(grant: GrantLogin): string {
  return `grant:${grantKey(grant)}`;
}

/** `grant`'s entry in the generated values' `grants`: `<device>/<service>`. */
function grantKey(grant: GrantLogin): string {
  return passwordKey(grant.device, grant.service.name);
}

/**
 * A new value for each generated secret of `services` (in the catalog's formats) and a new
 * password for each of `grants` (32 letters and digits, as `opscrew vpn grant` makes one), beside
 * the one it has, both registered with the redactor; nothing is kept yet
 * ({@link keepPendingRotation}).
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer keeps no value of one,
 * `ARTIFACT_INVALID` when the generated values are damaged.
 */
export async function newRotationValues(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  services: readonly PlanService[],
  grants: readonly GrantLogin[] = [],
): Promise<RotationValues> {
  const kept = await readKept(deps);
  const values: RotationValues = {
    names: [...services.map((s) => s.name), ...grants.map(grantName)],
    services: {},
  };
  for (const grant of grants) {
    const old = kept.grants?.[grantKey(grant)];
    if (old === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `This computer keeps no password of device ${grant.device}'s login to ${grant.service.name}, so OpsCrew can't rotate it. Nothing was changed.`,
        {
          hint: "Bring OpsCrew's generated values from your recovery copy (`opscrew secrets restore`) or run the command on the computer that granted the login.",
        },
      );
    }
    values.grants = { ...values.grants, [grantKey(grant)]: { old, new: randomPassword(32) } };
  }
  for (const service of services) {
    const secrets: Record<string, { old: string; new: string }> = {};
    for (const { name, format } of serviceSpec(service.kind).secrets) {
      const old = keptValue(kept, service, name);
      if (old === undefined) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `This computer keeps no ${name} of ${service.name}, so OpsCrew can't rotate it. Nothing was changed.`,
          {
            hint: "Bring OpsCrew's generated values from your recovery copy (`opscrew secrets restore`) or run the command on the computer that set up the app.",
          },
        );
      }
      secrets[name] = { old, new: newValue(format) };
    }
    values.services[service.name] = secrets;
  }
  registerRotationValues(deps.redactor, values);
  return values;
}

/**
 * The secrets of every running service of `plan` as this computer keeps them, those `values`
 * rotates with their `side` of it, and each device login's SHA-256 added as the services' env
 * files declare it (`withGrantHashes`), those `values` rotates by their `side` too.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer keeps no value of a running
 * service, `ARTIFACT_INVALID` when the generated values are damaged.
 */
export async function serviceValues(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  values: RotationValues,
  side: "old" | "new",
): Promise<ServiceValues> {
  const kept = await readKept(deps);
  const services: ServiceValues = {};
  for (const service of plan.services.filter((s) => s.enabled)) {
    const secrets: Record<string, string> = {};
    for (const { name } of serviceSpec(service.kind).secrets) {
      const value = values.services[service.name]?.[name]?.[side] ?? keptValue(kept, service, name);
      if (value === undefined) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `This computer keeps no ${name} of ${service.name}, so OpsCrew can't write its settings. Nothing was changed.`,
          {
            hint: "Bring OpsCrew's generated values from your recovery copy (`opscrew secrets restore`), then run the command again.",
          },
        );
      }
      secrets[name] = value;
    }
    services[service.name] = secrets;
  }
  const rotated = Object.entries(values.grants ?? {}).map(([key, pair]) => [key, pair[side]]);
  return withGrantHashes(plan, services, { ...kept.grants, ...Object.fromEntries(rotated) });
}

/** `<service>.env` of every running service of `plan` with `services`' values, by file name. */
export function serviceEnvTexts(plan: DeployPlan, services: ServiceValues): Record<string, string> {
  const files = serviceEnvFiles(plan, { values: { app: {}, build: {}, services } });
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [`${name}.env`, text]));
}

/**
 * The app's settings `text` (its `app.env` as the deploy wrote it) with each variable that holds a
 * value of `from` (an address, a password, a key, as OpsCrew writes it) holding the one of `to`
 * instead, for the services `values` rotates; every other line stays.
 * @throws OpsCrewError `PHASE_PRECONDITION` when a line still holds a value of `from` that way
 * does not change (a value of the user's own that quotes it): the app would keep the old value.
 */
export function swapAppEnv(
  plan: DeployPlan,
  text: string,
  values: RotationValues,
  from: ServiceValues,
  to: ServiceValues,
): string {
  const secret = (side: ServiceValues) => (service: PlanService, name: string) => {
    const value = side[service.name]?.[name];
    if (value === undefined) throw new Error(`${service.name} has no secret ${name}.`);
    return value;
  };
  const pairs = new Map<string, string>();
  const before = serviceAppVariables(plan, secret(from));
  const after = serviceAppVariables(plan, secret(to));
  for (const [name, value] of before) {
    const next = after.get(name);
    if (next !== undefined && next !== value) pairs.set(value, next);
  }
  for (const service of plan.services.filter((s) => s.enabled && values.services[s.name])) {
    const address = (side: ServiceValues) =>
      serviceSpec(service.kind).address({
        plan,
        service,
        secretRef: (n) => secret(side)(service, n),
      });
    const a = address(from);
    const b = address(to);
    if (a !== b) pairs.set(a, b);
  }
  const lines = text
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => {
      const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
      if (name === undefined) return line;
      for (const [a, b] of pairs) if (line === dotenvLine(name, a)) return dotenvLine(name, b);
      return line;
    });
  const swapped = `${lines.join("\n")}\n`;
  for (const [service, secrets] of Object.entries(values.services)) {
    for (const name of Object.keys(secrets)) {
      const left = from[service]?.[name];
      if (left === undefined || !swapped.includes(left)) continue;
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The app's settings (its app.env) hold the ${name} of ${service} in a way OpsCrew doesn't write it (a value of your own?), so OpsCrew can't give the app the new one. Nothing was changed.`,
        {
          hint: "Let the app's settings hold only what OpsCrew writes for the service (run `opscrew provision` and let its deploy finish), then run the command again.",
        },
      );
    }
  }
  return swapped;
}

/**
 * Makes the new values of `values` the services' own (PostgreSQL's as `dbPassword`), the device
 * logins' (`grants`) and the app's (`env`, an emptied variable removed), keeping the services' old
 * ones under `history` at the generation each credential had (`generations`, by name; 1 when
 * absent) and every other generated value as it was (0600); then forgets the unfinished rotation.
 * @throws OpsCrewError `ARTIFACT_INVALID` when the generated values are damaged.
 */
export async function completePendingRotation(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  values: RotationValues,
  generations: Readonly<Record<string, number>>,
): Promise<void> {
  await changeGenerated(deps, (current) => {
    const services: ServiceValues = {
      ...GeneratedValuesSchema.shape.services.parse(current.services),
    };
    const history = { ...HistorySchema.catch({}).parse(current.history) };
    let dbPassword = GeneratedValuesSchema.shape.dbPassword.parse(current.dbPassword);
    for (const [name, secrets] of Object.entries(values.services)) {
      const service = plan.services.find((s) => s.name === name);
      if (service === undefined) throw new Error(`The plan has no service ${name}.`);
      const old = Object.fromEntries(Object.entries(secrets).map(([s, pair]) => [s, pair.old]));
      history[name] = { ...history[name], [String(generations[name] ?? 1)]: old };
      for (const [secret, pair] of Object.entries(secrets)) {
        if (isDbPassword(service, secret)) dbPassword = pair.new;
        else services[name] = { ...services[name], [secret]: pair.new };
      }
    }
    const grants = Object.entries(values.grants ?? {}).map(([key, pair]) => [key, pair.new]);
    const env = GeneratedValuesSchema.shape.env.parse(current.env);
    return {
      ...current,
      ...(dbPassword === undefined ? {} : { dbPassword }),
      services,
      history,
      ...(values.app === undefined ? {} : { env: appEnvAfter(env, values.app) }),
      ...(grants.length === 0
        ? {}
        : {
            grants: {
              ...GeneratedValuesSchema.shape.grants.parse(current.grants),
              ...Object.fromEntries(grants),
            },
          }),
    };
  });
  await dropPendingRotation(deps);
}
