import { OpsCrewError } from "@opscrew/core";
import { FqdnSchema, type Requirements, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
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
 * again when no server exists yet.
 */
export async function runDns(deps: PhaseDeps, options: DnsOptions = {}): Promise<ProvisionResult> {
  const { domain: requested, ...rest } = options;
  let plan = await readArtifact("plan", deps.paths.files.plan);
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

  if (plan.dns.provider !== "cloudflare" || plan.dns.domain !== domain) {
    const { zone: _staleZone, ...dns } = plan.dns;
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

  return runPhaseFlow(deps, "dns", {
    ...rest,
    secrets: rest.secrets ?? plan.deployment.serverIpv4 === undefined,
  });
}
