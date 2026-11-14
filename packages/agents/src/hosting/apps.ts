/**
 * A Node.js or Python app on a hosting account (027 plan 8): CloudLinux's selector runs it, its
 * app root the folder `app/` of the app's folder, which runs `current/<startup file>` through its
 * link `app/current` to the running release, served at the hostname's root (research R14). The agent drives the selector on an `app` request
 * (`AGENT_SH`): plan B's `app` step makes the app, destroy's removes it with what the selector
 * leaves. Each release's packages are the agent's to install, before its switch.
 */
import type { HostingFiles } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { HostingDeployTarget } from "@opscrew/plan-schema";
import type { AppStep } from "./plan";
import { type HostingRecord, recordedObject } from "./record";
import { sendRequest, type WaitOptions } from "./requests";

/** The interpreter's name in plain English. */
export const RUNTIME_NAMES = { nodejs: "Node.js", python: "Python" } as const;

/**
 * Plan B's `app` step for a Node.js or Python app OpsCrew didn't make in the selector yet: asked
 * `again` while the record has it only as `asked` (no clear answer came; the agent keeps an app the
 * selector already has).
 */
export function appStep(
  target: HostingDeployTarget,
  record: Pick<HostingRecord, "objects"> | undefined,
): Extract<AppStep, { kind: "app" }> | undefined {
  const { runtime } = target;
  if (runtime === undefined) return undefined;
  const app = recordedObject(record, "app");
  if (app === undefined) return { kind: "app", ...runtime };
  return app.state === "asked" ? { kind: "app", ...runtime, again: true } : undefined;
}

/**
 * Asks the agent to make the app in the selector (`create`) or remove it (`destroy`), bound to the
 * approved plan's hash, and waits for its answer: its note, if any (what a removal left, or the
 * settings the selector refused when it made the app, or that it already had it). A create's
 * caller records the app as `asked` before (a stop or a wait without an answer may leave it made);
 * `madeNothing` runs only on an answer that says the agent made nothing: it refused the request, or
 * the selector refused to make the app (`made=no`).
 * @throws OpsCrewError `PROVIDER_ERROR` when the agent didn't carry it out.
 */
export async function selectorApp(
  files: HostingFiles,
  folder: string,
  action: "create" | "destroy",
  input: { hash: string; now: Date; madeNothing?: () => Promise<void> } & WaitOptions,
): Promise<string | undefined> {
  const answer = await sendRequest(files, folder, { kind: "app", action }, input);
  if (answer.result === "done") return answer.note;
  const reason = answer.reason ?? answer.result;
  if (action === "destroy") {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `The agent didn't remove the app in CloudLinux's selector: ${reason}.`,
      {
        hint: "`opscrew logs` shows the agent's lines; the panel's Setup Node.js App or Setup Python App page shows the app.",
      },
    );
  }
  if (answer.result === "refused" || answer.made === "no") {
    await input.madeNothing?.();
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `The agent didn't make the app in CloudLinux's selector: ${reason}.`,
      {
        hint: "Check the app's version and startup file in opscrew/plan.yaml (target.runtime) against the versions the panel's Setup Node.js App or Setup Python App page offers; `opscrew logs` shows the agent's lines. Then run `opscrew provision` again.",
      },
    );
  }
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    `The agent didn't say it made the app in CloudLinux's selector: ${reason}. OpsCrew keeps the app recorded as asked for in .opscrew/hosting.json, so \`opscrew destroy\` removes it if it is there.`,
    {
      hint: "`opscrew logs` shows the agent's lines. The next `opscrew provision` asks the agent for the app again, and the agent keeps an app the selector already has.",
    },
  );
}
