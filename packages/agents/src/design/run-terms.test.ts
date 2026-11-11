/**
 * `opscrew design` in a script on a cloud provider with Contabo's terms (T2628): without the
 * chooser, the chosen option's terms are printed as the chooser shows them. DigitalOcean's
 * definition stands in for the provider (`withTermProvider`), as in `term-provider.test.ts`.
 */
import type { ComputeOffer } from "@opscrew/contracts";
import { type Architecture, type DesignOption, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import {
  createTestPhaseDeps,
  digitaloceanCatalog,
  doOffer,
  euCatalog,
  makeRequirements,
  staticSpaFacts,
} from "../testing";
import { runDesign } from "./run";

vi.mock("@opscrew/providers", async (importOriginal) => {
  const { withTermProvider } = await import("./__fixtures__/term-provider");
  return withTermProvider(await importOriginal());
});

/** Plans in fra1 like Contabo's: the smallest with a setup fee, each with included snapshots. */
function termOffers(): ComputeOffer[] {
  const plan = (init: Parameters<typeof doOffer>[0], includedSnapshots: number) =>
    doOffer({ ...init, pricesIncludeVat: true, includedSnapshots });
  return [
    {
      ...plan({ id: "vps-4", vcpus: 2, memoryGb: 4, diskGb: 100, price: 6 }, 1),
      setupFee: { amount: 5, currency: "USD" },
    },
    plan({ id: "vps-6", vcpus: 4, memoryGb: 8, diskGb: 200, price: 9 }, 2),
  ];
}

const catalog = () =>
  digitaloceanCatalog(termOffers(), { snapshotsIncluded: true, pricesIncludeVat: true });

const NO_BACKUPS =
  "DigitalOcean offers no automatic backups through OpsCrew: OpsCrew's own snapshots of the app's data (`opscrew snapshot`) cover it instead.";
const TERM = "The contract runs at least 1 month; a removal ends it at the end of the term.";

const termRequirements = makeRequirements({
  provider: "digitalocean",
  dataCriticality: "none",
  budgetMonthly: { amount: 20, currency: "USD" },
});

async function setup(requirements = termRequirements) {
  const deps = await createTestPhaseDeps();
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: staticSpaFacts(),
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  return deps;
}

/** The info lines after the last option line (`… — fits the budget…`). */
function linesAfterOptions(deps: Awaited<ReturnType<typeof setup>>): string[] {
  const info = deps.reporter.lines.filter((l) => l.level === "info").map((l) => l.message);
  const last = info.findLastIndex((line) => line.includes(" — fits the budget"));
  return info.slice(last + 1);
}

describe("design in a script on a provider with terms", () => {
  it("prints the recommended option's setup fee, term, snapshots and backups", async () => {
    const deps = await setup();
    const result = await runDesign(deps, { catalog: catalog() });
    expect(result.chosen.target.serverType).toBe("vps-4");
    expect(linesAfterOptions(deps).slice(0, 4)).toEqual([
      "Plus a one-time setup fee of $5.00 (incl. tax) when the server is created, not part of the monthly price.",
      TERM,
      "Whole-server snapshots are included in the price, up to 1.",
      NO_BACKUPS,
    ]);
  });

  it("prints the terms of the option `--option` names", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: catalog(), optionId: "digitalocean-single-vps-6-fra1" });
    expect(linesAfterOptions(deps).slice(0, 3)).toEqual([
      TERM,
      "Whole-server snapshots are included in the price, up to 2.",
      NO_BACKUPS,
    ]);
  });

  it("leaves them to the chooser, which shows them", async () => {
    const deps = await setup();
    await runDesign(deps, {
      catalog: catalog(),
      choose: async (options) => options[0]?.id ?? "",
    });
    expect(deps.reporter.text()).not.toContain(TERM);
  });
});

describe("design in a script on a provider without terms", () => {
  it("asks Hetzner's catalogue no more than a run with the chooser does", async () => {
    const calls = async (chooser: boolean) => {
      const catalog = euCatalog();
      const extras = vi.spyOn(catalog, "extras");
      const choose = async (options: readonly DesignOption[]) =>
        options.find((option) => option.recommended)?.id ?? "";
      const deps = await setup(makeRequirements());
      const result = await runDesign(deps, { catalog, ...(chooser ? { choose } : {}) });
      return {
        chosen: result.chosen.id,
        offers: catalog.requested.length,
        extras: extras.mock.calls.length,
      };
    };
    const script = await calls(false);
    expect(script.offers).toBeGreaterThan(0);
    expect(script).toEqual(await calls(true));
  });
});
