/**
 * The CLI side of the `opscrew retarget` tests: a provisioned Hetzner project from the harness
 * with every fake of `@opscrew/agents/testing`'s move (`moveFakes`), a command runner for resolved
 * binaries that copies between the fake servers, and a CLI context for each run. Tests only.
 */
import path from "node:path";
import { type FakeHosts, HOST_KEY, moveFakes, movePlan } from "@opscrew/agents/testing";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { type CliServices, withServices } from "../../deps";
import { deployProject } from "./deploy";
import { projectContext } from "./harness";

// The end-to-end tests in `test/e2e` import these from here.
export {
  APP,
  DOMAIN,
  NEW_SERVERS,
  OLD_IPV4,
  TOKENS as MOVE_TOKENS,
} from "@opscrew/agents/testing";

/** Real git; `ssh-keyscan` answers with {@link HOST_KEY}; `scp` copies between the fake hosts. */
class MoveRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });

  constructor(private readonly hosts: FakeHosts) {}

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const name = path.basename(command).replace(/\.exe$/i, "");
    if (name === "git") return this.#node.run(command, args, options);
    if (name === "ssh-keyscan") {
      return { exitCode: 0, stdout: `${args[args.length - 1]} ${HOST_KEY}\n`, stderr: "" };
    }
    if (name === "scp") return this.hosts.scp(args);
    return { exitCode: 127, stdout: "", stderr: "not found" };
  }
}

/** A live Hetzner deployment of `shop` (Cloudflare DNS, self-hosted Postgres) and its fakes. */
export async function moveProject() {
  const plan = movePlan();
  const project = await deployProject(plan);
  const fakes = await moveFakes(project.root, project.env);
  const runner = new MoveRunner(fakes.hosts);
  let seconds = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 13, 12, 0, seconds++)) };

  /** A test context for one `opscrew` run in the project, with every fake attached. */
  const context = (options: { interactive?: boolean; services?: CliServices } = {}) => {
    const ctx = projectContext(
      { ...project, env: fakes.env },
      {
        ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
        services: { runner, fetch: fakes.fetch, clock, ...options.services },
      },
    );
    withServices(ctx, { retarget: fakes.services });
    return ctx;
  };

  return { ...fakes, project, plan, context };
}

export type MoveProject = Awaited<ReturnType<typeof moveProject>>;
