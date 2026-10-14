import { OpsCrewError } from "@opscrew/core";
import { PORTAINER_PORT } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, type PortainerSettings } from "@opscrew/plan-schema";
import { z } from "zod";

/**
 * Portainer CE release OpsCrew pins (`portainer/portainer-ce:2.45.2`, the LTS tag on Docker Hub
 * on 2026-10-14). Enabling Portainer writes it to `plan.portainer.version`.
 */
export const PORTAINER_VERSION = "2.45.2";

/** The address Portainer answers on through the SSH tunnel, on the user's computer. */
export const PORTAINER_LOCAL_URL = `https://localhost:${PORTAINER_PORT}`;

/** On Hetzner and DigitalOcean servers Portainer runs as the deploy user in its home directory. */
export const CLOUD_PORTAINER_DIR = "/home/deploy/opscrew/portainer";

/** The tunnel connector for Portainer's subdomain on Hetzner and DigitalOcean servers. */
export const CLOUD_TUNNEL_DIR = "/home/deploy/opscrew/cloudflared";

/** What the user asked for with `opscrew portainer enable`. */
export interface PortainerEnableRequest {
  /**
   * Opt-in: serve Portainer on this subdomain of the app's Cloudflare zone, behind Cloudflare
   * Access. A single label (`portainer`) means `portainer.<zone>`.
   */
  subdomain?: string;
  /** Email addresses Cloudflare Access lets in (subdomain only; at least one there). */
  allowEmails?: readonly string[];
}

const EmailSchema = z.email();

/**
 * The Portainer settings for an enable request, before the zone is known: on, the pinned
 * version, local-only or a subdomain with its allowed emails. Throws `INVALID_INPUT` or
 * `PHASE_PRECONDITION` with a plain next step for a request OpsCrew cannot serve.
 */
export function portainerSettings(
  plan: Pick<DeployPlan, "dns">,
  request: PortainerEnableRequest,
  zone: string | undefined,
): PortainerSettings {
  const subdomain = request.subdomain?.trim().toLowerCase().replace(/\.$/, "");
  const emails = [...new Set((request.allowEmails ?? []).map((email) => email.trim()))].filter(
    (email) => email !== "",
  );
  if (subdomain === undefined || subdomain === "") {
    if (emails.length > 0) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "Allowed email addresses only apply to a Portainer subdomain, and none was given.",
        {
          hint: "Add `--subdomain <host>` to serve Portainer behind Cloudflare Access, or leave out `--allow-email` to keep it reachable only through an SSH tunnel.",
        },
      );
    }
    return { enabled: true, version: PORTAINER_VERSION, access: "local" };
  }
  if (plan.dns.provider !== "cloudflare" || plan.dns.domain === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "A Portainer subdomain is served through Cloudflare (a tunnel and Cloudflare Access), and this app has no domain on Cloudflare. Nothing was changed.",
      {
        hint: "Add a domain whose DNS is on Cloudflare with `opscrew dns --domain <domain>` first, or run `opscrew portainer enable` without `--subdomain` to reach Portainer through an SSH tunnel.",
      },
    );
  }
  if (emails.length === 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "A Portainer subdomain needs at least one email address that Cloudflare Access lets in.",
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
  const hostname =
    subdomain.includes(".") || zone === undefined ? subdomain : `${subdomain}.${zone}`;
  return {
    enabled: true,
    version: PORTAINER_VERSION,
    access: "subdomain",
    hostname,
    allowedEmails: emails,
  };
}

/**
 * The plan with `portainer` replaced (or removed with `undefined`), validated with the plan
 * schema; a setting the schema refuses (a hostname outside the zone, the app's own domain) stops
 * with its plain reason.
 */
export function withPortainer(
  plan: DeployPlan,
  portainer: PortainerSettings | undefined,
): DeployPlan {
  const { portainer: _old, ...rest } = plan;
  const parsed = DeployPlanSchema.safeParse(
    portainer === undefined ? rest : { ...rest, portainer },
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") ?? "portainer";
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew cannot use these Portainer settings: ${field} ${issue?.message ?? "is not valid"}.`,
      {
        hint: `Give a subdomain of ${plan.dns.zone ?? "the app's Cloudflare zone"} that is not the app's own domain, for example \`--subdomain portainer\`.`,
      },
    );
  }
  return parsed.data;
}
