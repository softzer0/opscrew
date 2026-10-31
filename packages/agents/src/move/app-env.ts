/**
 * The app's settings around a move's switch (feature 018): `app.env` on the app's server, which
 * the deploy writes from the GitHub secret `OPSCREW_APP_ENV`. The switch changes only the moving
 * service's address in them. Their text holds secrets: it is never logged, shown or audited.
 */
import type { CommandResult } from "@opscrew/contracts";
import { OpsCrewError, type Redactor } from "@opscrew/core";
import {
  appDir,
  DEPLOY_SECRETS,
  deploySecretName,
  maskFileScript,
  serviceSpec,
} from "@opscrew/iac-templates";
import type { DeployPlan, Move } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitHubSetup } from "../provision/credentials";
import { secretsEnvironment } from "../provision/secrets";
import { dotenvLine, readValidJson, serverWords } from "../shared";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import type { MoveShell } from "./shells";

/** The app's settings file on its server. */
function appEnvFile(plan: DeployPlan): string {
  return `${appDir(plan)}/app.env`;
}

/** The app's settings before and after a move's switch, in the GitHub secret's form. */
export interface SwitchedEnv {
  /** With the moving service's address on `move.from`. */
  before: string;
  /** With its address on `move.to`. */
  after: string;
  /** True when the app's server holds `after` already: an earlier window switched them. */
  switched: boolean;
}

/**
 * Reads the app's settings on its server (`app`) and gives them before and after the switch of
 * `move`: each variable that holds the moving service's address (as OpsCrew writes it, with the
 * password this computer keeps) on one server, with its address on the other.
 * @throws OpsCrewError when the settings cannot be read, or the service's secrets are not on this
 * computer.
 */
export async function switchedEnv(
  deps: Pick<PhaseDeps, "paths">,
  app: MoveShell,
  plan: DeployPlan,
  move: Move,
): Promise<SwitchedEnv> {
  const service = plan.services.find((s) => s.name === move.service);
  if (service === undefined) throw new Error(`The plan has no service ${move.service}.`);
  const generated = (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
  const secretRef = (name: string) => {
    const value =
      service.kind === "postgres" && name === "password"
        ? generated.dbPassword
        : generated.services?.[service.name]?.[name];
    if (value !== undefined) return value;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer does not keep the ${name} of ${service.name}, so OpsCrew cannot give the app its new address. Nothing was changed.`,
      {
        hint: "Run `opscrew provision` on the computer that set up the app: it keeps the generated values.",
      },
    );
  };
  const address = (step: Move["step"]) =>
    serviceSpec(service.kind).address({
      plan: { ...plan, move: { ...move, step } },
      service,
      secretRef,
    });
  const from = address("deployed");
  const to = address("switched");

  const result = await app.remote.run(`cat ${appEnvFile(plan)}`, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not read the app's settings (app.env) on ${serverWords(app.name)} (exit code ${result.exitCode}). Nothing was changed.`,
      { hint: "Check that the app is deployed there, then run `opscrew provision` again." },
    );
  }
  const lines = result.stdout.replace(/\n+$/, "").split("\n");
  /** The settings with each variable that holds address `a` holding `b` instead. */
  const swap = (a: string, b: string) =>
    `${lines
      .map((line) => {
        const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
        return name !== undefined && line === dotenvLine(name, a) ? dotenvLine(name, b) : line;
      })
      .join("\n")}\n`;
  const now = `${lines.join("\n")}\n`;
  const before = swap(to, from);
  const after = swap(from, to);
  return { before, after, switched: now === after && now !== before };
}

/**
 * What a failed command on a server said, to follow its description: `: <its error output>`
 * (redacted, at most 300 characters), or ` (exit code <n>)` when it said nothing.
 */
export function failureDetail(
  result: Pick<CommandResult, "exitCode" | "stderr">,
  redactor: Pick<Redactor, "redact">,
): string {
  const said = redactor.redact(result.stderr.trim()).slice(0, 300);
  return said ? `: ${said}` : ` (exit code ${result.exitCode})`;
}

/**
 * Writes `text` as the app's settings on its server (`app`), owner-only, replacing the file in one
 * step.
 * @throws OpsCrewError `COMMAND_FAILED` with the server's words, never the settings.
 */
export async function writeAppEnv(
  app: MoveShell,
  plan: DeployPlan,
  text: string,
  redactor: Pick<Redactor, "redact">,
): Promise<void> {
  const file = appEnvFile(plan);
  const result = await app.remote.run(
    `umask 077 && cat > ${file}.opscrew && mv ${file}.opscrew ${file}`,
    { input: text, timeoutMs: 60_000 },
  );
  if (result.exitCode === 0) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `Could not write the app's settings (app.env) on ${serverWords(app.name)}${failureDetail(result, redactor)}.`,
    { hint: "Check the free disk space on the app's server (`df -h /srv`)." },
  );
}

/**
 * Rewrites Grafana Alloy's masking file `mask.re` on the app's server from the `app.env` there,
 * with the deploy's own script (`maskFileScript`), so the logs it sends mask the settings' new
 * values too; nothing without Grafana Cloud.
 * @throws OpsCrewError `COMMAND_FAILED` with the server's words, never the settings.
 */
export async function writeMask(
  app: MoveShell,
  plan: DeployPlan,
  redactor: Pick<Redactor, "redact">,
): Promise<void> {
  const script = maskFileScript(plan);
  if (script === "") return;
  const result = await app.remote.run("bash -s", { input: script, timeoutMs: 60_000 });
  if (result.exitCode === 0) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `Could not rewrite Grafana Alloy's masking file (mask.re) on ${serverWords(app.name)}${failureDetail(result, redactor)}.`,
    { hint: "Check the free disk space on the app's server (`df -h /srv`)." },
  );
}

/**
 * Stores `text` as the GitHub secret `OPSCREW_APP_ENV` of the plan's environment (where its deploy
 * secrets live), so the next deploy writes the same settings. Audited by name only.
 */
export async function storeAppEnv(
  deps: Pick<PhaseDeps, "audit">,
  github: Pick<GitHubSetup, "api" | "owner" | "repo">,
  plan: DeployPlan,
  text: string,
): Promise<void> {
  const name = deploySecretName(plan, DEPLOY_SECRETS.appEnv);
  const environment = secretsEnvironment(plan);
  if (environment === undefined) {
    await github.api.setActionsSecret(github.owner, github.repo, name, text);
  } else {
    await github.api.setEnvironmentSecret(github.owner, github.repo, environment, name, text);
  }
  await deps.audit.append({
    kind: "secret-set",
    actor: "opscrew",
    action: `set secret ${name}${environment === undefined ? "" : ` in the environment ${environment}`}`,
    phase: "provision",
    target: `${github.owner}/${github.repo}`,
    decision: "approved",
  });
}
