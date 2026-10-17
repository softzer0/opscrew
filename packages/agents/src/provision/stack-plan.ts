import type {
  CreatedRecord,
  PortainerFacts,
  StackChange,
  StackPlan,
} from "@opscrew/connector-portainer";
import { DEPLOY_BRANCH } from "@opscrew/connector-portainer";
import type { ApprovalRecord } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PortainerDeployTarget, PortainerWeb } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  type AdapterFinding,
  adapterBlocked,
  describeAdapterPlan,
  type PortainerConnection,
  recordPortainerConnection,
} from "../shared";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "./portainer";
import type { ProvisionOptions } from "./types";

/** The stack step's outcome: the plan shown, and whether it was applied. */
export interface StackStepResult {
  plan: StackPlan;
  hash: string;
  applied: boolean;
  approval?: ApprovalRecord;
}

/** The plain stop for findings and blocked changes in Portainer: what was found and what to do. */
function portainerBlocked(
  findings: readonly AdapterFinding[],
  blocked: readonly StackChange[],
): OpsCrewError {
  return adapterBlocked({
    cannot: "OpsCrew cannot deploy to your Portainer yet",
    findings,
    blocked,
    ...(findings.some((finding) => finding.code === "registry-missing")
      ? {
          extraHint:
            "If you made the image public, run `opscrew provision --public-image`: OpsCrew cannot see a package's visibility before the first build.",
        }
      : {}),
    fallbackHint: "Fix what blocks these changes in Portainer, then run `opscrew provision` again.",
  });
}

/** Stops on blocking findings of the inspection or an environment of another architecture. */
export function requireUsableFacts(facts: PortainerFacts, target: PortainerDeployTarget): void {
  if (facts.findings.length > 0) throw portainerBlocked(facts.findings, []);
  const arch = facts.environment?.arch;
  if (arch !== undefined && arch !== target.arch) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/plan.yaml builds the app for ${target.arch}, but your Portainer environment runs on ${arch}. Nothing was changed.`,
      {
        hint: `Run \`opscrew design\` again so OpsCrew builds the image for ${arch}, then run \`opscrew provision\` again.`,
      },
    );
  }
}

/** Stops on a stack plan with findings or blocked changes. */
export function requireNoStackBlockers(plan: StackPlan): void {
  const blocked = plan.changes.filter((change) => change.state === "blocked");
  if (plan.findings.length > 0 || blocked.length > 0) {
    throw portainerBlocked(plan.findings, blocked);
  }
}

/**
 * Plain-English stack plan shown before the `stack-apply` approval: every change, its state and
 * reason, the findings, then the hash. No value, token, webhook or Portainer address.
 */
export function describeStackPlan(plan: StackPlan, hash: string, environment?: string): string {
  return describeAdapterPlan({
    heading: `Stack plan for your Portainer${environment === undefined ? "" : ` (environment "${environment}")`}`,
    items: plan.changes,
    findings: plan.findings,
    note: "OpsCrew sends the values of the app's variables, the webhook and the tokens only when it applies this plan; they are never shown or saved in a plan. It changes no other stack and never Portainer's own settings.",
    hashLabel: "Stack plan hash",
    hash,
  });
}

/** Actions of a change that send the app stack's values (and the repository token). */
const SENDS_VALUES = new Set(["create", "update", "redeploy"]);

/** Whether the plan's changes send the repository token or the registry token. */
export function sentTokens(plan: StackPlan): { repository: boolean; registry: boolean } {
  const changed = plan.changes.filter((change) => change.state === "change");
  return {
    repository: changed.some(
      (change) =>
        change.id === "app-stack" &&
        SENDS_VALUES.has(String(change.params.action)) &&
        change.params.repositoryAuthentication === true,
    ),
    registry: changed.some(
      (change) =>
        change.id === "registry" &&
        (change.params.action === "create" || change.params.action === "update"),
    ),
  };
}

/** How to make the read-only token of a private repository, which Portainer pulls the stack with. */
export const REPOSITORY_TOKEN_HINT = `Create a fine-grained token at https://github.com/settings/personal-access-tokens/new for only this repository with Contents: Read-only, set ${REPOSITORY_TOKEN_VAR} to it and run the command again. OpsCrew sends it only to your Portainer (for this stack) and never saves it.`;
/** How to make the registry token of a private image, and that `--public-image` avoids it. */
export const REGISTRY_TOKEN_HINT = `Create a classic token with only the read:packages scope at https://github.com/settings/tokens/new?scopes=read:packages, set ${REGISTRY_TOKEN_VAR} to it and run the command again (OpsCrew sends it only to your Portainer's registry entry and never saves it). If you made the image public on GitHub, run \`opscrew provision --public-image\` instead.`;

/** Stops plainly when a change sends a token that is not set (nothing in Portainer changed). */
export function requireTokens(
  sends: { repository: boolean; registry: boolean },
  present: { repository: boolean; registry: boolean },
): void {
  if (sends.repository && !present.repository) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `Your repository is private, so Portainer needs a read-only token to fetch the ${DEPLOY_BRANCH} branch, and ${REPOSITORY_TOKEN_VAR} is not set. Nothing in Portainer was changed.`,
      { hint: REPOSITORY_TOKEN_HINT },
    );
  }
  if (sends.registry && !present.registry) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `The app's image on GitHub Container Registry is private, so Portainer needs a registry entry with a read-only token, and ${REGISTRY_TOKEN_VAR} is not set. Nothing in Portainer was changed.`,
      { hint: REGISTRY_TOKEN_HINT },
    );
  }
}

/** Stops when asked to replace a token there is none of, before anything changes. */
export function requireReplaceable(
  options: Pick<ProvisionOptions, "replaceTokens">,
  repositoryPrivate: boolean,
  imagePrivate: boolean,
): void {
  if (options.replaceTokens?.repository === true && !repositoryPrivate) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Your repository is public, so Portainer fetches it without a token and there is no repository token to replace. Nothing was changed.",
      { hint: "Run the command without replacing the repository token." },
    );
  }
  if (options.replaceTokens?.registry === true && !imagePrivate) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The app's image is public, so Portainer pulls it without a registry entry and there is no registry token to replace. Nothing was changed.",
      { hint: "Run the command without replacing the registry token." },
    );
  }
}

/** Said when this run changes how visitors reach an app that already runs in Portainer. */
export const ROUTE_CHANGE_NOTE =
  "Visitors cannot reach the site on its new route until you merge the deploy pull request (the deploy workflow then writes the new stack file to the opscrew-deploy branch, which Portainer deploys) and your DNS or reverse proxy points at the new route.";

/**
 * True when the app's stack already exists (OpsCrew's record lists it) and this plan serves it
 * another way than it was last set up: by the recorded route (`appliedWeb`: the web mode, and the
 * port for `proxy`). A record without the route tells nothing.
 */
export function switchesWebRoute(
  target: PortainerDeployTarget,
  connection: PortainerConnection,
): boolean {
  const recorded = connection.created.stacks.some((stack) => stack.role === "app");
  if (!recorded || connection.appliedWeb === undefined) return false;
  return !sameWeb(connection.appliedWeb, target.web);
}

/** The same web route: the same mode, and for `proxy` the same port. */
function sameWeb(a: PortainerWeb, b: PortainerWeb): boolean {
  if (a.mode !== b.mode) return false;
  return a.mode !== "proxy" || (b.mode === "proxy" && a.port === b.port);
}

/** True when the record lists the app's stack. */
export function hasAppStack(created: Pick<CreatedRecord, "stacks">): boolean {
  return created.stacks.some((stack) => stack.role === "app");
}

/**
 * Records in `server.json` → `portainer` what OpsCrew created in Portainer (`created`), the
 * image's visibility the stacks were set up with (`publicImage`) and the web route of the app's
 * stack (`appliedWeb`); unchanged fields stay.
 */
export async function recordConnection(
  deps: Pick<PhaseDeps, "paths">,
  connection: PortainerConnection,
  update: { created?: CreatedRecord; publicImage?: boolean; appliedWeb?: PortainerWeb },
): Promise<PortainerConnection> {
  const { created, publicImage, appliedWeb } = update;
  const next: PortainerConnection = {
    ...connection,
    ...(created !== undefined
      ? {
          created: {
            stacks: created.stacks.map((stack) => ({ ...stack })),
            ...(created.registryId !== undefined ? { registryId: created.registryId } : {}),
            volumes: [...created.volumes],
          },
        }
      : {}),
    ...(publicImage !== undefined ? { publicImage } : {}),
    ...(appliedWeb !== undefined ? { appliedWeb: { ...appliedWeb } } : {}),
  };
  const same =
    created === undefined &&
    (publicImage === undefined || connection.publicImage === publicImage) &&
    (appliedWeb === undefined ||
      (connection.appliedWeb !== undefined && sameWeb(connection.appliedWeb, appliedWeb)));
  if (!same) await recordPortainerConnection(deps.paths, next);
  return next;
}
