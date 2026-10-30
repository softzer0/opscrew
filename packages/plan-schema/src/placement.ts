/**
 * Split placement and the private network in `opscrew/plan.yaml` (ADR 0022): the network that links
 * the app's servers and the user's devices (`network`), a service's move between servers (`move`),
 * where services run, and the plan's rules across them.
 */
import { z } from "zod";
import { APP_SERVER, ComponentNameSchema, type PlanService } from "./components";
import { IsoDateTimeSchema, onOneServer, type SelfHostedServiceKind } from "./enums";

/** A device's name on an app's network (`network.devices[].name`). */
export const DeviceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, {
  message: "must be 1-32 lower-case letters, digits or hyphens and start with a letter",
});

/**
 * A WireGuard public key: the base64 of exactly 32 bytes, as `wg pubkey` prints it. The 43rd
 * character's last two bits are zero, so only 16 characters can stand there.
 */
export const WireGuardKeySchema = z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/, {
  message:
    "must be a WireGuard public key: the base64 of 32 bytes (44 characters ending in =), as `wg pubkey` prints it",
});

/** The first UDP port of an app's network on a server: `wg-opscrew0`'s. */
const FIRST_PORT = 51820;

/** The private ranges OpsCrew picks a network's `/24` from: 10.200.0.0/13. */
const NETWORKS_START = ipv4Number("10.200.0.0");
const NETWORKS_END = ipv4Number("10.207.255.255");

/** An IPv4 address as a number. */
function ipv4Number(address: string): number {
  return address.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

/** True for a `/24` network address inside 10.200.0.0/13 (an input `z.cidrv4()` accepted). */
function isNetworkRange(range: string): boolean {
  const [base = "", size] = range.split("/");
  const start = ipv4Number(base);
  return size === "24" && start % 256 === 0 && start >= NETWORKS_START && start <= NETWORKS_END;
}

/**
 * `plan.network`: one WireGuard network per app and environment, a full mesh between its servers
 * that the user's devices join. Only public keys: every private key stays on this computer and its
 * own server or device.
 */
export const NetworkSchema = z.strictObject({
  /** A `/24` inside 10.200.0.0/13, such as `10.200.4.0/24`. */
  range: z.cidrv4().refine(isNetworkRange, {
    message:
      "must be a /24 network inside 10.200.0.0/13 with its last number 0, such as 10.200.4.0/24",
  }),
  /** One per server: `app` and each extra server. */
  members: z.array(
    z.strictObject({
      /** `app` or an extra server's name. */
      name: z.string(),
      address: z.ipv4(),
      /** The UDP port it listens on; it names the interface ({@link networkInterface}). */
      port: z.int().min(FIRST_PORT).max(65535),
      publicKey: WireGuardKeySchema,
    }),
  ),
  /** The user's devices on the network. */
  devices: z
    .array(
      z.strictObject({
        name: DeviceNameSchema,
        address: z.ipv4(),
        publicKey: WireGuardKeySchema,
        addedAt: IsoDateTimeSchema,
      }),
    )
    .default(() => []),
  /** A device's own login to a database or cache. */
  grants: z
    .array(
      z.strictObject({
        device: DeviceNameSchema,
        service: ComponentNameSchema,
        access: z.enum(["read-only", "full"]),
      }),
    )
    .default(() => []),
  /** `false` once `opscrew secure --close-public-ssh` closed SSH everywhere but the network. */
  publicSsh: z.boolean().default(true),
});

/**
 * `plan.move`: a service moving between the app's servers, resumable. `copy`: `dump` copies
 * Postgres's data, `empty` starts Valkey, Redis or Dragonfly empty.
 */
export const MoveSchema = z.strictObject({
  service: ComponentNameSchema,
  /** `app` or an extra server's name. */
  from: z.string(),
  /** `app` or an extra server's name. */
  to: z.string(),
  /** The last completed step. */
  step: z.enum(["started", "deployed", "switched"]),
  copy: z.enum(["dump", "empty"]),
  /** The data's size, measured at the start of the window. */
  sizeBytes: z.int().nonnegative().optional(),
});

/** The private network, with its defaults filled in. */
export type Network = z.output<typeof NetworkSchema>;
/** A service's move between the app's servers. */
export type Move = z.output<typeof MoveSchema>;

/** The service kinds a device can be granted its own login to. */
export const GRANTABLE_KINDS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
  "valkey",
  "redis",
  "dragonfly",
] as const satisfies readonly SelfHostedServiceKind[];

const GRANTABLE: ReadonlySet<string> = new Set(GRANTABLE_KINDS);

/**
 * The server a service of the plan runs on: {@link APP_SERVER} or an extra server's name.
 * @throws Error when the plan has no service of that name.
 */
export function serverOfService(
  plan: { readonly services: readonly PlanService[] },
  serviceName: string,
): string {
  const service = plan.services.find((s) => s.name === serviceName);
  if (service === undefined) throw new Error(`The plan has no service named "${serviceName}".`);
  return service.server ?? APP_SERVER;
}

/** The enabled services placed on a server ({@link APP_SERVER} or an extra server's name). */
export function servicesOn(
  plan: { readonly services: readonly PlanService[] },
  server: string,
): PlanService[] {
  return plan.services.filter((s) => s.enabled && (s.server ?? APP_SERVER) === server);
}

/** A network member's WireGuard interface on its server: `wg-opscrew<port - 51820>`. */
export function networkInterface(member: { port: number }): string {
  return `wg-opscrew${member.port - FIRST_PORT}`;
}

/** What {@link checkPlacement} reads of a plan. */
interface PlacementFields {
  target: { provider: string };
  servers?: readonly { name: string }[];
  services: readonly PlanService[];
  network?: Network;
  move?: Move;
  retarget?: unknown;
}

/** How a refusal names a target that has no place for extra servers. */
const TARGET_NAMES: Record<string, string> = {
  portainer: "a Portainer target",
  localhost: "the localhost target",
  "cloudflare-workers": "Cloudflare hosting",
  "github-pages": "GitHub Pages",
};

/** `a, b or c`. */
function orList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/**
 * The plan's rules across `servers`, `services[].server`, `network` and `move`: extra servers and
 * the network only on a cloud or own target, every server named once and running a service, the
 * network holding every server with its address, devices and grants that fit, a move between two
 * servers of the plan, and no `retarget` with extra servers.
 */
export function checkPlacement(plan: PlacementFields, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const { services, network, move } = plan;
  const servers = plan.servers ?? [];
  if (!onOneServer(plan.target.provider)) {
    const target = TARGET_NAMES[plan.target.provider] ?? plan.target.provider;
    const choose =
      "a cloud server or your own server (target.provider hetzner, digitalocean or own)";
    if (servers.length > 0) {
      issue(
        ["servers"],
        `is refused with ${target}: extra servers run on ${choose}; remove servers, or choose such a target`,
      );
    }
    if (network !== undefined) {
      issue(
        ["network"],
        `is refused with ${target}: the private network links ${choose}; remove network, or choose such a target`,
      );
    }
  }
  const names = servers.map((server) => server.name);
  const named = new Set<string>();
  for (const [i, { name }] of servers.entries()) {
    if (named.has(name)) {
      issue(
        ["servers", i, "name"],
        `"${name}" is already the name of another server; give each its own`,
      );
    }
    named.add(name);
  }
  for (const [i, service] of services.entries()) {
    if (service.server === undefined || named.has(service.server)) continue;
    const instead =
      names.length > 0 ? `use one of ${names.join(", ")}, or` : "the plan has none, so";
    issue(
      ["services", i, "server"],
      `names no server of the plan: "${service.server}"; ${instead} leave server out to run the service on the app's server`,
    );
  }
  for (const [i, { name }] of servers.entries()) {
    if (servicesOn(plan, name).length > 0 || move?.from === name) continue;
    issue(
      ["servers", i],
      `runs no enabled service: place a service on ${name} (services[].server), or remove the server (it is deleted at the next provision, after your approval)`,
    );
  }
  if (network !== undefined) checkNetwork(network, plan, names, issue);
  else if (servers.length > 0) {
    issue(
      ["network"],
      "is required with extra servers: the private network links them to the app's server; run opscrew design to add it",
    );
  }
  if (move !== undefined) {
    const serviceNames = services.map((service) => service.name);
    if (!serviceNames.includes(move.service)) {
      issue(
        ["move", "service"],
        `names no service of the plan: "${move.service}"; use one of ${serviceNames.join(", ")}`,
      );
    }
    for (const field of ["from", "to"] as const) {
      const server = move[field];
      if (server !== APP_SERVER && !named.has(server)) {
        const others = names.length > 0 ? ` or one of ${names.join(", ")}` : "";
        issue(
          ["move", field],
          `names no server of the plan: "${server}"; use ${APP_SERVER}${others}`,
        );
      }
    }
    if (move.from === move.to) {
      issue(
        ["move", "to"],
        `must differ from move.from ("${move.from}"): a move takes a service to another server`,
      );
    }
  }
  if (plan.retarget !== undefined && servers.length > 0) {
    issue(
      ["retarget"],
      "is refused for an app with extra servers: moving it to another provider is not available yet; place every service on the app's server (remove services[].server and servers), then move it",
    );
  }
}

/** The network's members, addresses, devices and grants. */
function checkNetwork(
  network: Network,
  plan: PlacementFields,
  servers: readonly string[],
  issue: (path: (string | number)[], message: string) => void,
): void {
  const expected = [APP_SERVER, ...servers];
  const everyServer = servers.length > 0 ? `${APP_SERVER} and ${servers.join(", ")}` : APP_SERVER;
  const members = new Set<string>();
  for (const [i, { name }] of network.members.entries()) {
    if (!expected.includes(name)) {
      const which =
        servers.length > 0
          ? `"${APP_SERVER}" or the name of one of servers (${servers.join(", ")})`
          : `"${APP_SERVER}": the plan has no extra servers`;
      issue(
        ["network", "members", i, "name"],
        `names no server of the plan: "${name}"; a member is ${which}`,
      );
    } else if (members.has(name)) {
      issue(
        ["network", "members", i, "name"],
        `"${name}" is already a member; each server is a member once`,
      );
    }
    members.add(name);
  }
  for (const name of expected) {
    if (members.has(name)) continue;
    issue(
      ["network", "members"],
      `has no member "${name}": every server of the app needs one (${everyServer}), with its address and port`,
    );
  }

  const [base = ""] = network.range.split("/");
  const start = ipv4Number(base);
  const prefix = base.slice(0, base.lastIndexOf("."));
  const owners = new Map<string, string>();
  const address = (path: (string | number)[], owner: string, value: string) => {
    const host = ipv4Number(value) - start;
    if (host < 1 || host > 254) {
      issue(
        path,
        `must be inside the network's range ${network.range}, from ${prefix}.1 to ${prefix}.254`,
      );
      return;
    }
    const other = owners.get(value);
    if (other !== undefined) {
      issue(path, `${value} is already the address of ${other}; give each its own`);
    }
    owners.set(value, owner);
  };
  for (const [i, member] of network.members.entries()) {
    address(["network", "members", i, "address"], member.name, member.address);
  }
  const devices = new Set<string>();
  for (const [i, device] of network.devices.entries()) {
    if (devices.has(device.name)) {
      issue(
        ["network", "devices", i, "name"],
        `"${device.name}" is already the name of another device; give each its own`,
      );
    }
    devices.add(device.name);
    address(["network", "devices", i, "address"], device.name, device.address);
  }

  const grantable = plan.services.filter((s) => s.enabled && GRANTABLE.has(s.kind));
  for (const [i, grant] of network.grants.entries()) {
    if (!devices.has(grant.device)) {
      issue(
        ["network", "grants", i, "device"],
        `names no device of the network: "${grant.device}"; add it first (opscrew vpn add ${grant.device})`,
      );
    }
    const service = plan.services.find((s) => s.enabled && s.name === grant.service);
    if (service === undefined) {
      const instead =
        grantable.length > 0
          ? `grant one of ${grantable.map((s) => s.name).join(", ")}`
          : `the plan has no enabled service of a kind a device can be granted (${orList(GRANTABLE_KINDS)})`;
      issue(
        ["network", "grants", i, "service"],
        `names no enabled service of the plan: "${grant.service}"; ${instead}`,
      );
    } else if (!GRANTABLE.has(service.kind)) {
      issue(
        ["network", "grants", i, "service"],
        `is ${service.name}, a ${service.kind} service, which has no logins to grant: a device can be granted ${orList(GRANTABLE_KINDS)}`,
      );
    }
  }
}
