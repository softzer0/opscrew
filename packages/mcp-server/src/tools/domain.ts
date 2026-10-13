import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchDomains } from "@opscrew/agents";
import type { DomainCheck, Money } from "@opscrew/contracts";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { projectDirInput, runTool } from "./shared";

/** What the user runs in a terminal to buy a domain (there is no purchase tool on purpose). */
export const DOMAIN_BUY_COMMAND = "npx opscrew domain buy <domain>";

const money = (m: Money | undefined) =>
  m === undefined ? "unknown" : `${m.amount.toFixed(2)} ${m.currency}`;

function line(check: DomainCheck): string {
  if (check.registrable) {
    return `- ${check.domain}: available, first year ${money(check.firstYear)}, renewal ${money(check.renewal)} per year`;
  }
  const reason = (check.reason ?? "it is not available").trim().replace(/\.$/, "");
  return `- ${check.domain}: cannot be bought through OpsCrew. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

/**
 * `opscrew_domain_check`: `opscrew domain search` for the agent. Checks names live with the
 * Cloudflare registrar (availability, first-year and renewal prices, the reason a name cannot be
 * bought through the API). Read-only; buying is terminal-only (`npx opscrew domain buy`).
 */
export function registerDomainCheckTool(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_domain_check",
    {
      title: "Check domain availability",
      description:
        "Check whether a domain can be bought through Cloudflare Registrar, with its first-year and renewal prices, plus suggestions for a name. Names OpsCrew cannot buy through the API (taken, premium, extensions sold only in the Cloudflare dashboard) come with a plain reason. Needs the CLOUDFLARE_API_TOKEN environment variable with the optional Registrar permission. Never buys anything: buying is terminal-only, so tell the user to run `npx opscrew domain buy <domain>` in their own terminal.",
      inputSchema: {
        ...projectDirInput,
        query: z
          .string()
          .min(1)
          .max(253)
          .describe("A name or a full domain, for example `shopapp` or `shopapp.com`."),
        account: z
          .string()
          .min(1)
          .optional()
          .describe("Cloudflare account id, needed only when the token can use several accounts."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ projectDir, query, account }) =>
      runTool(deps, "opscrew_domain_check", projectDir, async (call) => {
        const result = await searchDomains(await call.phaseDeps(), {
          query,
          ...(account !== undefined ? { account } : {}),
        });
        const header = `Checked live with Cloudflare Registrar (account ${result.account.name}).`;
        const body =
          result.results.length === 0
            ? "Cloudflare returned no names for this search; try another name."
            : result.results.map(line).join("\n");
        const next = result.results.some((c) => c.registrable)
          ? `\n\nTo buy one, the user runs \`${DOMAIN_BUY_COMMAND}\` in their own terminal: it shows the price and asks them to type the domain to confirm (scripts need --confirm and --max-price). OpsCrew then sets up the Cloudflare zone, DNSSEC, auto-renew and the plan's domain.`
          : "";
        return {
          text: `${header}\n${body}${next}`,
          data: {
            account: result.account,
            results: result.results,
            buyCommand: DOMAIN_BUY_COMMAND,
          },
        };
      }),
  );
}
