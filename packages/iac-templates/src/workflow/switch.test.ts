// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { localhostHostname, localhostTlsUpload, renderEdgeCompose } from "../edge";
import { localhostPlan } from "../edge/__fixtures__/localhost";
import { renderCompose, renderEdgeSite, renderRuntimeFiles } from "../runtime";
import { runtimeDir } from "../runtime-dir";
import { NIGHTLY, withPlan, withProcesses } from "./__fixtures__/plans";
import { type EdgeFiles, rollbackCommands, switchCommands } from "./switch";

const ROOTS = [
  'APPS_DIR="${OPSCREW_APPS_DIR:-/srv/apps}"',
  'EDGE_DIR="${OPSCREW_EDGE_DIR:-/srv/edge}"',
];

/** A server app's scripts in every shape the deploy takes. */
function serverScripts(): string[][] {
  const plan = testPlan({ domain: "example.com", www: true });
  const nginx = DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge: "nginx" } });
  const busy = withProcesses(withPlan(plan, { releaseCommand: "npm run migrate" }), {
    workers: [{ name: "worker", command: "node worker.js" }],
    cron: [NIGHTLY],
  });
  const recreate = withPlan(plan, { deploy: { strategy: "recreate" } });
  const init = [{ service: "db", check: ["test", "-f", "/done"], run: ["touch", "/done"] }];
  return [
    switchCommands(plan, []),
    switchCommands(plan, init, { originTls: true, additions: true }),
    switchCommands(nginx, [], {
      originTls: false,
      additions: true,
      certbot: { hosts: ["example.com", "www.example.com"], email: "ops@example.com" },
    }),
    switchCommands(busy, init),
    switchCommands(recreate, []),
    rollbackCommands(busy),
    rollbackCommands(recreate),
  ];
}

describe("the scripts' root folders", () => {
  it("start every switch, edge and rollback script, with a server's folders as the defaults", () => {
    for (const script of serverScripts()) expect(script.slice(0, 2)).toEqual(ROOTS);
    const local = localhostPlan();
    const site = { hostname: "shop.localhost" };
    expect(
      switchCommands(local, [], { originTls: false, additions: false, localhost: site }).slice(
        0,
        2,
      ),
    ).toEqual(ROOTS);
    expect(rollbackCommands(local, site).slice(0, 2)).toEqual(ROOTS);
  });

  it("build every path: no other line names a server folder", () => {
    for (const script of serverScripts()) {
      expect(script.filter((line) => line.includes("/srv"))).toEqual(ROOTS);
    }
  });

  it("keep the server's paths, built from the roots, in the commands and the messages", () => {
    const [plain = [], , nginx = [], busy = []] = serverScripts();
    expect(plain).toContain('cd "$APPS_DIR"/shop');
    expect(plain).toContain('export DOCKER_CONFIG="$APPS_DIR"/shop/.docker');
    expect(plain).toContain(
      'edge() { docker compose -p opscrew-edge -f "$EDGE_DIR"/compose.yaml "$@"; }',
    );
    expect(plain).toContain(') 9> "$EDGE_DIR"/.lock');
    expect(nginx).toContain(
      `  printf 'OPSCREW_DEPLOY_UID=%s\\nOPSCREW_DEPLOY_GID=%s\\n' "$(id -u)" "$(id -g)" > "$EDGE_DIR"/.env`,
    );
    // A message names the folder through the root: the single-quoted text opens around it.
    expect(busy.join("\n")).toContain(
      "Its output stays on the server in '\"$APPS_DIR\"'/shop/release.log (it can quote data",
    );
  });
});

describe("the start script on this computer", () => {
  it("has no origin TLS and no certbot, whatever the edge files say", () => {
    const site = { hostname: "shop.localhost" };
    for (const edge of ["caddy", "nginx"] as const) {
      const plan = localhostPlan({ edge });
      const plain = switchCommands(plan, [], {
        originTls: false,
        additions: false,
        localhost: site,
      });
      const mixed = switchCommands(plan, [], {
        originTls: true,
        additions: false,
        certbot: { hosts: ["shop.localhost"], email: "ops@example.com" },
        localhost: site,
      });
      expect(mixed).toEqual(plain);
      // No certbot container, no Cloudflare origin files.
      expect(plain.join("\n")).not.toMatch(/edge run|pull\.pem|origin\.(pem|key)/);
    }
  });

  it("takes the edge's lock only where flock exists, which a server's script always does", () => {
    const local = switchCommands(localhostPlan(), [], {
      originTls: false,
      additions: false,
      localhost: { hostname: "shop.localhost" },
    });
    expect(local).toContain("  if command -v flock > /dev/null 2>&1; then flock 9; fi");
    expect(local).not.toContain("  flock 9");
    for (const script of serverScripts().slice(0, 5)) {
      expect(script).toContain("  flock 9");
      expect(script.join("\n")).not.toContain("command -v flock");
    }
  });
});

const IMAGE = `ghcr.io/acme/shop@sha256:${"b".repeat(64)}`;
const OLD = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;

/**
 * The fake `docker`: logs every call and refuses any argument under `/srv/`. An app project's
 * containers live in $WORK/containers-<folder>; the edge's `up` fails with EDGE_UP_FAIL, a one-off
 * container (certbot) always fails, and kamal-proxy's `deploy <service>` writes its target and
 * host to $WORK/routes/<service>.
 */
const FAKE_DOCKER = [
  "#!/bin/sh",
  'echo "docker $*" >> "$WORK/docker.log"',
  'case " $* " in *" /srv/"*) echo "docker was given a server folder: $*" >&2; exit 9 ;; esac',
  'project="$(basename "$PWD")"',
  'if [ "$1" = compose ]; then',
  "  shift",
  '  while [ "$1" = -p ] || [ "$1" = -f ]; do',
  '    if [ "$1" = -p ]; then project="$2"; fi',
  "    shift 2",
  "  done",
  '  set -- compose "$@"',
  "fi",
  'for last in "$@"; do :; done',
  'state="$WORK/containers-$project"',
  'touch "$state"',
  'case "$1 $2" in',
  '  "network inspect") test -f "$WORK/network-$3" ;;',
  '  "network create") touch "$WORK/network-$3" ;;',
  '  "compose ps") cut -d " " -f 1 "$state" ;;',
  '  "compose up")',
  '    if [ "$project" = opscrew-edge ]; then test -z "${EDGE_UP_FAIL:-}"; exit; fi',
  '    if [ "$last" = app ]; then',
  '      n=$(( $(cat "$WORK/next" 2> /dev/null || echo 0) + 1 ))',
  '      echo "$n" > "$WORK/next"',
  '      echo "c$n $project-app-$n" >> "$state"',
  "    fi ;;",
  '  "compose run") echo "a one-off container ran: $*" >&2; exit 1 ;;',
  '  "compose exec")',
  '    if [ "$5 $6" = "kamal-proxy deploy" ]; then',
  '      target=""; host=""; prev=""',
  '      for arg in "$@"; do',
  '        if [ "$prev" = --target ]; then target="$arg"; fi',
  '        if [ "$prev" = --host ]; then host="$arg"; fi',
  '        prev="$arg"',
  "      done",
  '      mkdir -p "$WORK/routes"',
  '      echo "$target $host" > "$WORK/routes/$7"',
  "    fi ;;",
  `  "inspect --format") cat "$WORK"/containers-* | awk -v id="$last" '$1 == id { print "/" $2 }' ;;`,
  '  "rm "*) for f in "$WORK"/containers-*; do grep -v "^$last " "$f" > "$f.tmp" || true; mv "$f.tmp" "$f"; done ;;',
  "esac",
].join("\n");

/** The fake `flock`: the edge's lock, logged. */
const FAKE_FLOCK = ["#!/bin/sh", 'echo "flock $*" >> "$WORK/flock.log"'].join("\n");

function shWorks(): boolean {
  try {
    return spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

let work = "";
/** The roots the local executor sets, under the test's folder. */
const appsDir = () => `${work}/local/srv/apps`;
const edgeDir = () => `${work}/local/srv/edge`;

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

/** The localhost edge's files for `hostname`. */
const localFiles = (hostname: string): EdgeFiles => ({
  originTls: false,
  additions: false,
  localhost: { hostname },
});

/**
 * What the local deploy leaves before the start script: the app's runtime files in its folder,
 * and the `leaf` certificate and key (placeholders) in the edge's TLS folder; no leaf with `false`
 * (a deploy on the local runner).
 */
function upload(plan: DeployPlan, hostname: string, leaf: string | false = hostname): void {
  const ctx = { ...testContext(), localhost: { hostname } };
  const files = [renderCompose(plan), ...renderRuntimeFiles(plan), ...renderEdgeSite(plan, ctx)];
  const dir = runtimeDir(plan);
  for (const file of files) {
    write(`${appsDir()}/${plan.app.name}/${file.path.slice(dir.length + 1)}`, file.content);
  }
  if (leaf === false) return;
  const tls = localhostTlsUpload(plan.app.name);
  write(`${edgeDir()}/${tls.certificate}`, `certificate for ${leaf}\n`);
  write(`${edgeDir()}/${tls.key}`, `key for ${leaf}\n`);
}

/**
 * Runs `script` as the local executor does: piped to `sh -s` with the image as `$1`, the roots in
 * OPSCREW_APPS_DIR and OPSCREW_EDGE_DIR, and the fakes first on PATH.
 */
function run(script: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(
    "sh",
    ["-c", 'PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; exec sh -s -- "$1"', "sh", IMAGE],
    {
      input: `${script.join("\n")}\n`,
      env: {
        ...process.env,
        WORK: work,
        OPSCREW_APPS_DIR: appsDir(),
        OPSCREW_EDGE_DIR: edgeDir(),
        ...env,
      },
      encoding: "utf8",
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Where kamal-proxy routes `service`: its target and host. */
const route = (service: string) => read(`${work}/routes/${service}`)?.trim();

// Each test runs sh several times; on Windows (Git Bash) under a parallel `pnpm check` that can
// take longer than the default 5 seconds.
describe.skipIf(!shWorks())(
  "the scripts on this computer, under the roots",
  { timeout: 30_000 },
  () => {
    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "opscrew-switch-")).replaceAll("\\", "/");
      write(`${work}/bin/docker`, `${FAKE_DOCKER}\n`);
      write(`${work}/bin/flock`, `${FAKE_FLOCK}\n`);
      for (const fake of ["docker", "flock"]) spawnSync("chmod", ["755", `${work}/bin/${fake}`]);
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    it("deploys an app on Caddy into the edge's and the app's folders under the roots", () => {
      const plan = localhostPlan();
      upload(plan, "shop.localhost");
      const start = run(switchCommands(plan, [], localFiles("shop.localhost")));
      expect(start.status, start.output).toBe(0);
      expect(read(`${edgeDir()}/compose.yaml`)).toBe(renderEdgeCompose(plan).content);
      expect(read(`${edgeDir()}/sites/shop.caddy`)).toBe(
        read(`${appsDir()}/shop/edge/sites/shop.caddy`),
      );
      // The leaf went in place under the edge's lock, which is in the edge's folder.
      expect(read(`${edgeDir()}/tls/shop/local.pem`)).toBe("certificate for shop.localhost\n");
      expect(read(`${edgeDir()}/tls/shop/local.key`)).toBe("key for shop.localhost\n");
      expect(existsSync(`${edgeDir()}/tls/shop/local.pem.new`)).toBe(false);
      expect(existsSync(`${edgeDir()}/tls/shop/local.key.previous`)).toBe(false);
      expect(read(`${work}/flock.log`)).toBe("flock 9\n");
      expect(existsSync(`${edgeDir()}/.lock`)).toBe(true);
      const docker = read(`${work}/docker.log`) ?? "";
      expect(docker).toContain(
        `docker compose -p opscrew-edge -f ${edgeDir()}/compose.yaml up -d --wait --remove-orphans\n`,
      );
      expect(docker).not.toContain("certbot");
      // kamal-proxy routes the app's hostname to its new copy, and .env names the image.
      expect(route("shop")).toBe("shop-app-1:3000 shop.localhost");
      expect(read(`${appsDir()}/shop/.env`)).toBe(`APP_IMAGE=${IMAGE}\n`);
    });

    it("deploys an app on nginx without certbot, nginx running as this computer's user", () => {
      const plan = localhostPlan({ edge: "nginx" });
      upload(plan, "shop.localhost");
      const start = run(switchCommands(plan, [], localFiles("shop.localhost")));
      expect(start.status, start.output).toBe(0);
      expect(read(`${edgeDir()}/.env`)).toMatch(
        /^OPSCREW_DEPLOY_UID=\d+\nOPSCREW_DEPLOY_GID=\d+\n$/,
      );
      expect(read(`${edgeDir()}/sites/shop.conf`)).toBe(
        read(`${appsDir()}/shop/edge/sites/shop.conf`),
      );
      expect(read(`${edgeDir()}/tls/shop/local.pem`)).toBe("certificate for shop.localhost\n");
      const docker = read(`${work}/docker.log`) ?? "";
      expect(docker).toContain(" exec -T nginx sh -c nginx -t -q && nginx -s reload\n");
      expect(docker).not.toMatch(/certbot| run /);
      expect(route("shop")).toBe("shop-app-1:3000 shop.localhost");
    });

    it("serves two localhost environments of the app on one edge, each at its own hostname", () => {
      const prod = localhostPlan();
      const staging = localhostPlan({ environment: "staging" });
      for (const plan of [prod, staging]) {
        const hostname = localhostHostname(plan, true);
        upload(plan, hostname);
        const start = run(switchCommands(plan, [], localFiles(hostname)));
        expect(start.status, start.output).toBe(0);
      }
      expect(read(`${edgeDir()}/sites/shop.caddy`)).toContain("\nprod.shop.localhost {\n");
      expect(read(`${edgeDir()}/sites/shop-staging.caddy`)).toContain(
        "\nstaging.shop.localhost {\n",
      );
      expect(read(`${edgeDir()}/tls/shop/local.pem`)).toBe("certificate for prod.shop.localhost\n");
      expect(read(`${edgeDir()}/tls/shop-staging/local.pem`)).toBe(
        "certificate for staging.shop.localhost\n",
      );
      expect(route("shop")).toBe("shop-app-1:3000 prod.shop.localhost");
      expect(route("shop-staging")).toBe("shop-staging-app-2:3000 staging.shop.localhost");
      expect(read(`${edgeDir()}/compose.yaml`)).toBe(renderEdgeCompose(prod).content);
    });

    it("puts the previous leaf certificate back when the edge refuses the new site", () => {
      const plan = localhostPlan();
      upload(plan, "shop.localhost", "the first");
      expect(run(switchCommands(plan, [], localFiles("shop.localhost"))).status).toBe(0);
      upload(plan, "shop.localhost", "the second");
      const failed = run(switchCommands(plan, [], localFiles("shop.localhost")), {
        EDGE_UP_FAIL: "1",
      });
      expect(failed.status).toBe(1);
      expect(failed.output).toContain(
        "::error::OpsCrew's shared edge on the server (Caddy and kamal-proxy, in",
      );
      expect(failed.output).toContain(`, in ${edgeDir()}) did not start`);
      expect(read(`${edgeDir()}/tls/shop/local.pem`)).toBe("certificate for the first\n");
      expect(read(`${edgeDir()}/tls/shop/local.key`)).toBe("key for the first\n");
    });

    it("deploys without the edge's lock where flock is missing (Git for Windows, macOS)", () => {
      rmSync(`${work}/bin/flock`);
      const plan = localhostPlan();
      upload(plan, "shop.localhost");
      const start = run(switchCommands(plan, [], localFiles("shop.localhost")));
      expect(start.status, start.output).toBe(0);
      expect(existsSync(`${work}/flock.log`)).toBe(false);
      expect(read(`${edgeDir()}/tls/shop/local.pem`)).toBe("certificate for shop.localhost\n");
      expect(route("shop")).toBe("shop-app-1:3000 shop.localhost");
    });

    it("keeps the leaf certificate the edge has when the deploy brings none", () => {
      const plan = localhostPlan();
      upload(plan, "shop.localhost", "the first");
      expect(run(switchCommands(plan, [], localFiles("shop.localhost"))).status).toBe(0);
      // A deploy on the local runner: the runtime files, and no new leaf.
      upload(plan, "shop.localhost", false);
      const again = run(switchCommands(plan, [], localFiles("shop.localhost")));
      expect(again.status, again.output).toBe(0);
      expect(read(`${edgeDir()}/tls/shop/local.pem`)).toBe("certificate for the first\n");
      expect(read(`${edgeDir()}/tls/shop/local.key`)).toBe("key for the first\n");
      expect(existsSync(`${edgeDir()}/tls/shop/local.pem.previous`)).toBe(false);
      // The edge refusing the site keeps it too.
      const failed = run(switchCommands(plan, [], localFiles("shop.localhost")), {
        EDGE_UP_FAIL: "1",
      });
      expect(failed.status).toBe(1);
      expect(read(`${edgeDir()}/tls/shop/local.pem`)).toBe("certificate for the first\n");
      expect(read(`${edgeDir()}/tls/shop/local.key`)).toBe("key for the first\n");
    });

    it("rolls back to the previous image with the app's hostname", () => {
      const plan = localhostPlan();
      upload(plan, "shop.localhost");
      expect(run(switchCommands(plan, [], localFiles("shop.localhost"))).status).toBe(0);
      write(`${appsDir()}/shop/.env.previous`, `APP_IMAGE=${OLD}\n`);
      const rollback = run(rollbackCommands(plan, { hostname: "shop.localhost" }));
      expect(rollback.status, rollback.output).toBe(0);
      expect(rollback.output.trim().split("\n").at(-1)).toBe("restored");
      expect(read(`${appsDir()}/shop/.env`)).toBe(`APP_IMAGE=${OLD}\n`);
      expect(route("shop")).toBe("shop-app-2:3000 shop.localhost");
    });
  },
);
