import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeGitHub, testPlan } from "../testing";
import { storeCheckSecrets } from "./secrets";

const WEBHOOK = "https://hooks.slack.example.com/services/opscrew-alerts-2b7d";
const OLD = "https://hooks.slack.example.com/services/opscrew-alerts-old";

async function store(
  answer: string | undefined,
  env: Record<string, string> = {},
  held: Record<string, string> = {},
) {
  const deps = await createTestPhaseDeps({
    interactive: true,
    env: { OPSCREW_HOME: "/x", ...env },
  });
  const github = new FakeGitHub();
  for (const [name, value] of Object.entries(held)) github.secrets.set(name, value);
  const asked: { kind: string; prompt: string }[] = [];
  const plan = DeployPlanSchema.parse({
    ...testPlan(),
    observability: { check: { enabled: true, webhook: "slack" } },
  });
  await storeCheckSecrets(
    deps,
    { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
    {
      plan,
      settings: plan.observability?.check,
      services: {
        askCheckWebhook: async (question) => {
          asked.push(question);
          return answer;
        },
      },
      phase: "provision",
    },
  );
  return { deps, github, asked };
}

describe("storeCheckSecrets' webhook", () => {
  it("asks for the address by its kind and stores it as a secret, never shown", async () => {
    const { deps, github, asked } = await store(WEBHOOK);
    expect(asked).toEqual([
      {
        kind: "slack",
        prompt: "Address of the Slack webhook for the scheduled check (stored as a GitHub secret)",
      },
    ]);
    expect(github.secrets.get("OPSCREW_CHECK_WEBHOOK")).toBe(WEBHOOK);
    expect(`${deps.reporter.text()}${JSON.stringify(deps.audit.entries)}`).not.toContain(WEBHOOK);
  });

  it("says a cancelled question stored nothing", async () => {
    const { deps, github } = await store(undefined);
    expect(github.secrets.size).toBe(0);
    expect(deps.reporter.text()).toContain("The Slack webhook's address was not stored");
  });

  it("takes the address from OPSCREW_CHECK_WEBHOOK without asking", async () => {
    const { github, asked } = await store(undefined, { OPSCREW_CHECK_WEBHOOK: WEBHOOK });
    expect(asked).toEqual([]);
    expect(github.secrets.get("OPSCREW_CHECK_WEBHOOK")).toBe(WEBHOOK);
  });

  it("keeps a webhook GitHub already holds without asking, and says how to change it", async () => {
    const { deps, github, asked } = await store(WEBHOOK, {}, { OPSCREW_CHECK_WEBHOOK: OLD });
    expect(asked).toEqual([]);
    expect(github.secrets.get("OPSCREW_CHECK_WEBHOOK")).toBe(OLD);
    expect(deps.reporter.text()).toContain(
      "If you changed the webhook to Slack, set OPSCREW_CHECK_WEBHOOK to its address",
    );
  });

  it("lets OPSCREW_CHECK_WEBHOOK replace a webhook GitHub already holds", async () => {
    const { deps, github, asked } = await store(
      undefined,
      { OPSCREW_CHECK_WEBHOOK: WEBHOOK },
      { OPSCREW_CHECK_WEBHOOK: OLD },
    );
    expect(asked).toEqual([]);
    expect(github.secrets.get("OPSCREW_CHECK_WEBHOOK")).toBe(WEBHOOK);
    expect(deps.reporter.text()).not.toContain("already holds");
  });
});
