/**
 * `opscrew provision` for the localhost target (plan.md "11.", FR-1501–FR-1507): the app's
 * production stack in this computer's Docker, through the preflight, the stack's files in the
 * repository, the local plan approved by its hash (`host-apply`) and the production scripts run by
 * the local executor.
 */
import { serviceEnvSecret } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { requireOwnHostnames } from "../environments/hostnames";
import { requireSharedParts } from "../environments/shared-parts";
import { checkAdditions } from "../provision/additions";
import { buildAppEnvironment, serviceEnvSecrets } from "../provision/secrets";
import { deploymentRecord } from "../provision/steps";
import type { ProvisionOptions, ProvisionResult } from "../provision/types";
import {
  approvalEntry,
  approveAndWriteRenderedFiles,
  PlanRefusedError,
  planStop,
  writePlanIfChanged,
} from "../shared";
import type { AppEnvironment } from "../shared/app-env";
import { applyLocal } from "./apply";
import { caTrusted } from "./ca";
import { githubRegistry, type LocalImage, type LocalRegistry, resolveLocalImage } from "./image";
import {
  describeLocalPlan,
  type LocalDeploy,
  type LocalFile,
  localChanges,
  planLocal,
  saveLocalPlan,
} from "./plan";
import { localPreflight } from "./preflight";
import { localAddress, localSite, localTarget } from "./site";
import { localRenderContext, localStackFiles, stackUploads, uploadContents } from "./stack";

/** `NAME=value` lines (the build values' format) as a record; the value may hold `=`. */
function valueLines(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

/** The env files of the app's folder: `app.env`, and `<service>.env` for each service with secrets. */
function localEnvFiles(plan: DeployPlan, environment: AppEnvironment): LocalFile[] {
  const secrets = serviceEnvSecrets(plan, environment);
  return [
    { path: "app.env", content: environment.appEnv },
    ...plan.services.flatMap((service) => {
      const content = secrets[serviceEnvSecret(service.name)];
      return content === undefined ? [] : [{ path: `${service.name}.env`, content }];
    }),
  ];
}

/** Said after a deploy on this computer. */
function afterDeploy(address: string, trusted: boolean): string[] {
  return [
    `The app runs on this computer at ${address}, reachable only from this computer (127.0.0.1).`,
    ...(trusted
      ? []
      : [
          "Browsers warn about its certificate until this computer trusts OpsCrew's local CA: run `opscrew localhost trust` (it shows the command first; `opscrew localhost untrust` undoes it).",
        ]),
    "A local stack is not meant to run unattended: it starts again whenever Docker does.",
  ];
}

/**
 * Provisions the app on this computer: the shared parts and hostnames checked as for every
 * environment, then the local preflight (every problem stops before any change, with its fix; the
 * notes said once), the image (GHCR's digest, or a local build), the stack's files written to the
 * repository after their `repo-write` approval, the app's environment, the local plan saved, shown
 * and approved by its hash (`host-apply`; `--plan-only` stops after showing it), then applied
 * ({@link applyLocal}) and recorded in the plan. With the local runner the deploy workflow is
 * written too, rendered with the app's hostname here.
 */
export async function provisionLocalhost(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const services = options.services ?? {};
  const local = services.localhost;
  const target = localTarget(plan);
  await requireSharedParts(deps.paths, plan);
  await requireOwnHostnames(deps.paths, plan);

  deps.reporter.step("Checking this computer: Docker, its memory, the ports and the shell");
  const preflight = await localPreflight(deps, plan, local);
  for (const note of preflight.notes) deps.reporter.info(note);
  if (preflight.problems.length > 0) {
    throw planStop(
      "OpsCrew cannot run the app on this computer yet, so it changed nothing:",
      preflight.problems.map((problem) => `- ${problem}`),
      "Fix what is listed above, then run `opscrew provision` again.",
    );
  }

  // The image first, so a missing one stops before anything is written.
  let ghcr: LocalRegistry | undefined;
  const registry = async () => {
    ghcr ??= local?.registry ?? (await githubRegistry(deps));
    return ghcr;
  };
  if (target.image === "registry") {
    deps.reporter.step("Reading the image from GitHub Container Registry");
  }
  const image: LocalImage = await resolveLocalImage(deps, plan, registry);

  const site = await localSite(deps.paths, plan);
  const ctx = await localRenderContext(deps, plan, site);
  // The app's own additions to its site, checked before any change (FR-1443), as on a server.
  await checkAdditions(deps, plan, ctx, services);
  await approveAndWriteRenderedFiles(deps, deps.paths.root, localStackFiles(plan, ctx), {
    what: "the local stack's files",
  });
  const environment = await buildAppEnvironment(deps, plan, services, site.hostname);
  const deploy: LocalDeploy = {
    plan,
    site,
    image,
    uploads: await uploadContents(deps.paths, stackUploads(plan, ctx)),
    envFiles: localEnvFiles(plan, environment),
    buildValues: {
      args: valueLines(environment.buildEnv),
      secrets: valueLines(environment.buildSecrets),
    },
  };

  const { plan: localPlan, hash } = await planLocal(deps, deploy, local);
  await saveLocalPlan(deps.paths, localPlan, hash);
  const details = describeLocalPlan(localPlan, hash);
  deps.reporter.info(details);
  const address = localAddress(site, target);
  if (localChanges(localPlan).length === 0) {
    deps.reporter.success(`The app on this computer is up to date at ${address}; nothing changes.`);
    return { applied: false, localPlanHash: hash, localApplied: false, outputs: { url: address } };
  }
  if (options.planOnly === true) {
    deps.reporter.info(
      `Saved the local plan (hash ${hash}); nothing on this computer was changed.`,
    );
    return { applied: false, localPlanHash: hash, localApplied: false, outputs: {} };
  }
  const approval = await deps.approvals.request({
    kind: "host-apply",
    title: `Run ${plan.app.name} on this computer (${address})`,
    details,
    planHash: hash,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "local plan",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: "Nothing on this computer was changed.",
      hint: `To apply it later without prompts, run: opscrew provision${deps.paths.environment === "prod" ? "" : ` --env ${deps.paths.environment}`} --approve ${hash}`,
    });
  }
  deps.reporter.step(`Starting ${plan.app.name} on this computer`);
  await applyLocal(deps, deploy, {
    approvedHash: hash,
    phase: "provision",
    ...(image.source === "registry" ? { registry: await registry() } : {}),
    ...(local !== undefined ? { services: local } : {}),
  });
  const recorded = deploymentRecord(deps, {
    plan,
    url: undefined,
    iac: { applied: false },
    approvals: [approvalEntry(approval)],
  })(true);
  await writePlanIfChanged(deps, recorded);
  for (const line of afterDeploy(address, await caTrusted(deps.paths))) deps.reporter.success(line);
  if (plan.environment?.runner === "local") {
    deps.reporter.info(
      `The deploy workflow ${plan.cicd.workflowPath} and the stack's files are written to the repository: commit and push them, then \`opscrew runner start --env ${deps.paths.environment}\` runs its deploy job on this computer.`,
    );
  }
  return { applied: false, localPlanHash: hash, localApplied: true, outputs: { url: address } };
}
