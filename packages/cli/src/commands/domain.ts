import {
  type BuyDomainResult,
  buyDomain,
  type ConnectDomainResult,
  connectDomain,
  type DomainAccount,
  type DomainComparison,
  type DomainServices,
  type DomainStatusResult,
  domainStatus,
  type MaxPrice,
  type PhaseDeps,
  parseRegistrarId,
  REGISTRAR_IDS,
  REGISTRAR_NAMES,
  type SearchDomainsResult,
  searchDomains,
  setDomainAutoRenew,
  shellWord,
} from "@opscrew/agents";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  Clock,
  Money,
  RegistrarId,
} from "@opscrew/contracts";
import {
  type ErrorCode,
  isUserFacingError,
  listText,
  normalizeHostName,
  OpsCrewError,
} from "@opscrew/core";
import { Argument, type Command, Option } from "commander";
import { formatRequest, systemClock } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { quietReporter } from "../reporter";
import { printNextSteps } from "../ui/output";
import type { UiPrompts } from "../ui/prompts";

/** Approval kinds that need the domain typed (at the prompt or with `--confirm`). */
const TYPED_KINDS: readonly ApprovalRequest["kind"][] = ["domain-purchase", "domain-settings"];

/** Why the typed-domain handler refused a request without asking anyone. */
type DomainRefusal = "not-interactive" | "confirm-mismatch";

interface DomainApprovalOptions {
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
  return normalizeHostName(a) === normalizeHostName(b);
}

/**
 * Parses `--max-price`: `12.50`, `12.50USD` or `12.50 EUR` (USD or EUR, any case). Throws
 * `INVALID_INPUT` (exit 2) for anything else.
 */
export function parseMaxPriceFlag(value: string): MaxPrice {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]{3})?\s*$/.exec(value);
  const hint =
    "For example `--max-price 12.50` or `--max-price 12.50USD` (USD or EUR, in the currency the registrar quotes).";
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

/** An indented table with padded columns (the last column is not padded). */
function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    `  ${cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")}`.trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/** `label  value` lines, indented, labels padded to one width. */
function fields(rows: readonly [string, string][]): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n");
}

/** `Porkbun` for `porkbun` (the id itself when unknown). */
function registrarName(id: string): string {
  return (REGISTRAR_NAMES as Readonly<Record<string, string>>)[id] ?? id;
}

/** The search results as a table: domain, available, first year, renewal, note. */
function renderSearchTable(result: SearchDomainsResult): string {
  return table(
    ["DOMAIN", "AVAILABLE", "FIRST YEAR", "RENEWAL", "NOTE"],
    result.results.map((c) => [
      c.domain,
      c.registrable ? "yes" : "no",
      c.registrable ? money(c.firstYear) : "-",
      c.registrable ? money(c.renewal) : "-",
      c.registrable ? "" : (c.reason ?? "cannot be bought through OpsCrew"),
    ]),
  );
}

/**
 * `--compare`: one block per name, each registrar's first-year and renewal price on its own row
 * in the order the comparison gives (by price only), with the note or the reason it cannot be
 * bought there.
 */
function renderComparison(comparison: readonly DomainComparison[]): string {
  return comparison
    .map((c) =>
      [
        c.domain,
        table(
          ["REGISTRAR", "FIRST YEAR", "RENEWAL", "NOTE"],
          c.offers.map((o) => [
            registrarName(o.registrar),
            o.registrable ? money(o.firstYear) : "-",
            o.registrable ? money(o.renewal) : "-",
            o.registrable ? (o.note ?? "") : (o.reason ?? "cannot be bought through OpsCrew"),
          ]),
        ),
      ].join("\n"),
    )
    .join("\n\n");
}

/** `2026-10-12 14:00` in the local time zone (`utc`: in UTC). */
function clockTime(time: Date, utc: boolean): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const [y, mo, d, h, mi] = utc
    ? [
        time.getUTCFullYear(),
        time.getUTCMonth() + 1,
        time.getUTCDate(),
        time.getUTCHours(),
        time.getUTCMinutes(),
      ]
    : [time.getFullYear(), time.getMonth() + 1, time.getDate(), time.getHours(), time.getMinutes()];
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`;
}

/** `2026-10-12 14:00 local time (2026-10-12 12:00 UTC)` from an ISO timestamp. */
export function localAndUtc(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  return `${clockTime(time, false)} local time (${clockTime(time, true)} UTC)`;
}

/**
 * What `opscrew domain connect` did, in plain words, then its details. The command to run again
 * is in the result's next steps (with the run's flags), so it is not repeated here.
 */
function renderConnectResult(result: ConnectDomainResult): string {
  const { domain } = result;
  const name = registrarName(result.registrar);
  let summary: string;
  switch (result.outcome) {
    case "connected":
      summary = `${domain} is connected: its DNS is on Cloudflare and its nameservers at ${name} point at it.`;
      break;
    case "waiting-for-ds":
      summary =
        result.waitUntil === undefined
          ? `${domain} is not switched yet: its old DNSSEC records must be removed first (see the next steps).`
          : `${domain} is not switched yet: OpsCrew waits until resolvers have forgotten its old DNSSEC records, at ${localAndUtc(result.waitUntil)}; see the next steps.`;
      break;
    case "dnssec-published":
      summary = result.dnssec
        ? `${domain} is connected and DNSSEC is published.`
        : `${domain} is connected; this run updated its DNSSEC settings.`;
      break;
    case "already-connected":
      summary = `${domain} is already connected: its nameservers point at its Cloudflare zone, so nothing was switched.`;
      break;
  }
  const rows: [string, string][] = [
    ["Registrar", name],
    ["Records copied", String(result.copied)],
  ];
  if (result.nameservers.length > 0) rows.push(["Nameservers", result.nameservers.join(", ")]);
  rows.push(["DNSSEC", result.dnssec ? "on" : "off"]);
  return `${summary}\n${fields(rows)}`;
}

/** Prints a `--compare` result: the registrars asked, one block per name, then how to buy. */
function printComparison(
  ctx: CliContext,
  query: string,
  comparison: readonly DomainComparison[],
): void {
  if (comparison.length === 0) {
    ctx.stdout(`No names to compare for "${query}".\n`);
    printNextSteps(ctx, ["try another word with `opscrew domain search <name> --compare`."]);
    return;
  }
  const ids = [...new Set(comparison.flatMap((c) => c.offers.map((o) => o.registrar)))];
  ctx.stdout(
    `Prices for "${query}" at ${listText(ids.map(registrarName))}, checked just now (listed by renewal price, then first-year price):\n\n${renderComparison(comparison)}\n`,
  );
  printNextSteps(ctx, [
    `buy at the registrar you choose with \`opscrew domain buy <domain> --registrar <id>\` (${ids.join(", ")}). OpsCrew shows the price and buys nothing until you type the domain.`,
  ]);
}

/** Registrar and nameservers of a domain set up at another registrar (nothing for Cloudflare). */
function renderBuyResult(result: BuyDomainResult): string {
  if (result.outcome !== "set-up" || result.registrar === undefined) return "";
  if (result.registrar === "cloudflare") return "";
  const rows: [string, string][] = [["Registrar", registrarName(result.registrar)]];
  if (result.nameservers !== undefined && result.nameservers.length > 0) {
    rows.push(["Nameservers", result.nameservers.join(", ")]);
  }
  return fields(rows);
}

/** The registration of the project's domain, one setting per line. */
function renderDomainStatus(result: DomainStatusResult): string {
  const info = result.domain;
  if (info === undefined) return "";
  const rows: [string, string][] = [
    ["Registrar", registrarName(info.registrar)],
    ["Registered", day(info.createdAt)],
    ["Expires", day(info.expiresAt)],
    ["Auto-renew", onOff(info.autoRenew)],
    ["Transfer lock", onOff(info.locked)],
    ["WHOIS privacy", onOff(info.privacy)],
    ["DNSSEC", onOff(result.dnssec)],
  ];
  return `${info.domain}\n${fields(rows)}`;
}

/**
 * The Cloudflare accounts the token can use, from the run's domain services when they list them;
 * the token is registered with the redactor first.
 */
async function listAccounts(
  deps: PhaseDeps,
  given: DomainServices | undefined,
  token: string,
): Promise<DomainAccount[]> {
  deps.redactor.addLiteral(token, "cloudflare-token");
  if (given?.accounts !== undefined) return given.accounts();
  const accounts = await new CloudflareClient({
    token,
    fetch: deps.fetch,
    version: deps.version,
  }).listAccounts();
  return accounts.map((a) => ({ id: a.id, name: a.name }));
}

/**
 * The domain services for a run, with the account chosen at a prompt when a person runs the
 * command without `--account` and the token can use several accounts (the agents then see only
 * that account's list once, so they do not ask Cloudflare again). `cloudflare: false` (a search,
 * status or auto-renew at another registrar) never asks.
 */
async function servicesFor(
  ctx: CliContext,
  deps: PhaseDeps,
  account: string | undefined,
  cloudflare = true,
): Promise<{ services?: DomainServices; account?: string }> {
  const given = servicesOf(ctx).domain;
  const keep = {
    ...(given === undefined ? {} : { services: given }),
    ...(account === undefined ? {} : { account }),
  };
  const token = ctx.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!cloudflare || !ctx.isInteractive || account !== undefined || !token) return keep;
  const list = await listAccounts(deps, given, token);
  const services: DomainServices = { ...given, accounts: async () => list };
  if (list.length < 2) return { services };
  return { services, account: await chooseAccount(ctx, list) };
}

/** Asks a terminal user which of several Cloudflare accounts to use; returns its id. */
async function chooseAccount(ctx: CliContext, list: readonly DomainAccount[]): Promise<string> {
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
  return chosen;
}

/**
 * Services for `status` and `auto-renew`, where the agents decide whether Cloudflare is needed
 * (the plan's registrar may be Porkbun, Namecheap or GoDaddy). The account list is read, and a
 * terminal user asked to choose among several accounts, only when the agents ask for it; the
 * agents then get the chosen account only. Without a terminal the agents' own "pass --account"
 * error applies.
 */
function lazyServicesFor(
  ctx: CliContext,
  deps: PhaseDeps,
  account: string | undefined,
): { services?: DomainServices; account?: string } {
  const given = servicesOf(ctx).domain;
  const keep = {
    ...(given === undefined ? {} : { services: given }),
    ...(account === undefined ? {} : { account }),
  };
  const token = ctx.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!ctx.isInteractive || account !== undefined || !token) return keep;
  let chosen: Promise<DomainAccount[]> | undefined;
  const accounts = (): Promise<DomainAccount[]> => {
    chosen ??= (async () => {
      const list = await listAccounts(deps, given, token);
      if (list.length < 2) return list;
      const id = await chooseAccount(ctx, list);
      return list.filter((a) => a.id === id);
    })();
    return chosen;
  };
  return { services: { ...given, accounts } };
}

interface AccountFlag {
  account?: string;
  registrar?: string;
}

interface SearchFlags extends AccountFlag {
  json?: boolean;
  compare?: boolean;
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

interface ConnectFlags extends AccountFlag {
  recordsFile?: string;
  confirm?: string;
  yes?: boolean;
  json?: boolean;
}

const ACCOUNT_DESCRIPTION =
  "Cloudflare account id or name, when the token can use several accounts";

const REGISTRAR_LIST = REGISTRAR_IDS.join(", ");

/**
 * `--registrar <id>`, parsed (unknown ids stop with `INVALID_INPUT`, exit 2); undefined when not
 * given.
 */
function registrarFlag(value: string | undefined): RegistrarId | undefined {
  return value === undefined ? undefined : parseRegistrarId(value);
}

/** True when the command needs the Cloudflare account (no registrar, or Cloudflare itself). */
function usesCloudflare(registrar: RegistrarId | undefined): boolean {
  return registrar === undefined || registrar === "cloudflare";
}

/** ` --registrar <id>` for a registrar other than Cloudflare, else nothing (for suggested commands). */
function registrarArg(registrar: RegistrarId | undefined): string {
  return usesCloudflare(registrar) ? "" : ` --registrar ${registrar}`;
}

/** A file path for a suggested command: `/` separators, quoted like any word (`shellWord`). */
export function pathArg(value: string): string {
  return shellWord(value.replaceAll("\\", "/"));
}

/**
 * `error` with the exact command of this run (its flags included) as the next step when the
 * typed-domain handler refused a request without a prompt, so copying the command approves the
 * same request; any other error as it is.
 */
function withScriptedHint(
  error: unknown,
  handler: DomainApprovalHandler | undefined,
  command: (refused: ApprovalRequest, phrase: string) => string,
): unknown {
  const refused = handler?.refused;
  if (refused === undefined || !isUserFacingError(error) || error.code !== "APPROVAL_REFUSED") {
    return error;
  }
  const run = `\`${command(refused.request, refused.phrase)}\``;
  const hint =
    refused.why === "confirm-mismatch"
      ? `--confirm does not match ${refused.phrase}. To approve it, run ${run}.`
      : `This run is not interactive, so OpsCrew needs the domain typed again: run ${run}, or run the command in a terminal.`;
  return new OpsCrewError(error.code as ErrorCode, error.message, { hint, cause: error });
}

/**
 * `opscrew domain`: find, buy, connect and manage a domain at Cloudflare, Porkbun, Namecheap or
 * GoDaddy, with its DNS on Cloudflare (FR-601, FR-701, FR-703, FR-705, FR-706). A purchase or a
 * settings change is approved only with the domain typed (at the prompt, or `--confirm <domain>`
 * in scripts; a purchase also needs `--max-price` there); `--yes` never approves either. Exit
 * codes: 0 done (for `connect`, also while it waits for old DNSSEC records), 1 stopped on purpose
 * (refused, cancelled, cannot be bought), 2 error (bad input, credentials, registrar errors).
 */
export function register(program: Command, ctx: CliContext): void {
  const domain = program
    .command("domain")
    .description(
      "Find, buy, connect and manage a domain (Cloudflare, Porkbun, Namecheap or GoDaddy) with its DNS on Cloudflare",
    );

  domain
    .command("search")
    .description("Check which domains you can buy and what they cost (changes nothing)")
    .argument("<name>", "A word or a domain, for example shopapp or shopapp.com")
    .option(
      "--registrar <id>",
      `Search at this registrar instead of Cloudflare (${REGISTRAR_LIST})`,
    )
    .addOption(
      new Option(
        "--compare",
        "Check the name at every registrar you set up and list their prices side by side",
      ).conflicts("registrar"),
    )
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option("--json", "Print the results as JSON")
    .action(async (name: string, flags: SearchFlags) => {
      const json = flags.json === true;
      const compare = flags.compare === true;
      const registrar = registrarFlag(flags.registrar);
      // Progress is dropped for `--json` so stdout holds only the JSON; problems go to stderr.
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...(json ? { reporter: quietReporter(ctx.reporter) } : {}),
      });
      const chosen = await servicesFor(
        ctx,
        deps,
        flags.account?.trim() || undefined,
        usesCloudflare(registrar),
      );
      const result = await searchDomains(deps, {
        query: name,
        ...(registrar === undefined ? {} : { registrar }),
        ...(compare ? { compare: true } : {}),
        ...chosen,
      });
      if (json) {
        ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (compare) {
        printComparison(ctx, name.trim(), result.comparison ?? []);
        return;
      }
      const where = usesCloudflare(registrar)
        ? `on the Cloudflare account ${result.account?.name ?? ""}`.trimEnd()
        : `at ${registrarName(registrar ?? "")}`;
      if (result.results.length === 0) {
        ctx.stdout(
          usesCloudflare(registrar)
            ? `Cloudflare suggested no domains for "${name.trim()}".\n`
            : `${registrarName(registrar ?? "")} found no domains for "${name.trim()}".\n`,
        );
        printNextSteps(ctx, ["try another word with `opscrew domain search <name>`."]);
        return;
      }
      ctx.stdout(
        `Domains for "${name.trim()}" ${where}, checked just now:\n\n${renderSearchTable(result)}\n`,
      );
      const cheapest = result.results.find((c) => c.registrable);
      printNextSteps(ctx, [
        cheapest === undefined
          ? "none of these can be bought through OpsCrew; try another word with `opscrew domain search <name>`."
          : `run \`opscrew domain buy ${cheapest.domain}${registrarArg(registrar)}\` (or another available name). OpsCrew shows the price and buys nothing until you type the domain.`,
      ]);
    });

  domain
    .command("buy")
    .description("Buy a domain (shows the price and asks you to type the domain first)")
    .argument("<domain>", "The domain to buy, for example shopapp.com")
    .option(
      "--registrar <id>",
      `Where to buy it (${REGISTRAR_LIST}; default cloudflare). The DNS goes to Cloudflare either way`,
    )
    .option("--years <n>", "Registration years, 1 to 10 (default 1)")
    .option("--no-auto-renew", "Do not renew the domain automatically before it expires")
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option(
      "--confirm <domain>",
      "The domain again, to approve without a prompt (for scripts and CI; a purchase also needs --max-price)",
    )
    .option(
      "--max-price <amount>",
      "The most you agree to pay now, for example 12.50 or 12.50USD (USD or EUR, in the currency the registrar quotes; required without a terminal)",
    )
    .option(
      "--forget-pending-purchase",
      "Clear OpsCrew's note about an unfinished purchase after you checked the registrar's dashboard",
    )
    .option(
      "--yes",
      "In a run without a terminal, approve updating the project files (never a purchase or a domain setting)",
    )
    .action(async (input: string, flags: BuyFlags, command: Command) => {
      const name = normalizeHostName(input);
      // --no-auto-renew only when given: for a domain already on the account, auto-renew then
      // changes only after an approval.
      const autoRenew =
        command.getOptionValueSource("autoRenew") === "cli" ? flags.autoRenew : undefined;
      const account = flags.account?.trim() || undefined;
      const forget = flags.forgetPendingPurchase === true;
      const registrar = registrarFlag(flags.registrar);
      const maxPrice = flags.maxPrice === undefined ? undefined : parseMaxPriceFlag(flags.maxPrice);
      const years = flags.years === undefined ? undefined : Number(flags.years.trim());
      let handler: DomainApprovalHandler | undefined;
      // The command that approves the refused request: forgetting the note needs only the
      // typed domain, setting up an owned domain no price, a purchase the price limit too.
      const scripted = (refused: ApprovalRequest, phrase: string) => {
        const buy = `opscrew domain buy ${name}${registrarArg(registrar)}`;
        if (forget && refused.kind === "domain-settings") {
          return `${buy} --forget-pending-purchase --confirm ${phrase}`;
        }
        const parts = [buy];
        if (flags.years !== undefined) parts.push(`--years ${flags.years.trim()}`);
        if (autoRenew === false) parts.push("--no-auto-renew");
        if (account !== undefined) parts.push(`--account ${shellWord(account)}`);
        parts.push(`--confirm ${phrase}`);
        if (refused.kind === "domain-purchase") {
          parts.push(`--max-price ${flags.maxPrice?.trim().replace(/\s+/g, "") || "<amount>"}`);
        }
        return parts.join(" ");
      };
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...(flags.yes === true ? { assumeYes: true } : {}),
        wrapApprovals: (base, clock) => {
          handler = new DomainApprovalHandler(base, {
            interactive: ctx.isInteractive,
            ...(flags.confirm === undefined ? {} : { confirm: flags.confirm }),
            priceBound: maxPrice !== undefined,
            prompts: promptsOf(ctx),
            print: ctx.stdout,
            clock,
          });
          return handler;
        },
      });
      const chosen = await servicesFor(ctx, deps, account);
      const result = await buyDomain(deps, {
        domain: input,
        ...(registrar === undefined ? {} : { registrar }),
        ...(years === undefined ? {} : { years }),
        ...(autoRenew === undefined ? {} : { autoRenew }),
        ...(maxPrice === undefined ? {} : { maxPrice }),
        ...(forget ? { forgetPendingPurchase: true } : {}),
        ...chosen,
      }).catch((error: unknown) => {
        throw withScriptedHint(error, handler, scripted);
      });
      const details = renderBuyResult(result);
      if (details !== "") ctx.stdout(`${details}\n`);
      printNextSteps(ctx, result.next);
    });

  domain
    .command("connect")
    .description(
      "Move a domain you own at Porkbun, Namecheap or GoDaddy to Cloudflare DNS (copies its records first, asks before every change)",
    )
    .argument("<domain>", "The domain to connect, for example shopapp.com")
    .option(
      "--registrar <id>",
      "The registrar that holds it (porkbun, namecheap or godaddy; default: found in your accounts)",
    )
    .option(
      "--records-file <path>",
      "A BIND zone file with the current DNS records, relative to the project root (when the registrar does not serve them)",
    )
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option(
      "--confirm <domain>",
      "The domain again, to approve every step of this run without a prompt (for scripts and CI)",
    )
    .option(
      "--yes",
      "In a run without a terminal, approve updating the project files (never a DNS, nameserver or DNSSEC change)",
    )
    .option("--json", "Print the result as JSON")
    .action(async (input: string, flags: ConnectFlags) => {
      const name = normalizeHostName(input);
      const json = flags.json === true;
      const account = flags.account?.trim() || undefined;
      const recordsFile = flags.recordsFile?.trim() || undefined;
      const registrar = registrarFlag(flags.registrar);
      let handler: DomainApprovalHandler | undefined;
      // `opscrew domain connect <domain>` with the flags of this run that change what it does.
      const again = () =>
        [
          `opscrew domain connect ${name}`,
          ...(registrar === undefined ? [] : [`--registrar ${registrar}`]),
          ...(recordsFile === undefined ? [] : [`--records-file ${pathArg(recordsFile)}`]),
          ...(account === undefined ? [] : [`--account ${shellWord(account)}`]),
        ].join(" ");
      const scripted = (_refused: ApprovalRequest, phrase: string) =>
        `${again()} --confirm ${phrase}`;
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...(json ? { reporter: quietReporter(ctx.reporter) } : {}),
        ...(flags.yes === true ? { assumeYes: true } : {}),
        wrapApprovals: (base, clock) => {
          handler = new DomainApprovalHandler(base, {
            interactive: ctx.isInteractive,
            ...(flags.confirm === undefined ? {} : { confirm: flags.confirm }),
            priceBound: false,
            prompts: promptsOf(ctx),
            // With --json, stdout holds only the result.
            print: json ? ctx.stderr : ctx.stdout,
            clock,
          });
          return handler;
        },
      });
      const chosen = await servicesFor(ctx, deps, account);
      const result = await connectDomain(deps, {
        domain: input,
        ...(registrar === undefined ? {} : { registrar }),
        ...(recordsFile === undefined ? {} : { recordsFile }),
        ...chosen,
      }).catch((error: unknown) => {
        throw withScriptedHint(error, handler, scripted);
      });
      if (json) {
        ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      ctx.stdout(`\n${renderConnectResult(result)}\n`);
      printNextSteps(ctx, result.next);
    });

  domain
    .command("status")
    .description("Show the registration of the project's domain: expiry, auto-renew, lock, DNSSEC")
    .option(
      "--registrar <id>",
      `The registrar that holds it (${REGISTRAR_LIST}; default: the one in opscrew/plan.yaml, else cloudflare)`,
    )
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option(
      "--yes",
      "In a run without a terminal, approve recording the registration in opscrew/plan.yaml",
    )
    .action(async (flags: AccountFlag & { yes?: boolean }) => {
      const registrar = registrarFlag(flags.registrar);
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...(flags.yes === true ? { assumeYes: true } : {}),
      });
      // The agents decide whether Cloudflare is needed (the plan may name another registrar).
      const chosen = lazyServicesFor(ctx, deps, flags.account?.trim() || undefined);
      const result = await domainStatus(deps, {
        ...(registrar === undefined ? {} : { registrar }),
        ...chosen,
      });
      const text = renderDomainStatus(result);
      if (text !== "") ctx.stdout(`${text}\n`);
      printNextSteps(ctx, result.next);
    });

  domain
    .command("auto-renew")
    .description("Turn automatic renewal of the project's domain on or off (asks first)")
    .addArgument(new Argument("<state>", "on or off").choices(["on", "off"]))
    .option(
      "--registrar <id>",
      `The registrar that holds it (${REGISTRAR_LIST}; default: the one in opscrew/plan.yaml, else cloudflare)`,
    )
    .option("--account <id or name>", ACCOUNT_DESCRIPTION)
    .option("--confirm <domain>", "The project's domain, to approve without a prompt (for scripts)")
    .action(async (state: "on" | "off", flags: AutoRenewFlags) => {
      const account = flags.account?.trim() || undefined;
      const registrar = registrarFlag(flags.registrar);
      let handler: DomainApprovalHandler | undefined;
      const scripted = (_refused: ApprovalRequest, phrase: string) =>
        [
          `opscrew domain auto-renew ${state}`,
          ...(registrar === undefined ? [] : [`--registrar ${registrar}`]),
          ...(account === undefined ? [] : [`--account ${shellWord(account)}`]),
          `--confirm ${phrase}`,
        ].join(" ");
      const deps = createPhaseDeps(ctx, {
        ai: false,
        wrapApprovals: (base, clock) => {
          handler = new DomainApprovalHandler(base, {
            interactive: ctx.isInteractive,
            ...(flags.confirm === undefined ? {} : { confirm: flags.confirm }),
            priceBound: false,
            prompts: promptsOf(ctx),
            print: ctx.stdout,
            clock,
          });
          return handler;
        },
      });
      const result = await setDomainAutoRenew(deps, {
        on: state === "on",
        ...(registrar === undefined ? {} : { registrar }),
        ...lazyServicesFor(ctx, deps, account),
      }).catch((error: unknown) => {
        throw withScriptedHint(error, handler, scripted);
      });
      printNextSteps(ctx, result.next);
    });
}
