import { otherActiveApps, tunnelOf } from "@opscrew/connector-ssh-host";
import { listText, OpsCrewError } from "@opscrew/core";
import type { PlanService } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { InterviewAnswers } from "../interview";
import { splitFollowUps } from "../interview/follow-ups";
import {
  answersToOwnServer,
  buildServerQuestions,
  SERVER_FIELDS,
  type ServerQuestion,
} from "../interview/own-server";
import type { NetworkHostFacts } from "../network";
import type { OwnServerServices } from "../provision/types";
import { connectExtraServer, ownServerFacts, ownServerPublicAddress } from "../shared/own-server";
import { readServerAddresses, type SshLogin, updateServerAddresses } from "../shared/server-record";
import { distinctAmounts } from "./own";
import type { DesignedServer } from "./servers";
import { ownServerFreeDiskGb, ownServerMemory, smallServerWarnings } from "./sizing";

/** How design reaches the extra servers the user owns. */
export interface OwnServersOptions {
  /**
   * Asks for the address and SSH login of an extra server the user owns that this computer has
   * none for, once (the interview's server questions, `server.host`, `server.port`, `server.user`
   * and `server.key`, each naming the server). Without it such a server stops design.
   */
  askServerLogin?: (server: string, questions: ServerQuestion[]) => Promise<InterviewAnswers>;
  /** The servers' shells, the host adapter and the home folder for `~/` keys (fakes in tests). */
  extraServers?: Pick<OwnServerServices, "remote" | "homeDir" | "host">;
}

/** An extra server the user owns, as design read it. */
export interface DesignedOwnServer extends DesignedServer {
  /** What inspection found, for the network's free port. */
  facts: NetworkHostFacts;
}

/** The interview's questions that make a login. */
const LOGIN_QUESTIONS = new Set(["server.host", "server.port", "server.user", "server.key"]);

/** The login of `server` from `askServerLogin`, validated as the interview validates its answers. */
async function askedLogin(
  server: string,
  ask: NonNullable<OwnServersOptions["askServerLogin"]>,
): Promise<SshLogin> {
  const questions = buildServerQuestions()
    .filter((question) => LOGIN_QUESTIONS.has(question.id))
    .map((question) => ({ ...question, prompt: `Server ${server}: ${question.prompt}` }));
  const answers = answersToOwnServer(
    splitFollowUps(await ask(server, questions), "server", SERVER_FIELDS),
  );
  return {
    host: answers.host,
    port: answers.port,
    user: answers.user,
    ...(answers.keyPath === undefined ? {} : { keyPath: answers.keyPath }),
    agent: answers.agent,
  };
}

/**
 * An extra server the user owns, read as an own app server is: its address and SSH login come from
 * `.opscrew/server.json` (`ownServers`), else are asked for once; the first connection confirms and
 * pins its host key and records the login; inspection (read-only, through the host adapter) gives
 * its size, its architecture and the OpsCrew apps already there. Its memory must hold `services`
 * next to them, its smaller shortfalls are warnings, and its public address is recorded
 * (`servers`) for the private network.
 * @throws OpsCrewError `PHASE_PRECONDITION` when nobody can be asked for its login, when it has no
 * public address (`appPublic` false: the app's server has none either, so nothing can link them),
 * or when its memory cannot hold the services, each before plan.yaml changes.
 */
export async function designOwnServer(
  deps: PhaseDeps,
  input: { name: string; services: PlanService[]; app: string; appPublic: boolean },
  options: OwnServersOptions,
): Promise<DesignedOwnServer> {
  const { name, services } = input;
  const record = await readServerAddresses(deps.paths);
  let login = record.ownServers?.[name];
  if (login === undefined) {
    if (options.askServerLogin === undefined || !deps.interactive) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Server ${name} is your own, and OpsCrew does not know its address and SSH login on this computer. plan.yaml was not changed.`,
        {
          hint: "Run `opscrew design` in a terminal: it asks for the server's address and SSH login once and keeps them on this computer.",
        },
      );
    }
    login = await askedLogin(name, options.askServerLogin);
  }
  const { facts } = await connectExtraServer(deps, name, login, {
    services: options.extraServers,
    phase: "design",
  });
  const server = ownServerFacts(facts);
  const address = ownServerPublicAddress({ host: login.host }, facts);
  if (address === undefined) {
    const placed = listText(services.map((service) => service.name));
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      input.appPublic
        ? `Server ${name} has no public IPv4 address OpsCrew can find, so it cannot run ${placed}: the deploys and OpsCrew's commands reach an extra server at its public address. plan.yaml was not changed.`
        : `Neither the app's server nor server ${name} has a public IPv4 address OpsCrew can find, so the private network cannot link them: one of the two must be reachable. plan.yaml was not changed.`,
      {
        hint: `Place ${placed} on a cloud server (servers[].target.provider hetzner or digitalocean) or on the app's server (no services[].server), or give server ${name}'s public IPv4 address as its address: remove ownServers.${name} from .opscrew/server.json and run \`opscrew design\` again.`,
      },
    );
  }
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    servers: { ...current.servers, [name]: address },
  }));

  const serverMb = server.memoryGb * 1024;
  const others = otherActiveApps(facts.apps, input.app).map((app) => ({
    name: app.app,
    memoryMb: app.memoryMb,
    tunnel: tunnelOf(facts, app.app).installed,
  }));
  const servicesMb = services.reduce((sum, service) => sum + service.memoryMb, 0);
  const memory = ownServerMemory(serverMb, servicesMb, others, 0, name);
  if (memory?.refused !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", memory.refused.message, {
      hint: memory.refused.hint,
    });
  }
  const warnings = [
    ...smallServerWarnings(services, serverMb),
    ...(memory?.warning === undefined ? [] : [memory.warning]),
  ];
  const freeDisk = ownServerFreeDiskGb({ services });
  if (server.diskFreeGb < freeDisk) {
    const [has, needs] = distinctAmounts(server.diskFreeGb, freeDisk);
    warnings.push(
      `Server ${name} has ${has} GB of free disk, but OpsCrew plans at least ${needs} GB of free disk for ${listText(services.map((s) => s.name))}, their images and updates. Free up space or add disk before you deploy.`,
    );
  }
  return {
    server: { name, target: { provider: "own", mode: "vps-compose", arch: server.arch } },
    services,
    vcpus: server.vcpus,
    memoryGb: server.memoryGb,
    ...(server.os === undefined ? {} : { os: server.os }),
    facts,
    warnings,
  };
}
