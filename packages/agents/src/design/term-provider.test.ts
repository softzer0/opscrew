/**
 * Design on a cloud provider with Contabo's terms (T2611): a one-time setup fee, a minimum term,
 * snapshots included in the price, and no size change in place. DigitalOcean's definition stands
 * in for it (`withTermProvider`), with catalogues that name the fee and the included snapshots.
 */
import type { ComputeOffer } from "@opscrew/contracts";
import { type PlanService, PlanServiceSchema } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import {
  digitaloceanCatalog,
  doOffer,
  makeRequirements,
  staticSpaFacts,
  testPlan,
} from "../testing";
import { offerTerms } from "./cost";
import { buildDesignOptionSet } from "./options";
import { type CloudServerInput, designCloudServer, serverLine } from "./servers";
import { selfHostedServices } from "./sizing";
import { noProviderBackups, withDesignedSnapshots } from "./snapshots";

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
    plan({ id: "vps-8", vcpus: 8, memoryGb: 16, diskGb: 300, price: 16 }, 3),
  ];
}

const catalog = () =>
  digitaloceanCatalog(termOffers(), { snapshotsIncluded: true, pricesIncludeVat: true });

const requirements = makeRequirements({
  provider: "digitalocean",
  dataCriticality: "none",
  budgetMonthly: { amount: 20, currency: "USD" },
});

/** The two ways to another size the refusals name. */
const WAYS =
  "There are two ways to another size: `opscrew retarget --to hetzner` moves the app to Hetzner Cloud with a short maintenance window for its data; or, at DigitalOcean with downtime, take a snapshot of the app's data with its encrypted copy off the Droplet (`opscrew snapshot`, after `opscrew snapshot offsite on --to <provider>` and `opscrew provision` if the copy is off), remove the Droplet with `opscrew destroy` (DigitalOcean bills it to the end of its term), run `opscrew design` and `opscrew provision` with the new size, then put the data back from that copy with `opscrew restore <id> --from offsite --key-file <path>`";

/** What design says of a provider without automated backups. */
const NO_BACKUPS =
  "DigitalOcean offers no automatic backups through OpsCrew: OpsCrew's own snapshots of the app's data (`opscrew snapshot`) cover it instead.";

describe("offerTerms", () => {
  it("states the setup fee once, the minimum term and the included snapshots", async () => {
    const [smallest, larger] = termOffers() as [ComputeOffer, ComputeOffer];
    const extras = await catalog().extras("fra1");
    expect(offerTerms(smallest, extras)).toEqual([
      "Plus a one-time setup fee of $5.00 (incl. tax) when the server is created, not part of the monthly price.",
      "The contract runs at least 1 month; a removal ends it at the end of the term.",
      "Whole-server snapshots are included in the price, up to 1.",
    ]);
    expect(offerTerms(larger, extras)).toEqual([
      "The contract runs at least 1 month; a removal ends it at the end of the term.",
      "Whole-server snapshots are included in the price, up to 2.",
    ]);
  });
});

describe("design's options on a provider with terms", () => {
  it("shows the setup fee as one-time, never in the monthly price, with the term and snapshots", async () => {
    const { options } = await buildDesignOptionSet({
      facts: staticSpaFacts(),
      requirements,
      catalog: catalog(),
    });
    const [lean] = options;
    expect(lean?.target.serverType).toBe("vps-4");
    expect(lean?.cost.monthly).toEqual({ amount: 6, currency: "USD" });
    expect(lean?.cost.breakdown).toEqual([
      { item: "Server vps-4 (fra1)", monthly: { amount: 6, currency: "USD" } },
    ]);
    expect(lean?.summary).toContain(
      "$6.00/month (estimate as of 2026-09-01, including tax). Plus a one-time setup fee of $5.00 (incl. tax) when the server is created, not part of the monthly price. The contract runs at least 1 month; a removal ends it at the end of the term. Whole-server snapshots are included in the price, up to 1.",
    );
    expect(options[1]?.summary).not.toContain("setup fee");
  });

  it("keeps a deployed server's type, saying why a cheaper one is left out", async () => {
    const { options, kept } = await buildDesignOptionSet({
      facts: staticSpaFacts(),
      requirements,
      catalog: catalog(),
      deployed: { location: "fra1", serverType: "vps-6" },
    });
    expect(options.map((o) => o.target.serverType)).toEqual(["vps-6"]);
    expect([...kept.values()]).toEqual([
      "Server app could use vps-4 now, but OpsCrew keeps vps-6: DigitalOcean can't change a Droplet's size in place.",
    ]);
  });

  it("refuses when the deployed type no longer holds the app, naming the two ways", async () => {
    const error = await buildDesignOptionSet({
      facts: staticSpaFacts(),
      requirements: { ...requirements, expectedMonthlyUsers: ">100k" },
      catalog: catalog(),
      deployed: { location: "fra1", serverType: "vps-4" },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    const { message, hint } = error as { message: string; hint: string };
    expect(message).toContain("Your Droplet in Frankfurt is a vps-4");
    expect(message).toContain("DigitalOcean can't change a Droplet's size in place");
    expect(hint).toBe(
      `${WAYS}. Or lower the memory limits in opscrew/plan.yaml and run \`opscrew design\` again.`,
    );
  });

  it("never turns on or prices the provider's backups, and says the snapshots cover the data", async () => {
    const { options } = await buildDesignOptionSet({
      facts: staticSpaFacts(),
      requirements: { ...requirements, dataCriticality: "important" },
      catalog: catalog(),
    });
    for (const option of options) {
      expect(option.backups).toBe(false);
      expect(option.cost.breakdown.map((line) => line.item)).not.toContainEqual(
        expect.stringContaining("backups"),
      );
      expect(option.summary).toContain(NO_BACKUPS);
      expect(option.summary).not.toContain("Automated backups are");
      expect(option.tradeoffs.join(" ")).not.toContain("No automated backups");
    }
  });
});

describe("an extra server on a provider with terms", () => {
  const [db] = selfHostedServices({ postgres: true, redis: false }) as [PlanService];
  const input: CloudServerInput = {
    name: "data",
    target: undefined,
    services: [db],
    app: {
      provider: "digitalocean",
      mode: "vps-compose",
      location: "fra1",
      serverType: "vps-6",
      image: "ubuntu-24-04-x64",
      backups: false,
      edge: "caddy",
    },
    region: "eu-central",
    backups: false,
    catalogFor: async () => catalog(),
  };

  it("names its terms in its line", async () => {
    const designed = await designCloudServer(input);
    expect(designed.server.target.serverType).toBe("vps-4");
    expect(serverLine(designed)).toContain(
      "/month (estimate as of 2026-09-01). Plus a one-time setup fee of $5.00 (incl. tax) when the server is created, not part of the monthly price.",
    );
  });

  it("keeps its deployed type, and refuses another one or one that no longer holds it", async () => {
    const deployed = { location: "fra1", serverType: "vps-6" };
    const kept = await designCloudServer({ ...input, deployed });
    expect(kept.server.target.serverType).toBe("vps-6");
    expect(kept.warnings).toEqual([
      "Server data could use vps-4 now, but OpsCrew keeps vps-6: DigitalOcean can't change a Droplet's size in place.",
    ]);

    const named = await designCloudServer({
      ...input,
      deployed,
      target: { serverType: "vps-8" },
    }).catch((e: unknown) => e);
    expect(named).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "Server data is a vps-6, and opscrew/plan.yaml names vps-8 for it (servers[].target.serverType), but DigitalOcean can't change a Droplet's size in place. plan.yaml was not changed.",
      hint: `Set servers[].target.serverType back to vps-6 for server data and run \`opscrew design\` again. ${WAYS}.`,
    });

    const big = PlanServiceSchema.parse({ ...db, memoryMb: 6144 });
    const outgrown = await designCloudServer({
      ...input,
      services: [big],
      deployed: { location: "fra1", serverType: "vps-4" },
    }).catch((e: unknown) => e);
    expect(outgrown).toMatchObject({ code: "INVALID_INPUT" });
    expect((outgrown as Error).message).toContain(
      "and DigitalOcean can't change a Droplet's size in place",
    );
    expect((outgrown as { hint: string }).hint).toContain(WAYS);
  });

  it("never has the provider's backups, and refuses them when the plan asks", async () => {
    const designed = await designCloudServer({ ...input, backups: true });
    expect(designed.server.target.backups).toBe(false);
    expect(designed.cost.breakdown).toHaveLength(1);
    const asked = await designCloudServer({ ...input, target: { backups: true } }).catch(
      (e: unknown) => e,
    );
    expect(asked).toMatchObject({
      code: "INVALID_INPUT",
      message: `Server data has automated backups on (servers[].target.backups), but ${NO_BACKUPS} plan.yaml was not changed.`,
    });
  });
});

describe("design's snapshots on a provider without backups", () => {
  it("proposes scheduled snapshots with the off-server copy, as on an own server", () => {
    const plan = testPlan({ provider: "digitalocean", postgres: true, domain: "shop.example.com" });
    const designed = withDesignedSnapshots(plan, undefined, { dataCriticality: "important" });
    expect(designed.snapshots?.schedule).toEqual({ every: "weekly", keep: 4 });
    expect(noProviderBackups("digitalocean")).toBe(true);
    expect(noProviderBackups("hetzner")).toBe(false);
  });
});
