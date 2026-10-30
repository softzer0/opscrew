# Contract: split placement and the private network

## plan-schema (T1801a, ADR 0022)

```ts
export const APP_SERVER = "app";
export const ServerNameSchema; // /^[a-z][a-z0-9-]{0,14}$/, never "app"
export const DeviceNameSchema; // /^[a-z][a-z0-9-]{0,31}$/

export const ExtraServerSchema = z.strictObject({
  name: ServerNameSchema,
  target: z.discriminatedUnion("provider", [
    // CloudTargetSchema's fields without `edge`: provider, mode, location, serverType, image?, backups
    ExtraCloudTargetSchema,
    z.strictObject({ provider: z.literal("own"), mode: z.literal("vps-compose"), arch: z.enum(["amd64", "arm64"]) }),
  ]),
});

// ServiceEntrySchema (every kind) gains:
server: ServerNameSchema.optional(), // absent: the app's server

export const NetworkSchema = z.strictObject({
  range: z.cidrv4(),                // a /24 inside 10.200.0.0/13
  members: z.array(z.strictObject({
    name: z.string(),               // "app" or a server's name
    address: z.ipv4(),
    port: z.int().min(51820).max(65535), // interface wg-opscrew<port - 51820>
    publicKey: WireGuardKeySchema,  // base64 of 32 bytes
  })),
  devices: z.array(z.strictObject({
    name: DeviceNameSchema, address: z.ipv4(), publicKey: WireGuardKeySchema, addedAt: IsoDateTimeSchema,
  })).default(() => []),
  grants: z.array(z.strictObject({
    device: DeviceNameSchema, service: ComponentNameSchema, access: z.enum(["read-only", "full"]),
  })).default(() => []),
  publicSsh: z.boolean().default(true),
});

export const MoveSchema = z.strictObject({
  service: ComponentNameSchema,
  from: z.string(), to: z.string(),
  step: z.enum(["started", "deployed", "switched"]),
  copy: z.enum(["dump", "empty"]),
  sizeBytes: z.int().nonnegative().optional(),
});

// DeployPlan gains:
servers: z.array(ExtraServerSchema).default(() => []),
network: NetworkSchema.optional(),
move: MoveSchema.optional(),
// deployment gains:
placement: z.record(ComponentNameSchema, z.string()).optional(),

export const GRANTABLE_KINDS = ["postgres", "mysql", "mariadb", "mongodb", "valkey", "redis", "dragonfly"] as const;
export function serverOfService(plan, serviceName): string;          // "app" or a server's name
export function servicesOn(plan, server: string): PlanService[];     // enabled services placed there
export function networkInterface(member: { port: number }): string; // `wg-opscrew${port - 51820}`
```

Cross-field rules, each with a plain message that says what would work:
- `servers` and `network` only on the cloud and own targets.
- Unique server names; every `services[].server` names a server; every server runs at least one
  enabled service or is `move.from`.
- `network.members` holds `app` and every server, each once. Addresses are inside `range`,
  unique, and not the network or broadcast address.
- Device names and addresses are unique, and each grant names a device and an enabled service of a
  grantable kind.
- `move.service` exists, `move.from` ≠ `move.to`, and both are servers of the plan.
- `retarget` together with `servers` is refused.

## ssh-host (T1803, T1806)

```ts
type HostPrivilege = "root" | "sudo" | "docker";  // probe result; "sudo-password" | "none" still refused
// HOST_STEP_IDS += "network" | "network-filter" | "public-ssh" | "grant"

interface NetworkStepParams {
  interface: string;              // wg-opscrew<k>
  address: string;                // "10.200.4.2/24"
  port: number;
  publicKey: string;              // this server's
  peers: { name: string; publicKey: string; endpoint?: string; allowedIp: string; keepalive?: number }[];
  otherInterfaces: string[];      // the host's other OpsCrew interfaces, for Docker's drop-in
}
// secret on stdin when the agents pass one: the private key (base64)

interface NetworkFilterParams { interface: string; address: string; rules: { port: number; sources: string[] }[] }
interface PublicSshParams { open: boolean; interface: string; allowedCidrs: string[] }
interface GrantParams { service: string; kind: "postgres" | "mysql" | "mariadb" | "mongodb"; login: string; access: "read-only" | "full"; remove: boolean }
// secrets on stdin: the login's password; for mysql and mariadb also the root password

export function readWireGuard(remote: RemoteExec, iface: string, privilege: HostPrivilege):
  Promise<{ publicKey: string; endpoint?: string; latestHandshake?: Date; allowedIps: string[] }[]>;

// HostFacts gain: wireguardInterfaces: string[]; udpPortsInUse: number[]; ipv4Routes: string[]
// HostRecord gains: networks: Record<string, string>  // interface → app
```

## iac-templates (T1804, T1805, T1807)

- **Modules** (`hetzner-vps`, `digitalocean-droplet`): variables `web` (bool, default `true`),
  `wireguard_port` (number, default `null`) and `ssh_key_id` (default `null`); output
  `ssh_key_id`. The cloud-init template takes `web`.
- **Root module:**
  - `module "server_<name>"` per extra cloud server;
  - `output "extra_servers"`: `{ <name> = { ipv4, ipv6, id, name } }`.
- **Runtime:**
  - `renderCompose(plan)` (the app's server, as today plus placement);
  - `renderServerCompose(plan, name)`;
  - `publishedOnNetwork(plan, server): { service: string; port: number; address: string }[]`;
  - the catalog context's `host` and `advertisedHost`;
  - `OPSCREW_ACL_USERS` in a Redis-protocol service's environment when it has grants.
- **Workflow:**
  - secrets `OPSCREW_SERVER_<NAME>_HOST` and `OPSCREW_SERVER_<NAME>_KNOWN_HOSTS`;
  - a step per extra server before the switch;
  - the published-port repair.
- **Check:** `OPSCREW_CHECK_SERVER` holds a list of `{ id, host, port, user, knownHosts }`.

## Agents and surfaces (T1808–T1817)

- **`agents/network`:**
  - `allocateNetwork(plan, facts, keys)`;
  - `networkSteps(plan, server, facts)`;
  - `readNetwork(deps, plan)`: links `{ from, to, up, handshakeAgeSeconds?, roundTripMs? }`;
  - `deviceConfig(plan, device, privateKey, endpoints)`: the text of a device's `.conf`.
- **Server record:**
  - `servers`: name → address;
  - `ownServers`: name → login;
  - `thisDevice`.
- **`serverRemote(deps, plan, name)`:** the public address, or the private one when
  `network.publicSsh` is `false`.
- **Generated values:**
  - `network`: member → private key;
  - `grants`: `<device>/<service>` → password.
- **CLI:**
  - `opscrew vpn add <name> [--this-computer] [--qr] [--again]`;
  - `opscrew vpn remove <name>`;
  - `opscrew vpn list`;
  - `opscrew vpn grant <device> <service> [--full]`;
  - `opscrew vpn revoke <device> <service>`;
  - `opscrew secure --close-public-ssh | --open-public-ssh`;
  - `opscrew provision --finish-move`.

  Every command takes `--app`, `--env` and `--approve <hash>` as the others do.
- **MCP:**
  - `status` gains `servers`, `links`, `devices` (name and address) and `grants`;
  - a read-only `placement_estimate` tool (a service and a server's provider, location and type →
    prices and the delay estimate).
