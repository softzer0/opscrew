import { normalizeHostName, OpsCrewError } from "@opscrew/core";
import { type AddonKind, IMAGES, portainerHostname } from "@opscrew/iac-templates";
import {
  ADDON_MEMORY_DEFAULTS,
  type BeszelSettings,
  cloudflareEdgeCoverage,
  type DeployPlan,
  DeployPlanSchema,
  type GrafanaCloudSettings,
  onOneServer,
} from "@opscrew/plan-schema";
import { z } from "zod";

/**
 * The phase add-on audits and approvals name: an add-on changes the deployment as provision does.
 * Their titles name the add-on.
 */
export const ADDON_PHASE = "provision";

/** The version in an image pin (`henrygd/beszel:0.21.1@sha256:…` → `0.21.1`, without a `v`). */
function pinnedVersion(ref: string): string {
  return (ref.split(/[:@]/)[1] as string).replace(/^v/, "");
}

/** Beszel's release OpsCrew pins (the hub's and the agent's). */
export const BESZEL_VERSION = pinnedVersion(IMAGES.beszel.ref);

/** Grafana Alloy's release OpsCrew pins. */
export const ALLOY_VERSION = pinnedVersion(IMAGES.alloy.ref);

/** Each add-on's name in messages, and its `opscrew addon` name. */
export const ADDON_NAMES: Readonly<Record<AddonKind, string>> = {
  beszel: "Beszel",
  "grafana-cloud": "Grafana Cloud",
};

/** The add-on's field in `plan.observability`. */
export function addonField(kind: AddonKind): "beszel" | "grafanaCloud" {
  return kind === "beszel" ? "beszel" : "grafanaCloud";
}

/** True when the plan turns the add-on on. */
export function addonEnabled(plan: DeployPlan, kind: AddonKind): boolean {
  return plan.observability?.[addonField(kind)]?.enabled === true;
}

/**
 * Stops unless the app runs on a server OpsCrew deploys to (a cloud server or the user's own):
 * the add-ons run there only. The stop says why, and what the target offers instead.
 */
export function requireServerTarget(plan: DeployPlan, kind: AddonKind, command: string): void {
  const provider = plan.target.provider;
  if (onOneServer(provider)) return;
  const where =
    provider === "portainer"
      ? "in your Portainer, where OpsCrew does not add containers of its own in this version"
      : provider === "localhost"
        ? "on this computer, which needs no monitoring add-on"
        : "on a host without a server of its own";
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${ADDON_NAMES[kind]} runs only on a server OpsCrew deploys to (a cloud server or your own), and this app runs ${where}, so \`${command}\` changes nothing.`,
    {
      hint: "`opscrew logs` shows the app's log lines and `opscrew status` its figures on every target.",
    },
  );
}

/** What the user asked for with `opscrew addon enable beszel`. */
export interface BeszelRequest {
  /** `hub` (default): the dashboard and the agent here; `agent`: only the agent. */
  mode?: "hub" | "agent";
  /** `local` (default): through an SSH tunnel; `subdomain`: behind Cloudflare Access. */
  access?: "local" | "subdomain";
  /** The dashboard's subdomain (`subdomain` only); a single label means `<label>.<zone>`. */
  hostname?: string;
  /** Email addresses Cloudflare Access lets in (`subdomain` only, at least one). */
  allowEmails?: readonly string[];
  /** Agent mode: the user's hub. */
  hubUrl?: string;
  /** Agent mode: the hub's public key (`ssh-ed25519 …`). */
  hubKey?: string;
}

const EmailSchema = z.email();

/**
 * Beszel's settings for a request, checked before anything is contacted: the pinned version and
 * the plan's memory limits, the mode and its access. Throws `INVALID_INPUT` or `PHASE_PRECONDITION`
 * with a plain next step.
 */
export function beszelSettings(
  plan: DeployPlan,
  request: BeszelRequest,
  zone: string | undefined,
): BeszelSettings {
  const mode = request.mode ?? "hub";
  const access = request.access ?? "local";
  const emails = [...new Set((request.allowEmails ?? []).map((email) => email.trim()))].filter(
    (email) => email !== "",
  );
  const memoryMb = plan.observability?.beszel?.memoryMb ?? { ...ADDON_MEMORY_DEFAULTS.beszel };
  if (mode === "agent") {
    const { hubUrl, hubKey } = request;
    if (hubUrl === undefined || hubKey === undefined) {
      const missing = [
        ...(hubUrl === undefined ? ["`--hub-url` (your hub's address)"] : []),
        ...(hubKey === undefined ? ["`--hub-key` (the hub's public key)"] : []),
      ];
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Beszel's agent connects out to your own hub, so it needs ${missing.join(" and ")}. Nothing was changed.`,
        {
          hint: "In your hub, choose Add system: it shows the public key and the token. Run `opscrew addon enable beszel --mode agent --hub-url https://… --hub-key 'ssh-ed25519 …'` with the token in OPSCREW_BESZEL_TOKEN.",
        },
      );
    }
    if (access === "subdomain" || emails.length > 0) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "A subdomain and allowed emails are for Beszel's own dashboard on this server (hub mode); in agent mode the dashboard is your hub.",
        { hint: "Leave out `--access`, `--hostname` and `--allow-email` with `--mode agent`." },
      );
    }
    return {
      enabled: true,
      version: BESZEL_VERSION,
      mode,
      access: "local",
      hubUrl,
      hubKey: hubKey.trim(),
      memoryMb,
    };
  }
  if (request.hubUrl !== undefined || request.hubKey !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "`--hub-url` and `--hub-key` are for agent mode, which connects to a hub you already run.",
      { hint: "Add `--mode agent`, or leave them out to run Beszel's dashboard on this server." },
    );
  }
  if (access === "local") {
    if (emails.length > 0 || request.hostname !== undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "A hostname and allowed emails only apply when Beszel's dashboard is served on a subdomain.",
        {
          hint: "Add `--access subdomain`, or leave out `--hostname` and `--allow-email` to reach the dashboard through an SSH tunnel (`opscrew addon open beszel`).",
        },
      );
    }
    return { enabled: true, version: BESZEL_VERSION, mode, access, memoryMb };
  }
  return { ...subdomainSettings(plan, request, emails, zone), memoryMb };
}

/** Hub mode at a subdomain: the hostname in the app's zone and the emails Access lets in. */
function subdomainSettings(
  plan: DeployPlan,
  request: BeszelRequest,
  emails: string[],
  zone: string | undefined,
): Omit<BeszelSettings, "memoryMb"> {
  if (plan.dns.provider !== "cloudflare" || plan.dns.domain === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "A subdomain for Beszel's dashboard is served through Cloudflare (a tunnel and Cloudflare Access), and this app has no domain on Cloudflare. Nothing was changed.",
      {
        hint: "Add a domain whose DNS is on Cloudflare with `opscrew dns --domain <domain>` first, or leave out `--access subdomain` to reach the dashboard through an SSH tunnel.",
      },
    );
  }
  const name = normalizeHostName(request.hostname ?? "");
  if (name === "") {
    throw new OpsCrewError("INVALID_INPUT", "A subdomain for Beszel's dashboard needs its name.", {
      hint: "Add `--hostname beszel` (or a full name in the app's zone).",
    });
  }
  const hostname = name.includes(".") || zone === undefined ? name : `${name}.${zone}`;
  if (zone !== undefined) {
    const deep = cloudflareEdgeCoverage(hostname, zone);
    if (deep !== undefined) {
      throw new OpsCrewError("INVALID_INPUT", `${deep.reason}. Nothing was changed.`, {
        hint: `Use a name one level below ${zone}, for example \`--hostname ${deep.suggestion}\`.`,
      });
    }
  }
  if (hostname === portainerHostname(plan)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Portainer's web UI already uses ${hostname} on this server, and both go through one Cloudflare Tunnel, so Beszel's dashboard needs a name of its own.`,
      { hint: "Give another name with `--hostname`, for example `--hostname beszel`." },
    );
  }
  if (emails.length === 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Beszel's dashboard on a subdomain needs at least one email address that Cloudflare Access lets in; OpsCrew never makes it public.",
      { hint: "Add `--allow-email you@example.com` (repeat it for more people)." },
    );
  }
  const invalid = emails.filter((email) => !EmailSchema.safeParse(email).success);
  if (invalid.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${invalid.join(", ")} ${invalid.length === 1 ? "is not an email address" : "are not email addresses"}.`,
      { hint: "Give each address as name@example.com with `--allow-email`." },
    );
  }
  return {
    enabled: true,
    version: BESZEL_VERSION,
    mode: "hub",
    access: "subdomain",
    hostname,
    allowedEmails: emails,
  };
}

/** Grafana Cloud's settings given by the user (or kept from the plan). */
export interface GrafanaRequest {
  metrics: { url: string; user: string };
  logs: { url: string; user: string };
  logSampling: number;
}

/** Grafana Cloud's settings: the pinned Alloy, the stack's endpoints and the plan's memory. */
export function grafanaSettings(plan: DeployPlan, request: GrafanaRequest): GrafanaCloudSettings {
  return {
    enabled: true,
    version: ALLOY_VERSION,
    metrics: request.metrics,
    logs: request.logs,
    logSampling: request.logSampling,
    memoryMb: plan.observability?.grafanaCloud?.memoryMb ?? {
      ...ADDON_MEMORY_DEFAULTS.grafanaCloud,
    },
  };
}

/**
 * The plan with the add-on's settings replaced (or removed with `undefined`; an `observability`
 * left empty goes too), validated with the plan schema: a setting it refuses stops with its plain
 * reason.
 */
export function withAddon(
  plan: DeployPlan,
  kind: AddonKind,
  settings: BeszelSettings | GrafanaCloudSettings | undefined,
): DeployPlan {
  const field = addonField(kind);
  const { [field]: _old, ...others } = plan.observability ?? {};
  const observability = settings === undefined ? others : { ...others, [field]: settings };
  const { observability: _previous, ...rest } = plan;
  const parsed = DeployPlanSchema.safeParse(
    Object.keys(observability).length === 0 ? rest : { ...rest, observability },
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? `observability.${field}`;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew cannot use these ${ADDON_NAMES[kind]} settings: ${path} ${issue?.message ?? "is not valid"}. Nothing was changed.`,
      { hint: "Correct the value named above and run the command again." },
    );
  }
  return parsed.data;
}
