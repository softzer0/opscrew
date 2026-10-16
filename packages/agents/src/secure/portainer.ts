import {
  opscrewNames,
  type PortainerFacts,
  type PortainerStackFacts,
} from "@opscrew/connector-portainer";
import type { CheckResult, Severity } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { portainerTarget } from "@opscrew/iac-templates";
import type { DeployPlan, PortainerDeployTarget } from "@opscrew/plan-schema";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { PORTAINER_BACKUPS_NOTE, PORTAINER_HOST_NOTE } from "../design/portainer";
import { inspectRecordedPortainer, publishedPorts, recordedStack } from "../drift/portainer";
import { PORTAINER_TOKEN_VAR } from "../providers";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import type { PortainerServices } from "../provision/types";
import { type PortainerConnection, readPortainerConnection } from "../shared";
import { checkResult, editCheckText } from "../verify/checks";

/** Said in the report and the terminal for an app in the user's Portainer (FR-1015). */
export const PORTAINER_SECURE_NOTES = [PORTAINER_HOST_NOTE, PORTAINER_BACKUPS_NOTE] as const;

/** Why `opscrew secure` probes no port of the user's Portainer host. */
export const PORTAINER_PROBES_SKIPPED =
  "OpsCrew does not probe your Portainer host: it never changes the host and does not know its public address. `opscrew verify` checks the site from outside.";

const ROLE_LABEL = {
  app: "app stack",
  updater: "updater stack",
  "tunnel-connector": "Cloudflare connector stack",
} as const;

type Role = keyof typeof ROLE_LABEL;

/** The stacks the plan's redeploy mode needs. */
function rolesFor(target: PortainerDeployTarget): Role[] {
  return ["app", target.redeploy === "updater" ? "updater" : "tunnel-connector"];
}

/** Whether OpsCrew's stack of `role` is in Portainer, running, and as OpsCrew left it. */
function stackState(role: Role, name: string, stack: PortainerStackFacts | undefined): CheckResult {
  const id = `stack-${role}`;
  const title = `The ${ROLE_LABEL[role]} ${name} runs`;
  if (stack === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `Portainer has no ${ROLE_LABEL[role]} ${name} that OpsCrew created (it was removed, or this token cannot see it).`,
      {
        remediation:
          "Run `opscrew provision`: its stack plan creates it again (you approve it as usual).",
      },
    );
  }
  if (stack.status === 4) {
    const last = stack.deploymentStatus.at(-1)?.message;
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `Portainer reports the last deploy of ${name} failed${last === undefined ? "" : ` ("${last}")`}.`,
      {
        remediation:
          "Look at the stack's containers and logs in Portainer, fix the cause, then run `opscrew provision` (it redeploys the stack) or merge a fix.",
      },
    );
  }
  if (stack.status === 2) {
    return checkResult(id, title, "high", "fail", `Portainer reports ${name} as stopped.`, {
      remediation: "Run `opscrew provision`: its stack plan starts it again.",
    });
  }
  return checkResult(id, title, "high", "pass", `${name} is active in Portainer.`);
}

/** A Compose service as far as the checks read it. */
interface Service {
  security_opt?: unknown;
  privileged?: unknown;
  network_mode?: unknown;
  pid?: unknown;
  ipc?: unknown;
  cap_add?: unknown;
  volumes?: unknown;
  ports?: unknown;
  logging?: unknown;
}

/** The host port of a Compose `ports` entry (`undefined` when Docker picks one). */
function hostPort(entry: unknown): number | undefined {
  if (typeof entry === "number") return undefined;
  if (typeof entry === "string") {
    const parts = entry.split("/")[0]?.split(":") ?? [];
    if (parts.length < 2) return undefined;
    const port = Number(parts[parts.length - 2]);
    return Number.isInteger(port) ? port : undefined;
  }
  if (typeof entry === "object" && entry !== null) {
    const published = (entry as { published?: unknown }).published;
    const port = Number(published);
    return published !== undefined && Number.isInteger(port) ? port : undefined;
  }
  return undefined;
}

function mountsDockerSocket(volumes: unknown): boolean {
  if (!Array.isArray(volumes)) return false;
  return volumes.some((volume) => {
    const source =
      typeof volume === "string"
        ? volume.split(":")[0]
        : typeof volume === "object" && volume !== null
          ? (volume as { source?: unknown }).source
          : undefined;
    return typeof source === "string" && /(^|\/)docker\.sock$/.test(source);
  });
}

/**
 * The hardening of a stack file, service by service: every service runs with
 * `no-new-privileges`, none is privileged, shares the host's network, PID or IPC namespace, adds
 * capabilities or mounts the Docker socket, each rotates its logs, and the stack publishes only the
 * host ports the plan's web mode needs.
 */
function fileChecks(
  role: Role,
  name: string,
  file: string | undefined,
  allowedPorts: readonly number[],
): CheckResult[] {
  const id = `stack-${role}-file`;
  const title = `The ${ROLE_LABEL[role]} ${name} is hardened`;
  if (file === undefined) {
    return [
      checkResult(
        id,
        title,
        "medium",
        "skip",
        "Skipped: Portainer did not return the stack file to this token.",
      ),
    ];
  }
  let services: Record<string, Service>;
  try {
    const document = parse(file) as { services?: unknown } | null;
    const parsed = document?.services;
    if (typeof parsed !== "object" || parsed === null) throw new Error("no services");
    services = parsed as Record<string, Service>;
  } catch {
    return [
      checkResult(
        id,
        title,
        "medium",
        "fail",
        `OpsCrew cannot read the stack file of ${name} in Portainer as a Compose file.`,
        {
          remediation:
            "Run `opscrew drift` to see how it differs from what OpsCrew set up, then `opscrew provision` (or merge a change, for the app stack).",
        },
      ),
    ];
  }
  const problems: { severity: Severity; text: string }[] = [];
  const published: number[] = [];
  for (const [service, spec] of Object.entries(services).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof spec !== "object" || spec === null) continue;
    const options = Array.isArray(spec.security_opt) ? spec.security_opt.map(String) : [];
    if (!options.some((option) => /^no-new-privileges(:true)?$/.test(option))) {
      problems.push({ severity: "medium", text: `${service} runs without no-new-privileges` });
    }
    if (spec.privileged === true) {
      problems.push({ severity: "critical", text: `${service} runs privileged` });
    }
    for (const field of ["network_mode", "pid", "ipc"] as const) {
      if (spec[field] === "host") {
        problems.push({
          severity: "high",
          text: `${service} shares the host's ${field === "network_mode" ? "network" : field.toUpperCase()}`,
        });
      }
    }
    if (Array.isArray(spec.cap_add) && spec.cap_add.length > 0) {
      problems.push({
        severity: "medium",
        text: `${service} adds capabilities (${spec.cap_add.map(String).join(", ")})`,
      });
    }
    if (mountsDockerSocket(spec.volumes)) {
      problems.push({ severity: "critical", text: `${service} mounts the Docker socket` });
    }
    if (spec.logging === undefined) {
      problems.push({ severity: "low", text: `${service} does not rotate its logs` });
    }
    for (const entry of Array.isArray(spec.ports) ? spec.ports : []) {
      const port = hostPort(entry);
      if (port === undefined || !allowedPorts.includes(port)) {
        problems.push({
          severity: "high",
          text:
            port === undefined
              ? `${service} publishes a port Docker picks on the host`
              : `${service} publishes host port ${port}, which this setup does not use`,
        });
      } else {
        published.push(port);
      }
    }
  }
  const worst = (["critical", "high", "medium", "low"] as const).find((severity) =>
    problems.some((problem) => problem.severity === severity),
  );
  if (worst === undefined) {
    const ports = [...new Set(published)].sort((a, b) => a - b);
    return [
      checkResult(
        id,
        title,
        "medium",
        "pass",
        `Every service runs with no-new-privileges and rotated logs, none is privileged or reaches the Docker socket, and ${ports.length === 0 ? "the stack publishes no host port" : `the stack publishes only host port${ports.length === 1 ? "" : "s"} ${ports.join(", ")}`}.`,
      ),
    ];
  }
  return [
    checkResult(
      id,
      title,
      worst,
      worst === "low" ? "warn" : "fail",
      `${problems.map((problem) => problem.text).join("; ")}.`,
      {
        remediation:
          role === "app"
            ? "The deploy workflow writes the app stack's file from OpsCrew's template: run `opscrew drift` to see what changed on the opscrew-deploy branch, and merge a change (or re-run the deploy) to write it again."
            : "Run `opscrew drift` to see how it differs from what OpsCrew set up, then `opscrew provision` to put it back.",
      },
    ),
  ];
}

/** The app stack is redeployed only through its webhook, never by scheduled Git polling. */
function redeployCheck(stack: PortainerStackFacts | undefined): CheckResult | undefined {
  if (stack === undefined) return undefined;
  const auto = stack.autoUpdate;
  const id = "stack-app-redeploy";
  const title = "The app stack redeploys only through its webhook";
  if (auto?.webhook === true && auto.interval === undefined && !auto.forcePullImage) {
    return checkResult(
      id,
      title,
      "medium",
      "pass",
      "Portainer redeploys the app stack only when its webhook is called (no scheduled polling).",
    );
  }
  return checkResult(
    id,
    title,
    "medium",
    "warn",
    auto?.webhook !== true
      ? "The app stack has no webhook, so merged changes do not reach Portainer."
      : "Portainer's redeploy settings of the app stack were changed (scheduled polling or forced image pulls).",
    { remediation: "Run `opscrew provision`: its stack plan puts the webhook back." },
  );
}

/** OpsCrew's registry entry, when it added one, is still usable on the environment. */
function registryCheck(
  facts: PortainerFacts,
  connection: PortainerConnection,
  environmentId: number,
): CheckResult | undefined {
  const id = connection.created.registryId;
  if (id === undefined || facts.registryEntries === undefined) return undefined;
  const entry = facts.registryEntries.find((item) => item.id === id);
  const title = "OpsCrew's registry entry lets Portainer pull the private image";
  if (entry === undefined) {
    return checkResult(
      "registry-entry",
      title,
      "high",
      "fail",
      "Portainer no longer has the registry entry OpsCrew added, so it cannot pull the app's private image.",
      { remediation: "Run `opscrew provision`: its stack plan adds it again." },
    );
  }
  return entry.environments.includes(environmentId)
    ? checkResult(
        "registry-entry",
        title,
        "high",
        "pass",
        `${entry.name} is usable on the environment.`,
      )
    : checkResult(
        "registry-entry",
        title,
        "high",
        "fail",
        `${entry.name} is no longer granted on the environment, so Portainer cannot pull the app's private image.`,
        { remediation: "Run `opscrew provision`: its stack plan grants it again." },
      );
}

/**
 * `opscrew secure` for the user's Portainer (FR-1015): read-only checks of how OpsCrew reaches
 * Portainer (HTTPS with the confirmed certificate), of Portainer itself as far as the app needs it,
 * and of the app and its stacks: that they run, are hardened (no-new-privileges, no privileged
 * service, no host namespaces or Docker socket, rotated logs, only the host ports the web mode
 * needs), redeploy only through the webhook, and can pull the private image. The host itself is
 * the user's: OpsCrew checks and changes nothing there. No address, token or value is returned.
 */
export async function portainerSecurityChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<PortainerServices, "client"> = {},
): Promise<{ checks: CheckResult[]; skipped?: string }> {
  const target = portainerTarget(plan.target);
  // Without the connection or the token there is nothing to ask Portainer: the checks are skipped
  // with the reason, and the rest of the report is written as usual.
  if ((await readPortainerConnection(deps.paths)) === undefined) {
    return {
      checks: [],
      skipped:
        "OpsCrew does not know how to reach your Portainer on this computer. Run `opscrew secure` on the computer that ran `opscrew provision` (its `.opscrew/server.json` holds Portainer's address and confirmed certificate).",
    };
  }
  if (!deps.env[PORTAINER_TOKEN_VAR]?.trim()) {
    return {
      checks: [],
      skipped: `${PORTAINER_TOKEN_VAR} is not set, so OpsCrew cannot read the app's stacks from your Portainer. Set it to your Portainer access token and run \`opscrew secure\` again.`,
    };
  }
  let connection: PortainerConnection;
  try {
    connection = await requirePortainerConnection(deps, plan);
  } catch (error) {
    if (!(error instanceof OpsCrewError) || error.code !== "PHASE_PRECONDITION") throw error;
    return {
      checks: [],
      skipped: deps.redactor.redact(`${error.message}${error.hint ? ` ${error.hint}` : ""}`),
    };
  }
  const { client, facts } = await inspectRecordedPortainer(deps, {
    plan,
    target,
    connection,
    token: requirePortainerToken(deps),
    client: services.client,
    step: "Checking the app's stacks in your Portainer (read-only)",
    phase: "secure",
    detail: "secure",
  });
  const redacted = (item: CheckResult) => editCheckText(item, deps.redactor.redact);
  const checks: CheckResult[] = [
    checkResult(
      "portainer-connection",
      "OpsCrew reaches Portainer only with its confirmed certificate",
      "high",
      "pass",
      client.pinned
        ? "OpsCrew talks to Portainer over HTTPS and checks the certificate you confirmed on every connection."
        : "Portainer runs on this computer, so OpsCrew talks to it over plain HTTP that never leaves the computer.",
    ),
  ];
  if (facts.findings.length > 0) {
    for (const [index, finding] of facts.findings.entries()) {
      checks.push(
        checkResult(
          `portainer-${finding.code}${index === 0 ? "" : `-${index}`}`,
          "Portainer can run the app as OpsCrew set it up",
          "high",
          "fail",
          finding.message,
          { remediation: finding.hint },
        ),
      );
    }
    return { checks: checks.map(redacted) };
  }
  const names = opscrewNames(plan.app.name);
  for (const role of rolesFor(target)) {
    const name =
      role === "app" ? names.app : role === "updater" ? names.updater : names.tunnelConnector;
    const stack = recordedStack(connection, facts, role);
    checks.push(stackState(role, name, stack));
    if (stack !== undefined) {
      checks.push(
        ...fileChecks(role, name, stack.file, role === "app" ? publishedPorts(target) : []),
      );
    }
  }
  const redeploy = redeployCheck(recordedStack(connection, facts, "app"));
  if (redeploy !== undefined) checks.push(redeploy);
  const registry = registryCheck(facts, connection, target.environmentId);
  if (registry !== undefined) checks.push(registry);
  return { checks: checks.map(redacted) };
}
