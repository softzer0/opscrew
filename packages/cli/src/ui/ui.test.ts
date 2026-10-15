import { PORTAINER_LOCATION, PORTAINER_SERVER_TYPE } from "@opscrew/agents";
import type { DesignOption, Question } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { CANCEL, ScriptedPrompts } from "./__fixtures__/harness";
import { chooseOption, RECOMMENDED_MARKER, renderOptionsTable } from "./options";
import { formatUsd } from "./output";
import { askQuestions } from "./questions";

const questions: Question[] = [
  {
    id: "region",
    prompt: "Where are most of your users?",
    help: "The server is placed close to them.",
    kind: "single-select",
    options: [
      { value: "eu-central", label: "Europe (Germany)" },
      { value: "us-east", label: "United States, east coast" },
    ],
    default: "eu-central",
    required: true,
  },
  {
    id: "budgetMonthly",
    prompt: "What is your monthly budget for hosting?",
    kind: "money",
    default: { amount: 10, currency: "EUR" },
    required: true,
  },
  { id: "domain", prompt: "Which domain?", kind: "text", required: false },
  {
    id: "dnsProvider",
    prompt: "Where is DNS managed?",
    kind: "single-select",
    options: [
      { value: "cloudflare", label: "Cloudflare" },
      { value: "none", label: "No domain yet" },
    ],
    required: false,
  },
  {
    id: "keepExternalServices",
    prompt: "Keep using your hosted Supabase project?",
    kind: "confirm",
    default: true,
    required: false,
  },
];

describe("askQuestions", () => {
  it("asks each question with its default and returns answers by id", async () => {
    const prompts = new ScriptedPrompts([
      "us-east",
      "20 USD",
      "app.example.com",
      "cloudflare",
      false,
    ]);
    const answers = await askQuestions(questions, { prompts });
    expect(answers).toEqual({
      region: "us-east",
      budgetMonthly: "20 USD",
      domain: "app.example.com",
      dnsProvider: "cloudflare",
      keepExternalServices: false,
    });
    expect(prompts.calls[0]?.message).toBe(
      "Where are most of your users?\nThe server is placed close to them.",
    );
    expect(prompts.calls[0]?.initial).toBe("eu-central");
    expect(prompts.calls[1]?.initial).toBe("10 EUR");
    expect(prompts.calls[4]?.initial).toBe(true);
  });

  it("skips the DNS question when the domain is left empty", async () => {
    const prompts = new ScriptedPrompts(["eu-central", "10 EUR", "", true]);
    const answers = await askQuestions(questions, { prompts });
    expect(answers.dnsProvider).toBe("none");
    expect(prompts.calls.map((c) => c.message)).not.toContain("Where is DNS managed?");
  });

  it("rejects a budget that is not an amount", async () => {
    const prompts = new ScriptedPrompts(["eu-central", "lots"]);
    await expect(askQuestions(questions, { prompts })).rejects.toThrow(/Write an amount/);
  });

  it("throws a user-facing error when cancelled", async () => {
    const prompts = new ScriptedPrompts([CANCEL]);
    await expect(askQuestions(questions, { prompts })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: "You cancelled the interview, so nothing was written.",
    });
  });
});

function option(id: string, amount: number, extra: Partial<DesignOption> = {}): DesignOption {
  return {
    id,
    title: `Option ${id}`,
    summary: `Summary of ${id}.`,
    target: {
      provider: "hetzner",
      location: "nbg1",
      serverType: id,
      vcpus: 2,
      memoryGb: 4,
      diskGb: 40,
      cpuType: "shared",
      architecture: "x86",
    },
    services: { postgres: false, redis: false },
    externalServices: [],
    backups: true,
    cost: {
      monthly: { amount, currency: "EUR" },
      breakdown: [{ item: "server", monthly: { amount, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    fitsBudget: true,
    recommended: false,
    tradeoffs: [`Trade-off of ${id}.`],
    ...extra,
  };
}

const options = [
  option("cx23", 7.09, { recommended: true }),
  option("cx33", 10.69, { fitsBudget: false }),
];

describe("renderOptionsTable", () => {
  it("shows cost, budget fit and the recommended marker per option", () => {
    const table = renderOptionsTable(options, { amount: 10, currency: "USD" });
    const lines = table.split("\n");
    const lean = lines.find((line) => line.includes("cx23 (shared)")) ?? "";
    const comfy = lines.find((line) => line.includes("cx33 (shared)")) ?? "";
    expect(table).toContain("Your budget: $10.00 per month");
    expect(lean).toContain("€7.09 (≈ $7.80)");
    expect(lean).toContain("fits");
    expect(lean).toContain(RECOMMENDED_MARKER);
    expect(comfy).toContain("over budget");
    expect(comfy).not.toContain(RECOMMENDED_MARKER);
    expect(table).toContain("2 vCPU, 4 GB RAM, 40 GB disk");
    expect(table).toContain("  - Trade-off of cx33.");
    expect(table).toContain("1 EUR = 1.10 USD");
  });

  it("omits the conversion when the budget is in the price currency", () => {
    const table = renderOptionsTable(options, { amount: 10, currency: "EUR" });
    expect(table).not.toContain("≈");
    expect(table).not.toContain("1 EUR = 1.10 USD");
  });
});

describe("renderOptionsTable for the user's Portainer", () => {
  const portainer = (): DesignOption =>
    option("portainer", 0, {
      title: "Your Portainer",
      recommended: true,
      target: {
        provider: "portainer",
        location: PORTAINER_LOCATION,
        serverType: PORTAINER_SERVER_TYPE,
        vcpus: 1,
        memoryGb: 0.01,
        diskGb: 0.01,
        cpuType: "shared",
        architecture: "arm",
      },
    });

  it("shows no price, no budget fit, no price source and never the placeholder sizes", () => {
    const table = renderOptionsTable([portainer()], { amount: 10, currency: "USD" });
    const row = table.split("\n").find((line) => line.includes("portainer")) ?? "";
    expect(row).toContain("no server price");
    expect(row).toContain(RECOMMENDED_MARKER);
    for (const text of ["€0.00", "fits", "over budget", "0.01", "1 vCPU", "shared"]) {
      expect(row).not.toContain(text);
    }
    expect(table).not.toContain("Your budget");
    expect(table).not.toContain("Prices:");
    expect(table).not.toContain("prices live from");
    expect(table).not.toContain("1 EUR = 1.10 USD");
  });

  it("offers the Portainer option without a price in the prompt", async () => {
    const prompts = new ScriptedPrompts(["portainer"]);
    await chooseOption([portainer()], { prompts, write: () => {} });
    const choice = prompts.calls[0]?.options?.[0];
    expect(choice?.label).toBe("Your Portainer: no server price (you already run it)");
    expect(choice?.hint).toBe(RECOMMENDED_MARKER);
  });
});

describe("chooseOption", () => {
  it("prints the table and starts on the recommended option", async () => {
    const out: string[] = [];
    const prompts = new ScriptedPrompts(["cx33"]);
    const id = await chooseOption(options, { prompts, write: (text) => out.push(text) });
    expect(id).toBe("cx33");
    expect(out.join("")).toContain(RECOMMENDED_MARKER);
    expect(prompts.calls[0]?.initial).toBe("cx23");
    expect(prompts.calls[0]?.options?.[0]?.hint).toBe(`fits the budget, ${RECOMMENDED_MARKER}`);
  });

  it("throws when cancelled", async () => {
    const prompts = new ScriptedPrompts([CANCEL]);
    await expect(chooseOption(options, { prompts, write: () => {} })).rejects.toThrow(
      "You cancelled the choice",
    );
  });
});

describe("formatUsd", () => {
  it("keeps four decimals below a dollar", () => {
    expect(formatUsd(0.0215)).toBe("$0.0215");
    expect(formatUsd(2.5)).toBe("$2.50");
  });
});
