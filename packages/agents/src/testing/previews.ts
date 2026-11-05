import { CloudflareClient } from "@opscrew/connector-cloudflare";
import { FAKE_ZONE_ID, type FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { testPlan } from "./deploy";
import { ownPlan } from "./own";

/**
 * The preview zone of {@link previewTestPlan}, a Cloudflare zone of its own: previews are
 * `pr-<n>-<random>.example.net`.
 */
export const PREVIEW_ZONE = "example.net";

/**
 * A preview environment's plan (`shop-preview`, environment `preview`) as design makes it: a
 * Hetzner server, or the user's own (`own`), the preview zone without a hostname of its own,
 * behind Cloudflare's proxy and open to Cloudflare only, no signing, deploy tags or check;
 * recorded as applied.
 */
export function previewTestPlan(options: { own?: boolean } = {}): DeployPlan {
  const base = options.own === true ? ownPlan({ deployed: true }) : testPlan({ deployed: true });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: "shop-preview" },
    environment: {
      name: "preview",
      deploySource: { from: "main" },
      runner: "github",
      previews: { cap: 3, lifetimeDays: 7, domain: PREVIEW_ZONE, seed: null },
    },
    infra: { ...base.infra, dir: "opscrew/infra/preview" },
    dns: { provider: "cloudflare", zone: PREVIEW_ZONE, proxied: true, www: false },
    security: { ...base.security, httpAllowedFrom: "cloudflare" },
    supplyChain: { ...base.supplyChain, sign: false },
    cicd: {
      ...base.cicd,
      workflowPath: ".github/workflows/opscrew-deploy-preview.yml",
      deployTags: { enabled: false, release: false },
    },
  });
}

/** The environment whose server previews share in the tests (spec.md US9). */
export const HOST_ENV = "dev";

/** The admin login of `dev`'s server when it is the user's own, in the tests: never shown. */
export const HOST_ADMIN = "dev-admin-7f3";

/** The address of `dev`'s server in the tests: a documentation address (RFC 5737), public. */
export const HOST_IPV4 = "198.51.100.40";

/**
 * `dev`'s plan (`shop-dev`), provisioned unless `deployed` is false: on a server OpsCrew created
 * at Hetzner, or the user's own (`own`), behind Cloudflare's proxy on `dev.shop.example.com`, with
 * the Caddy edge.
 */
export function hostTestPlan(options: { own?: boolean; deployed?: boolean } = {}): DeployPlan {
  const deployed = options.deployed ?? true;
  const base =
    options.own === true
      ? ownPlan({ deployed, domain: "dev.shop.example.com" })
      : testPlan({ deployed, domain: "dev.shop.example.com" });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: `shop-${HOST_ENV}` },
    environment: { name: HOST_ENV, deploySource: { from: "main" }, runner: "github" },
    infra: { ...base.infra, dir: `opscrew/infra/${HOST_ENV}` },
    cicd: { ...base.cicd, workflowPath: `.github/workflows/opscrew-deploy-${HOST_ENV}.yml` },
  });
}

/** The previews' domain below {@link PREVIEW_ZONE} in the tests of previews below a zone (US10). */
export const BELOW_ZONE = `previews.${PREVIEW_ZONE}`;

/** {@link previewTestPlan} with the previews below its zone, at {@link BELOW_ZONE}. */
export function appZonePreviewTestPlan(options: { own?: boolean } = {}): DeployPlan {
  const plan = previewTestPlan(options);
  return DeployPlanSchema.parse({
    ...plan,
    environment: {
      ...plan.environment,
      previews: { ...plan.environment?.previews, domain: BELOW_ZONE },
    },
  });
}

/** What Cloudflare answers about the zone's certificates in {@link certificateCloudflare}. */
export interface FakeCertificates {
  /** The zone's `advanced.allocated`: 0 without ACM (default 10). */
  allocated?: number;
  /** Total TLS on (default off). */
  totalTls?: boolean;
  /**
   * The status of the previews' pack at each read of the packs, the last one for every later read
   * (default `active`); none listed while it is `undefined`.
   */
  statuses?: (string | undefined)[];
  /** The previews' domain whose pack is listed (default {@link BELOW_ZONE}). */
  domain?: string;
  /** The statuses of older packs for the same names, listed first (default none). */
  older?: string[];
  /** What reading the packs answers instead, when given: Cloudflare's refusal. */
  packsFail?: { status: number; message: string };
}

/**
 * `fetch` answering the zone's certificate pack quota, Total TLS and packs, and the zones `zones`
 * names, as Cloudflare does (each read of the packs counted in `reads.packs`); `next` answers the
 * rest.
 */
export function certificateFetch(
  next: FetchLike,
  certificates: FakeCertificates = {},
  zones: Record<string, string> = { [PREVIEW_ZONE]: FAKE_ZONE_ID },
): { fetch: FetchLike; reads: { packs: number } } {
  const reads = { packs: 0 };
  const statuses = certificates.statuses ?? ["active"];
  const domain = certificates.domain ?? BELOW_ZONE;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result, ...extra }), {
        headers: { "content-type": "application/json" },
      });
    const id = Object.values(zones).find((zone) => path.startsWith(`/zones/${zone}/`));
    if (path === "/zones" && url.searchParams.has("name")) {
      const name = url.searchParams.get("name") ?? "";
      const found = zones[name];
      if (found !== undefined) {
        return ok([{ id: found, name, status: "active", name_servers: [] }]);
      }
    }
    if (path === `/zones/${id}/ssl/certificate_packs/quota`) {
      return ok({ advanced: { allocated: certificates.allocated ?? 10, used: 1 } });
    }
    if (path === `/zones/${id}/acm/total_tls`)
      return ok({ enabled: certificates.totalTls ?? false });
    if (path === `/zones/${id}/ssl/certificate_packs` && certificates.packsFail !== undefined) {
      const { status, message } = certificates.packsFail;
      reads.packs += 1;
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message }],
          messages: [],
          result: null,
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    }
    if (path === `/zones/${id}/ssl/certificate_packs`) {
      const status = statuses[Math.min(reads.packs, statuses.length - 1)];
      reads.packs += 1;
      const universal = { id: "u1", type: "universal", hosts: [domain], status: "active" };
      const pack = { id: "p1", type: "advanced", hosts: [`*.${domain}`], status };
      const older = (certificates.older ?? []).map((old, i) => ({
        ...pack,
        id: `o${i}`,
        status: old,
      }));
      return ok([universal, ...older, ...(status === undefined ? [] : [pack])], {
        result_info: { page: 1, per_page: 50, count: 2, total_count: 2, total_pages: 1 },
      });
    }
    return next(input, init);
  };
  return { fetch, reads };
}

/**
 * A Cloudflare client on `zone` (`FakeZone`) that also answers the zone's certificate pack quota,
 * Total TLS and packs ({@link certificateFetch}), and finds the zone `zoneName` (default
 * {@link PREVIEW_ZONE}).
 */
export function certificateCloudflare(
  zone: FakeZone,
  certificates: FakeCertificates = {},
  zoneName: string = PREVIEW_ZONE,
): { client: CloudflareClient; reads: { packs: number } } {
  const { fetch, reads } = certificateFetch(zone.fetch, certificates, { [zoneName]: FAKE_ZONE_ID });
  const client = new CloudflareClient({
    token: fakeSecret("cloudflare-token", "certificates"),
    fetch,
    sleep: async () => undefined,
  });
  return { client, reads };
}

/** {@link previewTestPlan} on `dev`'s server: an own target with `previews.server`. */
export function sharedPreviewTestPlan(): DeployPlan {
  const plan = previewTestPlan({ own: true });
  return DeployPlanSchema.parse({
    ...plan,
    environment: {
      ...plan.environment,
      previews: { ...plan.environment?.previews, server: { environment: HOST_ENV } },
    },
  });
}
