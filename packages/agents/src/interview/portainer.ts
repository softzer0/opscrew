import { normalizeCertFingerprint, sameCertFingerprint } from "@opscrew/connector-portainer";
import { OpsCrewError, type ProjectPaths } from "@opscrew/core";
import type { PortainerWeb, Question } from "@opscrew/plan-schema";
import { z } from "zod";
import { PORTAINER_TOKEN_VAR } from "../providers";
import {
  type PortainerConnection,
  readPortainerConnection,
  recordPortainerConnection,
} from "../shared";
import { deepDomainProblem } from "./answers";
import type { InterviewAnswers } from "./questions";

/** The follow-up answers for an existing Portainer (`portainer.<field>` in answers files). */
export const PORTAINER_FIELDS = ["url", "environment", "redeploy", "web", "port"] as const;
/** One follow-up answer for an existing Portainer. */
export type PortainerField = (typeof PORTAINER_FIELDS)[number];
/** Id of a follow-up question, for example `portainer.url`. */
export type PortainerQuestionId = `portainer.${PortainerField}`;

/** A follow-up question for an existing Portainer (same shape as a {@link Question}). */
export interface PortainerQuestion extends Omit<Question, "id"> {
  id: PortainerQuestionId;
}

/** How a new image reaches Portainer: the updater stack (default) or through Cloudflare Access. */
export type PortainerRedeploy = "updater" | "cloudflare";

/**
 * An environment Portainer lists for the token, as the adapter reports it. Only a single Docker
 * host (`kind: "docker"`) that is up can run the app; `arch` comes from its Docker info.
 */
export const PortainerEnvironmentSchema = z.strictObject({
  /** Portainer's id of the environment. */
  id: z.int().positive(),
  /** Its name in Portainer, on one line. */
  name: z.string().regex(/^[^\0\r\n]*\S[^\0\r\n]*$/),
  /** A single Docker host, a Docker Swarm, Kubernetes, an Edge agent, or anything else. */
  kind: z.enum(["docker", "swarm", "kubernetes", "edge", "other"]),
  /** True when Portainer reports the environment as up. */
  up: z.boolean(),
  /** CPU architecture from its Docker info; `other` for one OpsCrew cannot build images for. */
  arch: z.enum(["amd64", "arm64", "other"]).optional(),
});
/** An environment Portainer lists for the token (see {@link PortainerEnvironmentSchema}). */
export type PortainerEnvironment = z.infer<typeof PortainerEnvironmentSchema>;

/**
 * What the interview needs from Portainer, injected so tests never touch the network. The real
 * implementation comes from `@opscrew/connector-portainer` (wired by the provision task).
 */
export interface PortainerAccess {
  /**
   * The SHA-256 fingerprint of the certificate `url` answers with, read without trusting it (shown
   * to the user before any token is sent), for example `SHA256:AB:CD:…`.
   */
  fetchCertificateFingerprint(url: string): Promise<string>;
  /**
   * The environments the token can see, connecting to `url` with the certificate pinned to
   * `certFingerprint` (absent only for plain HTTP to this computer).
   */
  listEnvironments(
    url: string,
    token: string,
    certFingerprint: string | undefined,
  ): Promise<readonly PortainerEnvironment[]>;
}

/** The certificate to confirm: its fingerprint and, when it changed, the one pinned before. */
export interface PortainerCertificate {
  fingerprint: string;
  /** The fingerprint confirmed earlier for the same address, when the certificate changed. */
  previous?: string;
}

/**
 * Asks the user to confirm Portainer's certificate (never decided by a model); true to trust it.
 */
export type ConfirmPortainerCertificate = (certificate: PortainerCertificate) => Promise<boolean>;

/** How the interview reaches Portainer to confirm its certificate and list its environments. */
export interface PortainerInterviewOptions {
  access: PortainerAccess;
  /** Asks the user to confirm a certificate OpsCrew has not pinned for this address. */
  confirmCertificate?: ConfirmPortainerCertificate;
  /**
   * The fingerprint the user gave up front (scripts: `--portainer-cert SHA256:…`); Portainer's
   * certificate must match it, and no confirmation is asked then.
   */
  certFingerprint?: string;
}

/** Options of {@link buildPortainerQuestions} and {@link answersToPortainer}. */
export interface PortainerContext {
  /** The connection recorded earlier (`.opscrew/server.json` → `portainer`); pre-filled. */
  previous?: PortainerConnection;
  /** Whether the app's domain is on Cloudflare (needed for the tunnel and the Cloudflare redeploy). */
  cloudflareDomain?: boolean;
  /** The app's domain; Caddy needs one, and through the tunnel it must fit Cloudflare's certificate. */
  domain?: string;
  /** The environments Portainer listed; offered as the choices of `portainer.environment`. */
  environments?: readonly PortainerEnvironment[];
  /**
   * Portainer's address as answered now. The earlier environment is reused only for the same
   * address (another Portainer's ids mean other environments).
   */
  url?: string;
}

/**
 * The answers about an existing Portainer, as recorded in `.opscrew/server.json` → `portainer`.
 * Never the access token: it comes only from `PORTAINER_API_KEY`.
 */
export interface PortainerAnswers {
  /** Portainer's address, without a trailing slash. */
  url: string;
  /** The confirmed certificate fingerprint; absent for plain HTTP to this computer. */
  certFingerprint?: string;
  environmentId: number;
  environmentName: string;
  arch: "amd64" | "arm64";
  redeploy: PortainerRedeploy;
  web: PortainerWeb;
}

/** The answers split into the Portainer follow-ups and everything else. */
export interface SplitPortainerAnswers {
  /** `portainer.<field>` answers, from flat keys or a nested `portainer:` mapping. */
  portainer: Partial<Record<PortainerField, unknown>>;
  /** Portainer keys OpsCrew does not know (`portainer.token`, `portainer.password`). */
  unknown: string[];
  /** The remaining answers. */
  rest: InterviewAnswers;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Keys that would hold a secret OpsCrew never takes as an answer. */
const SECRET_KEYS = /token|key|pass(word|phrase)?|secret/i;

const NEVER_A_TOKEN = `OpsCrew never takes Portainer's access token or a password as an answer: set ${PORTAINER_TOKEN_VAR} in the environment instead, and OpsCrew reads it from there without saving it.`;

const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Takes the follow-up answers for an existing Portainer out of `answers`: flat `portainer.url`
 * keys (as in `--answers` files and the MCP tool) or a nested `portainer:` mapping.
 */
export function splitPortainerAnswers(answers: InterviewAnswers): SplitPortainerAnswers {
  const portainer: Partial<Record<PortainerField, unknown>> = {};
  const unknown: string[] = [];
  const rest: InterviewAnswers = {};
  const take = (field: string, value: unknown) => {
    if ((PORTAINER_FIELDS as readonly string[]).includes(field)) {
      portainer[field as PortainerField] = value;
    } else {
      unknown.push(`portainer.${field}`);
    }
  };
  for (const [key, value] of Object.entries(answers)) {
    if (key === "portainer") {
      if (isRecord(value)) {
        for (const [field, inner] of Object.entries(value)) take(field, inner);
      } else if (!isBlank(value)) {
        unknown.push("portainer");
      }
    } else if (key.startsWith("portainer.")) {
      take(key.slice("portainer.".length), value);
    } else {
      rest[key] = value;
    }
  }
  return { portainer, unknown, rest };
}

/** True when any Portainer follow-up was answered. */
export function hasPortainerAnswers(
  split: Pick<SplitPortainerAnswers, "portainer" | "unknown">,
): boolean {
  return split.unknown.length > 0 || Object.keys(split.portainer).length > 0;
}

/** True when an environment can run the app (see `unusableReason`). */
function usable(environment: PortainerEnvironment): boolean {
  return unusableReason(environment) === undefined;
}

/**
 * The earlier answers' environment, only for the same Portainer address (or while it is not
 * known yet, as in the first round of questions).
 */
function previousEnvironment(
  context: Pick<PortainerContext, "previous" | "url">,
): { id: number; name: string } | undefined {
  const { previous, url } = context;
  if (previous === undefined) return undefined;
  if (url !== undefined && !sameUrl(previous.url, url)) return undefined;
  return { id: previous.environmentId, name: previous.environmentName };
}

/** The web modes the domain allows: the tunnel needs it on Cloudflare, Caddy needs one at all. */
function webModes(context: PortainerContext): PortainerWeb["mode"][] {
  return [
    ...(context.cloudflareDomain === true ? (["tunnel"] as const) : []),
    "proxy" as const,
    ...(context.domain !== undefined ? (["caddy"] as const) : []),
  ];
}

/** The redeploy modes the domain allows: Cloudflare Access needs the domain on Cloudflare. */
function redeployModes(context: PortainerContext): PortainerRedeploy[] {
  return context.cloudflareDomain === true ? ["updater", "cloudflare"] : ["updater"];
}

/** The web mode when none is given: the earlier one when still allowed, else tunnel or proxy. */
function webDefault(context: PortainerContext): PortainerWeb["mode"] {
  const earlier = context.previous?.web?.mode;
  if (earlier !== undefined && webModes(context).includes(earlier)) return earlier;
  return context.cloudflareDomain === true ? "tunnel" : "proxy";
}

/** The redeploy mode when none is given: the earlier one when still allowed, else the updater. */
function redeployDefault(context: PortainerContext): PortainerRedeploy {
  const earlier = context.previous?.redeploy;
  return earlier !== undefined && redeployModes(context).includes(earlier) ? earlier : "updater";
}

const REDEPLOY_OPTIONS = {
  updater: {
    value: "updater",
    label: "Portainer fetches them itself (recommended)",
    hint: "A small updater stack next to the app asks Portainer once a minute, over your local network, to redeploy when the deploy branch changed. Nothing is opened to the internet and no Cloudflare is needed.",
  },
  cloudflare: {
    value: "cloudflare",
    label: "GitHub Actions calls Portainer through Cloudflare Access",
    hint: "Each merge goes live at once. Portainer is reachable only through a hostname protected by Cloudflare Access with a service token, never openly from the internet. Needs your domain on Cloudflare and Cloudflare Zero Trust.",
  },
} as const;

const WEB_OPTIONS = {
  tunnel: {
    value: "tunnel",
    label: "Through a Cloudflare Tunnel (recommended)",
    hint: "No port is opened on your host: the tunnel runs in the app's stack. Needs your domain on Cloudflare.",
  },
  proxy: {
    value: "proxy",
    label: "Through your own reverse proxy",
    hint: "The app listens on a port of your host that you choose; you route your domain to it and manage its certificate.",
  },
  caddy: {
    value: "caddy",
    label: "Through Caddy on ports 80 and 443",
    hint: "Caddy gets the certificates for your domain automatically. Ports 80 and 443 must be free on your host and reachable from the internet.",
  },
} as const;

const KIND_TEXT: Record<PortainerEnvironment["kind"], string> = {
  docker: "Docker",
  swarm: "Docker Swarm",
  kubernetes: "Kubernetes",
  edge: "Edge agent",
  other: "another kind",
};

/**
 * The follow-up questions for an existing Portainer: its address, the environment (a choice
 * among `context.environments` once Portainer listed them, else its name or id), how new versions
 * reach Portainer (`updater` by default, `cloudflare`), how visitors reach the app (`tunnel` by
 * default with a domain on Cloudflare, else `proxy`; `caddy` with a domain) and the host port for
 * `proxy`. Never the access token (only `PORTAINER_API_KEY`) or a password.
 */
export function buildPortainerQuestions(context: PortainerContext = {}): PortainerQuestion[] {
  const { previous } = context;
  const withDefault = <T>(value: T | undefined) => (value === undefined ? {} : { default: value });
  const listed = (context.environments ?? []).filter(usable);
  const earlier = previousEnvironment(context);
  const environmentDefault =
    listed.find((environment) => environment.id === earlier?.id) ?? listed[0];
  const environment: PortainerQuestion =
    listed.length > 0
      ? {
          id: "portainer.environment",
          prompt: "Which Portainer environment should run the app?",
          help: "OpsCrew deploys the app as stacks in one Docker environment (a single Docker host). Swarm, Kubernetes and Edge agent environments are not supported yet.",
          kind: "single-select",
          options: listed.map((env) => ({
            value: String(env.id),
            label: env.name,
            hint: `Docker${env.arch === undefined || env.arch === "other" ? "" : `, ${env.arch}`}`,
          })),
          ...withDefault(environmentDefault && String(environmentDefault.id)),
          required: true,
        }
      : {
          id: "portainer.environment",
          prompt: "Which Portainer environment should run the app?",
          help: "Its name or id, as Portainer lists it under Environments. OpsCrew deploys the app as stacks in one Docker environment (a single Docker host). Swarm, Kubernetes and Edge agent environments are not supported yet.",
          kind: "text",
          ...withDefault(earlier?.name),
          required: true,
        };
  const redeploys = redeployModes(context);
  const webs = webModes(context);
  const previousPort = previous?.web?.mode === "proxy" ? previous.web.port : undefined;
  return [
    {
      id: "portainer.url",
      prompt: "What is your Portainer's address?",
      help: `The address you open Portainer at, for example https://nas.local:9443. OpsCrew connects over HTTPS and asks you to confirm Portainer's certificate the first time; plain http:// works only for a Portainer on this computer. OpsCrew keeps the address on this computer only, never in your repository. The access token comes from the ${PORTAINER_TOKEN_VAR} environment variable, never from an answer.`,
      kind: "text",
      ...withDefault(previous?.url),
      required: true,
    },
    environment,
    {
      id: "portainer.redeploy",
      prompt: "How should new versions reach Portainer?",
      help:
        redeploys.length > 1
          ? "After each merge, GitHub Actions builds the new image and records it in a deploy branch of your repository. Either Portainer picks it up within a minute, or the workflow tells Portainer at once and checks the site."
          : "After each merge, GitHub Actions builds the new image and records it in a deploy branch of your repository, and Portainer picks it up within a minute. Calling Portainer through Cloudflare Access needs your domain on Cloudflare.",
      kind: "single-select",
      options: redeploys.map((mode) => ({ ...REDEPLOY_OPTIONS[mode] })),
      default: redeployDefault(context),
      required: true,
    },
    {
      id: "portainer.web",
      prompt: "How should visitors reach the app?",
      help:
        webs.length === 3
          ? "The tunnel is the safest choice: nothing on your host is open to the web."
          : "A Cloudflare Tunnel needs your domain on Cloudflare, and Caddy needs a domain for its certificates.",
      kind: "single-select",
      options: webs.map((mode) => ({ ...WEB_OPTIONS[mode] })),
      default: webDefault(context),
      required: true,
    },
    {
      id: "portainer.port",
      prompt: "Which port of your host should the app listen on?",
      help: "Only for your own reverse proxy: route your domain to this port of the Portainer host. Choose a port nothing else uses, for example 8080.",
      kind: "text",
      default: String(previousPort ?? 8080),
      required: false,
    },
  ];
}

function invalid(problems: readonly string[]): OpsCrewError {
  return new OpsCrewError(
    "INVALID_INPUT",
    `Some answers about your Portainer are missing or not valid: ${problems.join("; ")}.`,
    {
      hint: "Fix them in the answers file, or run `opscrew interview` in a terminal to answer the questions.",
    },
  );
}

/** Refuses a token, password or key given as an answer, never echoing it. */
function refuseSecrets(split: Pick<SplitPortainerAnswers, "unknown">): void {
  const secret = split.unknown.filter((key) => SECRET_KEYS.test(key.replace(/^portainer\.?/, "")));
  if (secret.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", `${secret.join(", ")}: ${NEVER_A_TOKEN}`, {
      hint: `Remove it from the answers and set ${PORTAINER_TOKEN_VAR} instead.`,
    });
  }
}

/** `https://Nas.lan:9443/` → `https://nas.lan:9443`; `undefined` when it is not an allowed address. */
function normaliseUrl(text: string): string | undefined {
  if (!/^https?:\/\//i.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** True for the same address, ignoring case and a trailing slash. */
function sameUrl(a: string, b: string): boolean {
  return normaliseUrl(a)?.toLowerCase() === normaliseUrl(b)?.toLowerCase();
}

/**
 * Portainer's address from the answers (else the earlier one), normalised. A login, a query or
 * plain HTTP to another computer is refused: the token must never travel unencrypted.
 * @throws OpsCrewError `INVALID_INPUT` naming the problem.
 */
export function portainerUrlAnswer(
  split: Pick<SplitPortainerAnswers, "portainer" | "unknown">,
  context: Pick<PortainerContext, "previous"> = {},
): string {
  refuseSecrets(split);
  const raw = split.portainer.url;
  if (isBlank(raw)) {
    if (context.previous !== undefined) return context.previous.url;
    throw invalid(["portainer.url (your Portainer's address) is missing"]);
  }
  const text = String(raw).trim();
  const url = normaliseUrl(text);
  if (url !== undefined) return url;
  if (/^http:\/\//i.test(text)) {
    throw invalid([
      "portainer.url: OpsCrew sends the access token only over HTTPS (plain http:// only to a Portainer on this computer); use Portainer's HTTPS address, usually on port 9443, such as https://nas.local:9443",
    ]);
  }
  throw invalid([
    "portainer.url: write Portainer's full address without a login or query, such as https://nas.local:9443",
  ]);
}

/**
 * A SHA-256 certificate fingerprint in the connector's one spelling, `SHA256:` and colon-separated
 * upper-case hex pairs (as browsers and `openssl x509 -fingerprint -sha256` show it), from any form
 * it accepts; `undefined` for anything else.
 */
export { normalizeCertFingerprint };

/** True when both name the same certificate, whatever the spelling (hex, colons or base64). */
export function sameCertificate(a: string, b: string): boolean {
  return sameCertFingerprint(a, b);
}

/** What {@link reachPortainer} found: the pinned certificate and the environments. */
export interface ReachedPortainer {
  certFingerprint?: string;
  environments: PortainerEnvironment[];
}

/**
 * Confirms Portainer's certificate and lists its environments with the token. Over HTTPS the
 * certificate's fingerprint must match the one given up front, the one pinned earlier for the same
 * address, or be confirmed by the user through `options.confirmCertificate`; the token is sent
 * only after that. Plain HTTP (this computer only) has no certificate.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the token is missing or the certificate is not
 * confirmed; nothing is saved then.
 */
export async function reachPortainer(
  url: string,
  token: string | undefined,
  context: Pick<PortainerContext, "previous">,
  options: PortainerInterviewOptions | undefined,
): Promise<ReachedPortainer> {
  if (token === undefined || token.trim() === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew needs a Portainer access token in ${PORTAINER_TOKEN_VAR} to list your environments, and it is not set.`,
      {
        hint: `In Portainer, open My account, then Access tokens, and add a token; set ${PORTAINER_TOKEN_VAR} to it and run \`opscrew interview\` again. OpsCrew reads the token only from this environment variable and never saves it.`,
      },
    );
  }
  if (options === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This OpsCrew command cannot connect to Portainer to list its environments.",
      { hint: "Run `opscrew interview` in a terminal in the project directory." },
    );
  }
  const given =
    options.certFingerprint === undefined
      ? undefined
      : normalizeCertFingerprint(options.certFingerprint);
  if (options.certFingerprint !== undefined && given === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The certificate fingerprint you gave is not a SHA-256 fingerprint, so OpsCrew sent nothing.",
      {
        hint: "Give it as SHA256: followed by the 64 hex characters (with or without colons) or the base64 form, as Portainer's certificate shows it.",
      },
    );
  }
  let certFingerprint: string | undefined;
  if (new URL(url).protocol === "https:") {
    const fingerprint = String(await options.access.fetchCertificateFingerprint(url)).trim();
    if (normalizeCertFingerprint(fingerprint) === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "OpsCrew could not read the fingerprint of Portainer's certificate, so it sent nothing.",
        { hint: "Check Portainer's address and that it answers over HTTPS, then try again." },
      );
    }
    const pinned =
      context.previous !== undefined && sameUrl(context.previous.url, url)
        ? context.previous.certFingerprint
        : undefined;
    if (given !== undefined) {
      if (!sameCertificate(given, fingerprint)) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `Portainer answers with the certificate ${fingerprint}, not the ${given} you gave, so OpsCrew sent nothing and saved nothing.`,
          {
            hint: "Check the fingerprint in Portainer's settings (or with your browser) and give the one it shows; if the certificate changed on purpose, give the new one.",
          },
        );
      }
    } else if (pinned === undefined || !sameCertificate(pinned, fingerprint)) {
      const certificate = { fingerprint, ...(pinned !== undefined ? { previous: pinned } : {}) };
      if (options.confirmCertificate === undefined) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          pinned === undefined
            ? `OpsCrew must confirm Portainer's certificate before it sends the token. Its fingerprint is ${fingerprint}.`
            : `Portainer's certificate changed from ${pinned} to ${fingerprint}, so OpsCrew sent nothing.`,
          {
            hint: `Check the fingerprint against Portainer's certificate, then run \`opscrew interview\` in a terminal to confirm it, or pass --portainer-cert ${fingerprint}.`,
          },
        );
      }
      if (!(await options.confirmCertificate(certificate))) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "You did not confirm Portainer's certificate, so OpsCrew sent nothing and saved nothing.",
          {
            hint: "Check the fingerprint against Portainer's certificate and run `opscrew interview` again.",
          },
        );
      }
    }
    // The same certificate keeps the spelling pinned before.
    certFingerprint =
      pinned !== undefined && sameCertificate(pinned, fingerprint) ? pinned : fingerprint;
  }
  const listed = await options.access.listEnvironments(url, token, certFingerprint);
  const environments = z.array(PortainerEnvironmentSchema).safeParse(listed);
  if (!environments.success) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Portainer's list of environments could not be read, so OpsCrew saved nothing.",
      { hint: "Check that the address is your Portainer (version 2.45 or newer) and try again." },
    );
  }
  return {
    ...(certFingerprint !== undefined ? { certFingerprint } : {}),
    environments: environments.data,
  };
}

/** Why an environment cannot run the app, or `undefined` when it can. */
function unusableReason(environment: PortainerEnvironment): string | undefined {
  const name = JSON.stringify(environment.name);
  if (environment.kind === "edge") {
    return `${name} is an Edge agent environment, which OpsCrew does not support yet; choose a Docker environment`;
  }
  if (environment.kind !== "docker") {
    return `${name} is a ${KIND_TEXT[environment.kind]} environment; OpsCrew deploys only to a single Docker host for now`;
  }
  if (!environment.up) {
    return `Portainer reports ${name} as down; start it in Portainer and answer again`;
  }
  if (environment.arch === undefined) {
    return `OpsCrew could not read the CPU architecture of ${name} from Portainer; check that the environment is up and answer again`;
  }
  if (environment.arch === "other") {
    return `${name} runs on a CPU architecture OpsCrew does not build images for (only amd64 and arm64)`;
  }
  return undefined;
}

function environmentList(environments: readonly PortainerEnvironment[]): string {
  return environments.length === 0
    ? "it lists none for this token"
    : `it lists ${environments.map((env) => `${env.name} (${env.id}, ${KIND_TEXT[env.kind]})`).join(", ")}`;
}

/**
 * Validates the Portainer follow-ups against what Portainer listed: the environment (by id or
 * name; default the earlier one, or the only usable one), the redeploy mode (`updater` default;
 * `cloudflare` needs the domain on Cloudflare), the web mode (`tunnel` default with a domain on
 * Cloudflare, else `proxy`; `caddy` needs a domain) and the port for `proxy`. Through the tunnel
 * the domain must be at most one level below its zone (Cloudflare's free certificate).
 * @throws OpsCrewError `INVALID_INPUT` naming each missing or invalid answer; a token or password
 * given as an answer is refused, and never echoed.
 */
export function answersToPortainer(
  split: Pick<SplitPortainerAnswers, "portainer" | "unknown">,
  context: PortainerContext & {
    url: string;
    certFingerprint?: string;
    environments: readonly PortainerEnvironment[];
  },
): PortainerAnswers {
  refuseSecrets(split);
  const problems: string[] = [];
  if (split.unknown.length > 0) {
    problems.push(
      `${split.unknown.join(", ")}: not a known answer (use ${PORTAINER_FIELDS.map((f) => `portainer.${f}`).join(", ")})`,
    );
  }
  const given = (field: PortainerField) => !isBlank(split.portainer[field]);
  const text = (field: PortainerField) => String(split.portainer[field]).trim();
  const { previous, environments } = context;

  let environment: PortainerEnvironment | undefined;
  if (given("environment")) {
    const answer = text("environment");
    environment = /^\d+$/.test(answer)
      ? environments.find((env) => env.id === Number(answer))
      : environments.find((env) => env.name.trim().toLowerCase() === answer.toLowerCase());
    if (environment === undefined) {
      problems.push(
        `portainer.environment: Portainer has no environment ${JSON.stringify(answer.slice(0, 100))} for this token (${environmentList(environments)})`,
      );
    }
  } else {
    const usableOnes = environments.filter(usable);
    environment =
      environments.find((env) => env.id === previousEnvironment(context)?.id) ??
      (usableOnes.length === 1 ? usableOnes[0] : undefined) ??
      // The only environment Portainer lists, so its problem is named.
      (environments.length === 1 ? environments[0] : undefined);
    if (environment === undefined) {
      problems.push(
        `portainer.environment (which environment runs the app) is missing (${environmentList(environments)})`,
      );
    }
  }
  const reason = environment === undefined ? undefined : unusableReason(environment);
  if (reason !== undefined) problems.push(`portainer.environment: ${reason}`);

  let redeploy = redeployDefault(context);
  if (given("redeploy")) {
    const answer = text("redeploy").toLowerCase();
    if (answer !== "updater" && answer !== "cloudflare") {
      problems.push("portainer.redeploy: answer updater or cloudflare");
    } else if (!redeployModes(context).includes(answer)) {
      problems.push(
        "portainer.redeploy: cloudflare needs the app's domain on Cloudflare (the workflow reaches Portainer through Cloudflare Access in that zone); answer updater, or give a domain on Cloudflare",
      );
    } else {
      redeploy = answer;
    }
  }

  let mode = webDefault(context);
  if (given("web")) {
    const answer = text("web").toLowerCase();
    if (answer !== "tunnel" && answer !== "proxy" && answer !== "caddy") {
      problems.push("portainer.web: answer tunnel, proxy or caddy");
    } else if (answer === "tunnel" && context.cloudflareDomain !== true) {
      problems.push(
        "portainer.web: tunnel needs the app's domain on Cloudflare (the tunnel serves the app on that domain); answer proxy (a port you route to) or caddy (with a domain)",
      );
    } else if (answer === "caddy" && context.domain === undefined) {
      problems.push(
        "portainer.web: caddy needs a domain (Caddy gets the certificates for it); answer proxy, or give a domain",
      );
    } else {
      mode = answer;
    }
  }

  let port: number | undefined;
  if (mode === "proxy") {
    const previousPort = previous?.web?.mode === "proxy" ? previous.web.port : undefined;
    if (given("port")) {
      const raw = split.portainer.port;
      const value =
        typeof raw === "number" ? raw : /^\d{1,5}$/.test(text("port")) ? Number(text("port")) : NaN;
      if (Number.isInteger(value) && value >= 1 && value <= 65535) port = value;
      else problems.push("portainer.port: write a port number from 1 to 65535, such as 8080");
    } else if (previousPort !== undefined) {
      port = previousPort;
    } else {
      problems.push(
        "portainer.port (the port of your host your reverse proxy routes to) is missing",
      );
    }
  }

  if (mode === "tunnel" && context.domain !== undefined) {
    const deep = deepDomainProblem(
      context.domain,
      "serve it with Caddy or your own reverse proxy and DNS only (portainer.web caddy or proxy)",
    );
    if (deep !== undefined) problems.push(`domain: ${deep.reason}; ${deep.next}`);
  }

  if (problems.length > 0 || environment === undefined) throw invalid(problems);
  const web: PortainerWeb = mode === "proxy" ? { mode, port: port as number } : { mode };
  return {
    url: context.url,
    ...(context.certFingerprint !== undefined ? { certFingerprint: context.certFingerprint } : {}),
    environmentId: environment.id,
    environmentName: environment.name.trim(),
    arch: environment.arch as "amd64" | "arm64",
    redeploy,
    web,
  };
}

/** What OpsCrew's record lists as created, in words: only what is there, never "0 stacks". */
function recordedText(created: PortainerConnection["created"]): string {
  const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
  const items = [
    ...(created.stacks.length > 0 ? [count(created.stacks.length, "a stack", "stacks")] : []),
    ...(created.registryId !== undefined ? ["a registry entry"] : []),
    ...(created.volumes.length > 0 ? [count(created.volumes.length, "a volume", "volumes")] : []),
  ];
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Records the answers in OpsCrew's local state (`.opscrew/server.json` → `portainer`, gitignored),
 * never the token. What OpsCrew created in Portainer is kept for the same address and environment.
 * @throws OpsCrewError `PHASE_PRECONDITION` when OpsCrew created stacks in another Portainer or
 * environment than the one answered: they would be left behind where destroy cannot reach them.
 */
export async function recordPortainerAnswers(
  paths: ProjectPaths,
  answers: PortainerAnswers,
): Promise<void> {
  const recorded = await readPortainerConnection(paths);
  const same =
    recorded !== undefined &&
    sameUrl(recorded.url, answers.url) &&
    recorded.environmentId === answers.environmentId;
  const created = recorded?.created;
  const owned =
    created !== undefined &&
    (created.stacks.length > 0 || created.registryId !== undefined || created.volumes.length > 0);
  if (!same && owned) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew's record lists ${recordedText(created)} it created in the Portainer environment ${JSON.stringify(recorded?.environmentName ?? "")} it deployed to before, and your answers name another Portainer or environment, so nothing was saved.`,
      {
        hint: "Run `opscrew destroy` first to remove what OpsCrew created there, or answer the same Portainer address and environment.",
      },
    );
  }
  await recordPortainerConnection(paths, {
    url: answers.url,
    ...(answers.certFingerprint !== undefined ? { certFingerprint: answers.certFingerprint } : {}),
    environmentId: answers.environmentId,
    environmentName: answers.environmentName,
    arch: answers.arch,
    redeploy: answers.redeploy,
    web: answers.web,
    ...(same && created !== undefined ? { created } : {}),
  });
}
