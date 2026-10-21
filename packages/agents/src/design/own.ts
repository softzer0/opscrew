import type { ComputeCatalog, ComputeOffer, Currency } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { EDGE_PROXIES, type EdgeProxy } from "@opscrew/iac-templates";
import {
  type CostEstimate,
  CostEstimateSchema,
  type DesignOption,
  DesignOptionSchema,
  type OwnDeployTarget,
  type ProjectFacts,
  type Requirements,
  serviceOf,
} from "@opscrew/plan-schema";
import { type Components, memoryText } from "./components";
import {
  containersText,
  OWN_SERVER_MEMORY_TOLERANCE,
  ownServerFreeDiskGb,
  sizeFor,
  smallServerWarnings,
} from "./sizing";

/** How the internet reaches a server the user owns: directly, or through a Cloudflare Tunnel. */
export type OwnServerAccess = OwnDeployTarget["access"];

/**
 * How a server the user owns serves the site: through a Cloudflare Tunnel (the default whenever
 * the domain is on Cloudflare, and for a server the internet cannot reach), directly behind
 * Cloudflare's proxy with OpsCrew's web filter (`proxy`, only as the user's explicit choice), or
 * directly with DNS only (the only way without a Cloudflare domain).
 */
export type OwnServerServing = "tunnel" | "proxy" | "dns-only";

/** True when the app's domain is on Cloudflare. */
export function hasCloudflareDomain(
  requirements: Pick<Requirements, "dnsProvider" | "domain">,
): boolean {
  return requirements.dnsProvider === "cloudflare" && requirements.domain !== undefined;
}

/**
 * The serving mode from the interview's answers: not reachable → the tunnel; reachable without a
 * Cloudflare domain → DNS only; reachable with one → the answer (`proxy` or `dns-only`), else the
 * tunnel.
 */
export function ownServerServing(input: {
  reachable: boolean;
  serve?: OwnServerServing | undefined;
  requirements: Pick<Requirements, "dnsProvider" | "domain">;
}): OwnServerServing {
  if (!input.reachable) return "tunnel";
  if (!hasCloudflareDomain(input.requirements)) return "dns-only";
  return input.serve ?? "tunnel";
}

/**
 * False when the server is known to have no public IPv4 address: OpsCrew reaches it by an IPv6
 * address and found no public IPv4 address for it. Serving behind Cloudflare's proxy with the web
 * filter publishes the site on IPv4 only, so it needs one. A host name may have one (provision
 * checks it before any change).
 */
export function mayHavePublicIpv4(server: {
  host: string;
  publicIpv4?: string | undefined;
}): boolean {
  if (server.publicIpv4 !== undefined) return true;
  return !server.host.includes(":");
}

/** The plain refusal when the web filter mode has no public IPv4 address to publish on. */
export function proxyNeedsIpv4Message(): { message: string; hint: string } {
  return {
    message:
      "Serving the site directly behind Cloudflare's proxy needs your server's public IPv4 address, because OpsCrew's web filter publishes the site on IPv4 only, and OpsCrew knows only an IPv6 address for your server.",
    hint: "Run `opscrew interview` and choose the Cloudflare Tunnel (recommended; it needs no public address), or give the server's public IPv4 address as its address.",
  };
}

/** The plan's `target.access` for a serving mode. */
export function servingAccess(serving: OwnServerServing): OwnServerAccess {
  return serving === "tunnel" ? "tunnel" : "public";
}

/** Said wherever OpsCrew designs, documents or removes a deployment on the user's own server. */
export const OWN_SERVER_BACKUPS_NOTE =
  "OpsCrew cannot turn on backups or snapshots on your own server; backups are your responsibility.";

/** Why an own-server option has no price. */
export const OWN_SERVER_PRICE_NOTE = "No server price: you already pay for this server.";

/** Id of the only design option on a server the user owns. */
export const OWN_SERVER_OPTION_ID = "own-server";

/**
 * The option's `target.serverType` and `target.location`, which the option schema requires but a
 * server the user owns does not have (the location is the same for an existing Portainer).
 * Surfaces that print them (`Server: <type> in <location>`) then read naturally; they never reach
 * the plan.
 */
export const OWN_SERVER_TYPE = "your server";
export const OWN_SERVER_LOCATION = "its current location";

/** The cost of an option on a server or Portainer the user already pays for: nothing. */
export function noServerCost(item: string, currency: Currency, asOf: string): CostEstimate {
  return CostEstimateSchema.parse({
    monthly: { amount: 0, currency },
    breakdown: [{ item, monthly: { amount: 0, currency } }],
    pricesIncludeVat: false,
    source: "live",
    asOf,
  });
}

export interface OwnServerOptionInput {
  facts: ProjectFacts;
  requirements: Requirements;
  /** The own-server catalogue: the inspected server as its single offer. */
  catalog: ComputeCatalog;
  access: OwnServerAccess;
  /** How the site is served (default: from `access`, a public server as DNS only). */
  serving?: OwnServerServing;
  /** What runs next to the app (`designComponents`); by default designed from the facts. */
  components?: Components;
  /** The server's proxy (`target.edge`), whose memory the sizing counts; Caddy by default. */
  edge?: EdgeProxy;
}

export interface OwnServerDesign {
  option: DesignOption;
  /** Plain-English problems: too little memory or disk, a tunnel without a Cloudflare domain. */
  warnings: string[];
}

/** True when the app is served through a tunnel but the user gave no domain on Cloudflare. */
export function tunnelNeedsCloudflareDomain(
  requirements: Pick<Requirements, "dnsProvider" | "domain">,
  access: OwnServerAccess,
): boolean {
  return access === "tunnel" && !(requirements.dnsProvider === "cloudflare" && requirements.domain);
}

/** The plain error (and next step) when a tunnel has no domain on Cloudflare. */
export function tunnelDomainMessage(): { message: string; hint: string } {
  return {
    message:
      "The internet cannot reach your server, so OpsCrew serves the app through a Cloudflare Tunnel, which needs a domain on your Cloudflare account, and you have not given one.",
    hint: "Run `opscrew interview` again and give a domain whose DNS is on Cloudflare, or say that the internet can reach the server.",
  };
}

/** `7.8` for 7.75 GB: at most one decimal. */
function gb(amount: number): string {
  return String(Math.round(amount * 10) / 10);
}

/**
 * Two amounts in GB for one sentence ("has X, needs Y"): whole numbers, or one decimal (then two)
 * when rounding would show the same number for both and the sentence would contradict itself.
 */
export function distinctAmounts(a: number, b: number): [string, string] {
  for (const decimals of [0, 1, 2]) {
    const factor = 10 ** decimals;
    const show = (amount: number) => String(Math.round(amount * factor) / factor);
    if (show(a) !== show(b)) return [show(a), show(b)];
  }
  return [String(a), String(b)];
}

/**
 * The single design option on a server the user already owns: the inspected server (the
 * catalogue's only offer) with no price ("you already pay for this server"), warnings when its
 * memory is clearly below what the sizing table plans for the app (below 90%: inspected memory
 * sits a little under the nominal size) or its free disk below what the app itself needs (the
 * operating system is already installed; `ownServerFreeDiskGb`), the Cloudflare Tunnel
 * when the internet cannot reach it (which needs a domain on Cloudflare), and the note that
 * backups are the user's responsibility. Validated with `DesignOptionSchema`.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the server has not been inspected (no offer).
 */
export async function buildOwnServerOption(input: OwnServerOptionInput): Promise<OwnServerDesign> {
  const { facts, requirements, catalog, access } = input;
  const serving = input.serving ?? (access === "tunnel" ? "tunnel" : "dns-only");
  if (catalog.provider !== "own") {
    throw new Error(`Design needs the own-server catalogue but got the ${catalog.provider} one.`);
  }
  const server: ComputeOffer | undefined = (await catalog.listOffers())[0];
  if (server === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew has not inspected your server yet, so it cannot check that the server is big enough for this app.",
      {
        hint: "OpsCrew reads the server's memory, disk and architecture over SSH before it designs the deployment. Check the answers about your server with `opscrew interview` and run `opscrew design` again.",
      },
    );
  }
  const sizing = sizeFor(facts, requirements, input.components, input.edge);
  const containers = containersText(sizing);
  const arch = server.architecture === "arm" ? "arm64" : "amd64";

  // One warning per shortfall: a service's own smallest server, else the server's size overall.
  const warnings = smallServerWarnings(sizing.services, server.memoryGb * 1024);
  if (warnings.length === 0 && server.memoryGb < sizing.memoryGb * OWN_SERVER_MEMORY_TOLERANCE) {
    const [has, needs] = distinctAmounts(server.memoryGb, sizing.memoryGb);
    warnings.push(
      `Your server has ${has} GB of memory, but OpsCrew plans at least ${needs} GB for ${containers} at the number of users you expect. The app may slow down or stop when memory runs out: add memory to the server, or expect fewer users.`,
    );
  }
  const freeDiskNeed = ownServerFreeDiskGb(sizing);
  if (server.diskGb < freeDiskNeed) {
    const [has, needs] = distinctAmounts(server.diskGb, freeDiskNeed);
    warnings.push(
      `Your server has ${has} GB of free disk, but OpsCrew plans at least ${needs} GB of free disk for ${containers}, their images and updates. Free up space or add disk before you deploy.`,
    );
  }
  if (tunnelNeedsCloudflareDomain(requirements, access)) {
    const { message, hint } = tunnelDomainMessage();
    warnings.push(`${message} ${hint}`);
  }

  const cost = noServerCost(
    "Your own server (you already pay for it)",
    requirements.budgetMonthly.currency,
    server.asOf,
  );

  const os = server.description === undefined ? "" : `, ${server.description}`;
  const served =
    access === "tunnel"
      ? " The app is served through a Cloudflare Tunnel, so no ports are opened on the server."
      : serving === "proxy"
        ? " The app is served directly behind Cloudflare's proxy; a filter in Docker lets only Cloudflare's addresses reach ports 80 and 443."
        : "";
  const summary = [
    `Your own server (${server.vcpus} vCPU, ${gb(server.memoryGb)} GB memory, ${gb(server.diskGb)} GB free disk, ${arch}${os}) running ${containers} with Docker Compose behind ${EDGE_PROXIES[sizing.edge].label}.${served}`,
    memoryText(sizing.components, server.memoryGb * 1024, sizing.edgeMb),
    OWN_SERVER_PRICE_NOTE,
    OWN_SERVER_BACKUPS_NOTE,
  ].join(" ");

  const tradeoffs = [...warnings];
  if (access === "tunnel") {
    tradeoffs.push(
      "OpsCrew serves the app through a Cloudflare Tunnel on your Cloudflare domain: no inbound ports are opened, and deploys from GitHub go through the tunnel too.",
    );
  } else if (serving === "proxy") {
    tradeoffs.push(
      "Ports 80 and 443 stay open, but OpsCrew's filter in Docker's DOCKER-USER chain lets only Cloudflare's addresses through (no Cloudflare Zero Trust needed). It fails closed: if the filter cannot be installed, Docker does not start and the site is down until it is fixed. A Cloudflare Tunnel opens no port at all.",
    );
  } else if (hasCloudflareDomain(requirements)) {
    tradeoffs.push(
      "DNS only: your server answers everyone on ports 80 and 443, and Cloudflare only answers DNS, so it neither hides nor protects the server. A Cloudflare Tunnel opens no port at all.",
    );
  }
  if (arch === "arm64") {
    tradeoffs.push("Your server uses arm64, so OpsCrew builds the app image for arm64.");
  }
  tradeoffs.push("A single server: if it fails, the app is down until the server is restored.");
  if (serviceOf(sizing, "postgres")) {
    tradeoffs.push(
      "Postgres runs in a container on the same server; back up its data yourself, because OpsCrew cannot turn on backups on your own server.",
    );
  }
  tradeoffs.push(OWN_SERVER_BACKUPS_NOTE);

  const option = DesignOptionSchema.parse({
    id: OWN_SERVER_OPTION_ID,
    title: "Your server",
    summary,
    target: {
      provider: "own",
      location: OWN_SERVER_LOCATION,
      serverType: OWN_SERVER_TYPE,
      vcpus: server.vcpus,
      // The option schema needs positive sizes; a full disk (0 GB free) already has its warning.
      memoryGb: Math.max(server.memoryGb, 0.01),
      diskGb: Math.max(server.diskGb, 0.01),
      cpuType: server.cpuType,
      architecture: server.architecture,
    },
    services: [...sizing.services],
    externalServices: [...sizing.externalServices],
    backups: false,
    cost,
    fitsBudget: true,
    recommended: true,
    tradeoffs,
  });
  return { option, warnings };
}
