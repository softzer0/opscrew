import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type DomainComparison, REGISTRAR_NAMES, searchDomains } from "@opscrew/agents";
import type { DomainCheck, Money, RegistrarId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { projectDirInput, runTool } from "./shared";

/** What the user runs in a terminal to buy a domain (there is no purchase tool on purpose). */
const DOMAIN_BUY_COMMAND = "npx opscrew domain buy <domain>";

/** The registrars the check can ask (the ids of `opscrew domain search --registrar`). */
const REGISTRARS = [
  "cloudflare",
  "porkbun",
  "namecheap",
  "godaddy",
] as const satisfies readonly RegistrarId[];

/** The buy command for a registrar (`--registrar` only when it is not Cloudflare). */
const buyCommand = (registrar: RegistrarId) =>
  registrar === "cloudflare"
    ? DOMAIN_BUY_COMMAND
    : `${DOMAIN_BUY_COMMAND} --registrar ${registrar}`;

const money = (m: Money | undefined) =>
  m === undefined ? "unknown" : `${m.amount.toFixed(2)} ${m.currency}`;

function plainReason(check: DomainCheck): string {
  const reason = (check.reason ?? "it is not available").trim().replace(/\.$/, "");
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

function line(check: DomainCheck): string {
  if (check.registrable) {
    return `- ${check.domain}: available, first year ${money(check.firstYear)}, renewal ${money(check.renewal)} per year`;
  }
  return `- ${check.domain}: cannot be bought through OpsCrew. ${plainReason(check)}`;
}

/** One name with every registrar's offer, in the order `searchDomains` gave (price only). */
function comparisonLines(entry: DomainComparison): string {
  const offers = entry.offers.map((offer) => {
    const name = REGISTRAR_NAMES[offer.registrar];
    if (!offer.registrable) {
      return `  - ${name}: cannot be bought through OpsCrew. ${plainReason(offer)}`;
    }
    const note = offer.note === undefined ? "" : ` (${offer.note})`;
    return `  - ${name}: first year ${money(offer.firstYear)}, renewal ${money(offer.renewal)} per year${note}`;
  });
  return [`- ${entry.domain}:`, ...offers].join("\n");
}

const buyNext = (command: string, setUp: string) =>
  `\n\nTo buy one, the user runs \`${command}\` in their own terminal: it shows the price and asks them to type the domain to confirm (scripts need --confirm and --max-price). OpsCrew then sets up ${setUp}.`;

const CLOUDFLARE_SET_UP = "the Cloudflare zone, DNSSEC, auto-renew and the plan's domain";
const ELSEWHERE_SET_UP =
  "the Cloudflare zone, points the domain at it and records the plan's domain";

/**
 * `opscrew_domain_check`: `opscrew domain search` for the agent. Checks names live with the
 * Cloudflare registrar (default), at Porkbun, Namecheap or GoDaddy (`registrar`), or at every
 * configured registrar side by side (`compare`, sorted by price only). Read-only; buying and
 * connecting a domain are terminal-only (`npx opscrew domain buy` / `connect`).
 */
export function registerDomainCheckTool(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_domain_check",
    {
      title: "Check domain availability",
      description:
        "Check whether a domain can be bought, with its first-year and renewal prices, plus suggestions for a name. Checks Cloudflare Registrar by default (needs the CLOUDFLARE_API_TOKEN environment variable with the optional Registrar permission); `registrar` checks Porkbun, Namecheap or GoDaddy instead (with their own API keys); `compare` checks every registrar that is set up and lists the prices side by side, cheapest renewal first. Names that cannot be bought through the API come with a plain reason. Never buys or connects anything: tell the user to run `npx opscrew domain buy <domain> [--registrar <id>]` or `npx opscrew domain connect <domain>` in their own terminal.",
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
        registrar: z
          .enum(REGISTRARS)
          .optional()
          .describe("Check at this registrar instead of Cloudflare. Not together with `compare`."),
        compare: z
          .boolean()
          .optional()
          .describe(
            "Check the name at every registrar that is set up and list the prices side by side. Not together with `registrar`.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ projectDir, query, account, registrar, compare }) =>
      runTool(deps, "opscrew_domain_check", projectDir, async (call) => {
        if (compare === true && registrar !== undefined) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            "opscrew_domain_check takes either `registrar` or `compare`, not both.",
            {
              hint: "Pass `registrar` to check one registrar, or `compare: true` to list every registrar's price side by side.",
            },
          );
        }
        const accountInput = {
          ...(account !== undefined ? { account } : {}),
          accountOption: "the `account` input of opscrew_domain_check",
        };
        const phaseDeps = await call.phaseDeps();

        if (compare === true) {
          const result = await searchDomains(phaseDeps, { query, compare: true, ...accountInput });
          const comparison = result.comparison ?? [];
          const header =
            "Compared live at every registrar that is set up, cheapest renewal first (sorted by price only).";
          const body =
            comparison.length === 0
              ? "The registrars returned no names for this search; try another name."
              : comparison.map(comparisonLines).join("\n");
          const next = comparison.some((c) => c.offers.some((o) => o.registrable))
            ? `\n\nTo buy one, the user runs \`${DOMAIN_BUY_COMMAND} --registrar <id>\` in their own terminal (without --registrar for Cloudflare): it shows the price and asks them to type the domain to confirm (scripts need --confirm and --max-price). OpsCrew then sets up the Cloudflare zone, points the domain at it and records the plan's domain.`
            : "";
          return {
            text: `${header}\n${body}${next}`,
            data: {
              ...(result.account !== undefined ? { account: result.account } : {}),
              comparison,
              buyCommand: `${DOMAIN_BUY_COMMAND} [--registrar <id>]`,
            },
          };
        }

        if (registrar !== undefined && registrar !== "cloudflare") {
          const result = await searchDomains(phaseDeps, { query, registrar });
          const name = REGISTRAR_NAMES[registrar];
          const body =
            result.results.length === 0
              ? `${name} returned no names for this search; try another name.`
              : result.results.map(line).join("\n");
          const command = buyCommand(registrar);
          const next = result.results.some((c) => c.registrable)
            ? buyNext(command, ELSEWHERE_SET_UP)
            : "";
          return {
            text: `Checked live with ${name}.\n${body}${next}`,
            data: { registrar, results: result.results, buyCommand: command },
          };
        }

        const result = await searchDomains(phaseDeps, { query, ...accountInput });
        const header = `Checked live with Cloudflare Registrar (account ${result.account.name}).`;
        const body =
          result.results.length === 0
            ? "Cloudflare returned no names for this search; try another name."
            : result.results.map(line).join("\n");
        const next = result.results.some((c) => c.registrable)
          ? buyNext(DOMAIN_BUY_COMMAND, CLOUDFLARE_SET_UP)
          : "";
        return {
          text: `${header}\n${body}${next}`,
          data: {
            registrar: "cloudflare",
            account: result.account,
            results: result.results,
            buyCommand: DOMAIN_BUY_COMMAND,
          },
        };
      }),
  );
}
