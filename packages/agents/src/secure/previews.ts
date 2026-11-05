/**
 * `opscrew secure` on a preview server (FR-2221): the server is hardened and probed as any, and
 * the services' checks run for each preview the server lists (its own Compose project,
 * `<app>-pr-<n>`), named by it. A preview environment has no hostname of its own to check.
 */
import type { CheckResult, RemoteExec } from "@opscrew/contracts";
import { errorText, isUserFacingError } from "@opscrew/core";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import { type HostCheck, serviceHostChecks } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { listPreviews } from "../previews/list";
import { checkResult } from "../shared";
import { serviceCheckInputs } from "./services";

/**
 * The services' checks of each preview on the server, read through the preview command's `list`
 * over `remote`; when it cannot be read, a warning that says why instead.
 */
export async function previewServiceChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  remote: RemoteExec,
): Promise<{ checks: HostCheck[]; unread: CheckResult[] }> {
  try {
    const list = await listPreviews(deps, plan, { remote });
    const inputs = serviceCheckInputs(plan, APP_SERVER);
    return {
      checks: list.previews.flatMap((p) =>
        serviceHostChecks(`${plan.app.name}-pr-${p.number}`, inputs).map((check) => ({
          ...check,
          id: `pr-${p.number}-${check.id}`,
          title: `pr-${p.number}: ${check.title}`,
        })),
      ),
      unread: [],
    };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return {
      checks: [],
      unread: [
        checkResult(
          "preview-services",
          "The previews' services are reachable only inside the server",
          "high",
          "warn",
          `OpsCrew could not list the previews, so their services were not checked: ${errorText(error)}`,
          { ...(error.hint !== undefined ? { remediation: error.hint } : {}) },
        ),
      ],
    };
  }
}
