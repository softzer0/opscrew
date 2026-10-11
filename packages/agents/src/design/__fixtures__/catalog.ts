import type {
  ComputeCatalog,
  ComputeLocation,
  ComputeOffer,
  ProviderExtras,
} from "@opscrew/contracts";
import type { ProjectFacts, Requirements } from "@opscrew/plan-schema";

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
  readonly provider = "hetzner" as const;
  readonly requested: (string | undefined)[] = [];
  constructor(
    readonly offers: ComputeOffer[],
    readonly extrasValue: Omit<ProviderExtras, "asOf" | "source"> &
      Partial<Pick<ProviderExtras, "asOf" | "source">> = {
      ipv4Monthly: { amount: 0.5, currency: "EUR" },
      backupPercent: 20,
      pricesIncludeVat: false,
    },
  ) {}
  async listLocations(): Promise<ComputeLocation[]> {
    return [...new Set(this.offers.map((o) => o.location))].map((id) => ({
      id,
      name: id,
      country: "DE",
    }));
  }
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
    git: {},
    ...overrides,
  };
}

/** A static Vite SPA. */
export function staticSpaFacts(): ProjectFacts {
  return makeFacts({
    name: "landing",
    frameworks: [{ name: "vite", path: "." }, { name: "react", path: "." }],
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
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "none",
    dnsProvider: "none",
    keepExternalServices: [],
    ...overrides,
  };
}
