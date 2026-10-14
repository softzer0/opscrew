import type { Readable, Writable } from "node:stream";
import type {
  DestroyServices,
  DomainServices,
  InitServices,
  PortainerServices,
  ProvisionServices,
  RetargetServices,
  RunSecureOptions,
  RunVerifyOptions,
} from "@opscrew/agents";
import type { CliContext } from "../context";

/**
 * Network, engine and stream overrides for `provision`, `dns`, `design` (an own server's
 * inspection, from `provision.own`), `secure`, `verify`, `destroy`, `retarget`, `domain`,
 * `portainer` and `mcp`. The
 * real CLI uses none of these (each phase builds its defaults from the environment); tests attach
 * fakes with {@link withDeployServices} so commands never reach a cloud, a server or the network.
 */
export interface DeployServices {
  /** Engine, cloud provider, Cloudflare, GitHub, SSH and wait fakes for `provision` and `dns`. */
  provision?: ProvisionServices;
  /** Remote shell, port probe and scanners for `secure`. */
  secure?: Omit<RunSecureOptions, "planJson">;
  /** DNS, TLS, TCP and Cloudflare-range fakes for `verify` (HTTP comes from `CliServices.fetch`). */
  verify?: Omit<RunVerifyOptions, "fetch">;
  /** Streams for `mcp` instead of the process's stdin and stdout. */
  mcp?: { stdin?: Readable; stdout?: Writable };
  /** PATH lookup, Node version and time budget for `init`. */
  init?: InitServices;
  /** Engine, cloud provider, Cloudflare and GitHub fakes for `destroy`. */
  destroy?: DestroyServices;
  /** Engine, both providers, Cloudflare, GitHub, SSH, catalogue and wait fakes for `retarget`. */
  retarget?: RetargetServices;
  /** Cloudflare accounts, registrar, extension and zone fakes for `domain`. */
  domain?: DomainServices;
  /** Engine, Cloudflare, own-server and deploy-user shell fakes for `portainer`. */
  portainer?: PortainerServices;
}

const attached = new WeakMap<CliContext, DeployServices>();

/** Attaches deploy overrides to `ctx` (merged with earlier ones) and returns `ctx`. */
export function withDeployServices<T extends CliContext>(ctx: T, overrides: DeployServices): T {
  attached.set(ctx, { ...attached.get(ctx), ...overrides });
  return ctx;
}

/** The deploy overrides attached to `ctx` (empty for the real CLI). */
export function deployServicesOf(ctx: CliContext): DeployServices {
  return attached.get(ctx) ?? {};
}
