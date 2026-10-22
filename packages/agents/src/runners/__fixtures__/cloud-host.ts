/**
 * The runner's host adapter on a server OpsCrew created, as the cloud runner tests answer it: the
 * runners deploy reads there, and an apply that refuses another plan than the approved one, asks
 * for the runner's token only when its step runs, and leaves the runner installed or removed.
 */
import {
  type ApplyOptions,
  type ApplyResult,
  type HostPlan,
  hostPlanHash,
  type RunnerFacts,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import type { CloudRunnerHost } from "../cloud";

/** A fake of {@link CloudRunnerHost} that records every inspection and apply. */
export class FakeCloudRunnerHost implements CloudRunnerHost {
  /** A server OpsCrew created whose first boot prepared the runner's root parts. */
  facts: RunnerFacts = { arch: "amd64", runners: [], prepared: true };
  inspections = 0;
  readonly applies: { remote: RemoteExec; plan: HostPlan; options: ApplyOptions }[] = [];
  /** Every runner token the step got, in order. */
  readonly tokens: string[] = [];
  /** A removal leaves GitHub's registration (`config.sh remove` failed). */
  keepsRegistration = false;

  // Arrow functions: the flow passes `inspect` and `apply` on as plain functions, as the
  // connector's are.
  inspect = async (_remote: RemoteExec): Promise<RunnerFacts> => {
    this.inspections++;
    return this.facts;
  };

  apply = async (remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> => {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    this.applies.push({ remote, plan, options });
    const step = plan.steps.find((item) => item.state === "change");
    if (step === undefined) return { applied: [], skipped: plan.steps.map((item) => item.id) };
    if (options.runnerToken === undefined) throw new Error("no runner token callback");
    const removes = step.params.remove === true;
    this.tokens.push(await options.runnerToken(removes ? "remove" : "registration"));
    const app = String(step.params.app);
    const others = this.facts.runners.filter((runner) => runner.app !== app);
    const installed = {
      app,
      registered: true,
      active: true,
      version: String(step.params.version),
      label: String(step.params.label),
      repositoryUrl: String(step.params.repositoryUrl),
    };
    this.facts = { ...this.facts, runners: removes ? others : [...others, installed] };
    return {
      applied: ["github-runner"],
      skipped: [],
      ...(removes && this.keepsRegistration ? { stillRegistered: [app] } : {}),
    };
  };
}
