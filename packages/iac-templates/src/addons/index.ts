import type { DeployPlan } from "@opscrew/plan-schema";
import { renderAlloyCompose, renderAlloyConfig } from "./alloy";
import { renderBeszelCompose, renderBeszelConfig } from "./beszel";
import { renderProxyCaddyfile } from "./proxy";

export { BESZEL_TOKEN_PLACEHOLDER } from "./beszel";

/** An add-on OpsCrew runs on a server: Beszel, or Grafana Alloy sending to Grafana Cloud. */
export type AddonKind = "beszel" | "grafana-cloud";

/** A file of an add-on, by its path in the add-on's folder on the server. */
export interface AddonFile {
  path: string;
  content: string;
}

/**
 * The files of an add-on's folder on the server (`opscrew/addons/<name>`): `compose.yaml`, the
 * read-only Docker proxy's `Caddyfile`, and Beszel's `config.yml` or Alloy's `config.alloy`. None
 * holds a secret: the host step writes the secrets into files of their own beside them, and the
 * agent's token into `config.yml` in place of {@link BESZEL_TOKEN_PLACEHOLDER}.
 * @throws Error when the plan doesn't turn the add-on on.
 */
export function renderAddon(plan: DeployPlan, kind: AddonKind): AddonFile[] {
  if (kind === "beszel") {
    const beszel = plan.observability?.beszel;
    if (!beszel?.enabled) {
      throw new Error("The plan doesn't turn Beszel on (observability.beszel.enabled).");
    }
    return [
      { path: "compose.yaml", content: renderBeszelCompose(plan, beszel) },
      { path: "Caddyfile", content: renderProxyCaddyfile(kind) },
      ...(beszel.mode === "hub" ? [{ path: "config.yml", content: renderBeszelConfig(plan) }] : []),
    ];
  }
  const grafana = plan.observability?.grafanaCloud;
  if (!grafana?.enabled) {
    throw new Error("The plan doesn't turn Grafana Cloud on (observability.grafanaCloud.enabled).");
  }
  return [
    { path: "compose.yaml", content: renderAlloyCompose(plan, grafana) },
    { path: "Caddyfile", content: renderProxyCaddyfile(kind) },
    { path: "config.alloy", content: renderAlloyConfig(plan, grafana) },
  ];
}
