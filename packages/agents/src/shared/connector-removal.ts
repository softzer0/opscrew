/**
 * Servers the provider's Terraform cannot remove, removed through its connector (ADR 0029, D10).
 * The approved plan still lists each such server's deletion, so its hash, its approval and the
 * typed name cover it. After the approval, and after the shutdown the flow does first, OpsCrew
 * cancels each through the connector's `cancelServer`, takes it out of the state, plans again with
 * the approved plan's options, and applies that plan only when its changes are the approved plan's
 * without those deletions. Contabo's Terraform provider sends the cancel without the body Contabo
 * requires (research R8).
 */
import { rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type {
  IacApplyResult,
  IacEngine,
  PhaseName,
  PlanSummary,
  ResourceChange,
  ServerSnapshotApi,
} from "@opscrew/contracts";
import { isRecord, listText, OpsCrewError, upperFirst } from "@opscrew/core";
import { type CloudProvider, isCloudProvider } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS, cloudProvider } from "@opscrew/providers";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { vpsConnector } from "../providers";
import { maskSensitivePlanJson } from "../provision/plan-json";
import { planStop } from "./adapter-plan";
import { continued, hintOf, reasonOf } from "./errors";

/** What the apply of an approved plan needs of the run. */
export interface ConnectorRemovalRun {
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version" | "reporter" | "audit">;
  /** Phase recorded in the audit entries. */
  phase: PhaseName;
  /** The command that goes on after a stop, e.g. `opscrew destroy`. */
  command: string;
  engine: IacEngine;
  /** Absolute root module directory. */
  dir: string;
  /** Engine environment: provider tokens and `TF_ENCRYPTION`. Never logged. */
  env: Record<string, string | undefined>;
  /** The server API the run was given for a provider (tests), else its connector's. */
  servers?: ((provider: CloudProvider) => ServerSnapshotApi | undefined) | undefined;
}

/** An approved plan: its file and hash, its changes, and its JSON, which holds the servers' ids. */
export type ApprovedPlan = Pick<PlanSummary, "planFile" | "planHash" | "changes"> & {
  planJson?: unknown;
};

/** A server the approved plan deletes (or replaces) that its provider's connector removes. */
interface ConnectorServer {
  change: ResourceChange;
  provider: CloudProvider;
  /** Its id as the plan's prior state records it; none when the plan JSON does not say. */
  id: string | undefined;
  /** `the Contabo server 202611001`, or with its address when the plan does not say its id. */
  label: string;
}

/** A server whose id the plan says. */
type KnownServer = ConnectorServer & { id: string };

/** What a stop after a cancel says to do: plan afresh, never apply the approved plan again. */
function afresh(command: string): string {
  return `Run \`${command}\` again without \`--approve\` to plan afresh`;
}

const PlanBeforeSchema = z.looseObject({
  resource_changes: z
    .array(
      z.looseObject({
        address: z.string(),
        change: z.looseObject({ before: z.unknown().optional() }),
      }),
    )
    .optional(),
});
const BeforeIdSchema = z.looseObject({
  id: z.union([z.string().trim().min(1), z.number().int().nonnegative().transform(String)]),
});

/** The servers `approved` deletes or replaces whose provider has `connectorRemoval`, in plan order. */
function connectorServers(approved: ApprovedPlan): ConnectorServer[] {
  const removing = CLOUD_PROVIDERS.filter((provider) => provider.terraform.connectorRemoval);
  const json = PlanBeforeSchema.safeParse(approved.planJson);
  const changes = json.success ? (json.data.resource_changes ?? []) : [];
  return approved.changes.flatMap((change): ConnectorServer[] => {
    if (change.action !== "delete" && change.action !== "replace") return [];
    const provider = removing.find((p) => p.terraform.serverResourceType === change.type)?.id;
    if (provider === undefined || !isCloudProvider(provider)) return [];
    const before = changes.find((c) => c.address === change.address)?.change.before;
    const parsed = BeforeIdSchema.safeParse(before);
    const id = parsed.success ? parsed.data.id : undefined;
    const { displayName, serverNoun } = cloudProvider(provider);
    const label = `the ${displayName} ${serverNoun} ${id ?? change.address}`;
    return [{ change, provider, id, label }];
  });
}

/**
 * Cancels `server` through its provider's connector, says and audits it with the day its contract
 * ends. `done` are the servers cancelled before it.
 * @throws OpsCrewError `PROVIDER_ERROR` when it fails: the state is untouched.
 */
async function cancel(
  run: ConnectorRemovalRun,
  server: KnownServer,
  done: readonly ConnectorServer[],
): Promise<void> {
  const { deps } = run;
  const { displayName, serverNoun, credentials, texts } = cloudProvider(server.provider);
  const { console } = texts.destroy;
  // As destroy's other calls on the server are audited.
  const target = `${server.provider} server ${server.id}`;
  const audit = (action: string, detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: run.phase,
      target,
      detail: deps.redactor.redact(detail),
    });
  deps.reporter.step(`Cancelling ${server.label} through ${displayName}'s API`);
  await audit("cancel server", `${server.change.address}, which the approved plan deletes`);
  let ends: string;
  try {
    const api = run.servers?.(server.provider) ?? vpsConnector(server.provider, deps).servers;
    if (api === undefined) {
      throw new OpsCrewError(
        "CREDENTIALS_MISSING",
        `its credentials (${listText(credentials.envVars)}) are not set`,
        { hint: "Set them. " },
      );
    }
    if (api.cancelServer === undefined) {
      throw new Error(`OpsCrew's ${displayName} connector cannot cancel a ${serverNoun}`);
    }
    ends = await api.cancelServer(server.id);
  } catch (error) {
    const reason = reasonOf(error);
    await audit("cancel failed", reason);
    const already = done.length > 0 ? ` ${cancelledText(done)} cancelled already.` : "";
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      deps.redactor.redact(
        `OpsCrew could not cancel ${server.label}: ${reason}. Nothing more was applied, and the infrastructure state is unchanged.${already}`,
      ),
      {
        hint: deps.redactor.redact(
          `${hintOf(error)}Check it in ${console}, then run \`${run.command}\` again; a ${serverNoun} cancelled already is not cancelled again. It is shut down: start it again in ${console} if you keep it.`,
        ),
        cause: error,
      },
    );
  }
  await audit("cancelled server", `contract ends ${ends}`);
  deps.reporter.success(`Cancelled ${server.label}: its contract ends on ${ends}.`);
}

/** `The Contabo server 202611001 is` or `The Contabo server 1 and the Contabo server 2 are`. */
function cancelledText(servers: readonly ConnectorServer[]): string {
  const text = listText(servers.map((server) => server.label));
  return `${upperFirst(text)} ${servers.length === 1 ? "is" : "are"}`;
}

/** `create module.x` for a change, compared by its address and action. */
const changeKey = (change: Pick<ResourceChange, "action" | "address">) =>
  `${change.action} ${change.address}`;

/**
 * The differences between the plan made again and the approved one without the deletions of
 * `removed` (a replaced server's is then its create): what it has that it should not, then what
 * it lacks.
 */
function differences(
  approved: readonly ResourceChange[],
  again: readonly ResourceChange[],
  removed: ReadonlySet<string>,
): string[] {
  const expected = approved.flatMap((change) =>
    !removed.has(change.address)
      ? [changeKey(change)]
      : change.action === "replace"
        ? [changeKey({ ...change, action: "create" })]
        : [],
  );
  const got = again.map(changeKey);
  return [
    ...got
      .filter((key) => !expected.includes(key))
      .map((key) => `${key}: not in the approved plan`),
    ...expected
      .filter((key) => !got.includes(key))
      .map((key) => `${key}: in the approved plan, not in the plan made again`),
  ];
}

/**
 * The differences between what the two plans were made from: their configuration and each input
 * variable, compared with their sensitive values masked, as a saved plan keeps them. No value is
 * named.
 */
function inputDifferences(approved: unknown, again: unknown): string[] {
  const [before, after] = [approved, again].map((json) => {
    const masked = maskSensitivePlanJson(json);
    return isRecord(masked) ? masked : {};
  });
  const lines = isDeepStrictEqual(before?.configuration, after?.configuration)
    ? []
    : ["the infrastructure configuration: not the approved plan's"];
  const variables = (json: Record<string, unknown> | undefined) =>
    isRecord(json?.variables) ? json.variables : {};
  const [was, now] = [variables(before), variables(after)];
  for (const name of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    if (!isDeepStrictEqual(was[name], now[name])) {
      lines.push(`variable ${name}: not the approved plan's value`);
    }
  }
  return lines;
}

/**
 * Applies the approved plan as `engine.apply` does (bound to its hash, with `allowDestroy`), after
 * its approval and the shutdown the flow does first. When it deletes or replaces a server whose
 * provider's Terraform cannot remove it (`terraform.connectorRemoval`), each such server is
 * cancelled through its provider's connector (its id from the plan's `before`), said and audited
 * with its end date, then taken out of the state; `replan` makes the plan again into the file it is
 * given, with the approved plan's options, and that plan is applied only when its changes are the
 * approved plan's without those deletions (address and action) and it was made from the same
 * configuration and variables (a plan saved by an earlier run may meet other files on disk). Its
 * file is removed afterwards. Without `replan`, or for any other plan, the engine calls are
 * exactly `engine.apply`'s.
 * @throws OpsCrewError `PHASE_PRECONDITION` before anything is cancelled when the plan does not say
 * a server's id; `PROVIDER_ERROR` when a cancel fails (the state is untouched);
 * `PHASE_PRECONDITION` naming the differences, audited, when the plan made again differs (nothing
 * more is applied); and the engine's error, continued, when the state removal or the plan fails.
 */
export async function applyWithConnectorRemoval(
  run: ConnectorRemovalRun,
  approved: ApprovedPlan,
  options: {
    allowDestroy: boolean;
    replan?: ((planFile: string) => Promise<PlanSummary>) | undefined;
  },
): Promise<IacApplyResult> {
  const { deps, engine, dir, env, command } = run;
  const apply = (plan: Pick<PlanSummary, "planFile" | "planHash">) =>
    engine.apply(
      dir,
      plan.planFile,
      { approvedPlanHash: plan.planHash, allowDestroy: options.allowDestroy },
      { env },
    );
  const servers = options.replan === undefined ? [] : connectorServers(approved);
  if (options.replan === undefined || servers.length === 0) return apply(approved);

  // Every id first: no server is cancelled when one of them cannot be.
  const unknown = servers.find((server) => server.id === undefined);
  if (unknown !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The approved plan deletes ${unknown.label} without saying its id, so OpsCrew cannot cancel it. Nothing was cancelled, and the infrastructure state is unchanged.`,
      {
        hint: `${afresh(command)}. It is shut down: start it again in ${cloudProvider(unknown.provider).texts.destroy.console} if you keep it.`,
      },
    );
  }
  const known = servers.filter((server): server is KnownServer => server.id !== undefined);
  for (const [index, server] of known.entries()) {
    await cancel(run, server, known.slice(0, index));
  }
  const addresses = servers.map((server) => server.change.address);
  const file = `${approved.planFile.replace(/\.tfplan$/, "")}-rest.tfplan`;
  const labels = listText(servers.map((server) => server.label));
  let again: PlanSummary;
  try {
    await engine.stateRemove(dir, addresses, { env });
    await deps.audit.append({
      kind: "iac",
      actor: "opscrew",
      action: "state rm",
      phase: run.phase,
      target: approved.planHash,
      detail: `${addresses.join(", ")}, cancelled through its provider's connector`,
    });
    deps.reporter.step(`Planning the rest again without ${labels}`);
    again = await options.replan(file);
  } catch (error) {
    await rm(file, { force: true });
    throw continued(error, {
      said: `${cancelledText(servers)} cancelled already.`,
      next: `${afresh(command)}: a server cancelled already is not cancelled again.`,
    });
  }
  try {
    const removed = new Set(addresses);
    const found = [
      ...differences(approved.changes, again.changes, removed),
      ...inputDifferences(approved.planJson, again.planJson),
    ];
    if (found.length > 0) {
      await deps.audit.append({
        kind: "iac",
        actor: "opscrew",
        action: "plan again",
        phase: run.phase,
        target: again.planHash,
        decision: "refused",
        detail: `the plan made again is not the approved plan ${approved.planHash} without the deletion of ${addresses.join(", ")}: ${found.join("; ")}`,
      });
      const one = servers.length === 1;
      throw planStop(
        `The plan made again without the cancelled ${labels.replace(/^the /, "")} is not the approved plan without ${one ? "its" : "their"} deletion, so OpsCrew stopped and applied nothing more:`,
        found,
        `The ${one ? "server stays" : "servers stay"} cancelled and ${one ? "is" : "are"} out of the infrastructure state, so the approved plan cannot be applied any more. Run \`opscrew drift\` to see what changed, then run \`${command}\` again without \`--approve\`: it plans what is left.`,
      );
    }
    await deps.audit.append({
      kind: "iac",
      actor: "opscrew",
      action: "plan again",
      phase: run.phase,
      target: again.planHash,
      detail: `the approved plan ${approved.planHash} without the deletion of ${addresses.join(", ")}`,
    });
    return await apply(again);
  } finally {
    await rm(again.planFile, { force: true });
  }
}
