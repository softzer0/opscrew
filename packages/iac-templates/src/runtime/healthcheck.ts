import type { AppBuild, DeployPlan } from "@opscrew/plan-schema";
import { composeLiteral } from "./services";

type Probe = NonNullable<AppBuild["probe"]>;

/** A string literal in single quotes, read the same by JavaScript, Python, Ruby and PHP. */
function quoted(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** A single-quoted shell word. */
function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The command of each probe for `app`: it fetches `http://127.0.0.1:<port><healthPath>` and exits
 * 0 only for a success, with a tool the image has, since images may lack curl (research R3, R8).
 */
const PROBES: Record<Exclude<Probe, "none">, (app: DeployPlan["app"]) => string[]> = {
  node: (app) => [
    "node",
    "-e",
    `fetch('http://127.0.0.1:'+process.env.PORT+${quoted(app.healthPath)},{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`,
  ],
  python: (app) => [
    "python",
    "-c",
    `import os,urllib.request as u;u.urlopen('http://127.0.0.1:'+os.environ['PORT']+${quoted(app.healthPath)},timeout=2)`,
  ],
  ruby: (app) => [
    "ruby",
    "-rnet/http",
    "-e",
    `exit Net::HTTP.get_response(URI('http://127.0.0.1:'+ENV['PORT']+${quoted(app.healthPath)})).is_a?(Net::HTTPSuccess)`,
  ],
  php: (app) => [
    "php",
    "-r",
    `exit(@file_get_contents('http://127.0.0.1:'.getenv('PORT').${quoted(app.healthPath)})===false?1:0);`,
  ],
  /** busybox wget (static sites on caddy:alpine). */
  wget: (app) => ["wget", "-q", "-O", "/dev/null", `http://127.0.0.1:${app.port}${app.healthPath}`],
  /** bash's `/dev/tcp`, for images with bash but no interpreter: only status 200 passes. */
  bash: (app) => [
    "bash",
    "-c",
    `exec 3<>/dev/tcp/127.0.0.1/${app.port} && printf 'GET %s HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' ${shellQuoted(app.healthPath)} >&3 && read -r _ code _ <&3 && [ "\${code%$'\\r'}" = 200 ]`,
  ],
};

/**
 * `app.build.probe`, or when it is absent: `none` for an own Dockerfile (its `HEALTHCHECK`
 * applies), the runtime's probe for Node, Python, Ruby and PHP (Node without `app.build`, the
 * generated Dockerfile), else `bash`.
 */
function probeFor(build: AppBuild | undefined): Probe {
  if (build?.probe !== undefined) return build.probe;
  if (build?.builder === "own-dockerfile") return "none";
  const language = build?.runtime.language ?? "node";
  return language === "node" || language === "python" || language === "ruby" || language === "php"
    ? language
    : "bash";
}

/**
 * Buildpacks images put the runtime (and bash) on the PATH only inside the launcher; without `--`
 * the launcher may exit 0 whatever the probe does (research R3).
 */
const LAUNCHER = ["/cnb/lifecycle/launcher", "--"];

/**
 * The app service's Compose healthcheck from its probe, through the launcher for Buildpacks;
 * `undefined` for the probe `none`. A new copy counts as healthy about a second after it answers.
 */
export function appHealthcheck(plan: DeployPlan): object | undefined {
  const build = plan.app.build;
  const probe = probeFor(build);
  if (probe === "none") return undefined;
  return {
    test: [
      "CMD",
      ...(build?.builder === "buildpacks" ? LAUNCHER : []),
      ...PROBES[probe](plan.app).map(composeLiteral),
    ],
    interval: "5s",
    timeout: "3s",
    retries: 3,
    start_period: "30s",
    start_interval: "1s",
  };
}
