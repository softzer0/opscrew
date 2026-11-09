/**
 * `opscrew rotate <service>…` on this computer (025 plan.md 4.): the rotation's steps through this
 * computer's Docker under the local deploy lock: each service's `begin` and `finish` by `docker
 * exec -e OPSCREW_OLD -e OPSCREW_NEW` with the values only in the child's environment, the env
 * files in the app's folder rewritten as provision writes them (the rotated services' own, and the
 * app's `app.env` with its values swapped as on a server, `swapAppEnv`), and the app's containers
 * created again from them by Compose. The app is held meanwhile (`.snapshots/.held` saying
 * `rotation <hash>`, as `rotate.sh` holds a server), so a deploy here refuses until the rotation
 * finished or was undone. GitHub's deploy pause does not apply: no GitHub run deploys here (the
 * local runner is refused), and the local lock keeps provision out meanwhile.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OpsCrewError, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import {
  localComposeProject,
  processServices,
  RESTORE_HELD,
  ROTATION_HOLDER,
  SNAPSHOT_GENERATIONS,
  serviceSpec,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { projectObjects } from "../localhost/docker";
import { withLocalLock } from "../localhost/lock";
import {
  appFolder,
  computer,
  type LocalhostServices,
  requireOwnLocalApp,
} from "../localhost/services";
import { withAppEnv } from "./app-values";
import {
  type DockerRotation,
  type DockerRotationOptions,
  type DockerUndo,
  rotateThroughDocker,
} from "./portainer-localhost";
import { serviceEnvTexts, serviceSides, serviceValues, swapAppEnv } from "./values";
import type { RotationValues, ValuePair } from "./values-pending";

const WHERE = "on this computer";

/** The format that makes `docker inspect` print a container's command and entrypoint, never its env. */
const START_FORMAT = "[{{json .Config.Cmd}},{{json .Config.Entrypoint}}]";

const Words = z.array(z.string()).nullable();

/** {@link START_FORMAT}'s answer. */
const StartSchema = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "is not JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.tuple([Words, Words]));

/** How long Compose may take to create the app's containers again and see them healthy. */
const COMPOSE_TIMEOUT_MS = 10 * 60_000;
/** How long one command of a rotation may take in a container. */
const EXEC_TIMEOUT_MS = 2 * 60_000;

/**
 * Rotates the generated secrets of the services `names` of `plan`'s environment on this computer
 * (`rotateThroughDocker`), refused before anything changes for an app of another project here, an
 * app the local runner deploys (its deploy writes the env files from GitHub's secrets), a hold
 * that is not this rotation's, or an env file that holds neither value of its service. With
 * `options.undo`, the unfinished rotation's undo.
 * @throws OpsCrewError as `rotateThroughDocker`, and `PHASE_PRECONDITION` for those refusals.
 */
export function rotateLocalServices(
  deps: PhaseDeps,
  plan: DeployPlan,
  names: readonly string[],
  options: DockerRotationOptions & { services?: LocalhostServices } = {},
): Promise<DockerRotation | DockerUndo> {
  const folder = appFolder(deps.paths, plan);
  const held = join(folder, RESTORE_HELD);
  const project = localComposeProject(plan);
  const holder = (hash: string) => `${ROTATION_HOLDER} ${hash}`;
  /** The running container of `service` in the app's Compose project, when there is one. */
  const containerOf = async (service: string) =>
    (await projectObjects(deps, project)).containers.find(
      (c) => c.service === service && c.running,
    );

  /** `docker compose up` of `services` in the app's folder, which recreates the changed ones. */
  const compose = async (services: readonly string[]) => {
    if (services.length === 0) return;
    const result = await deps.runner.run(
      "docker",
      ["compose", "up", "-d", "--no-deps", "--wait", ...services],
      { cwd: folder, env: deps.env, timeoutMs: COMPOSE_TIMEOUT_MS },
    );
    if (result.exitCode === 0) return;
    const said = deps.redactor.redact(`${result.stderr}\n${result.stdout}`.trim()).slice(-1200);
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Docker Compose could not start ${services.join(", ")} with the values in place on this computer:\n${said}`,
      { hint: `Run \`docker compose ps\` in ${folder} to see what runs.` },
    );
  };
  /** The app's settings, `app.env`, with `values` swapped from one side to `which`. */
  const appEnvWith = async (values: RotationValues, which: keyof ValuePair, text: string) => {
    const { from, to } = await serviceSides(deps, plan, values, which);
    return withAppEnv(swapAppEnv(plan, text, values, from, to), values.app, which);
  };
  /**
   * The env files as provision writes them, with `values` on their `which` side: the rotated
   * services' own and, unless `servicesOnly`, the app's.
   */
  const rewrite = async (values: RotationValues, which: keyof ValuePair, servicesOnly = false) => {
    const texts = serviceEnvTexts(plan, await serviceValues(deps, plan, values, which));
    for (const name of Object.keys(values.services)) {
      const content = texts[`${name}.env`];
      if (content !== undefined) {
        await writeFileAtomic(join(folder, `${name}.env`), content, { mode: 0o600 });
      }
    }
    if (servicesOnly) return;
    const app = join(folder, "app.env");
    const text = await readTextIfExists(app);
    if (text !== undefined) {
      await writeFileAtomic(app, await appEnvWith(values, which, text), { mode: 0o600 });
    }
  };
  /** The rotated services that run and are created again for their new values. */
  const recreated = (values: RotationValues) =>
    plan.services
      .filter(
        (s) =>
          s.enabled &&
          values.services[s.name] !== undefined &&
          serviceSpec(s.kind).rotation.secrets.some((r) => r.recreate),
      )
      .map((s) => s.name);

  return rotateThroughDocker(
    deps,
    plan,
    names,
    {
      target: "localhost",
      where: WHERE,
      valuesText:
        "The app's env files on this computer get the new values in place, and Docker Compose creates the app's containers again from them (and each service that restarts with its new value).",
      async check(steps, values, hash) {
        await requireOwnLocalApp(deps.paths, plan, "deploy");
        if (plan.environment?.runner === "local") {
          throw new OpsCrewError(
            "PHASE_PRECONDITION",
            `The local runner deploys the ${deps.paths.environment} environment from GitHub's secrets, which hold its env files, so a rotation on this computer alone would be undone by its next deploy. Nothing was changed.`,
            {
              hint: "Rotating the services of an environment the local runner deploys is not supported yet.",
            },
          );
        }
        const hold = (await readTextIfExists(held))?.trim();
        if (hold !== undefined && hold !== holder(hash)) {
          throw new OpsCrewError(
            "PHASE_PRECONDITION",
            hold.startsWith(`${ROTATION_HOLDER} `)
              ? `Another credential rotation holds the app on this computer (the rotation of the plan ${hold.slice(ROTATION_HOLDER.length + 1)}). Nothing was changed.`
              : "A restore holds the app on this computer, so its data may be partly restored. Nothing was changed.",
            {
              hint: hold.startsWith(`${ROTATION_HOLDER} `)
                ? "Finish that rotation, or put its old values back with --undo, then run the command again."
                : "Finish the restore with `opscrew restore <copy>`, or run `sh snapshot.sh resume` in the app's folder, then run the command again.",
            },
          );
        }
        for (const service of new Set(steps.filter((s) => s.runs).map((s) => s.service.name))) {
          const file = `${service}.env`;
          const text = (await readTextIfExists(join(folder, file))) ?? "";
          const holds = Object.values(values.services[service] ?? {}).every(
            (pair) => text.includes(pair.old) || text.includes(pair.new),
          );
          if (!holds) {
            throw new OpsCrewError(
              "PHASE_PRECONDITION",
              `${file} in the app's folder on this computer does not hold the value OpsCrew keeps for ${service}, so OpsCrew does not know which one it runs with. Nothing was changed.`,
              {
                hint: "Run `opscrew provision` so the app's folder has the values this computer keeps, then run the command again.",
              },
            );
          }
        }
        // The app's settings must take the new values as OpsCrew writes them (`swapAppEnv` stops
        // on a value of the user's own that quotes one), before anything changes.
        const app = await readTextIfExists(join(folder, "app.env"));
        if (app !== undefined) await appEnvWith(values, "new", app);
      },
      locked: (fn) => withLocalLock(deps.paths, computer(deps, options.services).sleep, fn),
      async startCommand(service) {
        const container = await containerOf(service);
        if (container === undefined) return undefined;
        const result = await deps.runner.run(
          "docker",
          ["inspect", "--format", START_FORMAT, container.name],
          { timeoutMs: 30_000 },
        );
        const said = StartSchema.safeParse(result.stdout.trim());
        if (result.exitCode !== 0 || !said.success) {
          throw new OpsCrewError(
            "COMMAND_FAILED",
            `Docker could not tell how ${service} started on this computer.`,
            { hint: `Run \`docker compose ps\` in ${folder} to see what runs.` },
          );
        }
        const [command, entrypoint] = said.data;
        return {
          ...(command === null ? {} : { command }),
          ...(entrypoint === null ? {} : { entrypoint }),
        };
      },
      async exec(service, command, values) {
        const container = await containerOf(service);
        if (container === undefined) {
          throw new OpsCrewError(
            "COMMAND_FAILED",
            `${service} does not run on this computer, so OpsCrew could not change its value.`,
            { hint: `Run \`docker compose up -d ${service}\` in ${folder}.` },
          );
        }
        // `-e NAME` takes each value from this child's environment: never on its command line.
        const result = await deps.runner.run(
          "docker",
          ["exec", "-e", "OPSCREW_OLD", "-e", "OPSCREW_NEW", container.name, ...command],
          {
            env: { ...deps.env, OPSCREW_OLD: values.old, OPSCREW_NEW: values.new },
            timeoutMs: EXEC_TIMEOUT_MS,
          },
        );
        return result.exitCode;
      },
      async hold(hash) {
        await mkdir(dirname(held), { recursive: true });
        await writeFileAtomic(held, `${holder(hash)}\n`, { mode: 0o644 });
      },
      async release(hash) {
        if ((await readTextIfExists(held))?.trim() === holder(hash))
          await rm(held, { force: true });
      },
      async restart(step, values) {
        // Only this step's secrets are new in its service's env file; its others wait for theirs.
        const { name } = step.service;
        const own = Object.fromEntries(
          step.rotation.secrets.flatMap((secret) => {
            const pair = values.services[name]?.[secret];
            return pair === undefined ? [] : [[secret, pair]];
          }),
        );
        await rewrite({ names: [name], services: { [name]: own } }, "new", true);
        await compose([name]);
      },
      async writeValues(which, values) {
        await rewrite(values, which);
        await compose(recreated(values));
      },
      // The app's folder's generations file, which its snapshots name (T2514), as on a server.
      async generation(service, generation) {
        const file = join(folder, SNAPSHOT_GENERATIONS);
        const others = ((await readTextIfExists(file)) ?? "")
          .split("\n")
          .filter((line) => line !== "" && !line.startsWith(`${service} `));
        await mkdir(dirname(file), { recursive: true });
        await writeFileAtomic(file, `${[...others, `${service} ${generation}`].join("\n")}\n`);
      },
      async switchApp() {
        await compose(["app", ...processServices(plan)]);
      },
    },
    options,
  );
}
