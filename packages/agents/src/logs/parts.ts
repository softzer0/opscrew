/**
 * The parts of the app whose lines `logs` reads, by the name `--service` takes, each with its
 * containers' Compose project and service.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import {
  EDGE_PROJECT,
  EDGE_PROXIES,
  edgeProxy,
  localComposeProject,
  portainerStackName,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import { componentServer, plannedComponents } from "../status/components";
import type { ContainersOf } from "./targets";

/** A part of the app whose lines `logs` reads: the name it shows, what it is, its containers. */
export interface LogPart extends ContainersOf {
  service: string;
  what: string;
  /** The server that runs it: `app`, or an extra server for a service placed there. */
  server: string;
  /** Said in the first line, after how far back the lines go. */
  note?: string;
}

/**
 * The parts of the plan `logs` reads, by the name `--service` takes: the web process (`app`), each
 * enabled worker, cron job and service, the cron jobs' shared container (`cron`), and the edge.
 */
export function logParts(plan: DeployPlan): LogPart[] {
  const { provider } = plan.target;
  const project =
    provider === "portainer"
      ? portainerStackName(plan)
      : provider === "localhost"
        ? localComposeProject(plan)
        : plan.app.name;
  const components = plannedComponents(plan).map((component) => ({
    service: component.service,
    what: `${component.what} (${component.service})`,
    server: componentServer(plan, component.service),
    project,
    composeService: component.service,
  }));
  const cronJobs = plan.processes.cron
    .filter((job) => job.enabled)
    .map((job) => ({
      service: job.name,
      what: `the cron job ${job.name}`,
      server: APP_SERVER,
      project,
      composeService: "cron",
      note: "The cron jobs run in one container (cron), so these are the lines of every cron job.",
    }));
  if (plan.target.provider === "portainer") {
    // Only web mode `caddy` puts a Caddy in the app's stack.
    if (plan.target.web.mode !== "caddy") return [...components, ...cronJobs];
    const caddy: LogPart = {
      service: "edge",
      what: "the edge (Caddy in the app's stack)",
      server: APP_SERVER,
      project,
      composeService: "caddy",
      note: "The edge is the Caddy in the app's stack, in front of the app.",
    };
    return [...components, ...cronJobs, caddy];
  }
  const proxy = EDGE_PROXIES[edgeProxy(plan)].label;
  const edge: LogPart = {
    service: "edge",
    what: `the edge (${proxy})`,
    server: APP_SERVER,
    project: EDGE_PROJECT,
    composeService: edgeProxy(plan),
    note:
      provider === "localhost"
        ? `The edge is this computer's shared proxy (${proxy}), in front of every OpsCrew app here, so its lines are of all of them.`
        : `The edge is the server's shared proxy (${proxy}), in front of every OpsCrew app on the server, so its lines are of all of them.`,
  };
  return [...components, ...cronJobs, edge];
}

/**
 * The part `name` names.
 * @throws OpsCrewError `INVALID_INPUT` for a name the plan has no part of, with the names it has.
 */
export function logPart(plan: DeployPlan, name: string): LogPart {
  const parts = logParts(plan);
  const part = parts.find((candidate) => candidate.service === name);
  if (part !== undefined) return part;
  const none =
    name === "edge" && plan.target.provider === "portainer"
      ? `The app's stack in your Portainer has no Caddy (its web mode is ${plan.target.web.mode}), so it has no edge lines.`
      : `The app has no part named "${name}".`;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${none} --service takes ${listText(parts.map((p) => p.service))}.`,
    { hint: "Without --service, `opscrew logs` shows the web process's lines (app)." },
  );
}
