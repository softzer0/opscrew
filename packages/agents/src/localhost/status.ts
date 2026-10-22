/**
 * `opscrew status` for the localhost target: the app's components from its Compose project's
 * containers, and what `status` shows of a server's TLS and secrets copy, as this computer has
 * it: the proxy, the address, the leaf certificate's expiry, whether the local CA is trusted, and
 * whether Docker's memory still holds the stack's limits.
 */
import { upperFirst } from "@opscrew/core";
import { EDGE_PROXIES, edgeProxy } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { type ComponentStatus, componentStatus } from "../status/components";
import { caTrusted, leafState } from "./ca";
import { dockerInfo, projectObjects } from "./docker";
import { composeProject } from "./services";
import { localAddress, localTarget, servedSite } from "./site";
import { stackMemoryMb } from "./stack";

/** Each of the plan's components and whether it runs, from the app's Compose project here. */
export async function localComponentStatus(
  deps: Pick<PhaseDeps, "runner">,
  plan: DeployPlan,
): Promise<ComponentStatus> {
  const { containers } = await projectObjects(deps, composeProject(plan));
  return componentStatus(
    plan,
    containers.map(({ service, running }) => ({ service, running })),
  );
}

/** The status lines of an app on this computer (redacted by the caller's report). */
export async function localStatusLines(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const target = localTarget(plan);
  const site = await servedSite(deps.paths, plan);
  const lines = [
    `Proxy: ${EDGE_PROXIES[edgeProxy(plan)].label}, on this computer (127.0.0.1 only)`,
    `Address: ${localAddress(site, target)}`,
  ];
  const now = deps.clock.now();
  const leaf = await leafState(deps.paths, plan, site.hostname, now);
  if (leaf.expires !== undefined) {
    const days = Math.floor((Date.parse(leaf.expires) - now.getTime()) / 86_400_000);
    lines.push(
      "Certificates:",
      `  ${site.hostname} (from OpsCrew's local CA): expires ${leaf.expires.slice(0, 10)} (${days} days left)`,
    );
    if (leaf.action !== "keep") {
      lines.push(`  Warning: ${upperFirst(leaf.detail)}; \`opscrew provision\` issues a new one.`);
    }
  }
  lines.push(
    (await caTrusted(deps.paths))
      ? "Local CA: trusted on this computer (`opscrew localhost untrust` undoes it)."
      : "Local CA: not trusted, so browsers warn about the site's certificate; `opscrew localhost trust` trusts it (`opscrew localhost untrust` undoes it).",
  );
  const info = await dockerInfo(deps);
  if (info === "missing" || info === "stopped") {
    lines.push("Docker: not running, so the stack does not run either. Start Docker to start it.");
    return lines;
  }
  const memory = Math.floor(info.memTotal / 1024 / 1024);
  const limits = stackMemoryMb(plan);
  lines.push(`Memory: the stack's limits ${limits} MB of the ${memory} MB Docker has.`);
  if (limits > memory) {
    lines.push(
      "  Warning: the limits no longer fit Docker's memory. Give Docker more memory (Docker Desktop: Settings → Resources), or lower the limits in the plan and run `opscrew provision` again.",
    );
  }
  return lines;
}
