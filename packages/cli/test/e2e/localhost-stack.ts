/**
 * SC-1502 for the localhost Docker pass (`localhost.test.ts`): the stack OpsCrew rendered for an
 * app on this computer, compared with the stack it renders for the same plan on a cloud server.
 * Every line that differs must be one of the local differences FR-1504 (and research.md R4)
 * lists; whatever else differs is reported line by line.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  initStepsFor,
  type LocalhostSite,
  type RuntimeContext,
  renderCompose,
  renderEdgeSite,
  renderRuntimeFiles,
  rollbackCommands,
  runtimeDir,
  switchCommands,
} from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { parse } from "yaml";
import { listFiles } from "./support";

/** The domain the server's copy of the plan serves; the comparison maps it to the local name. */
const SERVER_DOMAIN = "app.example.com";

/** Cloudflare's addresses in the server's render context (two of the real ranges). */
const CLOUDFLARE_RANGES = ["173.245.48.0/20", "2400:cb00::/32"];

/**
 * `plan` on a Hetzner server behind Cloudflare's proxy, everything else as it is: the production
 * stack the local one is compared with.
 */
export function onServer(plan: DeployPlan): DeployPlan {
  if (plan.target.provider !== "localhost") throw new Error("Expected a localhost plan.");
  return DeployPlanSchema.parse({
    ...plan,
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      image: "ubuntu-24.04",
      backups: false,
      edge: plan.target.edge,
    },
    dns: {
      provider: "cloudflare",
      domain: SERVER_DOMAIN,
      zone: "example.com",
      proxied: true,
      www: false,
    },
  });
}

/** The scripts the deploy runs, by a name of their own: the switch and the rollback. */
function scripts(plan: DeployPlan, localhost?: LocalhostSite): Map<string, string> {
  const edgeFiles = { originTls: false, additions: false, ...(localhost ? { localhost } : {}) };
  return new Map([
    ["switch script", switchCommands(plan, initStepsFor(plan), edgeFiles).join("\n")],
    ["rollback script", rollbackCommands(plan, localhost).join("\n")],
  ]);
}

/** The server's stack for `plan`: its runtime files and scripts, by path. */
export function serverStack(plan: DeployPlan, opscrewVersion: string): Map<string, string> {
  const ctx: RuntimeContext = {
    opscrewVersion,
    github: { owner: "acme", repo: "app" },
    deploySshPublicKey: "",
    cloudflareRanges: CLOUDFLARE_RANGES,
    acmeEmail: "ops@example.com",
  };
  const files = [
    renderCompose(plan),
    ...renderRuntimeFiles(plan, ctx),
    ...renderEdgeSite(plan, ctx),
  ];
  return new Map([...files.map((file) => [file.path, file.content] as const), ...scripts(plan)]);
}

/**
 * The local stack provision wrote for `plan` (every file under its runtime folder in `root`) and
 * the scripts the local deploy runs for `site`, by path.
 */
export async function localStack(
  root: string,
  plan: DeployPlan,
  site: LocalhostSite,
): Promise<Map<string, string>> {
  const stack = new Map<string, string>();
  for (const file of await listFiles(path.join(root, runtimeDir(plan)))) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    stack.set(relative, (await readFile(file, "utf8")).replaceAll("\r\n", "\n"));
  }
  for (const [name, script] of scripts(plan, site)) stack.set(name, script);
  return stack;
}

/**
 * A file as lines to compare: a YAML file as one line per value (`services.app.ports[] = …`, a
 * text value one line per line of it, `configs.caddyfile.content | …`), anything else by line.
 * Blank lines and comments are left out; they change no behaviour.
 */
function comparable(file: string, content: string): string[] {
  const text = (prefix: string, value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => `${prefix}${line}`);
  if (!file.endsWith(".yaml")) return text("", content);
  const lines: string[] = [];
  const walk = (key: string, value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(`${key}[]`, item);
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) lines.push(`${key} = {}`);
      for (const [name, item] of entries) walk(key === "" ? name : `${key}.${name}`, item);
    } else if (typeof value === "string" && value.includes("\n")) {
      lines.push(...text(`${key} | `, value));
    } else {
      lines.push(`${key} = ${String(value)}`);
    }
  };
  walk("", parse(content));
  return lines;
}

/** One line only one of the two stacks has. */
export interface StackDifference {
  file: string;
  side: "server" | "local";
  line: string;
}

/** One difference FR-1504 (or research.md R4) lists, and the lines it accounts for. */
interface ListedDifference {
  item: string;
  /** Matches the file and the line of a difference (`<file>: <line>`) on its side. */
  server?: RegExp;
  local?: RegExp;
}

const COMPOSE = String.raw`opscrew/runtime/compose\.yaml`;
const EDGE = String.raw`opscrew/runtime/edge/compose\.yaml`;
const SITE = String.raw`opscrew/runtime/edge/sites/[\w-]+\.(?:caddy|conf)`;
const SCRIPT = "(?:switch|rollback) script";

/** The local differences FR-1504 and research.md R4 list, as the lines they change. */
const LISTED: readonly ListedDifference[] = [
  {
    item: "R4: the scripts run with this computer's POSIX shell (Git Bash and macOS have no flock)",
    server: new RegExp(`^${SCRIPT}: flock 9$`),
    local: new RegExp(`^${SCRIPT}: if command -v flock > /dev/null 2>&1; then flock 9; fi$`),
  },
  {
    item: "R4: the data folders become named volumes",
    server: new RegExp(`^${COMPOSE}: services\\.[\\w-]+\\.volumes\\[\\] = /srv/data/`),
    local: new RegExp(
      `^${COMPOSE}: (?:services\\.[\\w-]+\\.volumes\\[\\] = [\\w-]+:/|volumes\\.[\\w-]+ = \\{\\})`,
    ),
  },
  {
    item: "FR-1504: files the server keeps on disk are kept in Docker where the computer's Docker needs it",
    server: new RegExp(
      `^(?:${COMPOSE}: services\\.[\\w-]+\\.volumes\\[\\] = \\./[\\w./-]+:[^:]+:ro|opscrew/runtime/(?:services/|crontab))`,
    ),
    local: new RegExp(`^${COMPOSE}: (?:services\\.[\\w-]+\\.configs\\[\\]\\.|configs\\.)`),
  },
  {
    item: "R4: the edge binds to 127.0.0.1, on 443 or 8443 and 80 or 8080 (TCP only: no HTTP/3)",
    server: new RegExp(`^${EDGE}: services\\.[\\w-]+\\.ports\\[\\] = \\d+:\\d+(?:/udp)?$`),
    local: new RegExp(
      `^(?:${EDGE}: services\\.[\\w-]+\\.ports\\[\\] = 127\\.0\\.0\\.1:\\d+:\\d+$|${EDGE}: configs\\.caddyfile\\.content \\| protocols h1 h2$|${SITE}: (?:http://\\S+ \\{|redir https://\\{host\\}(?::\\d+)?\\{uri\\} 308)$)`,
    ),
  },
  {
    item: "R4: certificates from OpsCrew's local CA, not ACME",
    server: new RegExp(`^(?:${SITE}: tls \\S+@\\S+$|${SCRIPT}: .*(?:/tls/|origin\\.pem))`),
    local: new RegExp(
      `^(?:${SITE}: tls /etc/caddy/tls/\\S+ \\S+$|${SCRIPT}: .*(?:/tls/|local\\.pem))`,
    ),
  },
  {
    item: "R4: the image is built on this computer (never pulled)",
    local: new RegExp(`^${COMPOSE}: services\\.[\\w-]+\\.pull_policy = never$`),
  },
  {
    item: "FR-1504: no Cloudflare (the visitor's address is not read from Cloudflare's header)",
    server: new RegExp(
      `^(?:${EDGE}: configs\\.caddyfile\\.content \\| (?:trusted_proxies static|client_ip_headers CF-Connecting-IP)|${SITE}: (?:reverse_proxy \\S+ \\{|header_up X-Forwarded-For \\{client_ip\\})$)`,
    ),
    local: new RegExp(`^${SITE}: reverse_proxy \\S+$`),
  },
  {
    item: "FR-1504: the Compose project is opscrew-<app>, apart from the user's own projects",
    server: new RegExp(`^${COMPOSE}: name = [\\w-]+$`),
    local: new RegExp(`^${COMPOSE}: name = opscrew-[\\w-]+$`),
  },
  {
    item: "FR-1504: no HSTS header on localhost",
    server: new RegExp(`^${SITE}: Strict-Transport-Security `),
  },
  {
    item: "follows the edge's main configuration, compared line by line above",
    server: new RegExp(`^${EDGE}: services\\.caddy\\.labels\\.dev\\.opscrew\\.caddyfile-sha256 = `),
    local: new RegExp(`^${EDGE}: services\\.caddy\\.labels\\.dev\\.opscrew\\.caddyfile-sha256 = `),
  },
];

/** The lines of `ours` that `theirs` does not have, counted (a line twice in ours, once there). */
function missingFrom(ours: readonly string[], theirs: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of theirs) left.set(line, (left.get(line) ?? 0) + 1);
  return ours.filter((line) => {
    const count = left.get(line) ?? 0;
    if (count === 0) return true;
    left.set(line, count - 1);
    return false;
  });
}

/** The comparison of the two stacks: each listed difference with its lines, and the rest. */
export interface StackComparison {
  listed: Map<string, StackDifference[]>;
  unlisted: StackDifference[];
}

/**
 * Compares the server's stack with the local one. A server line that names the server's domain
 * where the local line names `hostname` is R4's hostname difference; every other differing line
 * must match one of {@link LISTED}.
 */
export function compareStacks(
  server: ReadonlyMap<string, string>,
  local: ReadonlyMap<string, string>,
  hostname: string,
): StackComparison {
  const listed = new Map<string, StackDifference[]>();
  const unlisted: StackDifference[] = [];
  const record = (item: string | undefined, difference: StackDifference) => {
    if (item === undefined) unlisted.push(difference);
    else listed.set(item, [...(listed.get(item) ?? []), difference]);
  };
  const hostnames = "R4: the hostname is <app>.localhost (or <env>.<app>.localhost)";
  for (const file of new Set([...server.keys(), ...local.keys()]).values()) {
    const ours = comparable(file, server.get(file) ?? "");
    const theirs = comparable(file, local.get(file) ?? "");
    const renamed = ours.map((line) => line.replaceAll(SERVER_DOMAIN, hostname));
    const onlyServer = missingFrom(renamed, theirs);
    const onlyLocal = missingFrom(theirs, renamed);
    for (const line of renamed.filter(
      (line, i) => line !== ours[i] && !onlyServer.includes(line),
    )) {
      record(hostnames, { file, side: "local", line });
    }
    for (const [side, lines] of [
      ["server", onlyServer],
      ["local", onlyLocal],
    ] as const) {
      for (const line of lines) {
        const shown = side === "server" ? line.replaceAll(hostname, SERVER_DOMAIN) : line;
        const item = LISTED.find((difference) => difference[side]?.test(`${file}: ${shown}`));
        record(item?.item, { file, side, line: shown });
      }
    }
  }
  return { listed, unlisted };
}

/** The comparison as text: each listed difference with its lines, then the unlisted ones. */
export function comparisonText(comparison: StackComparison): string {
  const line = (d: StackDifference) =>
    `    ${d.side === "server" ? "-" : "+"} ${d.file}: ${d.line}`;
  return [
    ...[...comparison.listed].flatMap(([item, lines]) => [`  ${item}`, ...lines.map(line)]),
    ...(comparison.unlisted.length > 0
      ? ["  NOT IN FR-1504's LIST:", ...comparison.unlisted.map(line)]
      : []),
  ].join("\n");
}
