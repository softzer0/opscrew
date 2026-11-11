/**
 * Advise on a cloud provider with Contabo's terms (T2611): its size changes are refused with the two
 * ways to another size, a move to it names its setup fee and minimum term, and its servers get
 * OpsCrew's snapshots rather than the provider's backups.
 * DigitalOcean's definition stands in for it (`withTermProvider`).
 */
import type { ComputeOffer } from "@opscrew/contracts";
import { describe, expect, it, vi } from "vitest";
import { doOffer, makeRequirements, testPlan } from "../../testing";
import type { PriceList } from "../types";
import {
  hetznerPrices,
  history,
  ids,
  reading,
  readingsOf,
  server,
  texts,
  validated,
} from "./__fixtures__/rule-readings";
import { costRules } from "./cost";
import { reliabilityRules } from "./reliability";
import { sizeRules } from "./size";

vi.mock("@opscrew/providers", async (importOriginal) => {
  const { withTermProvider } = await import("../../design/__fixtures__/term-provider");
  return withTermProvider(await importOriginal());
});

const sized = validated(sizeRules);
const costed = validated(costRules);

/** The provider's prices in fra1: the deployed type, a cheaper twin and a larger type. */
function termPrices(extra: ComputeOffer[] = []): PriceList {
  return {
    provider: "digitalocean",
    location: "fra1",
    offers: [
      doOffer({ id: "s-1vcpu-2gb", vcpus: 1, memoryGb: 2, diskGb: 50, price: 12 }),
      doOffer({ id: "s-2vcpu-4gb", vcpus: 2, memoryGb: 4, diskGb: 80, price: 24 }),
      ...extra,
    ],
    extras: {
      snapshotsIncluded: true,
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-11-11T00:00:00.000Z",
    },
  };
}

const droplet = testPlan({ deployed: true, provider: "digitalocean", postgres: true });

/** The two ways to another size the refusals name. */
const WAYS =
  "There are two ways to another size: `opscrew retarget --to hetzner` or `opscrew retarget --to contabo` moves the app to Hetzner Cloud or Contabo with a short maintenance window for its data; or, at DigitalOcean with downtime, take a snapshot of the app's data with its encrypted copy off the Droplet (`opscrew snapshot`, after `opscrew snapshot offsite on --to <provider>` and `opscrew provision` if the copy is off), remove the Droplet with `opscrew destroy` (DigitalOcean bills it to the end of its term), run `opscrew design` and `opscrew provision` with the new size, then put the data back from that copy with `opscrew restore <id> --from offsite --key-file <path>`";

describe("advise's size changes where the provider can't resize in place", () => {
  it("proposes the larger type as a move to a new server, by hand, without resize reasons", async () => {
    const app = server(reading({ cpus: 1 }), history({ memoryP95: 0.9 }));
    const [larger] = sized(readingsOf(droplet, { servers: { app }, prices: [termPrices()] }));
    expect(larger).toMatchObject({
      id: "size.app.larger",
      title: "Move server app to a new s-2vcpu-4gb (2 vCPU, 4 GB memory, 80 GB disk)",
      // The plan's backups are never priced at a provider without them.
      price: { before: 12, after: 24, currency: "USD" },
      apply: { kind: "manual", text: WAYS },
    });
    const why = texts(larger);
    expect(why).toContain("DigitalOcean can't change a Droplet's size in place");
    expect(why).not.toContain("offline");
    expect(why).not.toContain("can't make it smaller");
  });

  it("proposes a cheaper type the same way, and only once", async () => {
    const twin = doOffer({ id: "s-twin", vcpus: 1, memoryGb: 2, diskGb: 50, price: 10 });
    const readings = readingsOf(droplet, {
      servers: { app: server(reading({ cpus: 1 })) },
      prices: [termPrices([twin])],
    });
    const proposals = costed(readings);
    expect(ids(proposals)).toEqual(["cost.app.cheaper-type"]);
    expect(proposals[0]?.apply).toEqual({ kind: "manual", text: WAYS });
  });

  it("proposes no cheaper type for a server the size rules move to a larger one", async () => {
    const twin = doOffer({ id: "s-twin", vcpus: 1, memoryGb: 2, diskGb: 50, price: 10 });
    const readings = readingsOf(droplet, {
      servers: { app: server(reading({ cpus: 1 }), history({ memoryP95: 0.9 })) },
      prices: [termPrices([twin])],
    });
    const [larger] = sized(readings);
    expect(larger).toMatchObject({ id: "size.app.larger", apply: { kind: "manual" } });
    expect(ids(costed(readings))).not.toContain("cost.app.cheaper-type");
  });

  it("proposes no disk change when the larger type holds the filling disk too", async () => {
    const app = server(reading({ cpus: 1 }), history({ memoryP95: 0.9, diskFullInDays: 5 }));
    const proposals = sized(readingsOf(droplet, { servers: { app }, prices: [termPrices()] }));
    expect(ids(proposals)).toEqual(["size.app.larger"]);
    expect(texts(proposals[0])).toContain("disk");
  });
});

describe("advise's backups where the provider offers none", () => {
  it("proposes OpsCrew's snapshots instead of the provider's backups", () => {
    const plan = { ...droplet, target: { ...droplet.target, backups: false } };
    const readings = readingsOf(plan, {
      prices: [termPrices()],
      requirements: makeRequirements({ provider: "digitalocean", dataCriticality: "important" }),
    });
    const found = ids(validated(reliabilityRules)(readings));
    expect(found).not.toContain("reliability.app.backups");
    expect(found).toContain("reliability.env.snapshot-schedule");
  });
});

describe("advise's move to a provider with terms", () => {
  it("names the setup fee once and the minimum term", async () => {
    const cheap: ComputeOffer = {
      ...doOffer({ id: "vps-4", vcpus: 2, memoryGb: 4, diskGb: 100, price: 2 }),
      setupFee: { amount: 5, currency: "USD" },
      includedSnapshots: 1,
    };
    const readings = readingsOf(testPlan({ deployed: true }), {
      servers: { app: server(reading({ cpus: 2 })) },
      prices: [hetznerPrices(), termPrices([cheap])],
      requirements: makeRequirements({ region: "eu-central" }),
    });
    const move = costed(readings).find((p) => p.id === "cost.app.other-provider");
    expect(move?.apply).toEqual({ kind: "command", command: "opscrew retarget --to digitalocean" });
    // $2 without backups, which the provider doesn't offer, in euros.
    expect(move?.price?.after).toBe(1.82);
    const why = texts(move);
    expect(why).toContain(
      "Plus a one-time setup fee of $5.00 (excl. tax) when the server is created, not part of the monthly price",
    );
    expect(why).toContain(
      "The contract runs at least 1 month; a removal ends it at the end of the term",
    );
    expect(why).toContain("Whole-server snapshots are included in the price, up to 1");
  });
});
