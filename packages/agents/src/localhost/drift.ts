/**
 * `opscrew drift` for the localhost target (FR-1508): the repository's generated files against
 * what OpsCrew renders from the plan, and the stack on this computer against what OpsCrew set up:
 * the files in the app's folder, the containers of the app and the edge, and the app's leaf
 * certificate. Read-only; there is no infrastructure state on this computer.
 */
import { join } from "node:path";
import type { ResourceChange } from "@opscrew/contracts";
import { readTextIfExists } from "@opscrew/core";
import { EDGE_PROJECT, type LocalhostSite } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { HostDifference } from "../drift/host";
import { finishDriftReport } from "../drift/infra";
import type { DriftReport } from "../drift/types";
import { leafState } from "./ca";
import { projectObjects } from "./docker";
import { appFolder } from "./services";
import { localSite, servedSite } from "./site";
import { localRenderContext, previewLocalStack, stackUploads, uploadContents } from "./stack";
import { localComponentStatus } from "./status";

/**
 * Every way the stack on this computer differs from what OpsCrew set up for `served`, the
 * hostname it serves; provision puts each back.
 */
async function stackDifferences(
  deps: PhaseDeps,
  plan: DeployPlan,
  served: LocalhostSite,
): Promise<HostDifference[]> {
  const differences: HostDifference[] = [];
  const add = (title: string, detail: string) =>
    differences.push({ area: "app", title, detail, restoredByProvision: true });
  const ctx = await localRenderContext(deps, plan, served);
  const folder = appFolder(deps.paths, plan);
  // A repository file missing too is listed with the files; its copy here is not compared.
  const uploads = await uploadContents(deps.paths, stackUploads(plan, ctx)).catch(() => []);
  for (const upload of uploads) {
    const there = await readTextIfExists(join(folder, upload.path));
    const differs =
      there === undefined
        ? "is missing in the app's folder"
        : there.replaceAll("\r\n", "\n") !== upload.content
          ? "in the app's folder differs from the repository's"
          : undefined;
    if (differs !== undefined) {
      add("The app's files on this computer", `${upload.path} ${differs}.`);
    }
  }
  const status = await localComponentStatus(deps, plan);
  for (const { service, containers, running } of status.components) {
    const state =
      containers === 0 ? "has no container" : running < containers ? "is stopped" : undefined;
    if (state !== undefined) add("The app's containers", `${service} ${state}.`);
  }
  for (const service of status.others) {
    add("The app's containers", `${service} runs, but is no component of the plan any more.`);
  }
  const edge = await projectObjects(deps, EDGE_PROJECT);
  if (!edge.containers.some((container) => container.running)) {
    add("OpsCrew's edge on this computer", "it does not run, so the site does not answer.");
  }
  const leaf = await leafState(deps.paths, plan, served.hostname, deps.clock.now());
  if (leaf.action !== "keep") add("The app's certificate", leaf.detail);
  return differences;
}

/**
 * The drift report of an app on this computer. A hostname the plan now gives that the stack does
 * not serve yet (another of the app's environments came to this computer since) is pending, for
 * `opscrew provision` to apply.
 */
export async function localDrift(deps: PhaseDeps, plan: DeployPlan): Promise<DriftReport> {
  deps.reporter.step("Comparing the generated files and the stack on this computer with the plan");
  const files = await previewLocalStack(deps, plan);
  const served = await servedSite(deps.paths, plan);
  const planned = await localSite(deps.paths, plan);
  const pending: ResourceChange[] =
    served.hostname === planned.hostname
      ? []
      : [
          {
            address: `the app's hostname ${served.hostname} → ${planned.hostname}`,
            type: "localhost-hostname",
            name: planned.hostname,
            provider: "localhost",
            action: "update",
          },
        ];
  return finishDriftReport(deps, plan, {
    drift: [],
    pending,
    files: { changed: files.changed, created: files.created },
    foreignDnsRecords: [],
    host: { differences: await stackDifferences(deps, plan, served) },
    provider: "localhost",
    notes: [],
  });
}
