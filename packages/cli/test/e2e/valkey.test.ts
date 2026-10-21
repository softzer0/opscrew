/**
 * Valkey's password on Docker (quickstart.md "Local Docker pass" 5, research.md R6):
 * `examples/node-bullmq` is designed by the real CLI (its queue is Valkey), and its Compose file
 * (`renderCompose`, adapted to this computer like the Docker pass's) runs the queue the way a
 * server ran it before 014, without a password, with a queued job and a value in it. The next
 * deploy, with OpsCrew's file and the queue's env file as provision assembles it, restarts Valkey
 * once with the password on the same volume. Then:
 * - `valkey-cli PING` without the password is refused, and answered with it;
 * - the job and the value are still there (the append-only file on the volume);
 * - neither Valkey's log nor its command line shows the password.
 *
 * The example's job running through the app and its worker with the password is the Docker pass's
 * (`docker.test.ts`, example node-bullmq), so it is not repeated here.
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon and git. The
 * Compose project is removed with its volumes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assembleAppEnv, serviceEnvSecrets } from "@opscrew/agents";
import { IMAGES, serviceEnvSecret } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { GIT, type TempProject } from "../../src/ui/__fixtures__/harness";
import {
  type ComposeProject,
  compose,
  composeOk,
  docker,
  dockerSkipReason,
  localServerCompose,
  TEN_MINUTES,
  TWO_MINUTES,
} from "./docker-support";
import { designedPlan, unique, until } from "./edge-support";

const SKIP = dockerSkipReason() ?? (GIT === undefined ? "git is not installed" : undefined);
if (SKIP !== undefined) console.warn(`Skipping Valkey's password on Docker: ${SKIP}.`);

/** A BullMQ job's keys as the queue keeps them, and a plain value. */
const DATA = [
  ["HSET", "bull:jobs:1", "name", "welcome", "data", '{"to":"user@example.com"}'],
  ["RPUSH", "bull:jobs:wait", "1"],
  ["SET", "opscrew:check", "survived"],
];

describe.skipIf(SKIP !== undefined)("Valkey's password on Docker (014)", () => {
  let project: TempProject | undefined;
  let plan: DeployPlan;
  let queue = "";
  let password = "";
  let server: ComposeProject;
  let before: ComposeProject;

  beforeAll(async () => {
    const designed = await designedPlan("node-bullmq", {});
    project = designed.project;
    plan = designed.plan;
    const service = plan.services.find((s) => s.enabled && s.kind === "valkey");
    if (service === undefined) throw new Error("node-bullmq's plan has no Valkey.");
    queue = service.name;
    const environment = await assembleAppEnv({ plan, ask: async () => ({ skip: true }) });
    password = environment.values.services[queue]?.password ?? "";
    expect(password, "the generated password").not.toBe("");
    const dir = path.join(project.dir, "server");
    const name = unique("valkey");
    const file = path.join(dir, "compose.yaml");
    await mkdir(dir, { recursive: true });
    const env = serviceEnvSecrets(plan, environment)[serviceEnvSecret(queue)];
    if (env === undefined) throw new Error(`No env file for ${queue}.`);
    await writeFile(path.join(dir, `${queue}.env`), env);
    // The deploy's `.env` names the app's image; the app is not started here.
    await writeFile(path.join(dir, ".env"), `APP_IMAGE=${IMAGES.curl.ref}\n`);
    // The server's Compose file, and the same file as a server had it before 014: the queue
    // started without the password file.
    const local = localServerCompose(plan);
    await writeFile(file, local);
    const doc = parse(local) as { services: Record<string, { command?: string[] }> };
    const command = doc.services[queue]?.command ?? [];
    const args = /exec docker-entrypoint\.sh valkey-server \S+ (.*)$/.exec(
      command.at(-1) ?? "",
    )?.[1];
    if (args === undefined)
      throw new Error(`Unexpected command for ${queue}: ${command.join(" ")}`);
    const old = doc.services[queue];
    if (old !== undefined)
      old.command = ["sh", "-c", `exec docker-entrypoint.sh valkey-server ${args}`];
    const beforeFile = path.join(dir, "compose.before.yaml");
    await writeFile(beforeFile, stringify(doc, { lineWidth: 0 }));
    server = { name, file };
    before = { name, file: beforeFile };
  }, TEN_MINUTES);

  afterAll(async () => {
    if (server !== undefined) await compose(server, ["down", "-v", "--remove-orphans"]);
    await project?.cleanup();
  }, TWO_MINUTES);

  /** `valkey-cli <args>` in the queue's container, with the password or without it. */
  async function cli(project: ComposeProject, withPassword: boolean, ...args: string[]) {
    const result = await compose(project, [
      "exec",
      "-T",
      ...(withPassword ? ["-e", `REDISCLI_AUTH=${password}`] : []),
      queue,
      "valkey-cli",
      "--no-auth-warning",
      ...args,
    ]);
    return result.stdout.trim();
  }

  it(
    "starts the queue as before 014, without a password, and keeps a job and a value",
    async () => {
      await composeOk(
        before,
        "the queue without a password",
        ["up", "-d", "--no-deps", queue],
        TEN_MINUTES,
      );
      await until("Valkey answering", async () =>
        (await cli(before, false, "PING")) === "PONG" ? true : undefined,
      );
      for (const words of DATA) expect(await cli(before, false, ...words)).not.toMatch(/ERR/);
    },
    TEN_MINUTES,
  );

  it(
    "restarts once with the password: refuses PING without it, answers with it, and keeps the data",
    async () => {
      const id = async () => (await compose(server, ["ps", "-q", queue])).stdout.trim();
      const was = await id();
      await composeOk(
        server,
        "the queue with OpsCrew's file",
        ["up", "-d", "--no-deps", "--wait", queue],
        TEN_MINUTES,
      );
      expect(await id(), "Compose recreated the queue").not.toBe(was);
      expect(await cli(server, false, "PING")).toMatch(/^NOAUTH/);
      expect(await cli(server, true, "PING")).toBe("PONG");
      expect(await cli(server, true, "GET", "opscrew:check")).toBe("survived");
      expect(await cli(server, true, "LRANGE", "bull:jobs:wait", "0", "-1")).toBe("1");
      expect(await cli(server, true, "HGET", "bull:jobs:1", "name")).toBe("welcome");

      const container = await id();
      const logs = await docker(["logs", container]);
      expect(`${logs.stdout}${logs.stderr}`.includes(password), "in its log").toBe(false);
      const cmdline = await compose(server, ["exec", "-T", queue, "cat", "/proc/1/cmdline"]);
      expect(cmdline.stdout).toContain("valkey-server");
      expect(cmdline.stdout.includes(password), "on its command line").toBe(false);
      const inspected = await docker(["inspect", "--format", "{{json .Config.Cmd}}", container]);
      expect(inspected.stdout.includes(password), "in the container's command").toBe(false);
    },
    TEN_MINUTES,
  );
});
