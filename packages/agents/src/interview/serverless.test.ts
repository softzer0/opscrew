import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture } from "@opscrew/core/testing";
import { type Question, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, makeRequirements, staticSpaFacts } from "../testing";
import { buildQuestions, defaultProvider, type InterviewAnswers } from "./questions";
import { runInterview } from "./run";

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));

const ANSWERS: InterviewAnswers = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 10, currency: "EUR" },
  region: "eu-central",
  uptime: "standard",
  dataCriticality: "none",
  domain: "docs.example.com",
  dnsProvider: "cloudflare",
};

/** Interviews `example` with `answers`, returning the questions asked and the result. */
async function interview(example: string, answers: InterviewAnswers = ANSWERS) {
  const root = await mkdtemp(join(tmpdir(), `opscrew-interview-${example}-`));
  await materializeFixture(join(examples, example), root);
  const deps = await createTestPhaseDeps({ root });
  let asked: Question[] = [];
  const result = await runInterview(deps, {
    ask: async (questions) => {
      asked = questions;
      return answers;
    },
  });
  const provider = asked.find((question) => question.id === "provider");
  return { deps, result, values: provider?.options?.map((option) => option.value), provider };
}

describe("the interview's server-less targets", () => {
  it("offers Cloudflare and GitHub Pages for a static site, and records the answer without a region", async () => {
    const { deps, result, values, provider } = await interview("static-vite", {
      ...ANSWERS,
      provider: "cloudflare-workers",
    });
    expect(values).toEqual([
      "hetzner",
      "digitalocean",
      "cloudflare-workers",
      "github-pages",
      "own",
      "portainer",
      "localhost",
    ]);
    expect(provider?.options?.[2]).toEqual({
      value: "cloudflare-workers",
      label: "Cloudflare (no server)",
      hint: expect.stringContaining("free for static files"),
    });
    expect(provider?.options?.[3]).toEqual({
      value: "github-pages",
      label: "GitHub Pages (no server)",
      hint: expect.stringContaining("no commercial use"),
    });
    expect(result.requirements).toMatchObject({
      provider: "cloudflare-workers",
      domain: "docs.example.com",
      dnsProvider: "cloudflare",
    });
    expect(result.requirements.region).toBeUndefined();
    expect(await readArtifact("requirements", deps.paths.files.requirements)).toEqual(
      result.requirements,
    );
  });

  it("offers Cloudflare but not GitHub Pages for a server-rendered app, and neither for an API", async () => {
    expect((await interview("astro-ssr")).values).toEqual([
      "hetzner",
      "digitalocean",
      "cloudflare-workers",
      "own",
      "portainer",
      "localhost",
    ]);
    expect((await interview("express-api")).values).toEqual([
      "hetzner",
      "digitalocean",
      "own",
      "portainer",
      "localhost",
    ]);
  });

  it("defaults to a server-less answer given before only while the question offers it", () => {
    const previous = makeRequirements({ provider: "github-pages" });
    const offered = buildQuestions(staticSpaFacts(), previous, [], {
      serverless: ["cloudflare-workers", "github-pages"],
    });
    expect(offered.find((q) => q.id === "provider")?.default).toBe("github-pages");
    expect(defaultProvider(previous, { serverless: ["cloudflare-workers"] })).toBe("hetzner");
    expect(defaultProvider(previous, { inferredProvider: "digitalocean" })).toBe("digitalocean");
  });
});
