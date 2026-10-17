import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  describePortainerStatus,
  type PortainerResult,
  type PortainerServices,
  portainerDisable,
  portainerEnable,
  portainerStatus,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import { CollectingReporter, type ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import { IDEMPOTENT_WRITE, projectDirInput, runTool } from "./shared";

/** Test-only collaborators for the Portainer tools (production uses the real ones). */
export interface PortainerToolOptions {
  services?: PortainerServices;
}

/** What a change did, in plain text: the hashes approved and how to open Portainer now. */
function changeText(command: "enable" | "disable", result: PortainerResult): string {
  return [
    ...(result.cloudflarePlanHash !== undefined
      ? [
          `Applied the Cloudflare plan ${result.cloudflarePlanHash} (OpsCrew's shared Cloudflare resources).`,
        ]
      : []),
    ...(result.applied ? [`Applied the infrastructure plan ${result.planHash}.`] : []),
    ...(result.hostApplied
      ? [`Changed the server with the host plan ${result.hostPlanHash}.`]
      : ["The server needed no change."]),
    ...(result.files.length > 0
      ? [`Wrote ${result.files.join(", ")}; ask the user to commit them with opscrew/plan.yaml.`]
      : ["Ask the user to commit opscrew/plan.yaml."]),
    "",
    command === "enable"
      ? describePortainerStatus(result.status)
      : "Portainer is off for this project.",
    "",
    "The admin password is only in the file named above on the user's computer: never read it into this chat. To open Portainer, the user runs `npx opscrew portainer status` in a terminal and starts the SSH tunnel it prints.",
  ].join("\n");
}

/**
 * The Portainer tools (FR-914–FR-917): `opscrew_portainer_status` (read-only: whether it is on,
 * the local address, the tunnel command and where the password file is; never the password) and
 * `opscrew_portainer_enable` / `opscrew_portainer_disable`, whose every plan is approved by the
 * user in a dialog (the model never approves; deleting Portainer's data stays in the terminal,
 * where the user types the app's name, so `opscrew_portainer_disable` refuses `deleteData`). The
 * server's address is never part of a result. `options` is for tests only.
 */
export function registerPortainerTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: PortainerToolOptions = {},
): void {
  const services = options.services === undefined ? {} : { services: options.services };

  server.registerTool(
    "opscrew_portainer_status",
    {
      title: "Portainer status",
      description:
        "Show whether Portainer (a web UI for the containers) is on for this project, its version, how it is reached (only through an SSH tunnel, or also on a subdomain behind Cloudflare Access), the local address to open and where the admin password file is on the user's computer. Never returns the password. Changes nothing and contacts nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_portainer_status", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        const status = await portainerStatus({
          ...phase,
          reporter: new CollectingReporter(deps.redactor.redact),
        });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const own = plan.target.provider === "own";
        const text = [
          describePortainerStatus(status),
          ...(status.enabled && own
            ? [
                "",
                "The tunnel command needs the server's address, which OpsCrew keeps out of this chat: ask the user to run `npx opscrew portainer status` in a terminal to see the exact command.",
              ]
            : []),
          ...(status.enabled
            ? ["Never read the password file into this chat; the user opens it themselves."]
            : []),
        ].join("\n");
        return { text, data: { ...status } };
      }),
  );

  server.registerTool(
    "opscrew_portainer_enable",
    {
      title: "Turn Portainer on",
      description:
        "Install Portainer CE (pinned version) on the deployment's server, listening only on the server itself and reached through an SSH tunnel; its admin password is generated on the user's computer and never shown here. Optional opt-in: subdomain plus allowEmails serve it on that subdomain of the app's Cloudflare domain behind Cloudflare Access (needs Cloudflare Zero Trust turned on). The host plan (and, for a subdomain, the Cloudflare plan of OpsCrew's shared Cloudflare resources and the infrastructure plan) is shown to the USER in a dialog and applied only after they approve it; the coding agent cannot approve. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
        subdomain: z
          .string()
          .optional()
          .describe(
            "Opt-in: serve Portainer on this subdomain of the app's Cloudflare domain behind Cloudflare Access (for example portainer). Leave out to keep it reachable only through an SSH tunnel.",
          ),
        allowEmails: z
          .array(z.string())
          .optional()
          .describe(
            "With subdomain: the email addresses Cloudflare Access lets in (at least one).",
          ),
      },
      annotations: IDEMPOTENT_WRITE,
      _meta: REQUIRES_USER,
    },
    ({ projectDir, subdomain, allowEmails }, extra: CallExtra) =>
      runTool(deps, "opscrew_portainer_enable", projectDir, async (call) => {
        requireDialogs(server, "npx opscrew portainer enable");
        const handler = dialogHandler(server, deps, extra);
        const phase = await call.phaseDeps({ approvalHandler: handler });
        const result = await portainerEnable(phase, {
          ...(subdomain === undefined ? {} : { subdomain }),
          ...(allowEmails === undefined || allowEmails.length === 0 ? {} : { allowEmails }),
          ...services,
        });
        return {
          text: changeText("enable", result),
          data: {
            cloudflarePlanHash: result.cloudflarePlanHash,
            planHash: result.planHash,
            hostPlanHash: result.hostPlanHash,
            applied: result.applied,
            hostApplied: result.hostApplied,
            files: result.files,
            approvals: handler.decisions,
            status: result.status,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_portainer_disable",
    {
      title: "Turn Portainer off",
      description:
        "Remove Portainer from the deployment's server (and the tunnel and Access application of its subdomain). Its data (users and settings) always stays: deleting it is not possible through this tool and stays in the terminal, where the user runs `npx opscrew portainer disable --delete-data` and types the app's name. Every plan is approved by the user in a dialog; the coding agent cannot approve. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
        deleteData: z
          .boolean()
          .optional()
          .describe(
            "Not accepted: true is refused. Deleting Portainer's data stays in the terminal (`npx opscrew portainer disable --delete-data`).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, deleteData }, extra: CallExtra) =>
      runTool(deps, "opscrew_portainer_disable", projectDir, async (call) => {
        if (deleteData === true) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            "Deleting Portainer's data (its users and settings) is not possible through this tool. Nothing was changed.",
            {
              hint: "Ask the user to run `npx opscrew portainer disable --delete-data` in a terminal in the project directory; it asks them to type the app's name.",
            },
          );
        }
        requireDialogs(server, "npx opscrew portainer disable");
        const handler = dialogHandler(server, deps, extra);
        const phase = await call.phaseDeps({ approvalHandler: handler });
        const result = await portainerDisable(phase, { ...services });
        return {
          text: changeText("disable", result),
          data: {
            cloudflarePlanHash: result.cloudflarePlanHash,
            planHash: result.planHash,
            hostPlanHash: result.hostPlanHash,
            dataPlanHash: result.dataPlanHash,
            applied: result.applied,
            hostApplied: result.hostApplied,
            files: result.files,
            approvals: handler.decisions,
          },
        };
      }),
  );
}
