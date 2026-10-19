import { OpsCrewError } from "@opscrew/core";
import {
  type DesignOption,
  DesignOptionSchema,
  type PortainerDeployTarget,
  type ProjectFacts,
  type Requirements,
  serviceOf,
} from "@opscrew/plan-schema";
import type { PortainerConnection } from "../shared";
import { hasCloudflareDomain, noServerCost, OWN_SERVER_LOCATION } from "./own";
import { containersText, sizeFor } from "./sizing";

/** What design needs from the interview's Portainer answers (`.opscrew/server.json`). */
export type PortainerDesignChoice = Pick<
  PortainerDeployTarget,
  "environmentId" | "arch" | "redeploy" | "web"
>;

/** Id of the only design option on an existing Portainer. */
export const PORTAINER_OPTION_ID = "portainer";

/** Said wherever OpsCrew designs, documents or removes a deployment in the user's Portainer. */
export const PORTAINER_HOST_NOTE =
  "OpsCrew does not change the host: its firewall, SSH and Portainer's own security stay yours.";

/** Said wherever OpsCrew designs, documents or removes a deployment in the user's Portainer. */
export const PORTAINER_BACKUPS_NOTE =
  "Backups, including the app's data volumes, are your responsibility: OpsCrew cannot back up a Portainer host.";

/** Both Portainer notes as one paragraph. */
export const PORTAINER_NOTES = `${PORTAINER_HOST_NOTE} ${PORTAINER_BACKUPS_NOTE}`;

/** Why a Portainer option has no price. */
export const PORTAINER_PRICE_NOTE = "No server price: you already run this Portainer.";

/**
 * The option's `target.serverType` (its `target.location` is {@link OWN_SERVER_LOCATION}), which
 * the option schema requires but an existing Portainer does not have; surfaces printing them read
 * naturally, and they never reach the plan. OpsCrew does not size the host either: its `vcpus`,
 * `memoryGb` and `diskGb` are the schema's smallest placeholders.
 */
export const PORTAINER_SERVER_TYPE = "your Portainer environment";

/**
 * The design choice from the interview's record, or a plain refusal: without the environment's
 * architecture (an older or hand-edited record) the environment must be picked again.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the record or one of its answers is missing.
 */
export function portainerDesignChoice(
  recorded: PortainerConnection | undefined,
): PortainerDesignChoice {
  if (recorded === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/requirements.yaml says the app runs in your existing Portainer, but OpsCrew does not know which Portainer and environment on this computer.",
      {
        hint: "Run `opscrew interview` and answer the questions about your Portainer, then run `opscrew design` again.",
      },
    );
  }
  const { arch, redeploy, web } = recorded;
  if (arch === undefined || redeploy === undefined || web === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew does not know ${arch === undefined ? "the CPU architecture of the Portainer environment you picked" : "how new versions and visitors should reach your Portainer"}, so it cannot design the deployment.`,
      {
        hint: "Pick the environment again with `opscrew interview`, then run `opscrew design` again.",
      },
    );
  }
  return { environmentId: recorded.environmentId, arch, redeploy, web };
}

/**
 * The plain refusal when the requirements no longer allow the recorded answers (the tunnel or the
 * Cloudflare redeploy without a domain on Cloudflare, Caddy without a domain), or `undefined`.
 */
export function portainerChoiceProblem(
  requirements: Pick<Requirements, "dnsProvider" | "domain">,
  choice: Pick<PortainerDesignChoice, "redeploy" | "web">,
): { message: string; hint: string } | undefined {
  const hint =
    "Run `opscrew interview` again and choose another way, or give a domain whose DNS is on Cloudflare, then run `opscrew design` again.";
  if (choice.web.mode === "tunnel" && !hasCloudflareDomain(requirements)) {
    return {
      message:
        "Visitors reach the app through a Cloudflare Tunnel, which needs a domain on your Cloudflare account, and you have not given one.",
      hint,
    };
  }
  if (choice.redeploy === "cloudflare" && !hasCloudflareDomain(requirements)) {
    return {
      message:
        "New versions reach Portainer through Cloudflare Access, which needs a domain on your Cloudflare account, and you have not given one.",
      hint,
    };
  }
  if (choice.web.mode === "caddy" && requirements.domain === undefined) {
    return {
      message:
        "Caddy serves the app on ports 80 and 443 with certificates for your domain, and you have not given one.",
      hint: "Run `opscrew interview` again and give a domain, or choose your own reverse proxy, then run `opscrew design` again.",
    };
  }
  return undefined;
}

/** How visitors reach the app, as a sentence. */
function webText(web: PortainerDesignChoice["web"]): string {
  switch (web.mode) {
    case "tunnel":
      return "Visitors reach it through a Cloudflare Tunnel in the app's stack, so no port is opened on the host.";
    case "proxy":
      return `The app listens on port ${web.port} of the host; you route your domain to it with your own reverse proxy and manage its certificate.`;
    case "caddy":
      return "Caddy serves it on ports 80 and 443 of the host with automatic certificates.";
  }
}

/** How new versions reach Portainer, as a sentence. */
function redeployText(redeploy: PortainerDesignChoice["redeploy"]): string {
  return redeploy === "updater"
    ? "New versions are recorded in a deploy branch of your repository, and a small updater stack next to the app asks Portainer once a minute to redeploy when it changed."
    : "After each merge, GitHub Actions asks Portainer to redeploy through Cloudflare Access with a service token; Portainer stays unreachable from the internet otherwise.";
}

export interface PortainerOptionInput {
  facts: ProjectFacts;
  requirements: Requirements;
  choice: PortainerDesignChoice;
  /** When the option was made (the cost's `asOf`). */
  now: Date;
}

/**
 * The single design option in the user's existing Portainer: the app (and the Postgres or Redis
 * it needs) as Portainer stacks in the chosen environment, built for its architecture, with no
 * price, the web and redeploy modes the user chose, and the notes that OpsCrew does not change
 * the host and that backups are the user's. Validated with `DesignOptionSchema`.
 */
export function buildPortainerOption(input: PortainerOptionInput): DesignOption {
  const { facts, requirements, choice } = input;
  const sizing = sizeFor(facts, requirements);
  const cost = noServerCost(
    "Your Portainer (you already run it)",
    requirements.budgetMonthly.currency,
    input.now.toISOString(),
  );
  const summary = [
    `Your existing Portainer, running ${containersText(sizing)} as a Docker Compose stack in the environment you picked (${choice.arch}).`,
    webText(choice.web),
    PORTAINER_PRICE_NOTE,
    PORTAINER_HOST_NOTE,
    PORTAINER_BACKUPS_NOTE,
  ].join(" ");

  const tradeoffs: string[] = [redeployText(choice.redeploy)];
  if (choice.web.mode === "proxy") {
    tradeoffs.push(
      "OpsCrew does not manage the certificate or the route on your reverse proxy: you point your domain at the port yourself.",
    );
  } else if (choice.web.mode === "caddy") {
    tradeoffs.push(
      "Ports 80 and 443 of the host must be free and reachable from the internet, and only one app on the host can use them.",
    );
  }
  if (choice.arch === "arm64") {
    tradeoffs.push("Your Portainer host uses arm64, so OpsCrew builds the app image for arm64.");
  }
  tradeoffs.push(
    "A single Docker host: if it fails, the app is down until the host is restored.",
    "OpsCrew does not check the host's memory or disk: make sure it has room for the app next to your other stacks.",
  );
  if (serviceOf(sizing, "postgres")) {
    tradeoffs.push(
      "Postgres runs in the app's stack with a named volume on the same host; back up its data yourself.",
    );
  }
  tradeoffs.push(PORTAINER_HOST_NOTE, PORTAINER_BACKUPS_NOTE);

  return DesignOptionSchema.parse({
    id: PORTAINER_OPTION_ID,
    title: "Your Portainer",
    summary,
    target: {
      provider: "portainer",
      location: OWN_SERVER_LOCATION,
      serverType: PORTAINER_SERVER_TYPE,
      vcpus: 1,
      memoryGb: 0.01,
      diskGb: 0.01,
      cpuType: "shared",
      architecture: choice.arch === "arm64" ? "arm" : "x86",
    },
    services: [...sizing.services],
    externalServices: [...sizing.externalServices],
    backups: false,
    cost,
    fitsBudget: true,
    recommended: true,
    tradeoffs,
  });
}
