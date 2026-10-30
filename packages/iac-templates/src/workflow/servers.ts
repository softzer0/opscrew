import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import { publishedOnNetwork } from "../runtime";
import { shellQuote } from "../runtime/services";

/**
 * The GitHub Actions secrets of the extra server `name` (`plan.servers[].name`), before
 * `deploySecretName`'s prefix: its public address and its known-hosts line(s), as
 * `OPSCREW_SERVER_<NAME>_HOST` and `OPSCREW_SERVER_<NAME>_KNOWN_HOSTS` (`-` as `_`).
 * `opscrew provision` sets them; the deploy reaches the server with the app's deploy key.
 */
export function serverDeploySecrets(name: string): { host: string; knownHosts: string } {
  const server = `OPSCREW_SERVER_${name.toUpperCase().replaceAll("-", "_")}`;
  return { host: `${server}_HOST`, knownHosts: `${server}_KNOWN_HOSTS` };
}

/** True when `network.publicSsh` is `false`: SSH answers only on the private network. */
export function publicSshClosed(plan: DeployPlan): boolean {
  return plan.network?.publicSsh === false;
}

/**
 * The published-port repair (research R5a) for `server`, as POSIX sh lines in the app's folder
 * there, after its services started: each port of a service published on the server's private
 * address ({@link publishedOnNetwork}) is checked with `docker compose port`; a service that came
 * up without it (Docker starts it so when the private network was not up yet) is recreated, which
 * publishes it again, and checked once more. Still missing, the script prints why and exits 1.
 * Nothing when no port is published there.
 */
export function portRepair(plan: DeployPlan, server: string): string[] {
  // Without options it lists no dashboards, which live in other Compose projects.
  const ports = publishedOnNetwork(plan, server);
  if (ports.length === 0) return [];
  const where = server === APP_SERVER ? "the app's server" : `the server ${server}`;
  return [
    'published() { [ "$(docker compose port "$1" "$2" 2> /dev/null)" = "$3" ]; }',
    ...ports.flatMap(({ service, port, address }) => {
      const binding = `${address}:${port}`;
      const recreated = `::warning::The ${service} service on ${where} was running without its port ${binding} on the private network (Docker starts it so when the network was not up yet), so OpsCrew recreated it.`;
      const failed = `::error::The ${service} service on ${where} is still not published on ${binding} after OpsCrew recreated it, so the deploy stopped before the app changed. Check that the private network is up on that server (opscrew status), then deploy again.`;
      return [
        `if ! published ${service} ${port} ${binding}; then`,
        `  echo ${shellQuote(recreated)}`,
        `  docker compose up -d --force-recreate --no-deps --wait ${service}`,
        `  if ! published ${service} ${port} ${binding}; then`,
        `    echo ${shellQuote(failed)}`,
        "    exit 1",
        "  fi",
        "fi",
      ];
    }),
  ];
}
