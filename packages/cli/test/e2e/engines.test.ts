/**
 * The catalog's search and analytics engines (T1311) on Docker: each is rendered into OpsCrew's
 * server Compose file for a Hetzner server (`renderCompose`, adapted to this computer like the
 * Docker pass's) and started alone, as the deploy starts the services (`up -d --no-deps --wait`,
 * after the one-shot `sysctl` container where the engine needs a kernel setting), one at a time
 * because their memory adds up. Each must:
 * - pass its health check, with its memory limit;
 * - require its login (Elasticsearch, Typesense, Neo4j), or answer without one on the app's
 *   network (OpenSearch, whose security plugin is off);
 * - show the image facts the catalog relies on: curl in the OpenSearch and Elasticsearch images
 *   (their health checks) and OpenSearch 3.9 honouring DISABLE_SECURITY_PLUGIN and
 *   DISABLE_INSTALL_DEMO_CONFIG; bash with `/dev/tcp` in the Typesense and Neo4j images; Neo4j's
 *   `/logs` among the volumes OpsCrew mounts (no anonymous volume); busybox wget in
 *   Meilisearch's; wget in ClickHouse's, and ClickHouse starting with `remove="1"` on the log
 *   tables it turns off.
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon.
 * OPSCREW_DOCKER_ENGINES=a,b limits the run to those kinds. Each Compose project is removed with
 * its volumes; the engines' images stay, as base images do.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AppEnvironment, assembleAppEnv, serviceEnvSecrets } from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import {
  hostSettingsServices,
  IMAGES,
  renderCompose,
  serviceEnvSecret,
  serviceSpec,
} from "@opscrew/iac-templates";
import { type DeployPlan, PlanServiceSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  type ComposeProject,
  type ComposeService,
  compose,
  docker,
  dockerSkipReason,
  LABEL,
  limitProblems,
  localServerCompose,
  type ProjectContainer,
  projectContainers,
  runtimeFiles,
  TEN_MINUTES,
  TWO_MINUTES,
  tail,
} from "./docker-support";

const ENGINES = [
  "opensearch",
  "elasticsearch",
  "typesense",
  "neo4j",
  "meilisearch",
  "clickhouse",
] as const;
type Engine = (typeof ENGINES)[number];

/** OPSCREW_DOCKER_ENGINES=a,b, or every engine. */
const REQUESTED = process.env.OPSCREW_DOCKER_ENGINES?.split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const RUN = ENGINES.filter((kind) => !REQUESTED?.length || REQUESTED.includes(kind));

const SKIP = dockerSkipReason();
if (SKIP !== undefined) console.warn(`Skipping the engines check: ${SKIP}.`);

/**
 * The engines with a login, each with a request on its network (curl's URL and options) and the
 * curl options that log in with its generated secret (`secret(name)`).
 */
const LOGINS: Partial<
  Record<
    Engine,
    (secret: (name: string) => string) => { url: string; request: string[]; login: string[] }
  >
> = {
  elasticsearch: (secret) => ({
    url: "http://elasticsearch:9200/",
    request: [],
    login: ["-u", `elastic:${secret("password")}`],
  }),
  typesense: (secret) => ({
    url: "http://typesense:8108/collections",
    request: [],
    login: ["-H", `X-TYPESENSE-API-KEY: ${secret("api-key")}`],
  }),
  neo4j: (secret) => ({
    url: "http://neo4j:7474/db/neo4j/tx/commit",
    request: ["-X", "POST", "-H", "Content-Type: application/json", "-d", '{"statements":[]}'],
    login: ["-u", `neo4j:${secret("password")}`],
  }),
};

/** A Hetzner plan whose one service is `kind`, with the catalog's version and memory. */
function enginePlan(kind: Engine): DeployPlan {
  const spec = serviceSpec(kind);
  const service = PlanServiceSchema.parse({
    kind,
    version: spec.defaultVersion,
    memoryMb: spec.memory.defaultMb,
    reason: `The engines check runs ${spec.title}.`,
    licence: spec.licence.id,
  });
  return { ...testPlan({ postgres: false, userSecret: false }), services: [service] };
}

describe.skipIf(SKIP !== undefined)(
  SKIP === undefined ? "the catalog's engines" : `the catalog's engines (skipped: ${SKIP})`,
  () => {
    it("OPSCREW_DOCKER_ENGINES names only engines the check knows", () => {
      const unknown = (REQUESTED ?? []).filter(
        (name) => !(ENGINES as readonly string[]).includes(name),
      );
      expect(unknown, `known engines: ${ENGINES.join(", ")}`).toEqual([]);
    });

    describe.each(RUN)("%s", (kind) => {
      const plan = enginePlan(kind);
      const spec = serviceSpec(kind);
      // The engine and the one-shot container it waits for, as the deploy names them.
      const steady = [...hostSettingsServices(plan), kind];
      const project: ComposeProject = { name: `opscrew-engine-${kind}-${Date.now()}`, file: "" };
      let dir = "";
      let environment: AppEnvironment | undefined;
      let started: ProjectContainer | undefined;

      /** The engine's generated secret `name`. */
      function secret(name: string): string {
        const value = environment?.values.services[kind]?.[name];
        if (value === undefined) throw new Error(`${kind} has no secret ${name}.`);
        return value;
      }

      /** The engine's container, once the first test started it. */
      function engine(): ProjectContainer {
        if (started === undefined) throw new Error(`${kind} is not running (see the first test).`);
        return started;
      }

      /** `args` in the engine's container. */
      function exec(...args: string[]) {
        return docker(["exec", engine().name, ...args]);
      }

      /** The HTTP status curl gets from `url` on the engine's network, with curl's `options`. */
      async function status(url: string, ...options: string[]): Promise<string> {
        const result = await docker([
          "run",
          "--rm",
          "--label",
          LABEL,
          "--network",
          `${project.name}_internal`,
          IMAGES.curl.ref,
          ...["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20"],
          ...options,
          url,
        ]);
        return result.stdout.trim();
      }

      beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), `opscrew-engine-${kind}-`));
        // Without the app.
        const doc = parse(localServerCompose(plan)) as {
          services: Record<string, ComposeService>;
        };
        doc.services = Object.fromEntries(steady.map((name) => [name, doc.services[name] ?? {}]));
        project.file = path.join(dir, "compose.yaml");
        await writeFile(project.file, stringify(doc, { lineWidth: 0 }));
        environment = await assembleAppEnv({ plan, ask: async () => ({ skip: true }) });
        const text = serviceEnvSecrets(plan, environment)[serviceEnvSecret(kind)];
        if (text !== undefined) await writeFile(path.join(dir, `${kind}.env`), text);
      });

      afterAll(async () => {
        await compose(project, ["down", "-v", "--remove-orphans"]);
        await rm(dir, { recursive: true, force: true });
      }, TWO_MINUTES);

      it(
        "starts alone with its memory limit, and its health check passes",
        async () => {
          const began = Date.now();
          const up = await compose(
            project,
            ["up", "-d", "--no-deps", "--wait", ...steady],
            TEN_MINUTES,
          );
          if (up.exitCode !== 0) {
            const logs = await compose(project, ["logs", "--tail", "60"]);
            throw new Error(
              `${kind} did not become healthy (exit ${up.exitCode}):\n${tail(up.stderr, 20)}\nIts log:\n${tail(logs.stdout, 60)}`,
            );
          }
          console.info(`${kind}: healthy ${Math.round((Date.now() - began) / 1000)} s after up`);
          const containers = await projectContainers(project.name);
          const services = (
            parse(renderCompose(plan).content) as {
              services: Record<string, ComposeService>;
            }
          ).services;
          expect(limitProblems(containers, services), `${kind}: memory limits`).toEqual([]);
          started = containers.find((c) => c.service === kind);
          expect(started?.running, `${kind} runs`).toBe(true);
          // On a cloud server the one-shot container sets the host's kernel setting first.
          const sysctl = containers.find((c) => c.service === "sysctl");
          if (spec.hostSettings !== undefined) {
            expect(sysctl, "the sysctl container").toMatchObject({ running: false, exitCode: 0 });
          } else {
            expect(sysctl, "a sysctl container").toBeUndefined();
          }
        },
        TEN_MINUTES + TWO_MINUTES,
      );

      it.runIf(kind === "opensearch")(
        "answers without a login on its network, with no demo certificates",
        async () => {
          expect(await status("http://opensearch:9200/")).toBe("200");
          const config = await exec("ls", "-1A", "/usr/share/opensearch/config");
          expect(config.exitCode, config.stderr).toBe(0);
          const pem = config.stdout.split(/\r?\n/).filter((file) => file.endsWith(".pem"));
          expect(pem, "demo certificates").toEqual([]);
        },
        TWO_MINUTES,
      );

      it.runIf(LOGINS[kind] !== undefined)(
        "refuses a request without its login and answers it with the login",
        async () => {
          const check = LOGINS[kind];
          if (check === undefined) return;
          const { url, request, login } = check(secret);
          expect(await status(url, ...request), "without the login").toBe("401");
          expect(await status(url, ...request, ...login), "with the login").toBe("200");
        },
        TWO_MINUTES,
      );

      it(
        "has the tools and volumes the catalog relies on",
        async () => {
          if (kind === "opensearch" || kind === "elasticsearch") {
            const curl = await exec("curl", "--version");
            expect(curl.exitCode, `curl in the ${kind} image: ${curl.stderr}`).toBe(0);
          }
          if (kind === "typesense" || kind === "neo4j") {
            const open = await exec(
              "bash",
              "-c",
              `exec 3<>/dev/tcp/127.0.0.1/${kind === "neo4j" ? 7474 : 8108}`,
            );
            expect(open.exitCode, `bash with /dev/tcp in the ${kind} image: ${open.stderr}`).toBe(
              0,
            );
          }
          if (kind === "neo4j") {
            const volumes = engine().mounts.filter((m) => m.type === "volume");
            expect(
              volumes.map((m) => `${m.destination} ${m.name}`).sort(),
              "Neo4j's volumes: none anonymous",
            ).toEqual([`/data ${project.name}_neo4j-data`, `/logs ${project.name}_neo4j-logs`]);
          }
          if (kind === "meilisearch") {
            const wget = await exec("sh", "-c", 'readlink -f "$(command -v wget)"');
            expect(wget.stdout.trim(), `wget in the Meilisearch image: ${wget.stderr}`).toBe(
              "/bin/busybox",
            );
          }
          if (kind === "clickhouse") {
            const wget = await exec("wget", "-q", "-O-", "http://127.0.0.1:8123/ping");
            expect(wget.stdout.trim(), `wget in the ClickHouse image: ${wget.stderr}`).toBe("Ok.");
            // The server started with OpsCrew's `remove="1"` on log tables, also on those the
            // image's own config.xml does not define, and none is left in its merged config.
            const settings = runtimeFiles(plan).get("services/clickhouse/server.xml") ?? "";
            const removed = [...settings.matchAll(/<(\w+) remove="1" \/>/g)].map(
              (match) => match[1] as string,
            );
            expect(removed.length, "the log tables OpsCrew turns off").toBeGreaterThan(0);
            /** The removed tables `file` defines, outside its comments. */
            const defined = async (file: string) => {
              const found = await exec("cat", file);
              expect(found.exitCode, `${file}: ${found.stderr}`).toBe(0);
              const xml = found.stdout.replace(/<!--[\s\S]*?-->/g, "");
              return removed.filter((table) => xml.includes(`<${table}>`));
            };
            const own = await defined("/etc/clickhouse-server/config.xml");
            const undefinedHere = removed.filter((table) => !own.includes(table));
            console.info(
              `${kind}: OpsCrew turns off ${removed.join(", ")}; the image's config.xml does not define ${undefinedHere.join(", ") || "any of them"}`,
            );
            expect(
              await defined("/var/lib/clickhouse/preprocessed_configs/config.xml"),
              "log tables left in the merged config",
            ).toEqual([]);
          }
        },
        TWO_MINUTES,
      );
    });
  },
);
