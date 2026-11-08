/**
 * `opscrew rotate beszel` (025 plan.md 10., US8, FR-2511): Beszel's hub password, its agent's token
 * and the hub's key get new values through Beszel's add-on host plan, approved by its hash (ADR
 * 0011). Its apply sets the new password in the running hub first (the hub makes its accounts from
 * `hub.env` at its first start only), then writes the files, and the hub and the agent start again on
 * the new key and token. The new values stay beside the old in the environment's unfinished rotation
 * until done; then they become this computer's, the rotation is recorded and the recovery copy
 * refreshed.
 */
import { OpsCrewError } from "@opscrew/core";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import { beszelHubPlan } from "../addons/run";
import { newBeszelHubSecrets, readBeszelSecrets, writeBeszelSecrets } from "../addons/secrets";
import { ADDON_PHASE } from "../addons/settings";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { serverForNetwork } from "../provision/servers";
import { approveAndApplyHostPlan } from "../shared";
import {
  type AddonRotation,
  type AddonRotationOptions,
  addonRotationValues,
  beginAddonRotation,
  finishAddonRotation,
  requireAddonServers,
} from "./addons-monitoring";
import { assertValuesCurrent } from "./record";

/** Beszel's hub secrets that rotate, as `beszel_secrets.json` names them. */
const SECRETS = ["password", "token", "hubKey", "hubPublicKey"] as const;

/**
 * Rotates Beszel's hub mode secrets of `plan`'s environment (`deps.paths`) on the app's server:
 * new ones made on this computer, then Beszel's host plan, shown and approved by its hash, with
 * the secrets passed only on apply. Refused before any change when Beszel is not on in hub mode
 * (agent mode's token is the user's hub's), without a deployment, while a move is under way, by
 * the two-computer guard, while another rotation is unfinished, and when this computer has not
 * Beszel's secrets. A run that stopped goes on with the same values when the command is run again.
 * @throws OpsCrewError `INVALID_INPUT`, `PHASE_PRECONDITION`, and the host plan's refusal.
 */
export async function rotateBeszel(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: AddonRotationOptions = {},
): Promise<AddonRotation> {
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const command = `opscrew rotate beszel${flags}`;
  const beszel = plan.observability?.beszel;
  if (beszel?.enabled !== true || beszel.mode !== "hub") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      beszel?.enabled === true
        ? `Beszel runs in agent mode in ${environment}: its token is the one your hub gave, not OpsCrew's. Nothing was changed.`
        : `Beszel is off in ${environment}, so it has no credentials to rotate. Nothing was changed.`,
      {
        hint:
          beszel?.enabled === true
            ? "Make a new token for this server in your hub, then turn Beszel on again with it in OPSCREW_BESZEL_TOKEN (`opscrew addon enable beszel`)."
            : `\`opscrew rotate${flags}\` lists what can be rotated.`,
      },
    );
  }
  requireAddonServers(plan, "Beszel", flags);
  await assertValuesCurrent(deps);
  const pending = await addonRotationValues(deps, "beszel", SECRETS, flags, async () => {
    const kept = await readBeszelSecrets(deps);
    if (kept?.mode !== "hub") {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `This computer does not keep Beszel's secrets of ${environment} (${deps.paths.files.beszelSecrets}), so OpsCrew can't rotate them. Nothing was changed.`,
        {
          hint: `Run the command on the computer that turned Beszel on, or bring its secrets back from the recovery copy (\`opscrew secrets restore${flags}\`), then run it again.`,
        },
      );
    }
    const made = newBeszelHubSecrets(deps.redactor);
    return Object.fromEntries(SECRETS.map((name) => [name, { old: kept[name], new: made[name] }]));
  });
  const value = (name: (typeof SECRETS)[number]) => {
    const pair = pending.services.beszel?.[name];
    if (pair === undefined) throw new Error(`The rotation of Beszel has no ${name}.`);
    return pair.new;
  };
  const hub = {
    mode: "hub" as const,
    password: value("password"),
    token: value("token"),
    hubKey: value("hubKey"),
    hubPublicKey: value("hubPublicKey"),
  };
  const server = await serverForNetwork(
    deps,
    { plan, services: options.services ?? {}, ownRun: undefined, extraOwn: [], phase: ADDON_PHASE },
    APP_SERVER,
  );
  const own = plan.target.provider === "own";
  const where = own ? "your server" : "the server";
  const outcome = await approveAndApplyHostPlan(deps, {
    plan: beszelHubPlan(plan, hub, own ? server.facts : undefined),
    remote: server.remote,
    apply: server.apply,
    verifyLogin: server.verifyLogin,
    title: `Rotate Beszel's dashboard password, its agent's token and the hub's key on ${where}`,
    server: where,
    upToDate: `Beszel on ${where} already runs with the new values; nothing on it changes.`,
    command,
    phase: ADDON_PHASE,
    intro: [
      "The new password is set in the running hub first (it makes its dashboard's login from its settings at its first start only), then Beszel's files get the new values, and the hub and its agent start again on the new key and token: the dashboard is down and no figures are kept for those seconds. Everyone signed in to the dashboard signs in again with the new password.",
    ],
    // Read once the plan is approved, right before its apply: the rotation has begun from here.
    secrets: async () => {
      await beginAddonRotation(deps, pending);
      return { beszelPassword: hub.password, beszelToken: hub.token, beszelHubKey: hub.hubKey };
    },
    applying: `Rotating Beszel's values on ${where}`,
  });
  const copy = await finishAddonRotation(deps, plan, "beszel", () =>
    writeBeszelSecrets(deps.paths, hub),
  );
  deps.reporter.success(
    `Rotated Beszel's dashboard password, its agent's token and the hub's key in ${environment}: the old ones no longer work. Sign in to the dashboard with the new password, kept in ${deps.paths.files.beszelSecrets} (\`opscrew addon open beszel${flags}\` opens it).`,
  );
  return { hostPlanHashes: [outcome.hash], copy };
}
