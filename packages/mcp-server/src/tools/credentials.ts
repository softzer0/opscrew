import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  credentialInventory,
  credentialListLines,
  listedCredentials,
  tokenExpiries,
} from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/**
 * `opscrew_credentials` (025 US9): what `opscrew rotate` lists, read-only: every credential OpsCrew
 * made for the environment by the name the command takes, how it rotates, its date and what else
 * changes, then the user's own tokens with their expiry where the provider gives it. It records
 * nothing (not even a token's first-seen date) and never rotates: rotating stays a terminal
 * command. No value is ever read into the result.
 */
export function registerCredentialsTool(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_credentials",
    {
      title: "List the credentials and their age",
      description:
        "List the credentials OpsCrew made for an environment (each service's generated secrets, the app's own secrets, the SSH keys, the private network's and devices' keys and logins, Cloudflare's tokens, the state passphrase, the add-ons' passwords, the recovery copy's key), each by the name `npx opscrew rotate <name>` takes, with how it rotates (seamless, a short swap, a restart, users logged out, new device configurations), when it was made or last rotated and what else changes; then the user's own tokens with their expiry where the provider shows it. Read-only, never a value. Rotating stays in the user's terminal, because each rotation is a plan the user approves by its hash: `npx opscrew rotate <name>`.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_credentials", projectDir, async (call) => {
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const credentials = listedCredentials(
          await credentialInventory(phase, plan),
          await tokenExpiries(phase, plan),
        );
        const where = { app: plan.app.name, environment: name, flag, opscrew: "npx opscrew" };
        return {
          text: credentialListLines(credentials, where, phase.clock.now()).join("\n"),
          data: { app: plan.app.name, environment: name, credentials },
        };
      }),
  );
}
