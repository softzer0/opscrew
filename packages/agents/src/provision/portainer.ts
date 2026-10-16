import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import { join } from "node:path";
import { OpsCrewError, type ProjectPaths } from "@opscrew/core";
import { portainerTarget } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { PORTAINER_TOKEN_VAR } from "../providers";
import {
  ensureSecretFile,
  hidePortainerAddress,
  type PortainerConnection,
  readPortainerConnection,
  readSecretFile,
  type SecretFile,
} from "../shared";

/** The read-only token for a private repository, which Portainer fetches the deploy branch with. */
export const REPOSITORY_TOKEN_VAR = "OPSCREW_REPO_READ_TOKEN";
/** The classic token with only `read:packages` for the registry entry of a private image. */
export const REGISTRY_TOKEN_VAR = "OPSCREW_GHCR_READ_TOKEN";

/** Hosts that mean "this computer": inside a container they are the container itself. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `~/.opscrew/projects/<id>/portainer-env.key` (0600): the key of the values' fingerprints. */
export function portainerValueKeyFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "portainer-env.key");
}

/** `~/.opscrew/projects/<id>/portainer-webhook` (0600): the app stack's webhook id, a secret. */
export function portainerWebhookFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "portainer-webhook");
}

/** `.opscrew/plans/stack-<hash>.json`: the stack plan the hash names, kept for review and audit. */
export function stackPlanFile(paths: Pick<ProjectPaths, "files">, hash: string): string {
  return join(paths.files.plansDir, `stack-${hash}.json`);
}

/**
 * The value key: 32 random bytes in {@link portainerValueKeyFile}, created once (mode 0600). With it
 * OpsCrew compares the values in Portainer with this computer's as keyed fingerprints, so a changed
 * secret shows by its name only and a plan is bound to the values it sends. A damaged file stops
 * instead of being replaced silently.
 */
export async function ensurePortainerValueKey(
  deps: Pick<PhaseDeps, "paths">,
  randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
): Promise<Uint8Array> {
  const file = portainerValueKeyFile(deps.paths);
  const key = await ensureSecretFile(
    {
      file,
      valid: (text) => {
        const bytes = Buffer.from(text, "base64");
        return bytes.length === 32 && bytes.toString("base64") === text;
      },
      damaged: {
        message: `OpsCrew's value key for your Portainer (${file}) is damaged, so it cannot compare the values in Portainer with this computer's. Nothing was changed.`,
        hint: "Delete the file and run `opscrew provision` again: OpsCrew makes a new key and then sends every value to Portainer once more (you approve that plan as usual).",
      },
    },
    () => Buffer.from(randomBytes(32)).toString("base64"),
  );
  return new Uint8Array(Buffer.from(key, "base64"));
}

/**
 * The app stack's webhook id from {@link portainerWebhookFile}, made once (a random UUID, mode
 * 0600). It alone lets anyone ask Portainer to redeploy the app, so it is never printed, planned,
 * audited or committed. `undefined` when it does not exist and `create` is false.
 */
export async function portainerWebhookId(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  options: { create: boolean; randomUUID?: () => string },
): Promise<string | undefined> {
  const file = portainerWebhookFile(deps.paths);
  const secret: SecretFile = {
    file,
    valid: (text) => UUID.test(text),
    damaged: {
      message: `OpsCrew's record of the app stack's webhook (${file}) is damaged. Nothing was changed.`,
      hint: "Delete the file and run `opscrew provision` again: OpsCrew makes a new webhook and sets it on the app's stack (you approve that plan as usual).",
    },
  };
  const id = options.create
    ? await ensureSecretFile(secret, () => (options.randomUUID ?? nodeRandomUUID)().toLowerCase())
    : await readSecretFile(secret);
  if (id !== undefined) deps.redactor.addLiteral(id, "portainer-webhook");
  return id;
}

/**
 * Portainer's address as a container on the Portainer host reaches it: the user's address, with
 * `localhost` (Portainer on the same computer) replaced by `host.docker.internal`, which the
 * updater and the Cloudflare connector map to the host. Never printed.
 */
export function portainerContainerUrl(url: string): string {
  const parsed = new URL(url);
  if (LOOPBACK.has(parsed.hostname)) parsed.hostname = "host.docker.internal";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * The stop when the interview on this computer chose another Portainer environment than
 * `opscrew/plan.yaml` deploys to (`PHASE_PRECONDITION`, nothing changed). `mismatch` names both
 * without what stayed as it was, for a command that changes nothing anyway (`opscrew secure`).
 */
export class PortainerEnvironmentError extends OpsCrewError {
  readonly mismatch: string;

  constructor(mismatch: string) {
    super("PHASE_PRECONDITION", `${mismatch} Nothing was changed.`, {
      hint: "Run `opscrew design` again so the plan uses the environment you chose, then run `opscrew provision` again.",
    });
    this.name = "PortainerEnvironmentError";
    this.mismatch = mismatch;
  }
}

/**
 * How OpsCrew reaches the user's Portainer, from `.opscrew/server.json`, checked against the plan:
 * the interview must have recorded it, for the environment the plan names (else
 * {@link PortainerEnvironmentError}).
 */
export async function requirePortainerConnection(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  plan: Pick<DeployPlan, "target">,
): Promise<PortainerConnection> {
  const target = portainerTarget(plan.target);
  const connection = await readPortainerConnection(deps.paths);
  if (connection === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew does not know how to reach your Portainer on this computer, so it changed nothing.",
      {
        hint: "Run `opscrew interview` and answer the Portainer questions (its address and the environment), then run `opscrew provision` again.",
      },
    );
  }
  if (connection.environmentId !== target.environmentId) {
    throw new PortainerEnvironmentError(
      `opscrew/plan.yaml deploys to Portainer environment ${target.environmentId}, but the interview on this computer chose environment ${connection.environmentId} (${connection.environmentName}).`,
    );
  }
  // Portainer's address (and its host name) is never printed.
  hidePortainerAddress(deps.redactor, connection.url);
  return connection;
}

/** `PORTAINER_API_KEY`, registered with the redactor; stops plainly when it is not set. */
export function requirePortainerToken(deps: Pick<PhaseDeps, "env" | "redactor">): string {
  const token = deps.env[PORTAINER_TOKEN_VAR]?.trim();
  if (token === undefined || token === "") {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `No Portainer access token found: set ${PORTAINER_TOKEN_VAR}. Nothing was changed.`,
      {
        hint: `In Portainer, open your user menu → My account → Access tokens and add a token (for an administrator, or for a user who may manage stacks on the environment), then set ${PORTAINER_TOKEN_VAR} to it. OpsCrew reads it only from this environment variable and never saves it.`,
      },
    );
  }
  deps.redactor.addLiteral(token, PORTAINER_TOKEN_VAR);
  return token;
}
