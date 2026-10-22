import { normalizeHostName, OpsCrewError, type ProjectPaths } from "@opscrew/core";
import type { Question } from "@opscrew/plan-schema";
import { z } from "zod";
import {
  deepDomainProblem,
  type OwnServerConnection,
  readOwnServer,
  recordOwnServer,
} from "../shared";
import {
  booleanAnswer,
  FIX_ANSWERS_HINT,
  type FollowUps,
  isBlank,
  portAnswer,
  withDefault,
} from "./follow-ups";

/** The follow-up answers for a server the user already has (`server.<field>` in answers files). */
export const SERVER_FIELDS = ["host", "port", "user", "key", "reachable", "serve"] as const;
/** One follow-up answer for a server the user already has. */
export type ServerField = (typeof SERVER_FIELDS)[number];
/** Id of a follow-up question, for example `server.host`. */
export type ServerQuestionId = `server.${ServerField}`;

/** A follow-up question for a server the user already has (same shape as a {@link Question}). */
export interface ServerQuestion extends Omit<Question, "id"> {
  id: ServerQuestionId;
}

/**
 * How OpsCrew reaches a server the user already has, as answered in the interview. Local only
 * (`.opscrew/server.json` → `own`): never in `opscrew/requirements.yaml`, the plan, pull requests
 * or commit messages. No password, passphrase or key material: the key is a path, or the SSH agent.
 */
export interface OwnServerAnswers {
  /** IP address or host name. */
  host: string;
  /** SSH port (22 by default). */
  port: number;
  /** The admin login: root or a user with passwordless sudo. */
  user: string;
  /** Absolute path to the private key; absent when `agent` is true. */
  keyPath?: string;
  /** Use the SSH agent. */
  agent: boolean;
  /** True when the internet reaches the server directly; false means a Cloudflare Tunnel. */
  reachable: boolean;
  /**
   * How the site is served when the server is reachable and its domain is on Cloudflare: through
   * a Cloudflare Tunnel (recommended, the default), directly behind Cloudflare's proxy with
   * OpsCrew's web filter (`proxy`), or directly with DNS only. Without a Cloudflare domain only
   * `dns-only` applies.
   */
  serve: OwnServerServe;
}

/** The interview's answer to how the site is served (see {@link OwnServerAnswers.serve}). */
export type OwnServerServe = "tunnel" | "proxy" | "dns-only";

const SERVE_VALUES = ["tunnel", "proxy", "dns-only"] as const;

/** A DNS name or a single host label; never starts with `-`, so `ssh` cannot read it as an option. */
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
/** `/…`, `~/…`, `C:\…` or `C:/…`. */
const ABSOLUTE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/])[^\0\r\n]*$/;

const HostSchema = z.union([z.ipv4(), z.ipv6(), z.string().regex(HOST_NAME)]);

const OwnServerAnswersSchema = z
  .strictObject({
    host: HostSchema,
    port: z.int().min(1).max(65535),
    user: z.string().regex(USER_NAME),
    keyPath: z
      .string()
      .regex(ABSOLUTE_PATH)
      .refine((path) => !looksLikeKeyMaterial(path))
      .optional(),
    agent: z.boolean(),
    reachable: z.boolean(),
    serve: z.enum(SERVE_VALUES),
  })
  .refine((own) => own.agent !== (own.keyPath !== undefined));

function looksLikeKeyMaterial(text: string): boolean {
  return text.includes("-----BEGIN") || text.includes("PRIVATE KEY");
}

/** Keys that would hold a secret OpsCrew never takes. */
const SECRET_KEYS = /pass(word|phrase)?$|^secret$|^private_?key$/i;

const NEVER_A_PASSWORD =
  "OpsCrew never asks for or stores a password or passphrase: give the path to your SSH key, or `agent` to use the SSH agent (which also handles a key with a passphrase).";

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * Whether the internet can probably reach `host`, from the address alone: `false` for private,
 * loopback, link-local and carrier-grade NAT addresses and for local names (`.local`, `.lan`,
 * `.home.arpa`, `.internal`, a single label); `true` for any other IP address; `undefined` for a
 * public-looking host name (it may point anywhere).
 */
export function suggestReachable(host: string): boolean | undefined {
  const name = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (z.ipv4().safeParse(name).success) return !PRIVATE_V4.some((range) => range.test(name));
  if (z.ipv6().safeParse(name).success) {
    return !(name === "::1" || /^f[cd]/.test(name) || /^fe[89ab]/.test(name));
  }
  const bare = name.replace(/\.$/, "");
  if (!bare.includes(".") || /\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(bare)) {
    return false;
  }
  return undefined;
}

/** Options of {@link buildServerQuestions} and {@link answersToOwnServer}. */
export interface OwnServerContext {
  /** The connection recorded earlier (`.opscrew/server.json` → `own`); pre-filled as defaults. */
  previous?: OwnServerConnection;
  /** Whether the internet reaches the server, as inspection suggests (wins over a guess). */
  suggestedReachable?: boolean;
  /**
   * Whether the app's domain is on Cloudflare (from the requirements answers). `false` leaves DNS
   * only as the way to serve the site; `undefined` offers every choice and design decides.
   */
  cloudflareDomain?: boolean;
  /**
   * The app's domain (from the requirements answers). Served through the tunnel or Cloudflare's
   * proxy it must be at most one level below its zone (Cloudflare's free certificate).
   */
  domain?: string;
}

/** The serving answer when none is given: the earlier one, else the tunnel (DNS only without Cloudflare). */
function serveDefault(context: OwnServerContext): OwnServerServe {
  if (context.cloudflareDomain === false) return "dns-only";
  return context.previous?.serve ?? "tunnel";
}

const SERVE_OPTIONS = [
  {
    value: "tunnel",
    label: "Through a Cloudflare Tunnel (recommended)",
    hint: "No web port is opened on your server: only Cloudflare reaches the app, and deploys go through the tunnel too.",
  },
  {
    value: "proxy",
    label: "Directly, behind Cloudflare's proxy, with a filter",
    hint: "Ports 80 and 443 stay open, but a filter in Docker lets only Cloudflare's addresses in. Needs no Cloudflare Zero Trust. It fails closed: if the filter cannot be installed, Docker does not start and the site is down until it is fixed.",
  },
  {
    value: "dns-only",
    label: "Directly, DNS only (no Cloudflare protection)",
    hint: "Everyone can reach your server on ports 80 and 443; Cloudflare only answers DNS, so it neither hides nor protects the server.",
  },
] as const;

function reachableDefault(context: OwnServerContext, host?: string): boolean {
  if (context.suggestedReachable !== undefined) return context.suggestedReachable;
  const { previous } = context;
  if (previous?.reachable !== undefined && (host === undefined || sameHost(host, previous.host))) {
    return previous.reachable;
  }
  return (host === undefined ? undefined : suggestReachable(host)) ?? true;
}

const sameHost = (a: string, b: string) => normalizeHostName(a) === normalizeHostName(b);

/**
 * The follow-up questions for a server the user already has: address, SSH port (22), SSH user,
 * key (a path, or the SSH agent) and whether the internet can reach the server. Never a password
 * or a passphrase.
 */
export function buildServerQuestions(context: OwnServerContext = {}): ServerQuestion[] {
  const { previous } = context;
  return [
    {
      id: "server.host",
      prompt: "What is your server's address?",
      help: "Its IP address or host name, for example 203.0.113.10 or server.example.com. OpsCrew keeps it on this computer only, never in your repository.",
      kind: "text",
      ...withDefault(previous?.host),
      required: true,
    },
    {
      id: "server.port",
      prompt: "Which port do you connect to for SSH?",
      help: "The port this computer and GitHub Actions connect to, usually 22. When a router forwards another port to your server (for example 2222 to the server's 22), give the forwarded port (2222).",
      kind: "text",
      default: String(previous?.port ?? 22),
      required: true,
    },
    {
      id: "server.user",
      prompt: "Which user should OpsCrew log in as?",
      help: "root, or a user that can run sudo without a password.",
      kind: "text",
      default: previous?.user ?? "root",
      required: true,
    },
    {
      id: "server.key",
      prompt: "Which SSH key should OpsCrew use?",
      help: "The path to your private key, for example ~/.ssh/id_ed25519, or `agent` to use the key in your SSH agent (also for a key with a passphrase). OpsCrew never asks for a password or passphrase.",
      kind: "text",
      default: previous === undefined ? "agent" : (previous.keyPath ?? "agent"),
      required: true,
    },
    {
      id: "server.reachable",
      prompt: "Can the internet reach this server directly?",
      help: "Yes for a rented server with a public IP address. No for a server at home or behind a router: OpsCrew then serves the app through a Cloudflare Tunnel, which needs a domain on your Cloudflare account.",
      kind: "confirm",
      default: reachableDefault(context),
      required: true,
    },
    context.cloudflareDomain === false
      ? {
          id: "server.serve",
          prompt: "How should your server serve the site?",
          help: "Your domain is not on Cloudflare, so the site is served directly with DNS only: everyone can reach your server on ports 80 and 443. A Cloudflare Tunnel or Cloudflare's proxy needs the domain on your Cloudflare account.",
          kind: "single-select",
          options: [SERVE_OPTIONS[2]].map((option) => ({ ...option })),
          default: "dns-only",
          required: true,
        }
      : {
          id: "server.serve",
          prompt: "If the internet can reach your server, how should it serve the site?",
          help: "Matters for a server the internet can reach with a domain on Cloudflare; a server it cannot reach always uses the Cloudflare Tunnel, and without a domain on Cloudflare the only choice is dns-only (a tunnel or Cloudflare's proxy needs the domain on your Cloudflare account). The tunnel is the safest choice: nothing on the server is open to the web.",
          kind: "single-select",
          options: SERVE_OPTIONS.map((option) => ({ ...option })),
          default: serveDefault(context),
          required: true,
        },
  ];
}

/**
 * Validates the follow-up answers for a server the user already has. Answers that were not given
 * fall back to the previous ones (port 22, the SSH agent and the reachability suggestion when
 * there are none). Throws `OpsCrewError("INVALID_INPUT")` naming each missing or invalid answer;
 * a password or passphrase is always refused, and never echoed.
 */
export function answersToOwnServer(
  split: Pick<FollowUps<ServerField>, "values" | "unknown">,
  context: OwnServerContext = {},
): OwnServerAnswers {
  const problems: string[] = [];
  const secret = split.unknown.filter((key) => SECRET_KEYS.test(key.replace(/^server\.?/, "")));
  if (secret.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", `${secret.join(", ")}: ${NEVER_A_PASSWORD}`, {
      hint: "Remove it from the answers and give server.key instead.",
    });
  }
  if (split.unknown.length > 0) {
    problems.push(
      `${split.unknown.join(", ")}: not a known answer (use ${SERVER_FIELDS.map((f) => `server.${f}`).join(", ")})`,
    );
  }
  const { previous } = context;
  const given = (field: ServerField) => !isBlank(split.values[field]);
  const text = (field: ServerField) => String(split.values[field]).trim();

  let host = previous?.host;
  if (given("host")) {
    host = text("host").replace(/^\[(.*)\]$/, "$1");
    if (host.includes("@")) {
      problems.push("server.host: give only the address; the user goes into server.user");
      host = undefined;
    } else if (!HostSchema.safeParse(host).success) {
      problems.push("server.host: write an IP address or a host name such as server.example.com");
      host = undefined;
    }
  } else if (host === undefined) {
    problems.push("server.host (your server's address) is missing");
  }

  let port = previous?.port ?? 22;
  if (given("port")) {
    const value = portAnswer(split.values.port);
    if (value !== undefined) port = value;
    else problems.push("server.port: write a port number from 1 to 65535, usually 22");
  }

  let user = previous?.user;
  if (given("user")) {
    user = text("user");
    if (!USER_NAME.test(user)) {
      problems.push("server.user: write a login name such as root or ubuntu");
      user = undefined;
    }
  } else if (user === undefined) {
    problems.push("server.user (the SSH user) is missing");
  }

  let agent = previous?.agent ?? true;
  let keyPath = previous?.keyPath;
  if (given("key")) {
    const key = text("key");
    if (key.toLowerCase() === "agent") {
      agent = true;
      keyPath = undefined;
    } else if (looksLikeKeyMaterial(key)) {
      // Never echo what looks like a private key.
      throw new OpsCrewError(
        "INVALID_INPUT",
        "server.key must be the path to your SSH key file, never the key itself.",
        { hint: "Give the path, for example ~/.ssh/id_ed25519, or `agent` to use the SSH agent." },
      );
    } else if (!ABSOLUTE_PATH.test(key) || key.startsWith("-")) {
      problems.push(
        "server.key: write the full path to the private key, such as ~/.ssh/id_ed25519, or agent",
      );
    } else {
      agent = false;
      keyPath = key;
    }
  }

  let reachable: boolean | undefined;
  if (given("reachable")) {
    reachable = booleanAnswer(split.values.reachable);
    if (reachable === undefined) problems.push("server.reachable: answer yes or no");
  }

  let serve = serveDefault(context);
  if (given("serve")) {
    const answer = text("serve").toLowerCase();
    if (!(SERVE_VALUES as readonly string[]).includes(answer)) {
      problems.push("server.serve: answer tunnel, proxy or dns-only");
    } else if (context.cloudflareDomain === false && answer !== "dns-only") {
      problems.push(
        "server.serve: without a domain on Cloudflare the site can only be served with DNS only (dns-only)",
      );
    } else {
      serve = answer as OwnServerServe;
    }
  }

  // Behind Cloudflare's proxy the web filter publishes the site on IPv4 only.
  const knownIpv4 =
    previous?.publicIpv4 !== undefined && host !== undefined && sameHost(previous.host, host);
  if (serve === "proxy" && host?.includes(":") && !knownIpv4) {
    problems.push(
      "server.serve: proxy needs your server's public IPv4 address (behind Cloudflare's proxy OpsCrew publishes the site on IPv4 only); give the IPv4 address as server.host, or answer tunnel",
    );
  }

  // Through the tunnel or behind the proxy Cloudflare serves the domain with its own certificate.
  const unreachable =
    host !== undefined && (reachable ?? reachableDefault(context, host)) === false;
  if (context.domain !== undefined && context.cloudflareDomain !== false) {
    const deep =
      unreachable || serve === "tunnel"
        ? deepDomainProblem(
            context.domain,
            "if the internet can reach your server, serve it with DNS only (server.reachable yes, server.serve dns-only)",
          )
        : serve === "proxy"
          ? deepDomainProblem(context.domain, "serve it with DNS only (server.serve dns-only)")
          : undefined;
    if (deep !== undefined) problems.push(`domain: ${deep.reason}; ${deep.next}`);
  }

  if (problems.length > 0 || host === undefined || user === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Some answers about your server are missing or not valid: ${problems.join("; ")}.`,
      { hint: FIX_ANSWERS_HINT },
    );
  }
  return OwnServerAnswersSchema.parse({
    host,
    port,
    user,
    ...(agent ? {} : { keyPath }),
    agent,
    reachable: reachable ?? reachableDefault(context, host),
    serve,
  });
}

/**
 * Records the answers in OpsCrew's local state (`.opscrew/server.json` → `own`, gitignored)
 * through `recordOwnServer`. For the same address and port as `pinned` (by default the connection
 * recorded there; another environment's on the same server) the pinned host key and the public
 * addresses are kept; when either changed they are dropped, so the next connection shows the new
 * server's host key for confirmation again.
 */
export async function recordOwnServerAnswers(
  paths: ProjectPaths,
  answers: OwnServerAnswers,
  pinned?: OwnServerConnection,
): Promise<void> {
  const server = OwnServerAnswersSchema.parse(answers);
  pinned ??= await readOwnServer(paths);
  const kept =
    pinned !== undefined && sameHost(pinned.host, server.host) && pinned.port === server.port
      ? {
          ...(pinned.hostKey !== undefined ? { hostKey: pinned.hostKey } : {}),
          ...(pinned.publicIpv4 !== undefined ? { publicIpv4: pinned.publicIpv4 } : {}),
          ...(pinned.publicIpv6 !== undefined ? { publicIpv6: pinned.publicIpv6 } : {}),
        }
      : {};
  await recordOwnServer(paths, { ...server, ...kept });
}
