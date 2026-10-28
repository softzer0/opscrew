import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ADDON_NAMES,
  type AddonResult,
  type AddonServices,
  type AddonStatus,
  addonDisable,
  addonEnable,
  addonStatus,
  describeAddonStatus,
  type PhaseDeps,
} from "@opscrew/agents";
import { exists, OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import { CollectingReporter, type ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import {
  appInput,
  appliedCloudflarePlan,
  environmentInput,
  IDEMPOTENT_WRITE,
  projectDirInput,
  runTool,
  type ToolCall,
  toolEnvironment,
} from "./shared";

/** Test-only collaborators for the add-on tools (production uses the real ones). */
export interface AddonToolOptions {
  services?: AddonServices;
}

type AddonKind = keyof typeof ADDON_NAMES;

const KINDS = Object.keys(ADDON_NAMES) as [AddonKind, ...AddonKind[]];

const kindInput = {
  addon: z.enum(KINDS).describe("The add-on: beszel or grafana-cloud."),
};

/** What the model is told about the add-ons' secrets, in every result that names them. */
const SECRETS_NOTE =
  "Never read Beszel's secrets file or the Grafana Cloud token into this chat; to open Beszel's dashboard, the user runs `npx opscrew addon open beszel` in a terminal.";

/** The app's plan and the phase deps of a call, for the app and environment it names. */
async function planOf(
  call: ToolCall,
  app: string | undefined,
  environment: string | undefined,
  extras: Parameters<ToolCall["phaseDeps"]>[0] = {},
): Promise<{ phase: PhaseDeps; plan: DeployPlan; terminal: string }> {
  const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
  const phase = await call.phaseDeps({ ...extras, app: appKey, environment: name });
  return { phase, plan: await readArtifact("plan", phase.paths.files.plan), terminal: flag };
}

/** Each add-on's state in words, never a secret. */
function statusText(status: AddonStatus, app: string): string {
  return status.addons.map((state) => describeAddonStatus(state, app)).join("\n\n");
}

/**
 * Stops before anything changes when the add-on needs a token the user gives and neither the MCP
 * server's environment nor this computer has it: the token never passes through the chat.
 */
async function requireToken(
  phase: PhaseDeps,
  kind: AddonKind,
  mode: "hub" | "agent" | undefined,
  terminal: string,
): Promise<void> {
  const needed =
    kind === "grafana-cloud"
      ? { variable: "OPSCREW_GRAFANA_CLOUD_TOKEN", kept: phase.paths.files.grafanaCloudToken }
      : mode === "agent"
        ? { variable: "OPSCREW_BESZEL_TOKEN", kept: phase.paths.files.beszelSecrets }
        : undefined;
  if (needed === undefined) return;
  if ((phase.env[needed.variable] ?? "").trim() !== "" || (await exists(needed.kept))) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${ADDON_NAMES[kind]} needs ${kind === "grafana-cloud" ? "the Grafana Cloud access policy token" : "the token your Beszel hub shows for this server"}, which OpsCrew never takes through this chat, and ${needed.variable} is not set for this MCP server. Nothing was changed.`,
    {
      hint: `Ask the user to set ${needed.variable} in the MCP server's environment and restart it, then call this tool again; or to run \`npx opscrew addon enable ${kind}${terminal}\` in a terminal, which asks for the token with hidden input.`,
    },
  );
}

/** What a change did, in plain text: the hashes approved and the add-on's state now. */
function changeText(result: AddonResult, plan: DeployPlan): string {
  return [
    ...(result.cloudflarePlanHash !== undefined
      ? [appliedCloudflarePlan(result.cloudflarePlanHash)]
      : []),
    ...(result.applied ? [`Applied the infrastructure plan ${result.planHash}.`] : []),
    ...(result.hostApplied
      ? [`Changed the server with the host plans ${result.hostPlanHashes.join(", ")}.`]
      : ["The server needed no change."]),
    result.files.length > 0
      ? `Wrote ${result.files.join(", ")}; ask the user to commit them with opscrew/plan.yaml.`
      : "Ask the user to commit opscrew/plan.yaml.",
    "",
    statusText(result.status, plan.app.name),
    "",
    SECRETS_NOTE,
  ].join("\n");
}

/** The structured data of a change: its hashes, what it applied and the decisions. */
function changeData(result: AddonResult, approvals: unknown): Record<string, unknown> {
  return {
    cloudflarePlanHash: result.cloudflarePlanHash,
    planHash: result.planHash,
    hostPlanHashes: result.hostPlanHashes,
    applied: result.applied,
    hostApplied: result.hostApplied,
    files: result.files,
    approvals,
    status: result.status,
  };
}

/**
 * The add-on tools (FR-1711–FR-1713): `opscrew_addon_status` (read-only: whether Beszel and
 * Grafana Cloud are on, their containers' state and memory, how to open them; never a secret),
 * and `opscrew_addon_enable` / `opscrew_addon_disable`, whose every plan the user approves in a
 * dialog (the model never approves). Tokens come only from the MCP server's environment
 * (`OPSCREW_BESZEL_TOKEN`, `OPSCREW_GRAFANA_CLOUD_TOKEN`) or this computer, never from a tool
 * input. Turning Beszel's hub off always keeps its history: deleting it needs the app's name typed
 * in a terminal. Opening Beszel's dashboard is terminal-only. `options` is for tests only.
 */
export function registerAddonTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: AddonToolOptions = {},
): void {
  const services = options.services === undefined ? {} : { services: options.services };

  server.registerTool(
    "opscrew_addon_status",
    {
      title: "Add-on status",
      description:
        "Show whether Beszel (a light dashboard on the server) and Grafana Cloud (Grafana Alloy sending the app's logs and the server's metrics to the user's Grafana Cloud stack) are on for the app, their versions and memory, their containers' state and memory (read over SSH as the deploy user, read-only, when one is on) and how to open them. Never returns a password or token. Changes nothing.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_addon_status", projectDir, async (call) => {
        const { phase, plan } = await planOf(call, app, environment);
        const status = await addonStatus(
          { ...phase, reporter: new CollectingReporter(deps.redactor.redact) },
          plan,
          services,
        );
        return {
          text: `${statusText(status, plan.app.name)}\n\n${SECRETS_NOTE}`,
          data: { ...status },
        };
      }),
  );

  server.registerTool(
    "opscrew_addon_enable",
    {
      title: "Turn an add-on on",
      description:
        "Add Beszel or Grafana Cloud's collector (Grafana Alloy) to the app's server (a cloud server or the user's own), pinned, with a memory limit, reading Docker only through a read-only proxy. Beszel: mode hub (its dashboard and agent on the server, reached through an SSH tunnel, or with access subdomain plus hostname and allowEmails behind Cloudflare Access) or agent (only the agent, connected to the user's hub: hubUrl, hubKey, and the token from OPSCREW_BESZEL_TOKEN). Grafana Cloud: metricsUrl, metricsUser, logsUrl, logsUser of the user's stack, logSampling, and the token from OPSCREW_GRAFANA_CLOUD_TOKEN (scopes metrics:write and logs:write only); its estimate against the free tier is shown with the plan. Tokens are never tool inputs: they come only from the MCP server's environment. Each plan (the host plan with each container's memory and price share; for a subdomain also the Cloudflare and infrastructure plans) is shown to the USER in a dialog and applied only after they approve it; the coding agent cannot approve. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        ...kindInput,
        mode: z
          .enum(["hub", "agent"])
          .optional()
          .describe("Beszel (the CLI's --mode): hub (the default) or agent."),
        access: z
          .enum(["local", "subdomain"])
          .optional()
          .describe(
            "Beszel's dashboard (--access): local (only through an SSH tunnel, the default) or subdomain (behind Cloudflare Access).",
          ),
        hostname: z
          .string()
          .optional()
          .describe(
            "With access subdomain (--hostname): the dashboard's hostname, or a label of the app's Cloudflare domain (for example beszel).",
          ),
        allowEmails: z
          .array(z.string())
          .optional()
          .describe(
            "With access subdomain (--allow-email): the email addresses Cloudflare Access lets in (at least one).",
          ),
        hubUrl: z
          .string()
          .optional()
          .describe("Beszel's agent mode (--hub-url): the https address of the user's hub."),
        hubKey: z
          .string()
          .optional()
          .describe("Beszel's agent mode (--hub-key): the hub's public key (ssh-ed25519 …)."),
        metricsUrl: z
          .string()
          .optional()
          .describe("Grafana Cloud (--metrics-url): the stack's Prometheus remote_write URL."),
        metricsUser: z
          .string()
          .optional()
          .describe("Grafana Cloud (--metrics-user): the numeric user id of its Prometheus."),
        logsUrl: z
          .string()
          .optional()
          .describe("Grafana Cloud (--logs-url): the stack's Loki push URL."),
        logsUser: z
          .string()
          .optional()
          .describe("Grafana Cloud (--logs-user): the numeric user id of its Loki."),
        logSampling: z
          .number()
          .int()
          .optional()
          .describe(
            "Grafana Cloud (--log-sampling): the percentage of log lines sent, 1 to 100 (default 100).",
          ),
      },
      annotations: IDEMPOTENT_WRITE,
      _meta: REQUIRES_USER,
    },
    ({ projectDir, app, environment, addon, ...request }, extra: CallExtra) =>
      runTool(deps, "opscrew_addon_enable", projectDir, async (call) => {
        requireDialogs(server, `npx opscrew addon enable ${addon}`);
        const handler = dialogHandler(server, deps, extra);
        const { phase, plan, terminal } = await planOf(call, app, environment, {
          approvalHandler: handler,
        });
        await requireToken(phase, addon, request.mode, terminal);
        const given = Object.fromEntries(
          Object.entries(request).filter(([, value]) => value !== undefined),
        );
        const result = await addonEnable(phase, plan, addon, { ...given, ...services });
        return {
          text: changeText(result, plan),
          data: changeData(result, handler.decisions),
        };
      }),
  );

  server.registerTool(
    "opscrew_addon_disable",
    {
      title: "Turn an add-on off",
      description:
        "Remove Beszel or Grafana Alloy from the app's server, with everything it added there (Grafana Alloy's buffer and token, Beszel's agent token, the tunnel and Access of Beszel's subdomain). Beszel's hub always keeps its history (its dashboard's data) through this tool: deleting it needs the app's name typed by the user, in a terminal (`npx opscrew addon disable beszel`). The data already in Grafana Cloud stays in the user's account. Every plan is approved by the user in a dialog; the coding agent cannot approve. Refuses when the client cannot show dialogs.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput, ...kindInput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, app, environment, addon }, extra: CallExtra) =>
      runTool(deps, "opscrew_addon_disable", projectDir, async (call) => {
        requireDialogs(server, `npx opscrew addon disable ${addon}`);
        const handler = dialogHandler(server, deps, extra);
        const { phase, plan, terminal } = await planOf(call, app, environment, {
          approvalHandler: handler,
        });
        // Beszel's hub keeps its history here; its agent mode keeps none.
        const keepData = addon === "beszel" && plan.observability?.beszel?.mode !== "agent";
        const result = await addonDisable(phase, plan, addon, {
          ...(keepData ? { keepData: true } : {}),
          ...services,
        });
        const kept = keepData
          ? [
              "",
              `Beszel's history stays on the server. Deleting it needs the app's name typed by the user: ask them to run \`npx opscrew addon disable beszel${terminal}\` in a terminal.`,
            ]
          : [];
        return {
          text: [changeText(result, plan), ...kept].join("\n"),
          data: { ...changeData(result, handler.decisions), keptHistory: keepData },
        };
      }),
  );
}
