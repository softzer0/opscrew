import type { FirewallApi, WantedFirewall, WantedFirewallOutput } from "@opscrew/contracts";
import type { CloudProvider } from "@opscrew/plan-schema";

/**
 * The firewall the server `server` (id `serverId`) at `provider` wants, as the root's
 * `wanted_firewalls` output lists it (ADR 0029, D8): SSH from anywhere.
 */
export function fakeWantedFirewall(provider: CloudProvider, serverId: string, server = "shop") {
  return {
    provider,
    firewall: {
      name: `${server}-firewall`,
      description: `OpsCrew's firewall of ${server}.`,
      server_ids: [serverId],
      rules: [{ protocol: "tcp" as const, ports: ["22"], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] }],
    },
  };
}

/**
 * A provider's firewalls as its connector applies them (ADR 0029, D8): every call is recorded in
 * `calls` (`sync <name>`, `differences <name>`, `remove <name>`) and told to `onCall`, a sync
 * makes the firewall the wanted one and says what it changed, and `syncError`/`removeError` make
 * those calls fail.
 */
export class FakeFirewalls implements FirewallApi {
  readonly calls: string[] = [];
  /** The firewalls there are, by name, as the last sync left them. */
  readonly firewalls = new Map<string, WantedFirewall>();
  syncError: Error | undefined;
  removeError: Error | undefined;

  constructor(
    /** Hears of each call, e.g. to keep it in order with a test's other events. */
    readonly onCall: (entry: string) => void = () => undefined,
  ) {}

  /** Leaves the firewall of a `wanted_firewalls` entry here, as an earlier sync did. */
  seed({ firewall }: { firewall: WantedFirewallOutput }): void {
    this.firewalls.set(firewall.name, {
      name: firewall.name,
      description: firewall.description,
      serverIds: firewall.server_ids,
      rules: firewall.rules,
    });
  }

  #call(entry: string): void {
    this.calls.push(entry);
    this.onCall(entry);
  }

  async sync(wanted: WantedFirewall): Promise<string[]> {
    this.#call(`sync ${wanted.name}`);
    if (this.syncError !== undefined) throw this.syncError;
    const before = this.firewalls.get(wanted.name);
    this.firewalls.set(wanted.name, wanted);
    if (before === undefined) {
      return [`Created Contabo's firewall ${wanted.name} with ${wanted.rules.length} rules.`];
    }
    return wanted.serverIds
      .filter((id) => !before.serverIds.includes(id))
      .map((id) => `Added server ${id} to Contabo's firewall ${wanted.name}.`);
  }

  async differences(wanted: WantedFirewall): Promise<string[]> {
    this.#call(`differences ${wanted.name}`);
    return this.firewalls.has(wanted.name) ? [] : [`Contabo has no firewall named ${wanted.name}.`];
  }

  async remove(name: string): Promise<boolean> {
    this.#call(`remove ${name}`);
    if (this.removeError !== undefined) throw this.removeError;
    return this.firewalls.delete(name);
  }
}
