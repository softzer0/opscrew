import {
  type ApplyOptions,
  type ApplyResult,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";

/** One add-on host plan the fake server received, with what was sent (secrets: tests only). */
export interface AddonApply {
  plan: HostPlan;
  options: ApplyOptions;
  result: ApplyResult;
}

/**
 * A server's add-ons as the host adapter leaves them: `apply` refuses a plan whose hash is not the
 * approved one, applies each step whose settings differ from what runs (and skips one already in
 * place, as the adapter's verify does), and removes a step's add-on on its removal. `shell` is the
 * deploy user's shell: it answers only OpsCrew's read-only reads (the server's CPUs, memory and
 * the app's log bytes of a day, and the add-ons' containers), and records every command.
 */
export class FakeAddonServer {
  readonly applies: AddonApply[] = [];
  readonly commands: string[] = [];
  /** What runs, by step id (`beszel`, `alloy`, `tunnel-connector`): its parameters. */
  readonly running = new Map<string, string>();
  cpus = 2;
  /** The server's memory as `/proc/meminfo` gives it, in kB (about 3.8 GiB). */
  memoryKb = 3_900_000;
  /** The bytes of the app's containers' logs of the last 24 hours. */
  logBytes24h = 40_000_000;

  readonly apply = async (
    _remote: RemoteExec,
    plan: HostPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> => {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const step of plan.steps) {
      const params = JSON.stringify(step.params);
      if (step.params.remove === true) {
        if (this.running.delete(step.id)) applied.push(step.id);
        else skipped.push(step.id);
      } else if (this.running.get(step.id) === params) {
        skipped.push(step.id);
      } else {
        this.running.set(step.id, params);
        applied.push(step.id);
      }
    }
    const result = { applied, skipped } as ApplyResult;
    this.applies.push({ plan, options, result });
    return result;
  };

  /** The deploy user's shell on the server at `host`. */
  readonly shell = (host: string): RemoteExec => ({
    host,
    run: async (command: string) => {
      this.commands.push(command);
      if (command.startsWith("nproc && ")) {
        const logs = command.includes("docker logs --since 24h");
        const lines = [this.cpus, this.memoryKb, ...(logs ? [this.logBytes24h] : [])];
        return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
      }
      if (command.startsWith("for p in opscrew-beszel opscrew-alloy;")) {
        const lines: string[] = [];
        if (this.running.has("beszel")) {
          lines.push("opscrew-beszel-agent-1|running", "opscrew-beszel-proxy-1|running");
        }
        if (this.running.has("alloy")) {
          lines.push("opscrew-alloy-alloy-1|running", "opscrew-alloy-proxy-1|exited");
        }
        lines.push("shop-app-1|512MiB / 1GiB");
        if (this.running.has("beszel")) lines.push("opscrew-beszel-agent-1|6.5MiB / 64MiB");
        if (this.running.has("alloy")) lines.push("opscrew-alloy-alloy-1|75.2MiB / 192MiB");
        return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
      }
      // Portainer's read-only checks, for tests that turn Portainer on beside the add-ons.
      if (command.startsWith("docker version")) {
        return { exitCode: 0, stdout: "28.5.1\n", stderr: "" };
      }
      if (command.startsWith("docker volume inspect")) {
        return { exitCode: 1, stdout: "", stderr: "Error response from daemon: no such volume\n" };
      }
      throw new Error(`the fake add-on server does not answer: ${command}`);
    },
  });
}
