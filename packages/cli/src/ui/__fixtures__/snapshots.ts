/**
 * The CLI side of the snapshot and restore command tests: a project with staging beside prod, the
 * faked agents' calls, and an answer that asks for an approval as the agent does. Tests only.
 */
import type { PhaseDeps } from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import type { ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { afterEach } from "vitest";
import { inEnvironment, withEnvironments } from "./environments";
import { projectContext, type TempProject } from "./harness";

/** One call of a faked agent: its name, its deps and the arguments after them. */
export interface AgentCall {
  name: string;
  deps: PhaseDeps;
  args: unknown[];
}

/**
 * The test file's projects, each removed after its test: `setup` makes one with prod deployed on
 * Hetzner and staging beside it and returns a script's context (a terminal's with `interactive`);
 * `project` is the one made last.
 */
export function stagingProjects() {
  let current: TempProject | undefined;
  afterEach(async () => {
    await current?.cleanup();
    current = undefined;
  });
  return {
    async setup(options: { interactive?: boolean; env?: Record<string, string> } = {}) {
      current = await withEnvironments({
        staging: inEnvironment(testPlan({ deployed: true }), "staging"),
      });
      Object.assign(current.env, options.env);
      return projectContext(current, { interactive: options.interactive ?? false });
    },
    project(): TempProject {
      if (current === undefined) throw new Error("No project: call setup first.");
      return current;
    },
  };
}

/** The last call of `name` among `calls`; throws when there is none. */
export function lastCall(calls: readonly AgentCall[], name: string): AgentCall {
  const call = calls.filter((each) => each.name === name).at(-1);
  if (call === undefined) throw new Error(`${name} was not called`);
  return call;
}

/**
 * An answer that asks `request` and reports the decision in `decisions`, as an agent does: on a
 * refusal it throws `refusal` (an approval refused), else returns `result`.
 */
export function asking(
  request: ApprovalRequest,
  decisions: (string | undefined)[],
  result: unknown,
  refusal: string,
) {
  return async (deps: PhaseDeps) => {
    const decision = await deps.approvals.request(request);
    decisions.push(decision.approved ? "approved" : decision.reason);
    if (!decision.approved) throw new OpsCrewError("APPROVAL_REFUSED", refusal);
    return result;
  };
}
