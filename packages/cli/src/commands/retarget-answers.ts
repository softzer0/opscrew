import { isIPv4, isIPv6 } from "node:net";
import path from "node:path";
import {
  answersToOwnServer,
  buildServerQuestions,
  type EmptyQuestion,
  type InterviewAnswers,
  type PhaseDeps,
  PORTAINER_FIELDS,
  placeWords,
  portainerAnswers,
  type RetargetOptions,
  readPortainerConnection,
  SERVER_FIELDS,
  type ServerAddress,
  sizeText,
  splitFollowUps,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan, DeployProvider } from "@opscrew/plan-schema";
import type { CliContext } from "../context";
import { promptsOf } from "../deps";
import { portainerInterviewOptions } from "../ui/portainer";
import { cancelled } from "../ui/prompts";
import { askQuestions } from "../ui/questions";
import { readAnswersFile } from "./interview";

/** What a cancelled question of a move stops, and the command to run again. */
const CANCEL = { what: "the move", rerun: "opscrew retarget" };

/**
 * `--portainer-address <ipv4[,ipv6]>`: the public address of the Portainer host, checked before
 * anything runs. Throws a user-facing error for anything else.
 */
export function parsePortainerAddress(value: string): ServerAddress {
  const [ipv4 = "", ipv6, ...rest] = value.split(",").map((part) => part.trim());
  if (!isIPv4(ipv4) || (ipv6 !== undefined && !isIPv6(ipv6)) || rest.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--portainer-address expects your Portainer host's public IPv4 address, optionally followed by a comma and its IPv6 address.",
      { hint: "For example --portainer-address 203.0.113.10 or 203.0.113.10,2001:db8::10." },
    );
  }
  return { ipv4, ...(ipv6 === undefined ? {} : { ipv6 }) };
}

/** The flags {@link newSideAnswers} reads. */
export interface NewSideFlags {
  answers?: string;
  /** `--portainer-address`, already parsed ({@link parsePortainerAddress}). */
  portainerAddress?: ServerAddress;
  /** `--portainer-cert`, already checked (`checkPortainerCert`). */
  portainerCert?: string;
}

/**
 * The new side's answers for a move to the user's own server or Portainer, as `opscrew interview`
 * takes them: from `--answers <file>` (`server.*` or `portainer.*`), else asked in a terminal;
 * in a script without them nothing is given, and the move stops saying what it needs. For
 * Portainer its certificate is confirmed and its environments listed, and its host's public
 * address comes from `--portainer-address` or a question. Nothing for a cloud provider.
 */
export async function newSideAnswers(
  ctx: CliContext,
  deps: PhaseDeps,
  input: { to: DeployProvider | undefined; plan: DeployPlan; flags: NewSideFlags },
): Promise<Pick<RetargetOptions, "ownServer" | "portainer" | "portainerAddress">> {
  const { to, plan, flags } = input;
  if (to !== "own" && to !== "portainer") return {};
  const given: InterviewAnswers | undefined =
    flags.answers === undefined
      ? undefined
      : await readAnswersFile(path.resolve(ctx.cwd, flags.answers));
  const prompts = promptsOf(ctx);
  const ask =
    given === undefined && ctx.isInteractive
      ? (questions: Parameters<typeof askQuestions>[0]) =>
          askQuestions(questions, { prompts, cancel: CANCEL })
      : undefined;
  // How the app is served now: its domain, and whether its DNS is on Cloudflare.
  const domain = plan.dns.domain;
  const context = {
    cloudflareDomain: plan.dns.provider === "cloudflare" && domain !== undefined,
    ...(domain === undefined ? {} : { domain }),
  };
  if (to === "own") {
    if (given === undefined && ask === undefined) return {};
    const answers = given ?? (await ask?.(buildServerQuestions(context))) ?? {};
    return {
      ownServer: answersToOwnServer(splitFollowUps(answers, "server", SERVER_FIELDS), context),
    };
  }
  const address = flags.portainerAddress ?? (await askPortainerAddress(ctx));
  if (given === undefined && ask === undefined) {
    return address === undefined ? {} : { portainerAddress: address };
  }
  const previous = await readPortainerConnection(deps.paths);
  const portainer = await portainerAnswers(
    deps,
    {
      ...(ask === undefined ? {} : { askPortainer: ask }),
      portainer: portainerInterviewOptions(ctx, prompts, flags.portainerCert),
    },
    splitFollowUps(given ?? {}, "portainer", PORTAINER_FIELDS),
    { ...context, ...(previous === undefined ? {} : { previous }) },
  );
  return { portainer, ...(address === undefined ? {} : { portainerAddress: address }) };
}

/** Asks for the Portainer host's public address in a terminal; nothing in a script. */
async function askPortainerAddress(ctx: CliContext): Promise<ServerAddress | undefined> {
  if (!ctx.isInteractive) return undefined;
  const prompts = promptsOf(ctx);
  const answer = await prompts.text({
    message:
      "What is the public address of your Portainer host? Its Caddy serves the app there, and the app's DNS records will point to it. Give its IPv4 address, optionally followed by a comma and its IPv6 address.",
    validate: (value) => {
      try {
        parsePortainerAddress(value ?? "");
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    },
  });
  if (prompts.isCancel(answer)) throw cancelled(CANCEL.what, CANCEL.rerun);
  return parsePortainerAddress(answer);
}

/**
 * The terminal question for each owner of data on the old side: copy it to the new side (the
 * default) or start it empty there, with its size and what starting empty loses.
 */
export function chooseEmptyInTerminal(
  ctx: CliContext,
  to: Pick<DeployPlan["target"], "provider">,
): (question: EmptyQuestion) => Promise<boolean> {
  const prompts = promptsOf(ctx);
  return async ({ owner, bytes, loses }) => {
    const answer = await prompts.confirm({
      message: `Copy ${owner === "app" ? "the app's own files" : `${owner}'s data`} (${sizeText(bytes)}) to ${placeWords(to)}? ${loses}`,
      initialValue: true,
    });
    if (prompts.isCancel(answer)) throw cancelled(CANCEL.what, CANCEL.rerun);
    return answer === true;
  };
}
