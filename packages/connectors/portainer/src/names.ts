import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";

/** The Compose label that names a container's or volume's project (Portainer's stack name). */
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
/** The Compose label that names a container's service in its project. */
export const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
/** The Compose label of a one-off container (`docker compose run`): `True`. */
export const COMPOSE_ONEOFF_LABEL = "com.docker.compose.oneoff";

/** The branch of the app's repository Portainer builds the app stack from (research R5). */
export const DEPLOY_BRANCH = "opscrew-deploy";
/** Its full reference, as Portainer stores it. */
export const DEPLOY_REFERENCE = `refs/heads/${DEPLOY_BRANCH}`;
/** The compose file on the deploy branch. */
export const DEPLOY_COMPOSE_FILE = "compose.yaml";

/** The OpsCrew app name stacks derive from: plan-schema's rule (1 to 41 characters). */
export const AppNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, {
  message: "must be 1 to 41 lower-case letters, digits and dashes, starting with a letter or digit",
});

/** A name OpsCrew gives a stack or registry entry: always `opscrew-…`. */
export const OpsCrewNameSchema = z.string().regex(/^opscrew-[a-z0-9][a-z0-9-]{0,60}$/, {
  message: "must be a name OpsCrew gives (opscrew-<app>…)",
});

/** A Docker volume name. */
export const VolumeNameSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, { message: "must be a Docker volume name" });

/**
 * The stacks OpsCrew creates for one app, by role, in the order its record lists them: the stack
 * plan change that manages each, and what its name adds to `opscrew-<app>` (research R6).
 */
export const ROLES = {
  app: { change: "app-stack", suffix: "" },
  updater: { change: "updater-stack", suffix: "-updater" },
  "tunnel-connector": { change: "tunnel-connector-stack", suffix: "-portainer-tunnel" },
} as const;
export type Role = keyof typeof ROLES;
/** The roles in record order. */
export const ROLE_NAMES = Object.keys(ROLES) as [Role, ...Role[]];

/** The names of everything OpsCrew creates in Portainer for one app (research R6). */
export interface OpsCrewNames {
  /** The app's Git stack (and its Compose project): `opscrew-<app>`. */
  app: string;
  /** The updater stack: `opscrew-<app>-updater`. */
  updater: string;
  /** The Cloudflare connector stack for redeploys through Access: `opscrew-<app>-portainer-tunnel`. */
  tunnelConnector: string;
  /** The registry entry for the app's image: `opscrew-<app>`. */
  registry: string;
}

/** OpsCrew's names for an app; pass `Object.values(...)` minus `registry` to `inspectPortainer`. */
export function opscrewNames(app: string): OpsCrewNames {
  const valid = AppNameSchema.safeParse(app);
  if (!valid.success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The app name is not one OpsCrew can name Portainer stacks after.",
      {
        hint: "Use 1 to 41 lower-case letters, digits and dashes, starting with a letter or digit (the app name in opscrew/plan.yaml).",
      },
    );
  }
  const base = `opscrew-${valid.data}`;
  return {
    app: base,
    updater: stackName({ app: base }, "updater"),
    tunnelConnector: stackName({ app: base }, "tunnel-connector"),
    registry: base,
  };
}

/** The name of the app's stack of `role`. */
export function stackName(names: Pick<OpsCrewNames, "app">, role: Role): string {
  return `${names.app}${ROLES[role].suffix}`;
}

/** The stack names `inspectPortainer` should look for, for one app. */
export function opscrewStackNames(app: string): string[] {
  const names = opscrewNames(app);
  return ROLE_NAMES.map((role) => stackName(names, role));
}
