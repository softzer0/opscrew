/**
 * `opscrew destroy` for the localhost target (FR-1508): removes only what OpsCrew created for the
 * app on this computer, found by Compose's labels and OpsCrew's folder names: its containers and
 * networks, its folder and its files on the edge, the edge itself with the computer's last OpsCrew
 * app, and the volumes only with `--delete-data`. A teardown local plan, approved by its hash with
 * the app's name typed (`host-apply`, `allowDestroy`). With the local runner, also the deploy
 * secrets its provision stored at GitHub (and the GitHub environment OpsCrew created for them).
 */
import { join } from "node:path";
import type { ApprovalRecord } from "@opscrew/contracts";
import { exists, listText, OpsCrewError } from "@opscrew/core";
import { EDGE_PROJECT, edgeProxy, runtimeDir } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  deploySecretsLeft,
  type GitHubTarget,
  nothingDeployed,
  recordTeardown,
  removeDeploySecrets,
  resolveGitHub,
} from "../destroy/common";
import type { DestroyOptions, DestroyResult } from "../destroy/types";
import { readSecretsRecord } from "../provision/secrets";
import { hasDeployment, PlanRefusedError } from "../shared";
import { caTrusted } from "./ca";
import { networkExists, projectObjects } from "./docker";
import { withLocalLock } from "./lock";
import {
  describeLocalPlan,
  type LocalItem,
  type LocalPlan,
  LocalPlanSchema,
  localPlanHash,
  saveLocalPlan,
} from "./plan";
import { otherLocalApps } from "./preflight";
import {
  appFolder,
  composeProject,
  computer,
  type LocalhostServices,
  localRelative,
  localRoots,
  localShell,
  requireOwnLocalApp,
  requireShell,
  shellWord,
} from "./services";
import { forgetServedSite, localAddress, localTarget, servedSite } from "./site";

/** How the edge's proxy takes the app's site out without stopping (as the deploy reloads it). */
const RELOAD = {
  caddy:
    "edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null",
  nginx: "edge exec -T nginx sh -c 'nginx -t -q && nginx -s reload' < /dev/null",
} as const;

/** The removal script: every object by its Compose label, then the folders by OpsCrew's names. */
function teardownScript(plan: DeployPlan, o: { last: boolean; deleteData: boolean }): string {
  const app = plan.app.name;
  const label = (project: string) => `label=com.docker.compose.project=${project}`;
  const removeAll = (list: string, remove: string, project: string) => [
    `ids="$(docker ${list} -q --filter ${label(project)})"`,
    `if [ -n "$ids" ]; then docker ${remove} $ids > /dev/null; fi`,
  ];
  const project = composeProject(plan);
  return [
    "set -eu",
    'APPS_DIR="$OPSCREW_APPS_DIR"',
    'EDGE_DIR="$OPSCREW_EDGE_DIR"',
    `edge() { docker compose -p ${EDGE_PROJECT} -f "$EDGE_DIR"/compose.yaml "$@"; }`,
    ...(o.last
      ? []
      : [
          `edge exec -T kamal-proxy kamal-proxy remove ${shellWord(app)} < /dev/null > /dev/null 2>&1 || true`,
        ]),
    ...removeAll("ps -a", "rm -f", project),
    ...removeAll("network ls", "network rm", project),
    ...(o.deleteData ? removeAll("volume ls", "volume rm", project) : []),
    ...(o.last
      ? [
          ...removeAll("ps -a", "rm -f", EDGE_PROJECT),
          `if docker network inspect ${EDGE_PROJECT} > /dev/null 2>&1; then docker network rm ${EDGE_PROJECT} > /dev/null; fi`,
          ...(o.deleteData ? removeAll("volume ls", "volume rm", EDGE_PROJECT) : []),
          'rm -rf "$EDGE_DIR"',
        ]
      : [
          `rm -f "$EDGE_DIR"/sites/${shellWord(app)}.caddy "$EDGE_DIR"/sites/${shellWord(app)}.conf "$EDGE_DIR"/sites/${shellWord(app)}.additions`,
          `rm -rf "$EDGE_DIR"/tls/${shellWord(app)}`,
          `${RELOAD[edgeProxy(plan)]} > /dev/null 2>&1 || true`,
        ]),
    `rm -rf "$APPS_DIR"/${shellWord(app)}`,
  ].join("\n");
}

/** What a teardown removes on this computer, and what stays. */
interface Teardown {
  plan: LocalPlan;
  hash: string;
  /** No other OpsCrew app is on this computer: the shared edge goes too. */
  last: boolean;
  /** The other apps the shared edge keeps serving. */
  others: string[];
  /** The data volumes that stay without `--delete-data`. */
  kept: string[];
}

/**
 * The teardown local plan of the app, from what this computer has now: its containers and
 * networks (by Compose's labels), its folder, its files on the shared edge or, with the computer's
 * last OpsCrew app, the edge itself, and the volumes only with `deleteData`.
 */
async function teardownPlan(
  deps: PhaseDeps,
  plan: DeployPlan,
  deleteData: boolean,
): Promise<Teardown> {
  const target = localTarget(plan);
  const roots = localRoots(deps.paths);
  const folder = appFolder(deps.paths, plan);
  const relative = (path: string) => localRelative(deps.paths, path);
  const others = await otherLocalApps(roots.apps, plan.app.name);
  const last = others.length === 0;
  const app = await projectObjects(deps, composeProject(plan));
  const items: LocalItem[] = [];
  const remove = (kind: LocalItem["kind"], name: string) =>
    items.push({ kind, name, action: "remove" });
  for (const container of app.containers) remove("container", container.name);
  for (const network of app.networks) remove("network", network);
  if (deleteData) for (const volume of app.volumes) remove("volume", volume);
  if (await exists(folder)) remove("folder", relative(folder));
  const kept = deleteData ? [] : [...app.volumes];
  if (last) {
    const edge = await projectObjects(deps, EDGE_PROJECT);
    for (const container of edge.containers) remove("container", container.name);
    if (await networkExists(deps, EDGE_PROJECT)) remove("network", EDGE_PROJECT);
    if (deleteData) for (const volume of edge.volumes) remove("volume", volume);
    else kept.push(...edge.volumes);
    if (await exists(roots.edge)) remove("folder", relative(roots.edge));
  } else {
    // The app's files on the edge that serves the computer's other apps.
    const name = plan.app.name;
    for (const site of [`${name}.caddy`, `${name}.conf`, `${name}.additions`]) {
      const file = join(roots.edge, "sites", site);
      if (await exists(file)) remove("file", relative(file));
    }
    const tls = join(roots.edge, "tls", name);
    if (await exists(tls)) remove("folder", relative(tls));
  }
  const teardown = LocalPlanSchema.parse({
    schemaVersion: 1,
    purpose: "teardown",
    app: plan.app.name,
    environment: deps.paths.environment,
    project: composeProject(plan),
    address: localAddress(await servedSite(deps.paths, plan), target),
    ports: target.ports,
    items,
  });
  return { plan: teardown, hash: localPlanHash(teardown), last, others, kept };
}

/**
 * The teardown of the app on this computer: refuses an app of the same name that another project
 * deployed here; shows what it removes (and what stays); asks for the `host-apply` approval of its
 * local plan with the app's name typed; then, under the deploy lock, plans it again and refuses
 * unless it is still the approved plan (another app may have come to share the edge meanwhile),
 * removes it all, removes the deploy secrets the secrets record names (`removeDeploySecrets`, only
 * with a record) and records the deployment as destroyed. The data volumes stay unless
 * `deleteData`; a later `--delete-data` run removes them.
 * @throws OpsCrewError `PHASE_PRECONDITION` when nothing of the app is on this computer or it is
 * another project's, `PLAN_HASH_MISMATCH` when the teardown changed since its approval.
 */
export async function destroyLocalhost(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
  services: LocalhostServices = {},
): Promise<DestroyResult> {
  const local = computer(deps, services);
  const deleteData = options.deleteData === true;
  await requireOwnLocalApp(deps.paths, plan, "remove");

  deps.reporter.step("Reading what OpsCrew created for the app on this computer (read-only)");
  const first = await teardownPlan(deps, plan, deleteData);
  if (first.plan.items.length === 0 && !hasDeployment(plan)) throw nothingDeployed(plan);
  // Only a provision with the local runner stored deploy secrets at GitHub (its record names them).
  const stored = (await readSecretsRecord(deps)) !== undefined;
  const github: GitHubTarget = stored ? await resolveGitHub(deps, options.services ?? {}) : {};
  await saveLocalPlan(deps.paths, first.plan, first.hash);
  const details = [
    describeLocalPlan(first.plan, first.hash),
    ...(first.kept.length > 0
      ? [
          `The data volumes stay (${listText(first.kept)}): \`opscrew destroy --delete-data\` removes them too.`,
        ]
      : []),
    ...(first.last
      ? []
      : [`OpsCrew's edge stays for the other apps on this computer (${listText(first.others)}).`]),
  ].join("\n");
  deps.reporter.info(details);
  let approval: ApprovalRecord | undefined;
  if (first.plan.items.length > 0) {
    const granted = await deps.approvals.request({
      kind: "host-apply",
      title: `Remove ${plan.app.name} from this computer`,
      details,
      planHash: first.hash,
      allowDestroy: true,
      confirmPhrase: plan.app.name,
    });
    if (!granted.approved) {
      throw new PlanRefusedError({
        plan: "local teardown plan",
        ...(granted.reason ? { reason: granted.reason } : {}),
        unchanged: "Nothing on this computer was changed.",
        hint: "Run `opscrew destroy` again when you are ready, and type the app's name to confirm.",
      });
    }
    await deps.approvals.assertApprovedHostPlan(first.hash, { allowDestroy: true });
    const exec = await localShell(deps, await requireShell(local));
    await withLocalLock(deps.paths, local.sleep, async () => {
      // Planned again under the lock: a stale plan could remove an edge another app now uses.
      const again = await teardownPlan(deps, plan, deleteData);
      if (again.hash !== first.hash) {
        throw new OpsCrewError(
          "PLAN_HASH_MISMATCH",
          `What OpsCrew would remove from this computer changed since you approved it (${first.hash}), for example another app now shares OpsCrew's edge. Nothing was changed.`,
          { hint: "Run `opscrew destroy` again and review what it removes now." },
        );
      }
      const audit = (action: string, decision: "approved" | "refused") =>
        deps.audit.append({
          kind: "remote-exec",
          actor: "opscrew",
          action,
          phase: "provision",
          target: first.hash,
          decision,
        });
      await audit("local teardown started", "approved");
      const result = await exec.run(teardownScript(plan, { last: again.last, deleteData }), {
        timeoutMs: 600_000,
      });
      if (result.exitCode !== 0) {
        await audit("local teardown failed", "refused");
        throw new OpsCrewError(
          "COMMAND_FAILED",
          deps.redactor.redact(
            `The teardown on this computer stopped (exit code ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
          ),
          {
            hint: "Fix the cause shown above, then run `opscrew destroy` again: it continues with what is left.",
          },
        );
      }
      await audit("local teardown finished", "approved");
    });
    approval = granted;
  }
  const secretsRemoved = stored
    ? await removeDeploySecrets(deps, github, {
        plan,
        done: "The app is removed from this computer.",
        reach: "this computer",
      })
    : [];
  await forgetServedSite(deps.paths);
  await recordTeardown(deps, plan, [approval], {
    summary: "removed from this computer by `opscrew destroy`",
    forgetAddress: false,
  });
  deps.reporter.success(`Removed ${plan.app.name} from this computer.`);
  return {
    destroyed: [],
    secretsRemoved,
    remaining: [
      ...deploySecretsLeft(github, { plan, removed: secretsRemoved }),
      ...(first.kept.length > 0
        ? [
            `The data volumes (${listText(first.kept)}): \`opscrew destroy --delete-data\` removes them.`,
          ]
        : []),
      `The local stack's files in the repository (${runtimeDir(plan)}/) and the plan, so \`opscrew provision\` can run it again.`,
      "The app's images in Docker: `docker image prune` removes those no container uses.",
      (await caTrusted(deps.paths))
        ? "OpsCrew's local CA, trusted on this computer: `opscrew localhost untrust` takes the trust back."
        : "OpsCrew's local CA in your OpsCrew folder, for the next local deploy.",
    ],
  };
}
