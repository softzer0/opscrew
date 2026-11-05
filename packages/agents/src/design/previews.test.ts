import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema, type MonitoringSettings } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { SYSTEM_RESERVE_MB } from "../shared/memory";
import {
  euCatalog,
  MemoryCatalog,
  makeRequirements,
  nextPostgresFacts,
  offer,
  testPlan,
} from "../testing";
import { readPlanWithEdits } from "./placement-edits";
import { previewCapacity, previewEdits, previewMemoryText } from "./previews";
import { type Sizing, sizeFor } from "./sizing";

const PREVIEWS = { cap: 3, lifetimeDays: 7, domain: "shop.example.com", seed: null };

/** A preview environment's plan as plan.yaml holds it, with `extra` over it. */
function previewPlanFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const plan = testPlan();
  return {
    ...plan,
    app: { ...plan.app, name: "shop-preview" },
    environment: {
      name: "preview",
      deploySource: { from: "main" },
      runner: "github",
      previews: PREVIEWS,
    },
    dns: { provider: "cloudflare", zone: "example.com", proxied: false, www: false },
    security: { ...plan.security, httpAllowedFrom: "any" },
    ...extra,
  };
}

async function planFile(content: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opscrew-test-"));
  const file = join(dir, "plan.yaml");
  await writeFile(file, stringify(content));
  return file;
}

describe("a preview environment's plan.yaml", () => {
  it("is a valid plan as design writes it", () => {
    expect(DeployPlanSchema.safeParse(previewPlanFile()).success).toBe(true);
  });

  it("is read with its servers and add-ons apart, and design leaves them out with a line each", async () => {
    const plan = testPlan();
    const file = await planFile(
      previewPlanFile({
        servers: [{ name: "data" }],
        services: plan.services.map((service) => ({ ...service, server: "data" })),
        observability: { check: { enabled: true } },
      }),
    );
    const read = await readPlanWithEdits(file);
    expect(read?.whole).toBeUndefined();
    expect(read?.plan.observability?.check?.enabled).toBe(false);
    expect(read?.edits).toMatchObject({ placed: { db: "data" }, addonsOff: ["check"] });

    const collapsed = previewEdits(read?.edits ?? { servers: [], placed: {} });
    expect(collapsed.edits).toEqual({ servers: [], placed: {} });
    expect(collapsed.lines).toEqual([
      "Server data is left out: every preview runs on the preview environment's one server, so db runs there too.",
      "The scheduled check is off: it watches a deployed app, and previews come and go.",
    ]);
  });

  it("of another environment is read with its add-ons as they are", async () => {
    const plan = testPlan();
    const file = await planFile({ ...plan, observability: { check: { enabled: true } } });
    const read = await readPlanWithEdits(file);
    expect(read?.plan.observability?.check?.enabled).toBe(true);
    expect(read?.edits.addonsOff).toBeUndefined();
  });
});

describe("previewCapacity", () => {
  const locations = ["nbg1", "fsn1"];
  /** One preview's sizing: 1024 MB of limits, a 128 MB edge, 2 vCPUs, 40 GB disk, 4 GB floor. */
  const sizing: Sizing = {
    ...sizeFor(nextPostgresFacts(), makeRequirements()),
    limitsMb: 1024,
    edgeMb: 128,
    vcpus: 2,
    diskGb: 40,
    memoryGb: 4,
  };
  /** euCatalog with an Arm type in nbg1. */
  const catalog = () =>
    new MemoryCatalog([
      ...euCatalog().offers,
      offer({ id: "cax21", vcpus: 4, memoryGb: 8, diskGb: 80, price: 6.49, architecture: "arm" }),
    ]);
  const refusal = (serverType: string, given: Sizing = sizing) =>
    previewCapacity(catalog(), { cap: 3, serverType }, given, locations).then(
      () => undefined,
      (error: unknown) => error as OpsCrewError,
    );

  it("keeps the cap without a server type, and takes the type's cap with one", async () => {
    const plain = catalog();
    expect(await previewCapacity(plain, { cap: 4 }, sizing, locations)).toEqual({
      catalog: plain,
      cap: 4,
    });

    const sized = await previewCapacity(plain, { cap: 3, serverType: "cx33" }, sizing, locations);
    expect(sized.cap).toBe(Math.floor((8 * 1024 - SYSTEM_RESERVE_MB - 128) / 1024));
    const offers = await sized.catalog.listOffers("nbg1");
    expect(new Set(offers.map((o) => o.id))).toEqual(new Set(["cx33"]));
    // At most 20, whatever the server holds.
    const big = await previewCapacity(
      plain,
      { cap: 3, serverType: "cx53" },
      { ...sizing, limitsMb: 256 },
      locations,
    );
    expect(big.cap).toBe(20);
  });

  it("refuses a type design cannot choose, listing those it can", async () => {
    const choosable = "choose one of cpx22, cx13, cx23, cx33, cx43 and cx53";
    for (const type of ["cx99", "cax21", "ccx13", "cx22"]) {
      const error = await refusal(type);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error?.message).toContain(`There is no ${type} server type previews can use here`);
      expect(error?.message).toContain(choosable);
    }
    // Below the sizing's disk, vCPUs or memory floor, or with no room for one preview.
    expect((await refusal("cx23", { ...sizing, diskGb: 60 }))?.message).toContain(
      "choose one of cpx22, cx33, cx43 and cx53",
    );
    expect((await refusal("cx23", { ...sizing, memoryGb: 8 }))?.message).not.toContain("cx23,");
    expect((await refusal("cx33", { ...sizing, limitsMb: 8192 }))?.message).toContain(
      "choose one of cx43 and cx53",
    );
  });
});

describe("previewEdits", () => {
  it("turns the self-hosted monitoring off with a line", () => {
    const monitoring = { enabled: true } as unknown as MonitoringSettings;
    expect(previewEdits({ servers: [], placed: {}, monitoring })).toEqual({
      edits: { servers: [], placed: {} },
      lines: ["The self-hosted monitoring is off: it watches prod's servers, not previews."],
    });
  });
});

describe("previewMemoryText", () => {
  it("names the cap, each preview's limits and what stays free", () => {
    const plan = testPlan();
    expect(previewMemoryText(plan, 2, 4096, 128)).toBe(
      `Memory limits: up to 2 previews at once, each ${plan.app.memoryMb + 512} MB (the app ${plan.app.memoryMb} MB, db 512 MB); OpsCrew's edge and the system 512 MB; ${((4096 - 2 * (plan.app.memoryMb + 512) - 512) / 1024).toFixed(1)} GB of 4.0 GB free.`,
    );
  });
});
