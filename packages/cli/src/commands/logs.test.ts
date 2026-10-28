import { setTimeout as delay } from "node:timers/promises";
import { recordServerAddress } from "@opscrew/agents";
import { FakeDocker, type FakeLogLine, SERVER_IPV4, testPlan } from "@opscrew/agents/testing";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { writeSitePlan } from "../ui/__fixtures__/site";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** A line logged at 11:mm (UTC) on the test clock's day. */
function at(minute: number, text: string): FakeLogLine {
  return {
    time: `2026-10-11T11:${String(minute).padStart(2, "0")}:00.000000123Z`,
    stream: "stdout",
    text,
  };
}

/**
 * A deployed Hetzner app with a worker, whose server at {@link SERVER_IPV4} runs `docker`; the
 * test's `stop` stands for Ctrl-C, and `ended` counts the process's ends after a follow.
 */
async function setup(docker: FakeDocker) {
  project = await tempProject();
  const paths = resolveProjectPaths(project.root, { env: project.env });
  const base = testPlan({ deployed: true, userSecret: false });
  await writeArtifact(
    "plan",
    paths.files.plan,
    DeployPlanSchema.parse({
      ...base,
      processes: { workers: [{ name: "worker", command: "node worker.js", source: "procfile" }] },
    }),
  );
  await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  const signals = { stop: undefined as (() => void) | undefined, released: 0, ended: 0 };
  const ctx = projectContext(project);
  withServices(ctx, {
    logs: { remote: (host) => docker.remote(host) },
    onStop: (stop) => {
      signals.stop = stop;
      return () => {
        signals.released += 1;
      };
    },
    endProcess: () => {
      signals.ended += 1;
    },
  });
  return { ctx, signals };
}

describe("opscrew logs", () => {
  it("prints how far back the lines go, then each line with its time and part", async () => {
    const docker = new FakeDocker([
      { name: "shop-app-1", project: "shop", service: "app", lines: [at(0, "listening on 3000")] },
    ]);
    const { ctx, signals } = await setup(docker);
    expect(await run(ctx, "logs"), ctx.errors).toBe(0);
    expect(ctx.output).toContain(
      [
        "The oldest line here is from 2026-10-11 11:00 UTC. Each deploy starts new containers, and each keeps up to 30 MB of logs.",
        "2026-10-11T11:00:00.000000123Z app listening on 3000",
        "",
      ].join("\n"),
    );
    // Without --follow nothing listens for Ctrl-C, and the process ends as usual.
    expect(signals.stop).toBeUndefined();
    expect(signals.ended).toBe(0);
  });

  it("passes --service, --since and --tail", async () => {
    const docker = new FakeDocker([
      {
        name: "shop-worker-1",
        project: "shop",
        service: "worker",
        lines: [at(50, "a"), at(55, "b"), at(58, "c")],
      },
    ]);
    const { ctx } = await setup(docker);
    const code = await run(ctx, "logs", "--service", "worker", "--since", "15m", "--tail", "2");
    expect(code, ctx.errors).toBe(0);
    expect(docker.commands.at(-1)).toMatch(
      /^docker logs --timestamps --tail 2 --since \d+ shop-worker-1$/,
    );
    expect(ctx.output).toContain("worker b\n");
    expect(ctx.output).toContain("worker c\n");
    expect(ctx.output).not.toContain("worker a\n");
  });

  it("refuses an unknown part with the names there are, and a --tail that is not a count", async () => {
    const docker = new FakeDocker([]);
    const { ctx } = await setup(docker);
    expect(await run(ctx, "logs", "--service", "nope")).toBe(2);
    expect(ctx.errors).toContain('The app has no part named "nope".');
    expect(ctx.errors).toContain("worker");
    const tail = (await setup(docker)).ctx;
    expect(await run(tail, "logs", "--tail", "lots")).toBe(2);
    expect(tail.errors).toContain("--tail takes a positive whole number of lines.");
  });

  it("masks a secret the app printed", async () => {
    const token = fakeSecret("github-pat", "cli-logs");
    const docker = new FakeDocker([
      {
        name: "shop-app-1",
        project: "shop",
        service: "app",
        lines: [at(1, `token=${token}`)],
      },
    ]);
    const { ctx } = await setup(docker);
    expect(await run(ctx, "logs"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("app token=");
    expect(ctx.output).not.toContain(token);
  });

  it("--follow shows new lines until Ctrl-C stops it, then ends the process", async () => {
    const docker = new FakeDocker([
      { name: "shop-app-1", project: "shop", service: "app", lines: [at(1, "started")] },
    ]);
    const { ctx, signals } = await setup(docker);
    const running = run(ctx, "logs", "--follow");
    while (docker.following === 0) await delay(5);
    docker.log("shop-app-1", at(2, "GET / 200"));
    expect(signals.ended).toBe(0);
    signals.stop?.();
    expect(await running, ctx.errors).toBe(0);
    expect(ctx.output).toContain("app started\n");
    expect(ctx.output).toContain("app GET / 200\n");
    expect(docker.following).toBe(0);
    expect(signals.released).toBe(1);
    expect(signals.ended).toBe(1);
  });

  it.each([
    ["github-pages", "GitHub Pages"],
    ["cloudflare-workers", "Cloudflare"],
  ] as const)(
    "on %s (no request logs), refuses --follow and --service with the reason",
    async (provider, host) => {
      project = await tempProject();
      await writeSitePlan(project, provider);
      for (const flag of [["--follow"], ["--service", "app"]]) {
        const ctx = projectContext(project);
        withServices(ctx, { endProcess: () => {}, onStop: () => () => {} });
        expect(await run(ctx, "logs", ...flag)).toBe(2);
        expect(ctx.errors).toContain(
          `${host} keeps no request logs for this site: its files are served without running any code`,
        );
        expect(ctx.errors).toContain(`without ${flag[0]} to see the site's last deploy runs`);
      }
    },
  );

  it("shows its options in --help", async () => {
    project = await tempProject();
    const ctx = projectContext(project);
    expect(await run(ctx, "logs", "--help")).toBe(0);
    for (const option of [
      "--follow",
      "--service <name>",
      "--since <duration>",
      "--tail <lines>",
      "--app <key>",
      "--env <name>",
      "--host-key <fingerprint>",
    ]) {
      expect(ctx.output).toContain(option);
    }
  });
});
