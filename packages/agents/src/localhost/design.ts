/**
 * Design for the localhost target (data-model.md "Localhost target"): the computer's CPU, the
 * ports the edge listens on, where the image comes from, and the single design option, with no
 * server, price or DNS.
 */
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  type DesignOption,
  DesignOptionSchema,
  type ImageBuilder,
  type LocalhostDeployTarget,
  type ProjectFacts,
  type Requirements,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { noServerCost } from "../design/own";
import { containersText, sizeFor } from "../design/sizing";
import { providerProfile } from "../providers";
import { buildsLocally, imageSource } from "./image";
import { computer, computerArch, type LocalhostServices } from "./services";
import { edgePorts } from "./stack";

/** Id of the only design option on this computer. */
const LOCALHOST_OPTION_ID = "localhost";

/** What design reads from this computer: its CPU and the ports the edge listens on. */
export interface LocalhostDesignChoice {
  arch: LocalhostDeployTarget["arch"];
  ports: LocalhostDeployTarget["ports"];
  /**
   * The environment this one takes its image from and the CPU its images are built for, when it
   * runs elsewhere (`imageSource`); `undefined` when every image comes from this computer.
   */
  source?: { environment: string; arch: "amd64" | "arm64" };
  /** The previous plan's image source on the same CPU, kept (the user may have chosen it). */
  image?: LocalhostDeployTarget["image"];
}

/**
 * The requirements as they apply to this computer: no region, domain or DNS (the app is served at
 * its `.localhost` address), whatever prod's answers say.
 */
export function onThisComputer(requirements: Requirements): Requirements {
  const { region: _region, domain: _domain, ...rest } = requirements;
  return { ...rest, dnsProvider: "none" };
}

/**
 * The ports the edge listens on: those of OpsCrew's edge already on this computer (every app there
 * shares it), else the previous plan's, else 443 and 80 when free and 8443 and 8080 otherwise.
 */
async function edgePortsFor(
  deps: Pick<PhaseDeps, "paths">,
  previous: DeployPlan | undefined,
  portFree: (port: number) => Promise<boolean>,
): Promise<LocalhostDeployTarget["ports"]> {
  const serving = await edgePorts(deps.paths);
  if (serving !== undefined) return serving;
  if (previous?.target.provider === "localhost") return previous.target.ports;
  return {
    https: (await portFree(443)) ? 443 : 8443,
    http: (await portFree(80)) ? 80 : 8080,
  };
}

/**
 * What design takes from this computer for the environment `deps.paths` belong to (its deploy
 * source in `environment`): the CPU (`services.arch`), the ports (probed with `services.portFree`)
 * and the CPU of the images it would otherwise run.
 * @throws OpsCrewError `PHASE_PRECONDITION` on a CPU Docker runs no Linux images for.
 */
export async function localhostDesignChoice(
  deps: Pick<PhaseDeps, "paths" | "env">,
  input: { previous: DeployPlan | undefined; environment: Pick<DeployPlan, "environment"> },
  services: Pick<LocalhostServices, "arch" | "portFree"> = {},
): Promise<LocalhostDesignChoice> {
  const local = computer(deps, services);
  const arch = computerArch(local.arch);
  if (arch === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer's CPU (${local.arch}) runs none of the Linux images Docker builds (amd64, arm64), so the app cannot run on it. Nothing was written.`,
      {
        hint: "Choose a server as the target with `opscrew interview`, then run `opscrew design` again.",
      },
    );
  }
  const source = await imageSource(deps.paths, input.environment);
  const before = input.previous?.target;
  return {
    arch,
    ports: await edgePortsFor(deps, input.previous, local.portFree),
    ...(source !== undefined ? { source } : {}),
    ...(before?.provider === "localhost" && before.arch === arch ? { image: before.image } : {}),
  };
}

/**
 * The plan's localhost target (data-model.md's `image` rule): `registry` when the image another
 * environment runs is built for this computer's CPU; else `local-build` when this computer builds
 * the image as GitHub Actions does, and `registry` under emulation otherwise. With no image built
 * elsewhere, `local-build` whenever this computer can build it. The previous plan's choice on the
 * same CPU stays, unless this computer can no longer build the image.
 */
export function localhostTarget(
  choice: LocalhostDesignChoice,
  app: { builder: ImageBuilder | undefined; cron: boolean; sqlite: boolean },
): LocalhostDeployTarget {
  const matches = choice.source !== undefined && choice.source.arch === choice.arch;
  const builds = buildsLocally(app);
  const image =
    choice.image === "registry" || (choice.image === "local-build" && builds)
      ? choice.image
      : matches || !builds
        ? "registry"
        : "local-build";
  return {
    provider: "localhost",
    mode: "local-compose",
    arch: choice.arch,
    ports: choice.ports,
    image,
    edge: "caddy",
  };
}

/** Why the localhost target has no price. */
export const LOCALHOST_PRICE_NOTE = "No server price: it runs in this computer's Docker.";

/**
 * The design warnings of the localhost target's image, said once: that it differs from the
 * source environment's (production's, or the environment it is promoted from) on another CPU, or
 * that nothing builds one.
 */
export function localhostImageWarnings(
  target: LocalhostDeployTarget,
  choice: LocalhostDesignChoice,
): string[] {
  const { source } = choice;
  if (source === undefined) {
    return target.image === "local-build"
      ? []
      : [
          "No other environment builds the app's image, and this computer cannot build it as GitHub Actions does: `opscrew provision` needs an image of the app on GitHub Container Registry, labelled by the environment that runs it.",
        ];
  }
  if (source.arch === choice.arch) return [];
  const theirs =
    source.environment === "prod" ? "production's" : `the ${source.environment} environment's`;
  return target.image === "local-build"
    ? [
        `This computer runs ${choice.arch} and ${theirs} image is built for ${source.arch}, so OpsCrew builds the app's image on this computer: it differs from ${theirs} image. To run ${theirs} image under emulation instead, set target.image to registry in the plan.`,
      ]
    : [
        `This computer runs ${choice.arch} and ${theirs} image is built for ${source.arch}, so Docker runs it under emulation, which is slower.`,
      ];
}

/**
 * The single design option on this computer: the app and what runs next to it in its Docker, as
 * in production, at its `.localhost` address on 127.0.0.1 only, with no price. Validated with
 * `DesignOptionSchema`.
 */
export function buildLocalhostOption(input: {
  facts: ProjectFacts;
  requirements: Requirements;
  arch: LocalhostDeployTarget["arch"];
  now: Date;
}): DesignOption {
  const { facts, requirements } = input;
  const sizing = sizeFor(facts, requirements);
  return DesignOptionSchema.parse({
    id: LOCALHOST_OPTION_ID,
    title: providerProfile("localhost").displayName,
    summary: `This computer's Docker, running ${containersText(sizing)} with production's memory limits and proxy, at a .localhost address on 127.0.0.1 only. ${LOCALHOST_PRICE_NOTE}`,
    target: {
      provider: "localhost",
      location: "this computer",
      serverType: "this computer's Docker",
      vcpus: 1,
      memoryGb: 0.01,
      diskGb: 0.01,
      cpuType: "shared",
      architecture: input.arch === "arm64" ? "arm" : "x86",
    },
    services: [...sizing.services],
    externalServices: [...sizing.externalServices],
    backups: false,
    cost: noServerCost(
      providerProfile("localhost").displayName,
      requirements.budgetMonthly.currency,
      input.now.toISOString(),
    ),
    fitsBudget: true,
    recommended: true,
    tradeoffs: [
      "Only this computer reaches it: the ports are bound to 127.0.0.1, and its certificate comes from OpsCrew's local CA (trusting it is your choice: `opscrew localhost trust`).",
      "It runs while this computer and Docker do: not meant to serve anyone else.",
      "OpsCrew does not back up its data volumes.",
    ],
  });
}
