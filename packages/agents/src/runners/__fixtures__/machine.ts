/**
 * A runner machine as the runner machine tests answer it: a desktop the user reaches as "ana" with
 * passwordless sudo, at a LAN address, as `inspectHost` reports it, and a host adapter whose apply
 * refuses another plan than the approved one, asks for a runner token only when a runner step
 * runs, and leaves the machine as the plan would: Docker and the deploy user after its setup, each
 * runner installed or removed, and nothing of OpsCrew's after its undo. Nothing reaches a machine.
 */
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import type { HostAdapterApi } from "../../shared";
import { freshFacts } from "../../testing";

/** The machine's address on the user's network (RFC 1918), which no plan or file may hold. */
export const MACHINE_IPV4 = "192.168.1.30";

const AT = "2026-10-22T12:00:00.000Z";

/** One apply the fake received, with the runner tokens its steps got. */
export interface MachineApply {
  plan: HostPlan;
  options: ApplyOptions;
  tokens: { kind: "registration" | "remove"; token: string }[];
}

/** The fake runner machine and its host adapter. */
export class FakeRunnerMachine implements HostAdapterApi {
  facts: HostFacts;
  inspections = 0;
  readonly applies: MachineApply[] = [];
  /** Removals leave GitHub's registration (`config.sh remove` failed). */
  keepsRegistration = false;

  constructor(o: { arch?: "amd64" | "arm64" } = {}) {
    this.facts = freshFacts({
      user: "ana",
      ...(o.arch !== undefined ? { arch: o.arch } : {}),
      addresses: [{ interface: "eth0", family: "ipv4", address: MACHINE_IPV4, public: false }],
    });
  }

  // Arrow functions: the flows pass `inspect` and `apply` on as plain functions.
  inspect = async (_remote: RemoteExec): Promise<HostFacts> => {
    this.inspections++;
    return this.facts;
  };

  apply = async (_remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> => {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    const record: MachineApply = { plan, options, tokens: [] };
    this.applies.push(record);
    const changes = plan.steps.filter((step) => step.state === "change");
    const removed: string[] = [];
    let f = this.facts;
    const changesOf = f.record?.changes ?? [];
    type Entry = (typeof changesOf)[number];
    const entry = (step: Entry["step"], previous: Entry["previous"]): Entry => ({
      step,
      purpose: "setup",
      at: AT,
      previous,
    });
    const recorded = new Set<string>(changesOf.map((item) => item.step));
    const added: Entry[] = [];
    for (const step of changes) {
      if (step.id === "docker") {
        f = {
          ...f,
          docker: {
            ...f.docker,
            kind: "docker-repo",
            version: "28.5.1",
            running: true,
            composePlugin: true,
            buildxPlugin: true,
          },
        };
        if (!recorded.has("docker")) added.push(entry("docker", { installed: false }));
      } else if (step.id === "deploy-user") {
        if (plan.purpose === "undo") f = { ...f, deployUser: null };
        else {
          f = { ...f, deployUser: { groups: ["deploy", "docker"], keys: [] } };
          if (!recorded.has("deploy-user")) added.push(entry("deploy-user", { existed: false }));
        }
      } else if (step.id === "github-runner") {
        if (options.runnerToken === undefined) throw new Error("no runner token callback");
        const app = String(step.params.app);
        const removes = step.params.remove === true;
        const kind = removes ? "remove" : "registration";
        record.tokens.push({ kind, token: await options.runnerToken(kind) });
        const others = f.runners.filter((runner) => runner.app !== app);
        if (removes) removed.push(app);
        f = {
          ...f,
          runners: removes
            ? others
            : [
                ...others,
                {
                  app,
                  registered: true,
                  active: true,
                  unitCurrent: true,
                  version: String(step.params.version),
                  label: String(step.params.label),
                  repositoryUrl: String(step.params.repositoryUrl),
                },
              ],
        };
        if (!removes && !recorded.has("github-runner")) {
          added.push(entry("github-runner", { runners: "absent" }));
          recorded.add("github-runner");
        }
      }
    }
    f =
      plan.purpose === "undo"
        ? { ...f, record: null }
        : {
            ...f,
            record: {
              schemaVersion: 1,
              apps: [],
              opscrewVersion: "0.0.0-test",
              changes: [...changesOf, ...added],
            },
          };
    this.facts = HostFactsSchema.parse(f);
    return {
      applied: changes.map((step) => step.id),
      skipped: plan.steps.filter((step) => step.state !== "change").map((step) => step.id),
      ...(this.keepsRegistration && removed.length > 0 ? { stillRegistered: removed } : {}),
    };
  };
}
