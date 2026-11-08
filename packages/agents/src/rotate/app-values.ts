/**
 * The app's own generated secrets in a rotation (025 plan.md 6., US4, FR-2507): which of them the
 * names `app` and `app:<NAME>` take, their new values made on this computer, the old one kept as
 * the previous one where the framework reads it (Laravel's `APP_PREVIOUS_KEYS`, Better Auth's
 * `BETTER_AUTH_SECRETS`, research R8; every target gives the app those variables), the drop of those
 * previous values (`app:APP_PREVIOUS_KEYS`, what `--drop-previous` names), the app's settings with
 * either side, and the plan's words: each secret's line, and the consequence line first with the
 * typed app name when users are logged out or data can no longer be read (founder, R9). Every
 * target applies them through its own switch: the servers' `rotate.sh`, Portainer's stack plan,
 * this computer's env file and Compose, a site's GitHub secrets and a deploy. No value is shown.
 */
import { listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import { PREVIOUS_VALUES, previousValueVariables } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { dotenvLine, newGeneratedValue } from "../shared/app-env";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { type RotationValues, readStrict } from "./values-pending";

/** Each app variable a rotation changes, by name, its old and new value (empty: unset). */
export type AppValues = NonNullable<RotationValues["app"]>;

/** The prefix of an app secret's name in `opscrew rotate`. */
const PREFIX = "app:";

/** The variables of {@link PREVIOUS_VALUES}, by the secret whose earlier values they hold. */
const SECRET_OF = new Map(Object.entries(PREVIOUS_VALUES).map(([s, variable]) => [variable, s]));

/**
 * How each previous-value variable takes the old value (`kept`: what it holds, empty when unset)
 * and what it keeps once dropped.
 */
const PREVIOUS_FORMATS: Readonly<
  Record<
    string,
    { add(kept: string, old: string, fresh: string): string; drop(kept: string): string }
  >
> = {
  // A comma list Laravel tries after APP_KEY, the latest first.
  APP_PREVIOUS_KEYS: {
    add: (kept, old) => [old, ...kept.split(",").filter((key) => key !== "")].join(","),
    drop: () => "",
  },
  // `<version>:<value>,…`, the first current and the version each encrypted value names: the
  // current one keeps its version once the others are dropped.
  BETTER_AUTH_SECRETS: {
    add: (kept, old, fresh) => {
      const entries = kept === "" ? [`1:${old}`] : kept.split(",");
      const version = Number(/^(\d+):/.exec(entries[0] ?? "")?.[1] ?? "1");
      return [`${version + 1}:${fresh}`, ...entries].join(",");
    },
    drop: (kept) => kept.split(",")[0] ?? "",
  },
};

/** True for a name of the app's own secrets: `app` or `app:<NAME>`. */
export function isAppName(name: string): boolean {
  return name === "app" || name.startsWith(PREFIX);
}

/** The generated app values this computer keeps (`generated_values.json`'s `env`). */
async function keptEnv(deps: Pick<PhaseDeps, "paths">): Promise<Record<string, string>> {
  return (await readStrict(generatedValuesFile(deps), GeneratedValuesSchema))?.env ?? {};
}

/** The app variables `plan` generates that this computer keeps a value of, in the plan's order. */
function generatedKept(plan: DeployPlan, env: Readonly<Record<string, string>>): string[] {
  return plan.app.env
    .filter((variable) => variable.source === "generated" && env[variable.name] !== undefined)
    .map((variable) => variable.name);
}

/**
 * True when a drop of the previous-value variable `variable` changes something: OpsCrew gives it
 * beside a generated secret (`previousValueVariables`, not one the plan names as the user's) and
 * it keeps more than its drop leaves (Better Auth's current version alone is not dropped again).
 */
function droppable(plan: DeployPlan, env: Readonly<Record<string, string>>, variable: string) {
  const kept = env[variable] ?? "";
  const format = PREVIOUS_FORMATS[variable];
  return (
    format !== undefined &&
    previousValueVariables(plan).includes(variable) &&
    generatedKept(plan, env).includes(SECRET_OF.get(variable) ?? "") &&
    format.drop(kept) !== kept
  );
}

/**
 * The app secrets `names` take, as `app:<NAME>`: `app` every generated one this computer keeps,
 * `app:<NAME>` that one, or a previous-value variable this computer keeps (its drop).
 * @throws OpsCrewError `INVALID_INPUT` for a name of no such secret, none to rotate, or a secret
 * rotated and its previous values dropped in one run; `ARTIFACT_INVALID` when the generated values
 * are damaged.
 */
export async function appSecretNames(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  names: readonly string[],
): Promise<string[]> {
  const env = await keptEnv(deps);
  const generated = generatedKept(plan, env);
  const refuse = (message: string) =>
    new OpsCrewError("INVALID_INPUT", `${message} Nothing was changed.`, {
      hint: "Run `opscrew rotate` to list what it can rotate.",
    });
  const variables = new Set<string>();
  for (const name of names) {
    if (name === "app") {
      if (generated.length === 0) {
        throw refuse(
          `${plan.app.name} has no secret OpsCrew generated and keeps on this computer (a value you set is yours to change).`,
        );
      }
      for (const variable of generated) variables.add(variable);
      continue;
    }
    const variable = name.slice(PREFIX.length);
    const previous = SECRET_OF.get(variable);
    const known =
      previous === undefined ? generated.includes(variable) : droppable(plan, env, variable);
    if (!known) {
      throw refuse(
        previous === undefined
          ? `${variable} is no secret OpsCrew generated for ${plan.app.name} and keeps on this computer.`
          : `${plan.app.name} keeps no previous value of ${previous} in ${variable}, so there is nothing to drop.`,
      );
    }
    variables.add(variable);
  }
  for (const [secret, variable] of Object.entries(PREVIOUS_VALUES)) {
    if (variables.has(secret) && variables.has(variable)) {
      throw refuse(
        `${secret} can't be rotated and its previous values in ${variable} dropped in one run.`,
      );
    }
  }
  return [...variables].map((variable) => `${PREFIX}${variable}`);
}

/**
 * The names that drop the previous values the app keeps (`opscrew rotate app --drop-previous`):
 * `app:<VARIABLE>` of each previous-value variable this computer keeps for a generated secret.
 * @throws OpsCrewError `INVALID_INPUT` when it keeps none.
 */
export async function dropPreviousNames(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
): Promise<string[]> {
  const env = await keptEnv(deps);
  const names = Object.values(PREVIOUS_VALUES)
    .filter((variable) => droppable(plan, env, variable))
    .map((variable) => `${PREFIX}${variable}`);
  if (names.length > 0) return names;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${plan.app.name} keeps no previous value of ${listText(Object.keys(PREVIOUS_VALUES))}, so there is nothing to drop. Nothing was changed.`,
    { hint: "Run `opscrew rotate` to list what it can rotate." },
  );
}

/**
 * New values for the app secrets `names` (from {@link appSecretNames}), each in its format, beside
 * the old one, which is added to the secret's previous values where its framework reads them and
 * OpsCrew gives that variable (`previousValueVariables`: not one `plan` names as the user's, whose
 * secret then rotates as any other); a previous-value variable's name drops all but the current.
 * Each registered with the redactor; nothing is kept yet.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer keeps no value of one,
 * `ARTIFACT_INVALID` when the generated values are damaged.
 */
export async function newAppValues(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  plan: DeployPlan,
  names: readonly string[],
): Promise<AppValues> {
  const companions = previousValueVariables(plan);
  const env = await keptEnv(deps);
  const values: AppValues = {};
  for (const name of names) {
    const variable = name.slice(PREFIX.length);
    const old = env[variable];
    if (old === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `This computer keeps no ${variable} of the app, so OpsCrew can't rotate it. Nothing was changed.`,
        {
          hint: "Bring OpsCrew's generated values from your recovery copy (`opscrew secrets restore`) or run the command on the computer that set up the app.",
        },
      );
    }
    const format = PREVIOUS_FORMATS[variable];
    if (format !== undefined) {
      values[variable] = { old, new: format.drop(old) };
      continue;
    }
    const fresh = newGeneratedValue(variable);
    values[variable] = { old, new: fresh };
    const previous = PREVIOUS_VALUES[variable];
    const add = previous === undefined ? undefined : PREVIOUS_FORMATS[previous];
    if (previous !== undefined && add !== undefined && companions.includes(previous)) {
      const kept = env[previous] ?? "";
      values[previous] = { old: kept, new: add.add(kept, old, fresh) };
    }
  }
  for (const pair of Object.values(values)) {
    for (const value of [pair.old, pair.new])
      if (value !== "") deps.redactor.addLiteral(value, "app-env");
  }
  return values;
}

/** The refusal of an app variable that does not hold the value OpsCrew keeps for it. */
function notOurs(name: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The app's settings hold ${name} in a way OpsCrew doesn't write it (a value of your own?), so OpsCrew can't give the app the new one. Nothing was changed.`,
    {
      hint: "Let the app's settings hold only what OpsCrew writes for it (run `opscrew provision` and let its deploy finish), then run the command again.",
    },
  );
}

/**
 * The app's settings `text` (its `app.env`, lines sorted by name as provision writes them) with
 * each variable of `values` on its `side`: the line replaced, added in its place, or removed when
 * that side is empty; every other line stays. A line already on `side` (a rotation run again) stays
 * as it is.
 * @throws OpsCrewError `PHASE_PRECONDITION` when a variable holds neither side's value as OpsCrew
 * writes it (or is set where both sides are empty).
 */
export function withAppEnv(
  text: string,
  values: AppValues | undefined,
  side: "old" | "new",
): string {
  if (values === undefined) return text;
  const body = text.replace(/\n+$/, "");
  const lines = body === "" ? [] : body.split("\n");
  const nameOf = (line: string) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
  const lineOf = (name: string, value: string) => (value === "" ? "" : dotenvLine(name, value));
  for (const [name, pair] of Object.entries(values)) {
    const to = pair[side];
    const at = lines.findIndex((line) => nameOf(line) === name);
    const holds = at === -1 ? "" : lines[at];
    if (holds !== lineOf(name, pair.old) && holds !== lineOf(name, pair.new)) throw notOurs(name);
    if (at !== -1) lines.splice(at, 1);
    if (to === "") continue;
    const after = lines.findIndex((line) => (nameOf(line) ?? "").localeCompare(name) > 0);
    lines.splice(after === -1 ? lines.length : after, 0, dotenvLine(name, to));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The app's values by name (a Portainer stack's) with each variable of `values` on its `side`,
 * removed when that side is empty.
 * @throws OpsCrewError `PHASE_PRECONDITION` as {@link withAppEnv}.
 */
export function withAppRecord(
  record: Readonly<Record<string, string>>,
  values: AppValues | undefined,
  side: "old" | "new",
): Record<string, string> {
  const result = { ...record };
  for (const [name, pair] of Object.entries(values ?? {})) {
    const holds = result[name] ?? "";
    if (holds !== pair.old && holds !== pair.new) throw notOurs(name);
    if (pair[side] === "") delete result[name];
    else result[name] = pair[side];
  }
  return result;
}

/** The generated app values `env` once the rotation of `values` is done: the new side, kept. */
export function appEnvAfter(
  env: Readonly<Record<string, string>> | undefined,
  values: AppValues | undefined,
): Record<string, string> {
  return withAppRecord(env ?? {}, values, "new");
}

/** The fingerprints of `values` a rotation's hash binds, never the values themselves. */
export function appFingerprints(values: AppValues | undefined) {
  return Object.entries(values ?? {}).map(([name, pair]) => ({
    name,
    old: sha256Hex(pair.old),
    new: sha256Hex(pair.new),
  }));
}

/** How one app variable of `values` rotates; `undefined` for a previous value that follows it. */
function modeOf(
  values: AppValues,
  name: string,
): "previous" | "both" | "logout" | "drop" | undefined {
  const secret = SECRET_OF.get(name);
  if (secret !== undefined) return values[secret] === undefined ? "drop" : undefined;
  if (name === "CRON_SECRET") return "both";
  const previous = PREVIOUS_VALUES[name];
  return previous !== undefined && values[previous] !== undefined ? "previous" : "logout";
}

/** The plan's line for each app secret of `values`: how it rotates and what it costs. */
export function appSecretLines(values: AppValues | undefined): string[] {
  if (values === undefined) return [];
  return Object.keys(values).flatMap((name) => {
    const mode = modeOf(values, name);
    if (mode === undefined) return [];
    const previous = PREVIOUS_VALUES[name];
    const said = {
      previous: `seamless: the new value is current, and the old one stays beside it in ${previous}, so nobody is logged out and what it encrypted stays readable; drop it with \`opscrew rotate app --drop-previous\` once nothing needs it.`,
      both: "seamless: the app and its cron jobs get the new value in the same switch.",
      logout: "every user of the app is logged out, or the tokens it issued stop working.",
      drop: `the earlier values of ${SECRET_OF.get(name)} are dropped; sessions, cookies and data still encrypted with them can no longer be read.`,
    }[mode];
    return [`${PREFIX}${name}: ${said}`];
  });
}

/**
 * The plan's first line when users are logged out or data can no longer be read, and the typed
 * confirmation of the app's name its approval then needs (`allowDestroy`, R9); `undefined` when
 * every app secret of `values` rotates seamlessly.
 */
export function appConsequence(
  plan: DeployPlan,
  values: AppValues | undefined,
): { line: string; guard: { allowDestroy: true; confirmPhrase: string } } | undefined {
  const names = (mode: string) =>
    Object.keys(values ?? {})
      .filter((name) => values !== undefined && modeOf(values, name) === mode)
      .map((name) => `${PREFIX}${name}`);
  const logout = names("logout");
  const drop = names("drop");
  if (logout.length === 0 && drop.length === 0) return undefined;
  const app = plan.app.name;
  const parts = [
    ...(logout.length === 0
      ? []
      : [
          `every user of ${app} is logged out, or the tokens it issued stop working (${listText(logout)})`,
        ]),
    ...(drop.length === 0
      ? []
      : [
          `what is still encrypted with the dropped previous values can no longer be read (${listText(drop)})`,
        ]),
  ];
  const said = parts.join(", and ");
  return {
    line: `${said.charAt(0).toUpperCase()}${said.slice(1)}. To go ahead, type the app's name, ${app}.`,
    guard: { allowDestroy: true, confirmPhrase: app },
  };
}

/** What a finished rotation of `values` says beside its success: the previous values kept. */
export function appSuccessNote(values: AppValues | undefined): string {
  const kept = Object.keys(values ?? {}).filter(
    (name) => values !== undefined && modeOf(values, name) === "previous",
  );
  if (kept.length === 0) return "";
  return ` The old value of ${listText(kept)} stays as the previous one (${listText(kept.map((name) => PREVIOUS_VALUES[name] as string))}) until \`opscrew rotate app --drop-previous\`.`;
}
