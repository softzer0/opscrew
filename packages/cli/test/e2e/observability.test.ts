/**
 * Feature 017's Docker pass (plan.md "11.", T1713): the monitoring add-ons and the check key,
 * as OpsCrew renders and installs them, on this computer's Docker.
 *
 * **The add-ons.** A plan designed by the real CLI (`examples/express-api`) turns Beszel (hub
 * mode) and Grafana Cloud on. `renderAddon` renders each add-on's files and `planAddon` checks
 * them as the host step takes them; the test then lays out each add-on's folder as the host step
 * writes it on a server (ssh-host `steps.ts`, `addonScripts`): the folder and its data folders
 * 0700, the rendered files 0644 except `config.yml` (the agent's token filled in, 0600), the
 * secret files 0600, `.env` with the deploy user's ids, and Alloy's `mask.re` 0600 in the app's
 * folder (0750). Everything belongs to the user running the test, who stands in for the deploy
 * user: the add-ons run as that user's uid:gid, as on a server, and the Docker proxy as root in
 * that user's group. Compose starts each add-on's own file, as the host step does. Three things
 * differ from a server, and nothing else:
 * - each Compose project (the app's, and so the one Alloy reads, and the add-ons') has a name of
 *   the run's, so a run never touches another's;
 * - Alloy's view of the server's root (`/:/host/root:ro`) is a folder holding only the app's
 *   `mask.re` (`/srv/apps/<app>` on a server is root's to create; this test never writes outside
 *   its folders);
 * - Alloy sends to a local Loki and Prometheus (on its network, plain HTTP) in place of the
 *   Grafana Cloud stack's HTTPS URLs.
 *
 * It checks the proxy's allow-list and refusals in front of this computer's Docker, the users,
 * Beszel's dashboard showing the server and its containers to its one user, Alloy's masked lines
 * and allow-listed series, and every container's memory after two minutes.
 *
 * **The check key.** An Ubuntu 24.04 sshd container with OpsCrew's sshd drop-in (`sshdDropIn`)
 * and a deploy user. The `check-key` host step (`planAddon`) is applied over SSH as deploy with
 * `applyHostPlan`, as provision does on a server OpsCrew created; then the check key gets the
 * `df` table whatever it asks, and is refused a port forward.
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon, Linux (where
 * bind mounts keep their owner) as a user other than root, `ssh`, and the network (the images and
 * Ubuntu's packages). Everything the test starts carries its run's label and is removed by it
 * afterwards, with the images it pulled.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import {
  BESZEL_EMAIL,
  BESZEL_LOCAL_URL,
  generateEd25519KeyPair,
  SshRemoteExec,
} from "@opscrew/agents";
import {
  applyHostPlan,
  type HostPlan,
  hostPlanHash,
  planAddon,
  sshdDropIn,
} from "@opscrew/connector-ssh-host";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { BESZEL_TOKEN_PLACEHOLDER, IMAGES, renderAddon } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  type ComposeProject,
  type ComposeService,
  composeOk,
  DOCKER,
  docker,
  dockerSkipReason,
  imageIds,
  LABEL,
  limitProblems,
  projectContainers,
  removeNewImages,
  TEN_MINUTES,
  TWO_MINUTES,
  tail,
  UBUNTU,
} from "./docker-support";
import { designedPlan, dockerOk, freePort, tempDir, unique, until } from "./edge-support";

const SSH = findExecutable("ssh");
const UID = process.getuid?.();
const GID = process.getgid?.();
const SKIP =
  dockerSkipReason() ??
  (process.platform !== "linux"
    ? "it runs only on Linux, where bind mounts keep their files' owner"
    : UID === 0
      ? "run it as a user other than root: that user stands in for the deploy user"
      : SSH === undefined
        ? "ssh is not installed"
        : undefined);
if (SKIP !== undefined) console.warn(`Skipping the observability Docker pass: ${SKIP}.`);

/** Grafana Loki and Prometheus, standing in for a Grafana Cloud stack; pinned for this test only. */
const LOKI =
  "grafana/loki:3.7.7@sha256:d70e4659623f3e109af669cae76fe2a5dd5be54e2298fe8aed380d982fbc2500";
const PROMETHEUS =
  "prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2";

/** Grafana Cloud's endpoints in the plan; Alloy's config is pointed at the stand-ins instead. */
const CLOUD = {
  metrics: { url: "https://prometheus.example.com/api/prom/push", user: "123456" },
  logs: { url: "https://logs.example.com/loki/api/v1/push", user: "654321" },
};
const STAND_INS = {
  metrics: "http://prometheus:9090/api/v1/write",
  logs: "http://loki:3100/loki/api/v1/push",
};

/** The series Alloy may send (the renderer's allow-list), and the CPU modes it keeps. */
const SERIES = [
  "node_cpu_seconds_total",
  "node_filesystem_avail_bytes",
  "node_filesystem_size_bytes",
  "node_load1",
  "node_load15",
  "node_load5",
  "node_memory_MemAvailable_bytes",
  "node_memory_MemTotal_bytes",
];
const CPU_MODES = ["idle", "iowait", "steal", "system", "user"];

/** How long the add-ons run before their memory is read (T1713: two minutes). */
const SETTLE_MS = 120_000;

/** Writes `content` to `file` with exactly `mode`, as the host step's `put` does. */
async function put(file: string, content: string, mode = 0o600): Promise<void> {
  await writeFile(file, content, { mode });
  await chmod(file, mode);
}

/** A folder only its owner may enter, as the host step's `own_dir` makes it. */
async function ownDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  await chmod(dir, mode);
}

/** The rendered files the host step takes, by name, from its `file:<name>` parameters. */
function stepFiles(plan: HostPlan): Map<string, string> {
  const step = plan.steps.at(-1);
  if (step === undefined) throw new Error("The add-on's host plan has no step.");
  return new Map(
    Object.entries(step.params)
      .filter(([key]) => key.startsWith("file:"))
      .map(([key, value]) => [key.slice("file:".length), String(value)]),
  );
}

/**
 * Writes an add-on's folder as the host step does: the rendered files (0644, the templated one
 * with the token filled in and 0600), the secret files (0600), the data folders (0700) and `.env`
 * with the deploy user's ids.
 */
async function writeAddonFolder(
  dir: string,
  files: Map<string, string>,
  o: { secrets: Record<string, string>; dataDirs: string[]; token?: string },
): Promise<void> {
  await ownDir(dir);
  for (const data of o.dataDirs) await ownDir(path.join(dir, data));
  for (const [name, content] of Object.entries(o.secrets)) {
    await put(path.join(dir, name), content);
  }
  await put(path.join(dir, ".env"), `OPSCREW_DEPLOY_UID=${UID}\nOPSCREW_DEPLOY_GID=${GID}\n`);
  for (const [name, content] of files) {
    if (name === "config.yml" && o.token !== undefined) {
      await put(path.join(dir, name), content.replaceAll(BESZEL_TOKEN_PLACEHOLDER, o.token));
    } else {
      await put(path.join(dir, name), content, 0o644);
    }
  }
}

/** `10.8MiB` as bytes. */
function bytes(text: string): number {
  const match = /^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)$/.exec(text.trim());
  if (!match?.[1] || !match[2]) throw new Error(`Unexpected memory figure ${text}.`);
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1e3, MB: 1e6, GB: 1e9 };
  return Number(match[1]) * unit[match[2] as keyof typeof unit];
}

/** Every container, volume, network and image with `label`, removed. */
async function removeLabelled(label: string): Promise<void> {
  const filter = ["--filter", `label=${label}`];
  const ids = async (args: string[]) =>
    (await docker([...args, ...filter])).stdout.split(/\s+/).filter((id) => id !== "");
  const containers = await ids(["ps", "-a", "-q"]);
  if (containers.length > 0) await docker(["rm", "-f", "-v", ...containers]);
  const volumes = await ids(["volume", "ls", "-q"]);
  if (volumes.length > 0) await docker(["volume", "rm", "-f", ...volumes]);
  const networks = await ids(["network", "ls", "-q"]);
  if (networks.length > 0) await docker(["network", "rm", ...networks]);
  const images = await ids(["image", "ls", "-q"]);
  if (images.length > 0) await docker(["image", "rm", "-f", ...images]);
}

describe.skipIf(SKIP !== undefined)("Beszel and Grafana Alloy on Docker (017)", () => {
  const run = unique("obs");
  /** The label of everything this test starts itself, besides the Compose projects' own. */
  const RUN_LABEL = `opscrew.test.run=${run}`;
  /** The app's name, and so its Compose project, the one Alloy reads. */
  const app = run;
  const projects = {
    app: { name: app, file: "" } as ComposeProject,
    beszel: { name: `${run}-beszel`, file: "" } as ComposeProject,
    alloy: { name: `${run}-alloy`, file: "" } as ComposeProject,
  };
  const loki = `${run}-loki`;
  const prometheus = `${run}-prometheus`;
  const knownValue = randomBytes(12).toString("hex");
  const githubToken = fakeSecret("github-token", run);
  const beszel = {
    password: randomBytes(24).toString("base64url"),
    token: randomBytes(24).toString("hex"),
    key: generateEd25519KeyPair("beszel-hub"),
  };
  const pulled = [IMAGES.caddy.ref, IMAGES.curl.ref, IMAGES.beszel.ref, IMAGES.beszelAgent.ref];
  let before = new Set<string>();
  let work = "";
  let cleanupProject: (() => Promise<void>) | undefined;
  let plan: DeployPlan;
  let environment = "";
  let lokiPort = 0;
  let prometheusPort = 0;
  let started = 0;
  /** Each add-on's Compose services, as rendered. */
  const services: Record<string, Record<string, ComposeService & { user?: string }>> = {};

  beforeAll(async () => {
    before = await imageIds();
    work = await tempDir("opscrew-observability-");
    const designed = await designedPlan(
      "express-api",
      {},
      {
        edit: (designedPlan) =>
          DeployPlanSchema.parse({
            ...designedPlan,
            app: { ...designedPlan.app, name: app },
            observability: {
              ...designedPlan.observability,
              beszel: { enabled: true, version: "0.21.1" },
              grafanaCloud: { enabled: true, version: "1.21.2", ...CLOUD },
            },
          }),
      },
    );
    cleanupProject = designed.project.cleanup;
    plan = designed.plan;
    environment = plan.environment?.name ?? "prod";

    // Beszel in hub mode, as the host step writes it.
    const beszelPlan = planAddon("beszel", {
      app,
      runAs: "login",
      enable: {
        files: Object.fromEntries(renderAddon(plan, "beszel").map((f) => [f.path, f.content])),
        mode: "hub",
        email: BESZEL_EMAIL,
        hubKey: beszel.key.publicKeyOpenSsh.split(" ").slice(0, 2).join(" "),
      },
    });
    const beszelDir = path.join(work, "addons", "beszel");
    const beszelFiles = stepFiles(beszelPlan);
    await writeAddonFolder(beszelDir, beszelFiles, {
      dataDirs: ["data", "agent_data"],
      token: beszel.token,
      secrets: {
        "data/id_ed25519": beszel.key.privateKeyOpenSsh,
        "hub.env": `USER_EMAIL=${BESZEL_EMAIL}\nUSER_PASSWORD=${beszel.password}\n`,
        "agent.env": `TOKEN=${beszel.token}\nKEY=${beszel.key.publicKeyOpenSsh.split(" ").slice(0, 2).join(" ")}\n`,
      },
    });
    projects.beszel.file = path.join(beszelDir, "compose.yaml");

    // Grafana Alloy, as the host step writes it, with the two stand-ins above.
    const alloyPlan = planAddon("alloy", {
      app,
      runAs: "login",
      enable: {
        files: Object.fromEntries(
          renderAddon(plan, "grafana-cloud").map((f) => [f.path, f.content]),
        ),
      },
    });
    const alloyFiles = stepFiles(alloyPlan);
    const config = alloyFiles.get("config.alloy") ?? "";
    const maskPath = /filename\s+=\s+"\/host\/root(\/[^"]+\/mask\.re)"/.exec(config)?.[1];
    if (maskPath === undefined) throw new Error("config.alloy reads no masking file.");
    alloyFiles.set(
      "config.alloy",
      config
        .replace(JSON.stringify(CLOUD.metrics.url), JSON.stringify(STAND_INS.metrics))
        .replace(JSON.stringify(CLOUD.logs.url), JSON.stringify(STAND_INS.logs)),
    );
    const compose = parse(alloyFiles.get("compose.yaml") ?? "") as {
      services: Record<string, ComposeService>;
    };
    const alloy = compose.services.alloy;
    const hostRoot = path.join(work, "host-root");
    if (!alloy?.volumes?.includes("/:/host/root:ro")) throw new Error("Alloy doesn't see /.");
    alloy.volumes = alloy.volumes.map((v) =>
      v === "/:/host/root:ro" ? `${hostRoot}:/host/root:ro` : v,
    );
    alloyFiles.set("compose.yaml", stringify(compose, { lineWidth: 0 }));
    const alloyDir = path.join(work, "addons", "alloy");
    await writeAddonFolder(alloyDir, alloyFiles, {
      dataDirs: ["data"],
      secrets: { grafana_cloud_credential: fakeSecret("github-token", `${run}:grafana`) },
    });
    // The app's folder and its masking file, as the deploy job writes it from app.env.
    await mkdir(hostRoot, { mode: 0o755 });
    const appFolder = path.join(hostRoot, path.dirname(maskPath));
    await mkdir(path.dirname(appFolder), { recursive: true, mode: 0o755 });
    await ownDir(appFolder, 0o750);
    await put(path.join(appFolder, "mask.re"), `(${knownValue})`);
    projects.alloy.file = path.join(alloyDir, "compose.yaml");
    for (const kind of ["beszel", "alloy"] as const) {
      const files = kind === "beszel" ? beszelFiles : alloyFiles;
      services[kind] = (parse(files.get("compose.yaml") ?? "") as typeof compose).services;
    }

    // The stand-ins for Grafana Cloud: Loki, and Prometheus with only what is written to it.
    await put(path.join(work, "prometheus.yml"), "global:\n  scrape_interval: 15s\n", 0o644);
    lokiPort = await freePort();
    prometheusPort = await freePort();
    const standIn = ["run", "-d", "--label", LABEL, "--label", RUN_LABEL];
    await dockerOk(
      [
        ...standIn,
        "--name",
        loki,
        "-p",
        `127.0.0.1:${lokiPort}:3100`,
        "--tmpfs",
        "/loki:mode=1777",
        LOKI,
      ],
      "starting Loki",
      TEN_MINUTES,
    );
    await dockerOk(
      [
        ...standIn,
        "--name",
        prometheus,
        "-p",
        `127.0.0.1:${prometheusPort}:9090`,
        "--tmpfs",
        "/prometheus:mode=1777",
        "-v",
        `${path.join(work, "prometheus.yml")}:/etc/prometheus/prometheus.yml:ro`,
        PROMETHEUS,
        "--config.file=/etc/prometheus/prometheus.yml",
        "--storage.tsdb.path=/prometheus",
        "--web.enable-remote-write-receiver",
      ],
      "starting Prometheus",
      TEN_MINUTES,
    );

    // The app: one container that logs a fake token and a value of app.env every second.
    projects.app.file = path.join(work, "app-compose.yaml");
    await put(
      projects.app.file,
      stringify({
        services: {
          web: {
            image: IMAGES.caddy.ref,
            labels: [LABEL, RUN_LABEL],
            entrypoint: ["sh", "-c"],
            command: [
              'i=0; while true; do i=$$((i+1)); echo "request $$i token=$$GITHUB_TOKEN password=$$DB_PASSWORD"; sleep 1; done',
            ],
            environment: { GITHUB_TOKEN: githubToken, DB_PASSWORD: knownValue },
          },
        },
      }),
      0o644,
    );
    await composeOk(projects.app, "starting the app", ["up", "-d", "--quiet-pull"], TEN_MINUTES);

    for (const project of [projects.beszel, projects.alloy]) {
      await composeOk(
        project,
        `starting ${project.name}`,
        ["up", "-d", "--quiet-pull"],
        TEN_MINUTES,
      );
    }
    for (const [container, alias] of [
      [loki, "loki"],
      [prometheus, "prometheus"],
    ] as const) {
      await dockerOk(
        ["network", "connect", "--alias", alias, `${projects.alloy.name}_default`, container],
        `connecting ${alias} to Alloy's network`,
      );
    }
    started = Date.now();
  }, TEN_MINUTES);

  afterAll(async () => {
    // The stand-ins first: they hold on to Alloy's network.
    await removeLabelled(RUN_LABEL);
    for (const project of Object.values(projects)) {
      if (project.file !== "") await composeOkQuiet(project);
      await removeLabelled(`com.docker.compose.project=${project.name}`);
    }
    await removeNewImages(before, [...pulled, IMAGES.alloy.ref, LOKI, PROMETHEUS]);
    if (work !== "") await rm(work, { recursive: true, force: true });
    await cleanupProject?.();
  }, TEN_MINUTES);

  /** `docker compose down -v`, reporting rather than failing (the label sweep follows). */
  async function composeOkQuiet(project: ComposeProject): Promise<void> {
    try {
      await composeOk(project, `removing ${project.name}`, ["down", "-v", "--timeout", "5"]);
    } catch (error) {
      console.warn(String(error));
    }
  }

  /** The containers of an add-on's project, by service. */
  async function addonContainers(kind: "beszel" | "alloy") {
    return projectContainers(projects[kind].name);
  }

  /**
   * Requests through the add-on's proxy socket from a container running as the deploy user (no
   * network, the proxy's volume): each `[method, path]` with its HTTP status.
   */
  async function throughProxy(
    kind: "beszel" | "alloy",
    requests: readonly (readonly [string, string])[],
  ): Promise<string[]> {
    const curl = (method: string, target: string) => {
      const how =
        method === "HEAD"
          ? "-I"
          : method === "POST"
            ? `-X POST -H 'Content-Type: application/json' -d '{"Cmd":["true"]}'`
            : `-X ${method}`;
      return `printf '%s %s %s\\n' "$(curl -s -o /dev/null -w '%{http_code}' -m 20 ${how} --unix-socket /run/opscrew-docker-ro/docker.sock 'http://docker${target}')" ${method} '${target}'`;
    };
    const output = await dockerOk(
      [
        "run",
        "--rm",
        "--label",
        LABEL,
        "--label",
        RUN_LABEL,
        "--network",
        "none",
        "--user",
        `${UID}:${GID}`,
        "-v",
        `${projects[kind].name}_docker_ro:/run/opscrew-docker-ro`,
        "--entrypoint",
        "sh",
        IMAGES.curl.ref,
        "-c",
        requests.map(([method, target]) => curl(method, target)).join("\n"),
      ],
      `requests through ${kind}'s proxy`,
    );
    return output.split("\n");
  }

  it(
    "passes each add-on's allow-list to Docker and refuses everything else with 403, the app untouched",
    async () => {
      const [web] = await projectContainers(app);
      if (web === undefined) throw new Error("The app's container is missing.");
      const id = (
        await dockerOk(["ps", "-q", "--no-trunc", "--filter", `name=^${web.name}$`], "the app's id")
      ).trim();
      const common = [
        ["GET", "/_ping"],
        ["HEAD", "/_ping"],
        ["GET", "/version"],
        ["GET", "/info"],
        ["GET", "/containers/json"],
        ["GET", "/v1.47/containers/json"],
        ["GET", `/containers/${id}/stats?stream=false`],
        ["GET", `/containers/${web.name}/stats?stream=false`],
      ] as const;
      const alloyOnly = [
        ["GET", "/networks"],
        ["GET", `/containers/${id}/json`],
        ["GET", `/containers/${id}/logs?stdout=1&tail=1`],
      ] as const;
      const refused = [
        ["POST", `/containers/${id}/stop?t=1`],
        ["POST", `/containers/${id}/exec`],
        ["GET", `/containers/${id}/archive?path=/etc`],
        ["GET", `/containers/${id}/export`],
        ["GET", "/images/json"],
        ["GET", "/v1.47/images/json"],
        ["GET", "/volumes"],
        ["DELETE", `/containers/${id}`],
        ["GET", "//images/json"],
        ["GET", `/containers/${id}%2Farchive?path=/etc`],
        ["GET", "/containers/json%2F..%2F..%2Fimages%2Fjson"],
      ] as const;
      const answers = (requests: readonly (readonly [string, string])[], code: string) =>
        requests.map(([method, target]) => `${code} ${method} ${target}`);
      expect(await throughProxy("beszel", [...common, ...alloyOnly, ...refused])).toEqual([
        ...answers(common, "200"),
        ...answers(alloyOnly, "403"),
        ...answers(refused, "403"),
      ]);
      expect(await throughProxy("alloy", [...common, ...alloyOnly, ...refused])).toEqual([
        ...answers([...common, ...alloyOnly], "200"),
        ...answers(refused, "403"),
      ]);
      const [after] = await projectContainers(app);
      expect(after).toMatchObject({ running: true, startedAt: web.startedAt, restarts: 0 });
    },
    TWO_MINUTES,
  );

  it(
    "runs every add-on container as the deploy user (the proxy as root in its group, without capabilities), writing its data as that user",
    async () => {
      for (const kind of ["beszel", "alloy"] as const) {
        const containers = await addonContainers(kind);
        expect(containers.map((c) => c.service).sort()).toEqual(
          Object.keys(services[kind] ?? {}).sort(),
        );
        const inspected = JSON.parse(
          await dockerOk(["inspect", ...containers.map((c) => c.name)], "inspecting the add-on"),
        ) as {
          Config: { User: string; Labels: Record<string, string> };
          HostConfig: {
            CapAdd: string[] | null;
            CapDrop: string[] | null;
            ReadonlyRootfs: boolean;
            SecurityOpt: string[] | null;
          };
        }[];
        for (const c of inspected) {
          const service = c.Config.Labels["com.docker.compose.service"];
          expect(c.HostConfig.ReadonlyRootfs, service).toBe(true);
          expect(c.HostConfig.CapDrop, service).toEqual(["ALL"]);
          expect(c.HostConfig.SecurityOpt, service).toContain("no-new-privileges:true");
          if (service === "proxy") {
            expect(c.Config.User).toBe(`0:${GID}`);
            expect(c.HostConfig.CapAdd?.map((cap) => cap.replace(/^CAP_/, ""))).toEqual([
              "NET_BIND_SERVICE",
            ]);
          } else {
            expect(c.Config.User, service).toBe(`${UID}:${GID}`);
            expect(c.HostConfig.CapAdd ?? [], service).toEqual([]);
          }
        }
      }
      // What each container wrote in its data folder is the deploy user's. (Beszel's data/config.yml
      // is Docker's own: the mount point it makes for the hub's read-only config.yml.)
      const mountPoint = await stat(path.join(work, "addons", "beszel", "data", "config.yml"));
      console.info(`addons/beszel/data/config.yml: ${mountPoint.uid}:${mountPoint.gid}`);
      const written = async (dir: string) => {
        const found = await until(`files in ${dir}`, async () => {
          const names = (await readdir(dir)).filter((name) => name !== "config.yml");
          const own = names.filter((name) => name !== "id_ed25519");
          return own.length > 0 ? names : undefined;
        });
        return Promise.all(
          found.map(async (name) => {
            const s = await stat(path.join(dir, name));
            return `${name} ${s.uid}:${s.gid}`;
          }),
        );
      };
      const owner = `${UID}:${GID}`;
      for (const dir of [
        path.join(work, "addons", "beszel", "data"),
        path.join(work, "addons", "beszel", "agent_data"),
        path.join(work, "addons", "alloy", "data"),
      ]) {
        const files = await written(dir);
        console.info(`${path.relative(work, dir)}: ${files.join(", ")}`);
        for (const file of files) expect(file).toMatch(new RegExp(` ${owner}$`));
      }
    },
    TWO_MINUTES,
  );

  it(
    "shows Beszel's one user this server and its containers, read through the proxy, with no users in config.yml",
    async () => {
      const config = await readFile(path.join(work, "addons", "beszel", "config.yml"), "utf8");
      expect(config).toContain(`token: "${beszel.token}"`);
      expect(config).not.toMatch(/users:/);
      const api = async (url: string, init?: RequestInit) => {
        const response = await fetch(`${BESZEL_LOCAL_URL}${url}`, init);
        if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
        return (await response.json()) as Record<string, unknown>;
      };
      const auth = await until(
        "Beszel's login",
        async () =>
          (await api("/api/collections/users/auth-with-password", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ identity: BESZEL_EMAIL, password: beszel.password }),
          })) as { token: string; record: { id: string } },
        TWO_MINUTES,
        2_000,
      );
      const headers = { authorization: auth.token };
      const system = await until(
        "the server up in Beszel",
        async () => {
          const { items } = (await api("/api/collections/systems/records", { headers })) as {
            items: { id: string; name: string; status: string; users: string[] }[];
          };
          expect(items.map((item) => item.name)).toEqual([app]);
          return items[0]?.status === "up" ? items[0] : undefined;
        },
        TWO_MINUTES,
        2_000,
      );
      expect(system.users).toEqual([auth.record.id]);
      const containers = await until(
        "the server's containers in Beszel",
        async () => {
          const { items } = (await api(
            `/api/collections/containers/records?perPage=500&filter=${encodeURIComponent(`system="${system.id}"`)}`,
            { headers },
          )) as { items: { name: string }[] };
          const names = items.map((item) => item.name);
          return names.includes(`${app}-web-1`) ? names : undefined;
        },
        TWO_MINUTES,
        2_000,
      );
      expect(containers).toEqual(
        expect.arrayContaining([`${projects.beszel.name}-hub-1`, `${projects.alloy.name}-alloy-1`]),
      );
    },
    TEN_MINUTES,
  );

  it(
    "sends the app's lines masked and labelled app, env and service, and only the allow-listed series",
    async () => {
      const lines = await until(
        "the app's lines in Loki",
        async () => {
          const query = new URLSearchParams({
            query: `{app="${app}"}`,
            since: "15m",
            limit: "1000",
          });
          const response = await fetch(
            `http://127.0.0.1:${lokiPort}/loki/api/v1/query_range?${query}`,
          );
          if (!response.ok) return undefined;
          const { data } = (await response.json()) as {
            data: { result: { stream: Record<string, string>; values: [string, string][] }[] };
          };
          const streams = data.result;
          return streams.flatMap((s) => s.values).length >= 5 ? streams : undefined;
        },
        TWO_MINUTES,
        3_000,
      );
      for (const stream of lines) {
        expect(stream.stream).toMatchObject({ app, env: environment, service: "web" });
      }
      const texts = lines.flatMap((s) => s.values.map(([, line]) => line));
      for (const text of texts) {
        expect(text).not.toContain(githubToken);
        expect(text).not.toContain(knownValue);
      }
      expect(texts).toContainEqual(
        expect.stringMatching(/token=<opscrew:github-token> password=<opscrew:known-value>$/),
      );

      const series = await until(
        "the server's series in Prometheus",
        async () => {
          const response = await fetch(
            `http://127.0.0.1:${prometheusPort}/api/v1/series?${new URLSearchParams({ "match[]": '{__name__=~".+"}' })}`,
          );
          if (!response.ok) return undefined;
          const { data } = (await response.json()) as { data: Record<string, string>[] };
          const names = new Set(data.map((s) => s.__name__));
          return SERIES.every((name) => names.has(name)) ? data : undefined;
        },
        TWO_MINUTES,
        3_000,
      );
      expect([...new Set(series.map((s) => s.__name__))].sort()).toEqual(SERIES);
      for (const s of series) expect(s).toMatchObject({ app, env: environment });
      const modes = new Set(
        series.filter((s) => s.__name__ === "node_cpu_seconds_total").map((s) => s.mode),
      );
      expect([...modes].every((mode) => CPU_MODES.includes(mode ?? ""))).toBe(true);
      const mounts = new Set(
        series.filter((s) => s.__name__?.startsWith("node_filesystem_")).map((s) => s.mountpoint),
      );
      expect([...mounts]).toEqual(["/"]);
      console.info(
        `Alloy sent ${series.length} series: ${[...modes].sort().join(", ")} CPU modes.`,
      );
    },
    TEN_MINUTES,
  );

  it(
    "keeps every add-on container within its memory limit after two minutes",
    async () => {
      const wait = started + SETTLE_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      for (const kind of ["beszel", "alloy"] as const) {
        const containers = await addonContainers(kind);
        expect(limitProblems(containers, services[kind] ?? {})).toEqual([]);
        for (const c of containers) {
          expect(c, c.name).toMatchObject({ running: true, oomKilled: false, restarts: 0 });
        }
        const stats = await dockerOk(
          [
            "stats",
            "--no-stream",
            "--format",
            "{{.Name}}\t{{.MemUsage}}",
            ...containers.map((c) => c.name),
          ],
          "reading the add-ons' memory",
        );
        for (const line of stats.split("\n")) {
          const [name, usage] = line.split("\t");
          const [used, limit] = (usage ?? "").split("/").map((part) => bytes(part));
          const container = containers.find((c) => c.name === name);
          console.info(`${name}: ${usage}`);
          expect(limit, name).toBe(container?.memory);
          expect(used, name).toBeLessThan(container?.memory ?? 0);
        }
      }
    },
    TEN_MINUTES,
  );
});

describe.skipIf(SKIP !== undefined)("the check key under OpsCrew's sshd settings (017)", () => {
  const run = unique("check-key");
  const RUN_LABEL = `opscrew.test.run=${run}`;
  const image = `${run}:1`;
  const server = `${run}-server`;
  const repository = "acme/shop";
  const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });
  const checkKey = generateEd25519KeyPair("opscrew-check@test");
  let before = new Set<string>();
  let work = "";
  /** ssh as the scheduled check runs it (`check.mjs`'s `sshDf`), up to the login. */
  let checkSsh: string[] = [];

  beforeAll(async () => {
    before = await imageIds();
    work = await tempDir("opscrew-check-key-");
    const dropIn = sshdDropIn({
      permitRootLogin: "no",
      disablePasswords: true,
      kbdInteractiveOff: true,
      moduliFile: false,
    });
    const dockerfile = `FROM ${UBUNTU}
RUN apt-get update -qq \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd --create-home --shell /bin/bash deploy \\
 && install -d -m 0755 /run/sshd \\
 && printf '%s' '${Buffer.from(dropIn).toString("base64")}' | base64 -d > /etc/ssh/sshd_config.d/10-opscrew.conf
`;
    const built = await runner.run(
      DOCKER ?? "docker",
      ["build", "-q", "--label", LABEL, "--label", RUN_LABEL, "-t", image, "-"],
      { input: dockerfile, timeoutMs: TEN_MINUTES },
    );
    expect(built.exitCode, tail(built.stderr)).toBe(0);
    const port = await freePort();
    await dockerOk(
      [
        "run",
        "-d",
        "--name",
        server,
        "--label",
        LABEL,
        "--label",
        RUN_LABEL,
        "-p",
        `127.0.0.1:${port}:22`,
        image,
        "sh",
        "-c",
        "ssh-keygen -A > /dev/null && exec /usr/sbin/sshd -D -e",
      ],
      "starting the server",
    );
    // The deploy key, as a server OpsCrew created has it.
    const deployKey = generateEd25519KeyPair("opscrew-deploy@check-key");
    const deployKeyFile = path.join(work, "deploy_key");
    await put(deployKeyFile, deployKey.privateKeyOpenSsh);
    await dockerOk(
      [
        "exec",
        "-u",
        "deploy",
        server,
        "sh",
        "-c",
        `umask 077 && mkdir -p ~/.ssh && printf '%s\\n' '${deployKey.publicKeyOpenSsh}' > ~/.ssh/authorized_keys`,
      ],
      "adding the deploy key",
    );
    const hostKey = await until("the server's host key", async () =>
      (await dockerOk(["exec", server, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"], "host key"))
        .split(" ")
        .slice(0, 2)
        .join(" "),
    );
    const knownHosts = path.join(work, "known_hosts");
    await put(knownHosts, `[127.0.0.1]:${port} ${hostKey}\n`);
    const remote = new SshRemoteExec({
      host: "127.0.0.1",
      port,
      keyFile: deployKeyFile,
      knownHostsFile: knownHosts,
      runner,
    });
    await until("the deploy user's login", async () =>
      (await remote.run("true")).exitCode === 0 ? true : undefined,
    );

    // The check-key host step, applied as provision applies it on a server OpsCrew created.
    const plan = planAddon("check-key", {
      app: "shop",
      runAs: "login",
      repository,
      enable: { publicKey: checkKey.publicKeyOpenSsh },
    });
    const applied = await applyHostPlan(remote, plan, {
      approvedHash: hostPlanHash(plan),
      command: "opscrew provision",
      verifyLogin: async () => true,
    });
    expect(applied.applied).toEqual(["check-key"]);
    // The ordinary deploy key beside it works as before.
    expect((await remote.run("id -un")).stdout.trim()).toBe("deploy");

    const checkKeyFile = path.join(work, "check_key");
    await put(checkKeyFile, checkKey.privateKeyOpenSsh);
    checkSsh = [
      "-i",
      checkKeyFile,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      "-p",
      String(port),
    ];
  }, TEN_MINUTES);

  afterAll(async () => {
    await removeLabelled(RUN_LABEL);
    await removeNewImages(before, [UBUNTU]);
    if (work !== "") await rm(work, { recursive: true, force: true });
  }, TWO_MINUTES);

  /** `df -P -B1 /`'s table: its header, and one line for `/`. */
  const DF =
    /^Filesystem\s+1-blocks\s+Used\s+Available\s+Capacity\s+Mounted on\n\S+(\s+\d+){3}\s+\d+%\s+\/\n$/;

  it(
    "writes the restricted line beside the deploy key",
    async () => {
      const keys = await dockerOk(
        ["exec", server, "cat", "/home/deploy/.ssh/authorized_keys"],
        "reading authorized_keys",
      );
      const lines = keys.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe(
        `restrict,command="df -P -B1 /" ${checkKey.publicKeyOpenSsh.split(" ").slice(0, 2).join(" ")} opscrew-check:${repository}`,
      );
    },
    TWO_MINUTES,
  );

  it(
    "answers df to whatever the check key asks, and runs nothing else",
    async () => {
      await dockerOk(["exec", "-u", "deploy", server, "mkdir", "/tmp/x"], "making /tmp/x");
      for (const command of [["rm", "-rf", "/tmp/x"], ["bash"], []]) {
        const result = await runner.run(
          SSH ?? "ssh",
          [...checkSsh, "deploy@127.0.0.1", ...command],
          { input: "touch /tmp/y\n", timeoutMs: TWO_MINUTES },
        );
        expect(result.exitCode, `${command.join(" ")}: ${result.stderr}`).toBe(0);
        expect(result.stdout, command.join(" ")).toMatch(DF);
      }
      expect((await docker(["exec", server, "test", "-d", "/tmp/x"])).exitCode).toBe(0);
      expect((await docker(["exec", server, "test", "-e", "/tmp/y"])).exitCode).not.toBe(0);
    },
    TWO_MINUTES,
  );

  it(
    "refuses a port forward",
    async () => {
      const local = await freePort();
      let stderr = "";
      const forward: ChildProcess = spawn(
        SSH ?? "ssh",
        [...checkSsh, "-N", "-L", `${local}:127.0.0.1:22`, "deploy@127.0.0.1"],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      forward.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      try {
        // Through a working forward, the server's own sshd would greet with its banner.
        const received = await until(
          "a connection through the forward",
          () =>
            new Promise<string | undefined>((resolve) => {
              let data = "";
              const socket = connect(local, "127.0.0.1");
              socket.setTimeout(10_000, () => socket.destroy());
              socket.on("data", (chunk) => {
                data += chunk.toString();
              });
              socket.on("error", () => resolve(undefined));
              socket.on("close", (failed) => resolve(failed ? undefined : data));
            }),
        );
        expect(received).toBe("");
        await until("ssh's refusal", async () =>
          stderr.includes("administratively prohibited") ? true : undefined,
        );
      } finally {
        forward.kill();
      }
    },
    TWO_MINUTES,
  );
});
