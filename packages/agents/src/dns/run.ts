import { OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  readArtifact,
  readOptionalArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { parseHostName } from "../domain/common";
import { insideDomain, recordRequirements } from "../domain/project";
import { requireNoMoveInProgress } from "../provision/guard";
import { runPhaseFlow } from "../provision/run";
import type { ProvisionOptions, ProvisionResult } from "../provision/types";
import { hasDeployment, hidesServerAddress } from "../shared";

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
  const raw = requested ?? plan.dns.domain;
  if (!raw?.trim()) {
    throw new OpsCrewError("INVALID_INPUT", "No domain to set up.", {
      hint: "Pass the hostname the app should use, for example `opscrew dns --domain app.example.com`.",
    });
  }
  const domain = parseHostName(raw, "app.example.com");

  // A running deployment served on its address, or on a domain without the proxy: the address
  // may already be known, which the flow says once the proxy goes on.
  const addressWasPublic = hasDeployment(plan) && !hidesServerAddress(plan);
  const changed = plan.dns.provider !== "cloudflare" || plan.dns.domain !== domain;
  if (changed) {
    const { zone, registration, ...rest } = plan.dns;
    // A recorded registration (and its zone) stays only while the new name is inside the
    // registered domain; otherwise both would describe another domain.
    const keep = registration !== undefined && zone !== undefined && insideDomain(domain, zone);
    const dns = keep ? { ...rest, zone, registration } : rest;
    plan = {
      ...plan,
      updatedAt: deps.clock.now().toISOString(),
      dns: { ...dns, provider: "cloudflare", domain, proxied: true },
      security: { ...plan.security, httpAllowedFrom: "cloudflare" },
    };
  }
  const updated = plan;
  const running = hasDeployment(plan);
  const switching = running && switchesRunningServer(plan, domain, changed);

  /** Saves the plan change once the flow's checks passed (a stop leaves the files as they were). */
  const ready = async (): Promise<void> => {
    if (changed) {
      await writeArtifact("plan", deps.paths.files.plan, updated);
      deps.reporter.info(`The plan now serves the app at https://${domain} through Cloudflare.`);
      const requirements = await readOptionalArtifact(
        "requirements",
        deps.paths.files.requirements,
      );
      if (requirements) await recordRequirements(deps, requirements, domain);
    }
    if (switching) deps.reporter.warn(runningServerNote(domain, updated.app.name));
  };

  const approvalNotes = switching
    ? [`Warning: ${runningServerNote(domain, updated.app.name)}`]
    : [];
  return runPhaseFlow(
    deps,
    "dns",
    { ...rest, secrets: rest.secrets ?? !running },
    { approvalNotes, plan: updated, ready, addressWasPublic },
  );
}

/** The warning when the running server goes behind Cloudflare before the app's new site deploys. */
function runningServerNote(domain: string, app: string): string {
  return `The server is already running. Once this plan is applied, ports 80 and 443 accept only Cloudflare's addresses and ${domain} points at the server through Cloudflare, but the server keeps its current web configuration: the app is unreachable (by its domain and by the server's IP address) until the pull request with the app's new Caddy site file (opscrew/runtime/edge/sites/${app}.caddy) is merged and deployed.`;
}

/**
 * True when applying moves the running server behind Cloudflare (or to a new domain): this run
 * changed the domain, or the recorded URL is not yet the domain's (an earlier `--plan-only` run
 * changed it; without a domain no URL is recorded).
 */
function switchesRunningServer(plan: DeployPlan, domain: string, changed: boolean): boolean {
  if (!plan.dns.proxied || plan.security.httpAllowedFrom !== "cloudflare") return false;
  return changed || plan.deployment.url !== `https://${domain}`;
}
