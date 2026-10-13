import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type InitCheck, initPassed, runInitChecks } from "@opscrew/agents";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { projectDirInput, runTool } from "./shared";

const MARK: Record<InitCheck["status"], string> = { pass: "✓", warn: "!", fail: "✗", skip: "-" };

/**
 * `opscrew_init_check`: the `opscrew init` checklist (tools, GitHub remote, tokens and their access,
 * optional model key and scanners, `.opscrew/` in `.gitignore`) with the fix for every problem.
 * Read-only: it never edits `.gitignore` (the CLI's `opscrew init --fix` does that).
 */
export function registerInitCheckTool(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_init_check",
    {
      title: "OpsCrew preflight",
      description:
        "Check that everything OpsCrew needs is ready: git and a GitHub remote, OpenTofu or Terraform, ssh, the cloud provider token (Hetzner Cloud or DigitalOcean, whichever is planned), the Cloudflare and GitHub tokens and what they can access, an optional model key, optional scanners, and .opscrew/ and .terraform/ in .gitignore. Returns a checklist where every problem has its fix. Token values are never shown. With offline: true, tokens are only checked for presence. Changes nothing.",
      inputSchema: {
        ...projectDirInput,
        offline: z
          .boolean()
          .optional()
          .describe("Do not verify tokens over the network; only check that they are set."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, offline }) =>
      runTool(deps, "opscrew_init_check", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        const checks = await runInitChecks(phase, offline === true ? { offline: true } : {});
        const passed = initPassed(checks);
        const lines = checks.flatMap((check) => [
          `${MARK[check.status]} ${check.title} — ${check.message}`,
          ...(check.fix !== undefined && check.status !== "pass" ? [`    ${check.fix}`] : []),
        ]);
        const text = [
          passed
            ? "Everything OpsCrew needs is ready."
            : "Some required items are missing; fix the ones marked ✗.",
          "",
          ...lines,
        ].join("\n");
        return { text, data: { passed, checks } };
      }),
  );
}
