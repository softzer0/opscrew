import type { CheckResult, CommandResult } from "@opscrew/contracts";
import { listText } from "@opscrew/core";
import type { HostCheck } from "./checks";

/** One of the app's backing services, as its checks on the server need it (from the catalog). */
export interface ServiceCheckInput {
  /** Its Compose service in the app's project, for example `db`. */
  name: string;
  /** Its kind in words, for example `MySQL`. */
  title: string;
  /** The variables of its environment that hold its login; empty for an `internal-only` one. */
  login: readonly string[];
}

/** Docker's filter for the service's containers in the app's Compose project. */
function filter(project: string, service: string): string {
  return `--filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=${service}`;
}

function result(
  check: Pick<HostCheck, "id" | "title" | "severity">,
  status: CheckResult["status"],
  message: string,
  remediation?: string,
): CheckResult {
  return {
    id: check.id,
    title: check.title,
    severity: check.severity,
    status,
    message,
    ...(remediation !== undefined ? { remediation } : {}),
  };
}

/** No port of the service is published on the host (FR-1328). */
function portCheck(project: string, service: ServiceCheckInput): HostCheck {
  const who = `${service.title} (${service.name})`;
  return {
    id: `service-${service.name}-port`,
    title: `${who} is reachable only inside the server`,
    severity: "critical",
    command: `docker ps -a ${filter(project, service.name)} --format '{{.Ports}}'`,
    evaluate(output: CommandResult) {
      if (output.exitCode !== 0) {
        return result(this, "warn", `Could not list the containers of ${who}.`);
      }
      const ports = output.stdout.trim();
      if (ports === "") {
        return result(
          this,
          "warn",
          `${who} has no container on the server yet; the deploy workflow starts it.`,
        );
      }
      // A port published on the server's loopback only is reachable from the server alone.
      const published = ports
        .split(/\r?\n|,\s*/)
        .filter((port) => port.includes("->") && !/^(?:127\.0\.0\.1|\[::1\]):/.test(port))
        .join(", ");
      return published === ""
        ? result(this, "pass", `${who} publishes no port; only the app's containers reach it.`)
        : result(
            this,
            "fail",
            `${who} publishes ${published}, so it can be reached from outside the server.`,
            "Remove its `ports` from opscrew/runtime/compose.yaml (OpsCrew renders none: run `opscrew provision` to write OpsCrew's version), then deploy again. The app reaches the service over the app's internal network.",
          );
    },
  };
}

/**
 * The service's login is set: each of its login variables is in its container's environment with
 * a value. Only the names of the variables that are set come back from the server, never a value.
 */
function loginCheck(project: string, service: ServiceCheckInput): HostCheck {
  const who = `${service.title} (${service.name})`;
  const names = service.login.join("|");
  return {
    id: `service-${service.name}-login`,
    title: `${who} requires its login`,
    severity: "high",
    command: `id=$(docker ps -aq ${filter(project, service.name)} | head -n 1) && [ -n "$id" ] && docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" | sed -n -E 's/^(${names})=.+$/\\1/p'`,
    evaluate(output: CommandResult) {
      if (output.exitCode !== 0) {
        return result(this, "warn", `Could not read the settings of ${who}'s container.`);
      }
      const set = new Set(output.stdout.split(/\r?\n/).map((line) => line.trim()));
      const missing = service.login.filter((name) => !set.has(name));
      return missing.length === 0
        ? result(
            this,
            "pass",
            `${who} requires its login: ${listText([...service.login])} ${service.login.length === 1 ? "is" : "are"} set.`,
          )
        : result(
            this,
            "fail",
            `${who} runs without ${listText(missing)}, so its login is not set.`,
            "Run `opscrew provision` again: it stores the service's settings with its generated login in GitHub Actions, and the next deploy gives them to the service.",
          );
    },
  };
}

/**
 * The checks of the app's backing services on the server (FR-1328), run as `deploy` with
 * `runHostChecks`: for each, that no port is published on the host, and for each with a login
 * (`auth` other than `internal-only`) that its login is set. `project` is the app's Compose
 * project, its name.
 */
export function serviceHostChecks(
  project: string,
  services: readonly ServiceCheckInput[],
): HostCheck[] {
  return services.flatMap((service) => [
    portCheck(project, service),
    ...(service.login.length > 0 ? [loginCheck(project, service)] : []),
  ]);
}
