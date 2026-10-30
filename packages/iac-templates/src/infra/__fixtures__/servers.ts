import { APP_SERVER, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { type TestPlanOptions, testPlan, testServices } from "../../__fixtures__/plans";

/** A WireGuard public key for the tests: 32 bytes of `n`, in base64 (never a real key). */
export function testWireGuardKey(n: number): string {
  return Buffer.alloc(32, n).toString("base64");
}

/** An extra cloud server of {@link splitPlan}: `db` runs on the first, `cache` on the second. */
export interface TestExtraServer {
  name: string;
  provider: "hetzner" | "digitalocean";
}

const EXTRA_TARGETS = {
  hetzner: { location: "hel1", serverType: "cx33", backups: false },
  digitalocean: { location: "ams3", serverType: "s-2vcpu-4gb", backups: false },
} as const;

/**
 * {@link testPlan} with a private network (`10.200.4.0/24`, every member on port 51820), the
 * given extra servers (PostgreSQL `db` on the first, Valkey `cache` on the second) and, with
 * `device`, a laptop on the network.
 */
export function splitPlan(
  o: { app?: TestPlanOptions; servers?: readonly TestExtraServer[]; device?: boolean } = {},
): DeployPlan {
  const servers = o.servers ?? [];
  const base = testPlan({ ...o.app, postgres: true });
  const services = testServices({ postgres: true, redis: servers.length > 1 }).map(
    (service, i) => {
      const server = servers[i]?.name;
      return server === undefined ? service : { ...service, server };
    },
  );
  return DeployPlanSchema.parse({
    ...base,
    services,
    ...(servers.length === 0
      ? {}
      : {
          servers: servers.map(({ name, provider }) => ({
            name,
            target: { provider, mode: "vps-compose", ...EXTRA_TARGETS[provider] },
          })),
        }),
    network: {
      range: "10.200.4.0/24",
      members: [APP_SERVER, ...servers.map((server) => server.name)].map((name, i) => ({
        name,
        address: `10.200.4.${i + 1}`,
        port: 51820,
        publicKey: testWireGuardKey(i + 1),
      })),
      devices: o.device
        ? [
            {
              name: "laptop",
              address: "10.200.4.100",
              publicKey: testWireGuardKey(100),
              addedAt: "2026-10-30T12:00:00.000Z",
            },
          ]
        : [],
    },
  });
}
