/**
 * A cloud provider with Contabo's terms for the tests that mock `@opscrew/providers`: DigitalOcean's
 * definition that can't change a server's size in place (so without `texts.resizeOffline`), offers
 * no automated backups, includes whole-server snapshots in its price, and cancels a server at the
 * end of a one-month minimum term. Its offers' setup fees and included snapshots come from each test's catalogue.
 *
 * ```ts
 * vi.mock("@opscrew/providers", async (importOriginal) => {
 *   const { withTermProvider } = await import("../design/__fixtures__/term-provider");
 *   return withTermProvider(await importOriginal());
 * });
 * ```
 */
import type { CloudProviderDefinition } from "@opscrew/contracts";
import type * as Providers from "@opscrew/providers";

/** `actual` with DigitalOcean's definition given the terms above. */
export function withTermProvider(actual: typeof Providers): typeof Providers {
  const base = actual.cloudProvider("digitalocean");
  const { resizeOffline: _offline, ...texts } = base.texts;
  const fake: CloudProviderDefinition = {
    ...base,
    offering: {
      ...base.offering,
      resize: false,
      providerBackups: false,
      backupPercent: 0,
      snapshots: { kind: "included" },
      removal: { kind: "cancel-at-term-end", minimumTermMonths: 1 },
    },
    texts,
  };
  return {
    ...actual,
    CLOUD_PROVIDERS: actual.CLOUD_PROVIDERS.map((p) => (p.id === fake.id ? fake : p)),
    cloudProvider: (id: string) => (id === fake.id ? fake : actual.cloudProvider(id)),
  };
}
