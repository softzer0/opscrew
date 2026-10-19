import type {
  ComputeCatalog,
  ComputeOffer,
  ProviderExtras,
  VpsProviderId,
} from "@opscrew/contracts";
import { type ProjectFacts, type Requirements, writeArtifact } from "@opscrew/plan-schema";

export const AS_OF = "2026-09-01T00:00:00.000Z";

type OfferInit = Partial<ComputeOffer> & Pick<ComputeOffer, "id">;

/** A Hetzner-like offer; defaults: shared x86 in nbg1, available, not deprecated, static. */
export function offer(
  init: OfferInit & { vcpus: number; memoryGb: number; diskGb: number; price: number },
): ComputeOffer {
  const { price, ...rest } = init;
  return {
    provider: "hetzner",
    cpuType: "shared",
    architecture: "x86",
    location: "nbg1",
    monthly: { amount: price, currency: "EUR" },
    pricesIncludeVat: false,
    deprecated: false,
    available: true,
    source: "static",
    asOf: AS_OF,
    ...rest,
  };
}

/** In-memory `ComputeCatalog` over a fixed offer list. Records the locations asked for. */
export class MemoryCatalog implements ComputeCatalog {
  readonly requested: (string | undefined)[] = [];
  constructor(
    readonly offers: ComputeOffer[],
    readonly extrasValue: Omit<ProviderExtras, "asOf" | "source"> &
      Partial<Pick<ProviderExtras, "asOf" | "source">> = {
      ipv4Monthly: { amount: 0.5, currency: "EUR" },
      backupPercent: 20,
      pricesIncludeVat: false,
    },
    readonly provider: VpsProviderId = "hetzner",
  ) {}
  async listOffers(location?: string): Promise<ComputeOffer[]> {
    this.requested.push(location);
    return this.offers.filter((o) => location === undefined || o.location === location);
  }
  async extras(_location: string): Promise<ProviderExtras> {
    return { source: "static", asOf: AS_OF, ...this.extrasValue };
  }
}

/** Offers in both eu-central locations plus traps that design must skip. */
export function euCatalog(): MemoryCatalog {
  const both = (init: Parameters<typeof offer>[0]) => [
    offer({ ...init, location: "nbg1" }),
    offer({ ...init, location: "fsn1" }),
  ];
  return new MemoryCatalog([
    // Traps: ARM, deprecated and unavailable offers are cheaper than everything else.
    ...both({ id: "cax11", vcpus: 2, memoryGb: 4, diskGb: 40, price: 3.79, architecture: "arm" }),
    ...both({ id: "cx22", vcpus: 2, memoryGb: 4, diskGb: 40, price: 3.99, deprecated: true }),
    offer({ id: "cx13", vcpus: 2, memoryGb: 4, diskGb: 40, price: 4.19, available: false }),
    offer({ id: "cx13", vcpus: 2, memoryGb: 4, diskGb: 40, price: 4.19, location: "fsn1" }),
    // Elsewhere: never offered for eu-central.
    offer({ id: "cx11", vcpus: 1, memoryGb: 2, diskGb: 20, price: 1.0, location: "hel1" }),
    ...both({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49 }),
    ...both({ id: "cx33", vcpus: 4, memoryGb: 8, diskGb: 80, price: 8.49 }),
    ...both({ id: "cx43", vcpus: 8, memoryGb: 16, diskGb: 160, price: 15.99 }),
    ...both({ id: "cpx22", vcpus: 2, memoryGb: 4, diskGb: 80, price: 19.49 }),
    ...both({ id: "cx53", vcpus: 16, memoryGb: 32, diskGb: 320, price: 29.49 }),
    ...both({ id: "ccx13", vcpus: 2, memoryGb: 8, diskGb: 80, price: 42.99, cpuType: "dedicated" }),
    ...both({
      id: "ccx23",
      vcpus: 4,
      memoryGb: 16,
      diskGb: 160,
      price: 85.99,
      cpuType: "dedicated",
    }),
    ...both({
      id: "ccx33",
      vcpus: 8,
      memoryGb: 32,
      diskGb: 240,
      price: 138.49,
      cpuType: "dedicated",
    }),
  ]);
}

/** Writes `opscrew/architecture.json` (at `file`) for the app `name`, with {@link makeFacts}. */
export async function writeArchitecture(file: string, name: string): Promise<void> {
  await writeArtifact("architecture", file, {
    schemaVersion: 1,
    generatedAt: "2026-10-11T09:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: makeFacts({ name }),
    summary: "A shop.",
    risks: [],
    aiEnriched: false,
  });
}

export function makeFacts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    name: "demo-app",
    languages: ["typescript"],
    packageManager: "npm",
    frameworks: [],
    appKind: "api",
    platformExport: { platform: "none", evidence: [] },
    build: {},
    runtimeVersions: {},
    envVars: [],
    services: [],
    docker: {},
    monorepo: false,
    appDir: ".",
    git: {},
    ...overrides,
  };
}

/** A static Vite SPA. */
export function staticSpaFacts(): ProjectFacts {
  return makeFacts({
    name: "landing",
    frameworks: [
      { name: "vite", path: "." },
      { name: "react", path: "." },
    ],
    appKind: "static-spa",
    build: { buildCommand: "npm run build", outputDir: "dist" },
  });
}

/** A Next.js app using Postgres. */
export function nextPostgresFacts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return makeFacts({
    name: "@acme/Shop",
    frameworks: [{ name: "next", version: "15.0.0", path: "." }],
    appKind: "ssr",
    port: 3000,
    build: { buildCommand: "npm run build", startCommand: "npm start" },
    envVars: [
      { name: "DATABASE_URL", files: ["src/db.ts"], clientExposed: false, secretLikely: true },
      { name: "NEXTAUTH_SECRET", files: ["src/auth.ts"], clientExposed: false, secretLikely: true },
      {
        name: "NEXT_PUBLIC_SITE_URL",
        files: ["src/app/page.tsx"],
        clientExposed: true,
        secretLikely: false,
      },
      { name: "PORT", files: ["server.ts"], clientExposed: false, secretLikely: false },
    ],
    services: [{ kind: "postgres", evidence: ["dependency:pg"] }],
    git: { defaultBranch: "trunk" },
    ...overrides,
  });
}

export function makeRequirements(overrides: Partial<Requirements> = {}): Requirements {
  return {
    schemaVersion: 1,
    answeredAt: "2026-10-11T11:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: 10, currency: "EUR" },
    provider: "hetzner",
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "none",
    dnsProvider: "none",
    keepExternalServices: [],
    ...overrides,
  };
}

/** DigitalOcean-like extras: daily backups at 30 %, IPv4 included (no separate price). */
export const DIGITALOCEAN_EXTRAS: Omit<ProviderExtras, "asOf" | "source"> = {
  backupPercent: 30,
  pricesIncludeVat: false,
};

/** A DigitalOcean-like offer; defaults: shared x86 Basic size in fra1, USD, available, static. */
export function doOffer(
  init: Partial<ComputeOffer> &
    Pick<ComputeOffer, "id"> & { vcpus: number; memoryGb: number; diskGb: number; price: number },
): ComputeOffer {
  const { price, ...rest } = init;
  return offer({
    location: "fra1",
    description: init.cpuType === "dedicated" ? "CPU-Optimized" : "Basic",
    ...rest,
    provider: "digitalocean",
    price,
    monthly: { amount: price, currency: "USD" },
  });
}

/** An in-memory DigitalOcean catalogue; `extras` defaults to {@link DIGITALOCEAN_EXTRAS}. */
export function digitaloceanCatalog(
  offers: ComputeOffer[],
  extras: ConstructorParameters<typeof MemoryCatalog>[1] = DIGITALOCEAN_EXTRAS,
): MemoryCatalog {
  return new MemoryCatalog(offers, extras, "digitalocean");
}

/**
 * Droplet sizes in fra1 and ams3 (the eu-central and eu-north locations) at the published Basic
 * prices, two CPU-Optimized sizes, plus traps design must skip: a size too small for the app,
 * an unavailable size in fra1 and a cheap size in London (never offered for these regions).
 */
export function doEuCatalog(): MemoryCatalog {
  const both = (init: Parameters<typeof doOffer>[0]) => [
    doOffer({ ...init, location: "fra1" }),
    doOffer({ ...init, location: "ams3" }),
  ];
  return digitaloceanCatalog([
    ...both({ id: "s-1vcpu-1gb", vcpus: 1, memoryGb: 1, diskGb: 25, price: 6 }),
    doOffer({ id: "s-1vcpu-2gb", vcpus: 1, memoryGb: 2, diskGb: 50, price: 12 }),
    doOffer({ id: "s-1vcpu-2gb", vcpus: 1, memoryGb: 2, diskGb: 50, price: 12, location: "ams3" }),
    doOffer({ id: "s-2vcpu-2gb", vcpus: 2, memoryGb: 2, diskGb: 60, price: 18, available: false }),
    doOffer({ id: "s-2vcpu-2gb", vcpus: 2, memoryGb: 2, diskGb: 60, price: 18, location: "ams3" }),
    doOffer({
      id: "s-1vcpu-512mb",
      vcpus: 4,
      memoryGb: 8,
      diskGb: 160,
      price: 1,
      location: "lon1",
    }),
    ...both({ id: "s-2vcpu-4gb", vcpus: 2, memoryGb: 4, diskGb: 80, price: 24 }),
    ...both({ id: "s-4vcpu-8gb", vcpus: 4, memoryGb: 8, diskGb: 160, price: 48 }),
    ...both({ id: "c-2", vcpus: 2, memoryGb: 4, diskGb: 25, price: 42, cpuType: "dedicated" }),
    ...both({ id: "c-4", vcpus: 4, memoryGb: 8, diskGb: 50, price: 84, cpuType: "dedicated" }),
  ]);
}
