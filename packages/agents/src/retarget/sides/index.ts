import type { ProjectPaths } from "@opscrew/core";
import { OpsCrewError } from "@opscrew/core";
import type { DeployTarget } from "@opscrew/plan-schema";
import {
  readPortainerConnection,
  readServerAddresses,
  recordPortainerConnection,
  updateServerAddresses,
} from "../../shared";
import type { MoveServer } from "../removal";
import { type MoveSession, moveOf } from "../session";
import { providerWords } from "../texts";
import { type CloudSideOptions, cloudSide } from "./cloud";
import { ownSide } from "./own";
import { type PortainerRecord, type PortainerSideInput, portainerSide } from "./portainer";
import type { MoveSide } from "./types";

/**
 * What {@link moveSide} gives the side it picks, beyond `session.services` (the own side's `own`
 * and `runnerGitHub`, the Portainer side's `portainer`). Each side uses only its own.
 */
export interface MoveSideOptions extends CloudSideOptions {
  /** Portainer: the image the old side runs, which the new side deploys at step `deployed`. */
  image?: PortainerSideInput["image"];
  /** Portainer: the app's image is public (`--public-image`), when the record doesn't say. */
  publicImage?: boolean;
}

/** The target of a side: `plan.target` for the new one, the move's `from.target` for the old one. */
export function sideTarget(session: Pick<MoveSession, "plan">, which: MoveServer) {
  return which === "new" ? session.plan.target : moveOf(session).from.target;
}

/**
 * The side `which` of the session's move, by its target's kind: a server OpsCrew created
 * (`cloudSide`), the user's own server (`ownSide`), or the user's Portainer (`portainerSide`, with
 * its record: `portainer` for the new side, `retarget.fromPortainer` for the old one).
 */
export function moveSide(
  session: MoveSession,
  which: MoveServer,
  options: MoveSideOptions = {},
): MoveSide {
  const { services } = session;
  const target = sideTarget(session, which);
  switch (target.provider) {
    case "hetzner":
    case "digitalocean":
      return cloudSide(which, options.snapshot !== undefined ? { snapshot: options.snapshot } : {});
    case "own":
      return ownSide(which, {
        ...(services.own !== undefined ? { own: services.own } : {}),
        ...(services.runnerGitHub !== undefined ? { runnerGitHub: services.runnerGitHub } : {}),
      });
    case "portainer":
      return portainerSide({
        which,
        record: portainerRecord(session.deps.paths, which),
        image: options.image ?? unknownImage,
        ...(options.publicImage !== undefined ? { publicImage: options.publicImage } : {}),
        ...(services.portainer !== undefined ? { services: services.portainer } : {}),
      });
    default:
      throw new OpsCrewError(
        "INTERNAL",
        `A move's ${which} side must be a server or Portainer, not ${target.provider}.`,
        { hint: "This is a bug in OpsCrew; please report it." },
      );
  }
}

/** Only the new side's step `deployed` asks for the image; without one it is a bug. */
async function unknownImage(): Promise<string> {
  throw new OpsCrewError("INTERNAL", "The image the old side runs was not given to the move.", {
    hint: "This is a bug in OpsCrew; please report it.",
  });
}

/** Where a Portainer side's connection is: `portainer` (new side), `retarget.fromPortainer` (old). */
function portainerRecord(paths: ProjectPaths, which: MoveServer): PortainerRecord {
  if (which === "new") {
    return {
      read: () => readPortainerConnection(paths),
      write: (connection) => recordPortainerConnection(paths, connection),
    };
  }
  return {
    read: async () => (await readServerAddresses(paths)).retarget?.fromPortainer,
    write: async (connection) => {
      await updateServerAddresses(paths, (current) => ({
        ...current,
        retarget: { ...current.retarget, fromPortainer: connection },
      }));
    },
  };
}

/** The VPS providers whose tokens a move needs: those of its sides that are cloud servers. */
export function cloudProviders(session: Pick<MoveSession, "plan">) {
  return (["old", "new"] as const).flatMap((which) => {
    const { provider } = sideTarget(session, which);
    return provider === "hetzner" || provider === "digitalocean" ? [provider] : [];
  });
}

/**
 * Where a side runs the app, in words: the provider's name (`Hetzner Cloud`) for a cloud server,
 * `your own server`, or `your Portainer`.
 */
export function placeWords(target: Pick<DeployTarget, "provider">): string {
  const { provider } = target;
  if (provider === "hetzner" || provider === "digitalocean") return providerWords(provider).name;
  return provider === "own" ? "your own server" : "your Portainer";
}

/**
 * A side in words, for messages (never its address): `the old server on Hetzner Cloud`, `your old
 * server` for one the user owns, `your Portainer`.
 */
export function sideWords(target: Pick<DeployTarget, "provider">, which: MoveServer): string {
  const { provider } = target;
  if (provider === "hetzner" || provider === "digitalocean") {
    const words = providerWords(provider);
    return `the ${which} ${words.noun} on ${words.name}`;
  }
  return provider === "own" ? `your ${which} server` : "your Portainer";
}
