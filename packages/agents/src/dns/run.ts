import { OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  FqdnSchema,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { requireNoMoveInProgress } from "../provision/guard";
import { runPhaseFlow } from "../provision/run";
import type { ProvisionOptions, ProvisionResult } from "../provision/types";

export interface DnsOptions extends ProvisionOptions {
  /** New or changed domain, for example `app.example.com`. Defaults to the plan's domain. */
  domain?: string;
}

/**
 * `opscrew dns`: puts the app behind a Cloudflare domain (proxied records, host-scoped TLS strict,
 * WAF probe rules, web ports limited to Cloudflare) by updating the plan's DNS settings and running
 * the same plan → policies → approval → apply flow as provisioning. Deploy secrets are only set
 * again when no server exists yet. Stops with `PHASE_PRECONDITION` before changing anything while
 * `opscrew retarget` is moving the deployment.
 */
export async function runDns(deps: PhaseDeps, options: DnsOptions = {}): Promise<ProvisionResult> {
  const { domain: requested, ...rest } = options;
  let plan = await readArtifact("plan", deps.paths.files.plan);
  requireNoMoveInProgress(plan);
  const raw = (requested ?? plan.dns.domain)?.trim().toLowerCase();
  if (!raw) {
    throw new OpsCrewError("INVALID_INPUT", "No domain to set up.", {
      hint: "Pass the hostname the app should use, for example `opscrew dns --domain app.example.com`.",
    });
  }
  const parsed = FqdnSchema.safeParse(raw.replace(/\.$/, ""));
  if (!parsed.success) {
    throw new OpsCrewError("INVALID_INPUT", `"${raw}" is not a valid domain name.`, {
      hint: "Use a full hostname such as app.example.com (no https:// and no path).",
    });
  }
  const domain = parsed.data;

  const changed = plan.dns.provider !== "cloudflare" || plan.dns.domain !== domain;
  if (changed) {
    const { zone, registration, ...rest } = plan.dns;
    // A recorded registration (and its zone) stays only while the new name is inside the
    // registered domain; otherwise both would describe another domain.
    const keep =
      registration !== undefined &&
      zone !== undefined &&
      (domain === zone || domain.endsWith(`.${zone}`));
    const dns = keep ? { ...rest, zone, registration } : rest;
    plan = {
      ...plan,
      updatedAt: deps.clock.now().toISOString(),
      dns: { ...dns, provider: "cloudflare", domain, proxied: true },
      security: { ...plan.security, httpAllowedFrom: "cloudflare" },
    };
    await writeArtifact("plan", deps.paths.files.plan, plan);
    deps.reporter.info(`The plan now serves the app at https://${domain} through Cloudflare.`);

    let requirements: Requirements | undefined;
    try {
      requirements = await readArtifact("requirements", deps.paths.files.requirements);
    } catch (error) {
      if ((error as { code?: string }).code !== "ARTIFACT_MISSING") throw error;
    }
    if (requirements) {
      await writeArtifact("requirements", deps.paths.files.requirements, {
        ...requirements,
        domain,
        dnsProvider: "cloudflare",
      });
    }
  }

  const approvalNotes: string[] = [];
  if (switchesRunningServer(plan, domain, changed)) {
    const note = `The server is already running. Once this plan is applied, ports 80 and 443 accept only Cloudflare's addresses and ${domain} points at the server through Cloudflare, but the server keeps its current web configuration: the app is unreachable (by its domain and by the server's IP address) until the pull request with the new Caddyfile is merged and deployed.`;
    deps.reporter.warn(note);
    approvalNotes.push(`Warning: ${note}`);
  }

  return runPhaseFlow(
    deps,
    "dns",
    { ...rest, secrets: rest.secrets ?? plan.deployment.serverIpv4 === undefined },
    { approvalNotes },
  );
}

/**
 * True when applying moves an already deployed server behind Cloudflare (or to a new domain):
 * this run changed the domain, or the recorded URL is not yet the domain's (an earlier
 * `--plan-only` run changed it).
 */
function switchesRunningServer(plan: DeployPlan, domain: string, changed: boolean): boolean {
  if (plan.deployment.serverIpv4 === undefined) return false;
  if (!plan.dns.proxied || plan.security.httpAllowedFrom !== "cloudflare") return false;
  const url = plan.deployment.url;
  return changed || (url !== undefined && url !== `https://${domain}`);
}
