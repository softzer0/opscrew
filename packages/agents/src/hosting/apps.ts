/**
 * A Node.js or Python app on a hosting account (027 plan 8): CloudLinux's selector runs it, its
 * app root the link `current`, served at the hostname's root. The agent drives the selector on an
 * `app` request (`AGENT_SH`): plan B's `app` step makes the app, destroy's removes it with what the
 * selector leaves. Each release's packages are the agent's to install, before its switch.
 */
import type { HostingFiles } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { HostingDeployTarget } from "@opscrew/plan-schema";
import type { AppStep } from "./plan";
import { type HostingRecord, recordedObject } from "./record";
import { sendRequest, type WaitOptions } from "./requests";

/** The interpreter's name in plain English. */
export const RUNTIME_NAMES = { nodejs: "Node.js", python: "Python" } as const;

/** Plan B's `app` step for a Node.js or Python app OpsCrew didn't make in the selector yet. */
export function appStep(
  target: HostingDeployTarget,
  record: Pick<HostingRecord, "objects"> | undefined,
): Extract<AppStep, { kind: "app" }> | undefined {
  const { runtime } = target;
  if (runtime === undefined || recordedObject(record, "app") !== undefined) return undefined;
  return { kind: "app", ...runtime };
}

/**
 * Asks the agent to make the app in the selector (`create`) or remove it (`destroy`), bound to the
 * approved plan's hash, and waits for its answer: its note, if any (what a removal left, or the
 * settings the selector refused when it made the app).
 * @throws OpsCrewError `PROVIDER_ERROR` when the agent didn't carry it out.
 */
export async function selectorApp(
  files: HostingFiles,
  folder: string,
  action: "create" | "destroy",
  input: { hash: string; now: Date } & WaitOptions,
): Promise<string | undefined> {
  const answer = await sendRequest(files, folder, { kind: "app", action }, input);
  if (answer.result === "done") return answer.note;
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    `The agent didn't ${action === "create" ? "make" : "remove"} the app in CloudLinux's selector: ${answer.reason ?? answer.result}.`,
    {
      hint:
        action === "create"
          ? "Check the app's version and startup file in opscrew/plan.yaml (target.runtime) against the versions the panel's Setup Node.js App or Setup Python App page offers; `opscrew logs` shows the agent's lines. Then run `opscrew provision` again."
          : "`opscrew logs` shows the agent's lines; the panel's Setup Node.js App or Setup Python App page shows the app.",
    },
  );
}
