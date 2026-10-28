import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { type TestPlanOptions, testPlan } from "../../__fixtures__/plans";

/** The hub's public key in agent mode (a fixed, fake key of the right shape). */
export const HUB_KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`;

/** Beszel at a subdomain, behind Cloudflare Access. */
export const BESZEL_SUBDOMAIN = {
  enabled: true,
  version: "0.21.1",
  access: "subdomain",
  hostname: "beszel.example.com",
  allowedEmails: ["ops@example.com", "dev@example.com"],
} as const;

/** Grafana Cloud's endpoints, as a stack's details page gives them. */
export const GRAFANA_CLOUD = {
  enabled: true,
  version: "1.21.2",
  metrics: { url: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom/push", user: "123456" },
  logs: { url: "https://logs-prod-eu-west-0.grafana.net/loki/api/v1/push", user: "654321" },
} as const;

/** {@link testPlan} with `observability` (re-parsed, so its defaults are filled in). */
export function observabilityPlan(
  observability: Record<string, unknown>,
  o: TestPlanOptions = {},
): DeployPlan {
  return DeployPlanSchema.parse({ ...testPlan(o), observability });
}
