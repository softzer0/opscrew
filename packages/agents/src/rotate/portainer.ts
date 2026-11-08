/**
 * `opscrew rotate <service>…` in the user's Portainer (025 plan.md 4.): each service's `begin` and
 * `finish` run in its container through Docker's exec on Portainer's Docker proxy, the values only
 * in the exec's environment; the new values reach the app's stack through its stack plan (ADR
 * 0012: values by their keyed fingerprints), planned and shown before the rotation's approval,
 * its hash bound into the rotation's, and applied under that one approval, which creates again
 * the containers whose values changed. An undo's stack plan asks its own `stack-apply` approval.
 * The app's deploys are paused in GitHub as the servers' rotation pauses them
 * (`withDeploysPausedUntilDone`: still paused after a failure, until the rotation or its undo is
 * run to its end). OpsCrew changes nothing else in Portainer and never its host.
 */
import type { PortainerClient } from "@opscrew/connector-portainer";
import { OpsCrewError } from "@opscrew/core";
import { portainerStackName, portainerTarget } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { withDeploysPausedUntilDone } from "../move/deploys";
import { setupGitHub } from "../provision/credentials";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import {
  type PlannedStacks,
  type PortainerStacksSetup,
  portainerStacksFor,
} from "../provision/portainer-flow";
import type { ProvisionServices } from "../provision/types";
import { type AppEnvironment, dotenvLine, parseDotenv } from "../shared/app-env";
import { gitClient } from "../shared/github";
import { portainerClientFor } from "../shared/portainer-stacks";
import { hidePortainerAddress } from "../shared/server-address";
import { withAppRecord } from "./app-values";
import {
  boundHash,
  type DockerRotation,
  type DockerRotationOptions,
  type DockerUndo,
  rotateThroughDocker,
} from "./portainer-localhost";
import { type ServiceValues, serviceValues, swapAppEnv } from "./values";
import type { RotationValues } from "./values-pending";

/** What a rotation in Portainer reaches; each defaults to the real one. */
export interface PortainerRotationServices {
  /** Provision's services: Portainer's client, GitHub, Cloudflare, the engine, sleep and clock. */
  provision?: ProvisionServices;
  /** Docker on the environment through Portainer's proxy (default: the recorded Portainer's). */
  docker?: Pick<PortainerClient, "listContainers" | "containerExec" | "containerInspect">;
}

/** Where it runs, in the plan's and the reporter's words. */
const WHERE = "in your Portainer";

/**
 * `environment` with the new side of `values`: the services' secrets (`to`), and the app's settings
 * swapped as on a server (`swapAppEnv`, which stops on a value of the user's own that quotes one).
 */
function withNewValues(
  plan: DeployPlan,
  environment: AppEnvironment,
  values: RotationValues,
  sides: { from: ServiceValues; to: ServiceValues },
): AppEnvironment {
  // One value at a time: a value the swap leaves as it is stays byte for byte (a dotenv line does
  // not read back every value as written); a swapped one is OpsCrew's own address or key.
  const withServices = Object.fromEntries(
    Object.entries(environment.values.app).map(([name, value]) => {
      const line = `${dotenvLine(name, value)}\n`;
      const swapped = swapAppEnv(plan, line, values, sides.from, sides.to);
      return [name, swapped === line ? value : (parseDotenv(swapped).get(name) ?? value)];
    }),
  );
  // The app's own secrets by name (`./app-values`).
  const app = withAppRecord(withServices, values.app, "new");
  return {
    ...environment,
    values: {
      ...environment.values,
      app,
      services: { ...environment.values.services, ...sides.to },
    },
  };
}

/**
 * Rotates the generated secrets of the services `names` of `plan`'s environment in the user's
 * Portainer (`rotateThroughDocker`): before the approval, the app's stack plan with the new values
 * (`portainerStacksFor`), shown and bound into the rotation's hash; once approved, the deploys
 * paused for the whole run, `begin` and `finish` through Docker's exec there, and that stack plan
 * applied under the rotation's approval.
 * With `options.undo`, the unfinished rotation's undo, whose stack plan has its own approval.
 * @throws OpsCrewError as `rotateThroughDocker` and provision's preconditions, before anything
 * changes when Portainer or GitHub can't be reached.
 */
export function rotatePortainerServices(
  deps: PhaseDeps,
  plan: DeployPlan,
  names: readonly string[],
  options: DockerRotationOptions & { services?: PortainerRotationServices } = {},
): Promise<DockerRotation | DockerUndo> {
  const { environmentId } = portainerTarget(plan.target);
  const stack = portainerStackName(plan);
  // The rotation never asks for the app's values: one missing shows as a change of the stack.
  const { askEnv: _ask, ...provision } = options.services?.provision ?? {};
  let docker: PortainerRotationServices["docker"];
  const connect = async () => {
    if (docker === undefined) {
      const connection = await requirePortainerConnection(deps, plan);
      // Portainer's address (and its host name) is never printed.
      hidePortainerAddress(deps.redactor, connection.url);
      docker =
        options.services?.docker ??
        portainerClientFor(deps, {
          connection,
          token: requirePortainerToken(deps),
          client: provision.portainer?.client,
        });
    }
    return docker;
  };
  const command = async () => {
    const { root, environment, app } = deps.paths;
    return `opscrew rotate ${names.join(" ")}${await commandFlags(root, environment, app)}`;
  };
  /** The app's stacks, with the values this computer keeps (`rewrite`: changed first). */
  const stacksFor = async (
    rewrite?: (environment: AppEnvironment) => AppEnvironment,
  ): Promise<PortainerStacksSetup> =>
    portainerStacksFor(deps, plan, provision, {
      phase: "provision",
      command: await command(),
      ...(rewrite === undefined ? {} : { rewrite }),
    });
  /** The stack plan the rotation's approval covers, planned before it. */
  let prepared: { setup: PortainerStacksSetup; planned: PlannedStacks; bound: string } | undefined;
  /** The running container of `service` in the app's stack, when there is one. */
  const containerOf = async (service: string) =>
    (await (await connect()).listContainers(environmentId)).find(
      (c) => c.project === stack && c.service === service && c.running,
    );
  return rotateThroughDocker(
    deps,
    plan,
    names,
    {
      target: "portainer",
      where: WHERE,
      valuesText:
        "The app's stack gets the new values through its stack plan, shown above and applied under this approval (the values by their fingerprints only); Portainer creates the containers whose values changed again, the app's among them.",
      async check() {
        await connect();
      },
      async prepare(values, identity, untouched) {
        // Before the switch began: with the old values the stack plan is empty, or it holds
        // changes the rotation did not make, which its approval must not carry.
        if (untouched) {
          const current = await stacksFor();
          const planned = await current.stacks.plan(current.outputs);
          if (planned.changes > 0) {
            const { root, environment, app } = deps.paths;
            throw new OpsCrewError(
              "PHASE_PRECONDITION",
              `The app's stacks in your Portainer have changes besides the rotation's (${planned.changes} ${planned.changes === 1 ? "change" : "changes"} with the values this computer keeps; the stack plan is shown above), so OpsCrew doesn't rotate yet. Nothing was changed.`,
              {
                hint: `Run \`opscrew provision${await commandFlags(root, environment, app)}\` first so the stacks are as the plan says, then run the command again.`,
              },
            );
          }
        }
        const sides = {
          from: await serviceValues(deps, plan, values, "old"),
          to: await serviceValues(deps, plan, values, "new"),
        };
        const setup = await stacksFor((environment) =>
          withNewValues(plan, environment, values, sides),
        );
        const planned = await setup.stacks.plan(setup.outputs);
        prepared = { setup, planned, bound: boundHash(identity, planned.hash) };
        return {
          hash: planned.hash,
          what: `Its stack plan's hash: ${planned.hash} (${planned.changes} ${planned.changes === 1 ? "change" : "changes"}).`,
        };
      },
      async locked(fn, rotation) {
        // Deploys stay paused after a failure, until the rotation or its undo is run to its end.
        const github = await setupGitHub(deps, gitClient(deps), provision);
        return withDeploysPausedUntilDone(deps, github, plan, provision, rotation, fn);
      },
      async startCommand(service) {
        const container = await containerOf(service);
        if (container === undefined) return undefined;
        const inspected = await (await connect()).containerInspect(environmentId, container.id);
        return {
          ...(inspected.command === undefined ? {} : { command: inspected.command }),
          ...(inspected.entrypoint === undefined ? {} : { entrypoint: inspected.entrypoint }),
        };
      },
      async exec(service, words, values) {
        const container = await containerOf(service);
        if (container === undefined) {
          throw new OpsCrewError(
            "COMMAND_FAILED",
            `${service} does not run in the app's stack ${stack} in your Portainer, so OpsCrew could not change its value.`,
            { hint: `Start the stack in Portainer (Stacks → ${stack}).` },
          );
        }
        return (await connect()).containerExec(environmentId, container.id, {
          command: words,
          env: { OPSCREW_OLD: values.old, OPSCREW_NEW: values.new },
        });
      },
      // The values this computer keeps are what the stack plan sends.
      async writeValues() {},
      async switchApp(which, approval) {
        if (which === "old" || approval === undefined) {
          // An undo: the stack plan with the old values, approved by its own hash.
          const setup = await stacksFor();
          await setup.stacks.step(setup.outputs, { planOnly: false });
          return;
        }
        if (prepared === undefined) {
          throw new OpsCrewError(
            "INTERNAL",
            "The rotation's stack plan was not planned before it.",
          );
        }
        // Exactly the stack plan shown, only under the approval its hash is bound into.
        if (!approval.approved || approval.planHash !== prepared.bound) {
          throw new OpsCrewError(
            "INTERNAL",
            "The rotation's stack plan is applied only under the approval bound to its hash.",
          );
        }
        await prepared.setup.stacks.apply(prepared.planned, approval);
      },
    },
    options,
  );
}
