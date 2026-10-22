import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addRunnerHost,
  applyRunnerHost,
  listRunnerHosts,
  type RunnerGitHubApi,
  type RunnerHostServices,
  removeRunnerHost,
} from "@opscrew/agents";
import { isUserFacingError } from "@opscrew/core";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import { projectDirInput, runTool, withHint } from "./shared";

/** Test-only collaborators for the runner machine tools. */
export interface RunnerHostToolOptions {
  /** The runner machine's shell and host adapter (production: SSH with its recorded login). */
  machine?: RunnerHostServices;
  /** GitHub's runner API (production: the client of the user's token). */
  github?: RunnerGitHubApi;
}

const NAME_INPUT = z
  .string()
  .min(1)
  .describe("The runner machine's name in the project, for example home or build-box.");

/** The terminal command that adds the machine `name`, without its address. */
const addCommand = (name: string) => `npx opscrew runner host add ${name} --ssh <user@host[:port]>`;

/**
 * Re-throws a refusal (the user declined or cancelled a dialog) with a next step that never names
 * `--approve`: the user asked again, here or in the terminal, where each plan is shown first.
 */
function declined(error: unknown, tool: string, terminal: string): never {
  if (isUserFacingError(error) && error.code === "APPROVAL_REFUSED") {
    withHint(
      error,
      `Call ${tool} again only when the user asks, or ask them to run \`${terminal}\` in a terminal in the project directory.`,
    );
  }
  throw error;
}

/**
 * The runner machine tools (contracts/runners.md "Runner machines"): `opscrew_runner_host_list`,
 * `opscrew_runner_host_add`, whose host plan only the user approves in a dialog, and
 * `opscrew_runner_host_remove`, which the user confirms by typing the machine's name. The
 * machine's address and login stay on the user's computer. `options` is for tests only.
 */
export function registerRunnerHostTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: RunnerHostToolOptions = {},
): void {
  const services = options.machine === undefined ? {} : { services: options.machine };

  server.registerTool(
    "opscrew_runner_host_list",
    {
      title: "List the runner machines",
      description:
        "List the runner machines this computer knows for the project (machines of the user's that run environments' deploy jobs and builds): each one's CPU, whether Docker is installed and the environments whose deploy job runs there. Never their address. Writes nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_runner_host_list", projectDir, async (call) => {
        const machines = await listRunnerHosts(await call.phaseDeps());
        const lines = machines.map(
          (machine) =>
            `- ${machine.name}: ${machine.arch}, ${machine.docker ? "Docker installed" : "Docker not installed yet"}, ${machine.environments.length === 0 ? "no environment's deploy job" : `the deploy jobs of ${machine.environments.join(", ")}`}`,
        );
        return {
          text:
            machines.length === 0
              ? "This computer knows no runner machine for this project. The user adds one with opscrew_runner_host_add, or in a terminal with `npx opscrew runner host add <name> --ssh <user@host[:port]>`."
              : ["The project's runner machines:", ...lines].join("\n"),
          data: { machines },
        };
      }),
  );

  server.registerTool(
    "opscrew_runner_host_add",
    {
      title: "Set up a runner machine",
      description:
        "Set up a machine of the user's (a home server, a spare PC, a VM with Ubuntu or Debian) as a runner machine: OpsCrew connects over SSH with the user's key file or SSH agent (never a password), the user confirms its SSH host key in a dialog the first time, OpsCrew inspects it read-only and shows its host plan (Docker and the deploy user; OpsCrew does not harden the machine, which may be a desktop), and applies it only after the USER approves the plan's hash in a dialog. The login stays on this computer, never in a file of the repository. Then an environment can choose it: opscrew_env_set with runner host and runnerHost. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
        name: NAME_INPUT,
        user: z
          .string()
          .min(1)
          .describe("The SSH user: root or a user with passwordless sudo, as the user says."),
        host: z.string().min(1).describe("The machine's address or host name, as the user says."),
        port: z.number().int().min(1).max(65535).optional().describe("The SSH port (default 22)."),
        keyFile: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The full path of the user's private key file (absolute or ~/…); leave it out to use the SSH agent. Never read the file.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, name, user, host, port, keyFile }, extra: CallExtra) =>
      runTool(deps, "opscrew_runner_host_add", projectDir, async (call) => {
        requireDialogs(server, addCommand(name));
        const dialogs = dialogHandler(server, deps, extra);
        const phase = await call.phaseDeps({ approvalHandler: dialogs });
        // The first connection's host key is confirmed by the user in a dialog.
        const asking = { ...phase, interactive: true };
        let hash: string;
        try {
          const added = await addRunnerHost(asking, {
            name,
            ssh: { user, host, ...(port === undefined ? {} : { port }) },
            ...(keyFile === undefined ? {} : { keyFile }),
            ...services,
          });
          hash = added.hash;
          await applyRunnerHost(asking, { name, approvedHash: hash, ...services });
        } catch (error) {
          declined(error, "opscrew_runner_host_add", addCommand(name));
        }
        const applied = dialogs.decisions.some((d) => d.kind === "host-apply" && d.approved);
        return {
          text: [
            applied
              ? `Set up the runner machine ${name} (host plan ${hash}).`
              : `The runner machine ${name} is set up already; nothing on it changed.`,
            `Next: an environment runs its deploy job there with opscrew_env_set (runner "host", runnerHost "${name}"; build "runner" to build its image there too), then opscrew_plan and opscrew_apply with that environment.`,
          ].join("\n"),
          data: { name, hostPlanHash: hash, applied, approvals: dialogs.decisions },
        };
      }),
  );

  server.registerTool(
    "opscrew_runner_host_remove",
    {
      title: "Remove a runner machine",
      description:
        "Take back what OpsCrew set up on a runner machine (this project's runners, the deploy user OpsCrew created and its home folder; Docker and the machine stay) and forget its login on this computer. Refused while an environment's deploy job runs there. Only when the user asks for it: the user confirms by typing the machine's name in a dialog. A machine OpsCrew cannot reach is only forgotten, with its runners' registrations at GitHub, after the same typed name. Refuses when the client cannot show dialogs.",
      inputSchema: { ...projectDirInput, name: NAME_INPUT },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, name }, extra: CallExtra) =>
      runTool(deps, "opscrew_runner_host_remove", projectDir, async (call) => {
        const terminal = `npx opscrew runner host remove ${name}`;
        requireDialogs(server, terminal);
        const dialogs = dialogHandler(server, deps, extra);
        const phase = await call.phaseDeps({ approvalHandler: dialogs });
        try {
          await removeRunnerHost(phase, {
            name,
            ...services,
            ...(options.github === undefined ? {} : { runnerGitHub: options.github }),
          });
        } catch (error) {
          declined(error, "opscrew_runner_host_remove", terminal);
        }
        return {
          text: `OpsCrew no longer keeps the runner machine ${name} on this computer.`,
          data: { name, approvals: dialogs.decisions },
        };
      }),
  );
}
