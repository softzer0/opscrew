import {
  buyDomain,
  type DomainAccount,
  type DomainServices,
  type DomainStatusResult,
  domainStatus,
  type MaxPrice,
  type PhaseDeps,
  type SearchDomainsResult,
  searchDomains,
  setDomainAutoRenew,
} from "@opscrew/agents";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  Clock,
  Money,
  Reporter,
} from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { Argument, type Command } from "commander";
import { formatRequest } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { runPhaseCommand, usageErrorsExit2 } from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { printNextSteps } from "../ui/output";
import type { UiPrompts } from "../ui/prompts";

/** Approval kinds that need the domain typed (at the prompt or with `--confirm`). */
const TYPED_KINDS: readonly ApprovalRequest["kind"][] = ["domain-purchase", "domain-settings"];

const systemClock: Clock = { now: () => new Date() };

/** Why the typed-domain handler refused a request without asking anyone. */
export type DomainRefusal = "not-interactive" | "confirm-mismatch";

export interface DomainApprovalOptions {
  /** True when a person answers the prompts. */
  interactive: boolean;
  /** `--confirm <domain>`. */
  confirm?: string;
  /** True when `--max-price` was given (a purchase is approved by `--confirm` only with it). */
  priceBound: boolean;
  prompts: UiPrompts;
  /** Where requests are shown (`ctx.stdout`, which redacts). */
  print(text: string): void;
  clock?: Clock;
}

/**
 * Approvals of `opscrew domain` on top of the normal handler (`base`). A `domain-purchase` or
 * `domain-settings` request (constitution I: purchases) is approved only when the domain is typed:
 * - `--confirm <domain>` (compared in lower case) approves a settings change, and a purchase only
 *   together with `--max-price` (the agent stops when the price is above it);
 * - otherwise a person types the domain at the prompt after seeing the details;
 * - a run without a terminal and without a matching `--confirm` is refused.
 * `--yes` never applies to these kinds; every other request goes to `base`.
 */
export class DomainApprovalHandler implements ApprovalHandler {
  /** The last request refused without a prompt, and why (for the next-step hint). */
  refused: { request: ApprovalRequest; phrase: string; why: DomainRefusal } | undefined;
  private readonly clock: Clock;

  constructor(
    private readonly base: ApprovalHandler,
    private readonly options: DomainApprovalOptions,
  ) {
    this.clock = options.clock ?? systemClock;
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!TYPED_KINDS.includes(request.kind)) return this.base.request(request);
    const { interactive, confirm, priceBound, prompts, print } = this.options;
    const decidedAt = this.clock.now().toISOString();
    const phrase = (request.confirmPhrase ?? "").trim();
    const purchase = request.kind === "domain-purchase";
    print(formatRequest(request));
    if (phrase === "") {
      return {
        approved: false,
        approver: "opscrew domain",
        decidedAt,
        reason: "no domain name to confirm",
      };
    }

    if (confirm !== undefined) {
      if (!sameDomain(confirm, phrase)) {
        this.refused = { request, phrase, why: "confirm-mismatch" };
        return {
          approved: false,
          approver: "--confirm flag",
          decidedAt,
          confirmation: confirm.trim(),
          reason: "confirmation phrase did not match",
        };
      }
      if (!purchase || priceBound) {
        print(`  ✓ ${request.title} (confirmed with --confirm ${phrase})\n`);
        return { approved: true, approver: "--confirm flag", decidedAt, confirmation: phrase };
      }
    }

    if (!interactive) {
      this.refused = { request, phrase, why: "not-interactive" };
      return {
        approved: false,
        approver: "--confirm flag",
        decidedAt,
        reason: `this run is not interactive and --confirm ${phrase} was not given`,
      };
    }

    const answer = await prompts.text({
      message: purchase
        ? `Type ${phrase} to buy it (anything else cancels)`
        : `Type ${phrase} to approve (anything else cancels)`,
      placeholder: phrase,
    });
    if (prompts.isCancel(answer)) {
      return {
        approved: false,
        approver: "typed domain name",
        decidedAt,
        reason: "cancelled by the user",
      };
    }
    const typed = answer.trim();
    if (!sameDomain(typed, phrase)) {
      return {
        approved: false,
        approver: "typed domain name",
        decidedAt,
        confirmation: typed,
        reason: "confirmation phrase did not match",
      };
    }
    return { approved: true, approver: "typed domain name", decidedAt, confirmation: phrase };
  }
}

/** Domain names compare without case and without a trailing dot. */
function sameDomain(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
  return norm(a) === norm(b);
}

/**
 * Parses `--max-price`: `12.50`, `12.50USD` or `12.50 EUR` (USD or EUR, any case). Throws
 * `INVALID_INPUT` (exit 2) for anything else.
 */
export function parseMaxPriceFlag(value: string): MaxPrice {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]{3})?\s*$/.exec(value);
  const hint =
    "For example `--max-price 12.50` or `--max-price 12.50USD` (USD or EUR, the currency Cloudflare quotes).";
  const amount = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (match === null || !Number.isFinite(amount) || amount <= 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--max-price ${value.trim()} is not a price OpsCrew understands. Nothing was bought.`,
      { hint },
    );
  }
  const currency = match[2]?.toUpperCase();
  if (currency === undefined) return { amount };
  if (currency !== "USD" && currency !== "EUR") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--max-price ${value.trim()} is in ${currency}; OpsCrew compares domain prices in USD or EUR. Nothing was bought.`,
      { hint },
    );
  }
  return { amount, currency };
}

/** `$10.44`, `€9.00`. */
function money(value: Money | undefined): string {
  if (value === undefined) return "-";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(
    value.amount,
  );
}

/** `2027-01-02` from an ISO timestamp (`unknown` when absent). */
function day(iso: string | undefined): string {
  if (iso === undefined) return "unknown";
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toISOString().slice(0, 10);
}

const onOff = (value: boolean | undefined) =>
  value === undefined ? "unknown" : value ? "on" : "off";

/** The search results as a table: domain, available, first year, renewal, note. */
export function renderSearchTable(result: SearchDomainsResult): string {
  const header = ["DOMAIN", "AVAILABLE", "FIRST YEAR", "RENEWAL", "NOTE"];
  const rows = result.results.map((c) => [
    c.domain,
    c.registrable ? "yes" : "no",
    c.registrable ? money(c.firstYear) : "-",
    c.registrable ? money(c.renewal) : "-",
    c.registrable ? "" : (c.reason ?? "cannot be bought through OpsCrew"),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    `  ${cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")}`.trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/** The registration of the project's domain, one setting per line. */
export function renderDomainStatus(result: DomainStatusResult): string {
  const info = result.domain;
  if (info === undefined) return "";
  const rows: [string, string][] = [
    ["Registrar", info.registrar === "cloudflare" ? "Cloudflare" : info.registrar],
    ["Registered", day(info.createdAt)],
    ["Expires", day(info.expiresAt)],
    ["Auto-renew", onOff(info.autoRenew)],
    ["Transfer lock", onOff(info.locked)],
    ["WHOIS privacy", onOff(info.privacy)],
    ["DNSSEC", onOff(result.dnssec)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return [info.domain, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join(
    "\n",
  );
}

/** Progress is dropped for `--json` so stdout holds only the JSON; problems go to stderr. */
function quietReporter(ctx: CliContext): Reporter {
  return {
    step: () => {},
    info: () => {},
    success: () => {},
    warn: (message) => ctx.reporter.warn(message),
    error: (message) => ctx.reporter.error(message),
  };
}

/**
 * The domain services for a run, with the account chosen at a prompt when a person runs the
 * command without `--account` and the token can use several accounts (the agents then see only
 * that account's list once, so they do not ask Cloudflare again).
 */
async function servicesFor(
  ctx: CliContext,
  deps: PhaseDeps,
  account: string | undefined,
): Promise<{ services?: DomainServices; account?: string }> {
  const given = deployServicesOf(ctx).domain;
  const keep = {
    ...(given === undefined ? {} : { services: given }),
    ...(account === undefined ? {} : { account }),
  };
  const token = ctx.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!ctx.isInteractive || account !== undefined || !token) return keep;
  deps.redactor.addLiteral(token, "cloudflare-token");
  const list: DomainAccount[] =
    given?.accounts !== undefined
      ? await given.accounts()
      : await new CloudflareClient({ token, fetch: deps.fetch, version: deps.version })
          .listAccounts()
          .then((accounts) => accounts.map((a) => ({ id: a.id, name: a.name })));
  const services: DomainServices = { ...given, accounts: async () => list };
  if (list.length < 2) return { services };
  const prompts = promptsOf(ctx);
  const chosen = await prompts.select({
    message: "Which Cloudflare account should OpsCrew use?",
    options: list.map((a) => ({ value: a.id, label: a.name, hint: a.id })),
  });
  if (prompts.isCancel(chosen)) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "You cancelled choosing a Cloudflare account, so nothing changed.",
      { hint: "Run the command again, or pass the account with --account <id>." },
    );
  }
  return { services, account: chosen };
}

interface AccountFlag {
  account?: string;
}

interface SearchFlags extends AccountFlag {
  json?: boolean;
}

interface BuyFlags extends AccountFlag {
  years?: string;
  autoRenew?: boolean;
  confirm?: string;
  maxPrice?: string;
  forgetPendingPurchase?: boolean;
  yes?: boolean;
}

interface AutoRenewFlags extends AccountFlag {
  confirm?: string;
}

const ACCOUNT_DESCRIPTION =
  "Cloudflare account id or name, when the token can use several accounts";

/** Lower-case domain without a trailing dot, for the commands OpsCrew suggests. */
function shownDomain(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, "");
}

/** Hint for a typed-domain request refused without a prompt: the exact command to run. */
function refusalHint(
  handler: DomainApprovalHandler,
  command: (refused: ApprovalRequest, phrase: string) => string,
): (error: unknown) => string | undefined {
  return (error) => {
    const refused = handler.refused;
    if (refused === undefined || !isUserFacingError(error) || error.code !== "APPROVAL_REFUSED") {
      return undefined;
    }
    const run = `\`${command(refused.request, refused.phrase)}\``;
    return refused.why === "confirm-mismatch"
      ? `--confirm does not match ${refused.phrase}. To approve it, run ${run}.`
      : `This run is not interactive, so OpsCrew needs the domain typed again: run ${run}, or run the command in a terminal.`;
  };
}

/**
 * `opscrew domain`: find, buy and manage a domain through the user's Cloudflare account
 * (FR-601). A purchase or a settings change is approved only with the domain typed (at the prompt,
 * or `--confirm <domain>` in scripts; a purchase also needs `--max-price` there); `--yes` never
 * approves either. Exit codes: 0 done, 1 stopped on purpose (refused, cancelled, cannot be
 * bought), 2 error (bad input, credentials, Cloudflare errors).
 */
export function register(program: Command, ctx: CliContext): void {
  const domain = program
    .command("domain")
    .description("Find, buy and manage a domain through your Cloudflare account")
    .exitOverride(usageErrorsExit2);

  domain
    .command("search")
    .description("Check which domains you can buy and what they cost (changes nothing)")
    .argument("<name>", "A word or a domain, for example shopapp or shopapp.com")
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option("--json", "Print the results as JSON")
    .exitOverride(usageErrorsExit2)
    .action(async (name: string, flags: SearchFlags) => {
      const json = flags.json === true;
      const result = await runPhaseCommand(ctx, async () => {
        const deps = createPhaseDeps(ctx, {
          ai: false,
          ...(json ? { reporter: quietReporter(ctx) } : {}),
        });
        const chosen = await servicesFor(ctx, deps, flags.account?.trim() || undefined);
        return searchDomains(deps, { query: name, ...chosen });
      });
      if (json) {
        ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (result.results.length === 0) {
        ctx.stdout(`Cloudflare suggested no domains for "${name.trim()}".\n`);
        printNextSteps(ctx, ["try another word with `opscrew domain search <name>`."]);
        return;
      }
      ctx.stdout(
        `Domains for "${name.trim()}" on the Cloudflare account ${result.account.name}, checked just now:\n\n${renderSearchTable(result)}\n`,
      );
      const cheapest = result.results.find((c) => c.registrable);
      printNextSteps(ctx, [
        cheapest === undefined
          ? "none of these can be bought through OpsCrew; try another word with `opscrew domain search <name>`."
          : `run \`opscrew domain buy ${cheapest.domain}\` (or another available name). OpsCrew shows the price and buys nothing until you type the domain.`,
      ]);
    });

  domain
    .command("buy")
    .description("Buy a domain (shows the price and asks you to type the domain first)")
    .argument("<domain>", "The domain to buy, for example shopapp.com")
    .option("--years <n>", "Registration years, 1 to 10 (default 1)")
    .option("--no-auto-renew", "Do not renew the domain automatically before it expires")
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option(
      "--confirm <domain>",
      "The domain again, to approve without a prompt (for scripts and CI; a purchase also needs --max-price)",
    )
    .option(
      "--max-price <amount>",
      "The most you agree to pay now, for example 12.50 or 12.50USD (required without a terminal)",
    )
    .option(
      "--forget-pending-purchase",
      "Clear OpsCrew's note about an unfinished purchase after you checked the Cloudflare dashboard",
    )
    .option(
      "--yes",
      "In a run without a terminal, approve updating the project files (never a purchase or a domain setting)",
    )
    .exitOverride(usageErrorsExit2)
    .action(async (input: string, flags: BuyFlags, command: Command) => {
      const name = shownDomain(input);
      // --no-auto-renew only when given: for a domain already on the account, auto-renew then
      // changes only after an approval.
      const autoRenew =
        command.getOptionValueSource("autoRenew") === "cli" ? flags.autoRenew : undefined;
      const account = flags.account?.trim() || undefined;
      const forget = flags.forgetPendingPurchase === true;
      let handler: DomainApprovalHandler | undefined;
      // The command that approves the refused request: forgetting the note needs only the
      // typed domain, setting up an owned domain no price, a purchase the price limit too.
      const scripted = (refused: ApprovalRequest, phrase: string) => {
        if (forget && refused.kind === "domain-settings") {
          return `opscrew domain buy ${name} --forget-pending-purchase --confirm ${phrase}`;
        }
        const parts = [`opscrew domain buy ${name}`];
        if (flags.years !== undefined) parts.push(`--years ${flags.years.trim()}`);
        if (autoRenew === false) parts.push("--no-auto-renew");
        if (account !== undefined) parts.push(`--account ${account}`);
        parts.push(`--confirm ${phrase}`);
        if (refused.kind === "domain-purchase") {
          parts.push(`--max-price ${flags.maxPrice?.trim().replace(/\s+/g, "") || "<amount>"}`);
        }
        return parts.join(" ");
      };
      const result = await runPhaseCommand(
        ctx,
        async () => {
          const maxPrice =
            flags.maxPrice === undefined ? undefined : parseMaxPriceFlag(flags.maxPrice);
          const years = flags.years === undefined ? undefined : Number(flags.years.trim());
          const deps = createPhaseDeps(ctx, {
            ai: false,
            ...(flags.yes === true ? { assumeYes: true } : {}),
            wrapApprovals: (base) => {
              handler = new DomainApprovalHandler(base, {
                interactive: ctx.isInteractive,
                ...(flags.confirm === undefined ? {} : { confirm: flags.confirm }),
                priceBound: maxPrice !== undefined,
                prompts: promptsOf(ctx),
                print: ctx.stdout,
                ...clockOf(ctx),
              });
              return handler;
            },
          });
          const chosen = await servicesFor(ctx, deps, account);
          return buyDomain(deps, {
            domain: input,
            ...(years === undefined ? {} : { years }),
            ...(autoRenew === undefined ? {} : { autoRenew }),
            ...(maxPrice === undefined ? {} : { maxPrice }),
            ...(forget ? { forgetPendingPurchase: true } : {}),
            ...chosen,
          });
        },
        (error) => (handler === undefined ? undefined : refusalHint(handler, scripted)(error)),
      );
      printNextSteps(ctx, result.next);
    });

  domain
    .command("status")
    .description("Show the registration of the project's domain: expiry, auto-renew, lock, DNSSEC")
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option(
      "--yes",
      "In a run without a terminal, approve recording the registration in opscrew/plan.yaml",
    )
    .exitOverride(usageErrorsExit2)
    .action(async (flags: AccountFlag & { yes?: boolean }) => {
      const result = await runPhaseCommand(ctx, async () => {
        const deps = createPhaseDeps(ctx, {
          ai: false,
          ...(flags.yes === true ? { assumeYes: true } : {}),
        });
        const chosen = await servicesFor(ctx, deps, flags.account?.trim() || undefined);
        return domainStatus(deps, chosen);
      });
      const text = renderDomainStatus(result);
      if (text !== "") ctx.stdout(`${text}\n`);
      printNextSteps(ctx, result.next);
    });

  domain
    .command("auto-renew")
    .description("Turn automatic renewal of the project's domain on or off (asks first)")
    .addArgument(new Argument("<state>", "on or off").choices(["on", "off"]))
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option("--confirm <domain>", "The project's domain, to approve without a prompt (for scripts)")
    .exitOverride(usageErrorsExit2)
    .action(async (state: "on" | "off", flags: AutoRenewFlags) => {
      const account = flags.account?.trim() || undefined;
      let handler: DomainApprovalHandler | undefined;
      const scripted = (_refused: ApprovalRequest, phrase: string) =>
        [
          `opscrew domain auto-renew ${state}`,
          ...(account === undefined ? [] : [`--account ${account}`]),
          `--confirm ${phrase}`,
        ].join(" ");
      const result = await runPhaseCommand(
        ctx,
        async () => {
          const deps = createPhaseDeps(ctx, {
            ai: false,
            wrapApprovals: (base) => {
              handler = new DomainApprovalHandler(base, {
                interactive: ctx.isInteractive,
                ...(flags.confirm === undefined ? {} : { confirm: flags.confirm }),
                priceBound: false,
                prompts: promptsOf(ctx),
                print: ctx.stdout,
                ...clockOf(ctx),
              });
              return handler;
            },
          });
          const chosen = await servicesFor(ctx, deps, account);
          return setDomainAutoRenew(deps, { on: state === "on", ...chosen });
        },
        (error) => (handler === undefined ? undefined : refusalHint(handler, scripted)(error)),
      );
      printNextSteps(ctx, result.next);
    });
}

function clockOf(ctx: CliContext): { clock?: Clock } {
  const clock = servicesOf(ctx).clock;
  return clock === undefined ? {} : { clock };
}
