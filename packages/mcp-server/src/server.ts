import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type OpscrewMcpDeps, resolveMcpDeps } from "./deps";
import { registerAddonTools } from "./tools/addons";
import { registerAppTools } from "./tools/apps";
import { registerDeployTools } from "./tools/deploy";
import { registerDesignTools } from "./tools/design";
import { registerDetectTool } from "./tools/detect";
import { registerDomainCheckTool } from "./tools/domain";
import { registerDriftTool } from "./tools/drift";
import { registerEnvironmentTools } from "./tools/environments";
import { registerInitCheckTool } from "./tools/init";
import { registerInterviewTools } from "./tools/interview";
import { registerLogsTool } from "./tools/logs";
import { registerPortainerTools } from "./tools/portainer";
import { registerRunnerHostTools } from "./tools/runners";
import { registerScanTool } from "./tools/scan";
import { registerSecretsTools } from "./tools/secrets";
import { registerStatusTool } from "./tools/status";

/**
 * The order of the tools and the hard rules for the model, also for a client without the
 * opscrew-deploy skill; the tool descriptions say the rest.
 */
const INSTRUCTIONS = [
  "OpsCrew's deterministic tools take an app from its repository to a production deployment on the user's own cloud, a server they already have or a Portainer they already run. They never call a model or print secrets; opscrew_status names the next step.",
  "Planning: opscrew_scan → opscrew_detect → opscrew_interview_questions → opscrew_save_requirements → opscrew_design_options → opscrew_select_design.",
  "Deploy, only after the app is adapted and merged: opscrew_render → opscrew_plan → show the user the plan, its cost and policy results → opscrew_apply → the user merges the pull request → opscrew_verify and opscrew_secure.",
  "Hard rules:",
  "- Only the user approves a change, each plan in its own OpsCrew dialog: never approve or claim approval yourself. The user also confirms the SSH host key of their server or runner machine and the certificate fingerprint of their Portainer in a dialog: never confirm one for them or pass one yourself.",
  "- Never ask the user to paste tokens, passwords, passphrases, private keys or .env values into the chat. Tokens come only from the environment (the user's Portainer: PORTAINER_API_KEY); a server the user has is reached with a key file or the SSH agent, never a password. Never read Portainer's password file into the chat, nor an age key file.",
  '- The address of a server the user has and of their Portainer stays on their computer: results say "your server" and "your Portainer"; never write the address into a file.',
  "- Never run tofu, terraform, hcloud, doctl, ssh or curl against Portainer yourself.",
  "- Terminal-only, with no tool on purpose (give the user the command): moving to another cloud provider, `npx opscrew retarget --to <provider>` (while a move is in progress, pass on the commands the tools name to continue, finish or abort it); buying a domain, `npx opscrew domain buy <domain> [--registrar <id>]` (it shows the price and asks the user to type the domain; scripts need --confirm and --max-price); connecting a domain they own, `npx opscrew domain connect <domain>`; removing the app, `npx opscrew destroy` (deleting the app's data needs `--delete-data` and the app's name typed by the user; `--undo-host` also reverses OpsCrew's changes to a server the user has).",
  "- OpsCrew never asks for contact details: registrars use the account's own contact.",
  "- OpsCrew never changes the host of the user's Portainer, its other stacks or Portainer's settings, and backs up neither a server the user has nor a Portainer host: backups are the user's.",
].join("\n");

/**
 * Creates the OpsCrew MCP server with the planning tools and the deploy tools registered. The
 * server is not connected; pass it a transport (`StdioServerTransport` in production,
 * `InMemoryTransport` in tests). Every tool takes an optional absolute `projectDir` (default
 * `deps.cwd`), returns text plus `structuredContent`, redacts all output and maps errors to
 * `isError: true` results with a plain-English message and next step.
 */
export function createOpscrewMcpServer(deps: OpscrewMcpDeps): McpServer {
  const resolved = resolveMcpDeps(deps);
  const server = new McpServer(
    { name: "opscrew", title: "OpsCrew", version: deps.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerScanTool(server, resolved);
  registerDetectTool(server, resolved);
  registerInterviewTools(server, resolved);
  registerDesignTools(server, resolved);
  registerStatusTool(server, resolved);
  registerLogsTool(server, resolved);
  registerDeployTools(server, resolved);
  registerDriftTool(server, resolved);
  registerInitCheckTool(server, resolved);
  registerDomainCheckTool(server, resolved);
  registerPortainerTools(server, resolved);
  registerAddonTools(server, resolved);
  registerSecretsTools(server, resolved);
  registerEnvironmentTools(server, resolved);
  registerAppTools(server, resolved);
  registerRunnerHostTools(server, resolved);
  return server;
}
