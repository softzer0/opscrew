import { existsSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalRequest, CommandResult } from "@opscrew/contracts";
import { DEPLOY_PAUSED_VARIABLE, shellQuote } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan } from "../localhost/__fixtures__/computer";
import { lockFile } from "../localhost/lock";
import { appFolder, ownerFile } from "../localhost/services";
import { localSite } from "../localhost/site";
import { localRenderContext, localStackFiles } from "../localhost/stack";
import { blobOf, cleanDrift, commitOf, digestOf } from "../promote/__fixtures__/world";
import {
  createTestPhaseDeps,
  DEPLOYED_AT,
  ScriptedApprovalHandler,
  ScriptedRunner,
} from "../testing";
import { FakeRollbackGitHub, failure, planHash, YES_KINDS } from "./__fixtures__/versions";
import { type RollbackOptions, rollback } from "./index";
import { imageRollbackHash, readRollback, rollbackFile } from "./record";

/** The images of the app on GHCR: the one running, and the one it ran before. */
const RUNNING = `ghcr.io/acme/shop@${digestOf("running")}`;
const PREVIOUS = `ghcr.io/acme/shop@${digestOf("previous")}`;
const COMMAND = "opscrew rollback --env prod";
/** The test deps' clock. */
const CLOCK = "2026-10-11T12:00:00.000Z";

/** The start script, given the image and its rollback mode. */
const SWITCH = /^set -- \S+ rollback\n/;

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

/**
 * `shop` on this computer, deployed twice: `.env` names `RUNNING`, `.env.previous` `PREVIOUS`,
 * which Docker still has. With `runner`, the local runner deploys it from main, and GHCR's
 * provenance says `PREVIOUS` was built from the commit of `previous`. `events` records, in order,
 * each approval, each write of the pause variable and each script the shell ran.
 */
async function localWorld(
  o: { runner?: boolean; approve?: (request: ApprovalRequest) => boolean } = {},
) {
  const events: string[] = [];
  const computer = new FakeComputer();
  const missing = new Set<string>();
  const runner = new ScriptedRunner((command, args, options) => {
    if (command === "git" && args.includes("get-url")) {
      return ok("https://github.com/acme/shop.git\n");
    }
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
      return missing.has(args[2] as string)
        ? { exitCode: 1, stdout: "", stderr: "Error: No such image" }
        : ok("[]");
    }
    return computer.runner.run(command, args, options);
  });
  const handler = new ScriptedApprovalHandler((request) => {
    const locked = existsSync(lockFile(deps.paths)) ? " (locked)" : "";
    events.push(`approve:${request.kind}${locked}`);
    return o.approve?.(request) ?? true;
  });
  const deps = await createTestPhaseDeps({ runner, approvalHandler: handler });
  const plan: DeployPlan = DeployPlanSchema.parse({
    ...localPlan({ image: "registry" }),
    deployment: { lastApplyAt: DEPLOYED_AT },
    ...(o.runner === true ? { environment: { runner: "local" } } : {}),
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const folder = appFolder(deps.paths, plan);
  await mkdir(folder, { recursive: true });
  const images = async (running: string, previous?: string) => {
    await writeFile(join(folder, ".env"), `APP_IMAGE=${running}\n`);
    if (previous === undefined) await rm(join(folder, ".env.previous"), { force: true });
    else await writeFile(join(folder, ".env.previous"), `APP_IMAGE=${previous}\n`);
  };
  await images(RUNNING, PREVIOUS);

  const locked: boolean[] = [];
  computer.script = (script) => {
    events.push(
      SWITCH.test(script)
        ? "switch"
        : script.includes("docker login")
          ? "login"
          : script.includes("docker logout")
            ? "logout"
            : script.includes("cp .env .env.previous")
              ? "keep"
              : "switch back",
    );
    locked.push(existsSync(lockFile(deps.paths)));
    return ok();
  };

  const github = new FakeRollbackGitHub();
  github.build(digestOf("previous"), {
    runId: 300,
    commit: commitOf("previous"),
    environment: "prod",
  });
  // The default branch holds the workflow the plan generates, which pauses.
  const ctx = await localRenderContext(deps, plan, await localSite(deps.paths, plan));
  const workflow = localStackFiles(plan, ctx).find((file) => file.path === plan.cicd.workflowPath);
  if (o.runner === true && workflow === undefined) throw new Error("no local runner workflow");
  if (workflow !== undefined) {
    github.onMain.set(plan.cicd.workflowPath, blobOf(workflow.content.replace(/\r\n/g, "\n")));
  }
  const api = Object.assign(github, {
    async setRepoVariable(_owner: string, _repo: string, name: string, value: string) {
      events.push("pause");
      github.variables.set(name, value);
    },
    async deleteRepoVariable(_owner: string, _repo: string, name: string) {
      events.push("unpause");
      github.variables.delete(name);
    },
  });
  const run = (options: Omit<RollbackOptions, "services"> = {}) =>
    rollback(deps, {
      ...options,
      // Without the local runner nothing reaches GitHub.
      services: {
        localhost: computer.services(),
        github: o.runner === true ? api : null,
        // Drift counts a broken app's stopped containers as pending: the rollback never asks it.
        drift: async () =>
          cleanDrift({
            clean: false,
            host: {
              differences: [
                {
                  area: "app",
                  title: "The app's containers",
                  detail: "app is stopped.",
                  restoredByProvision: true,
                },
              ],
            },
          }),
        sleep: async () => {
          events.push(existsSync(lockFile(deps.paths)) ? "sleep (locked)" : "sleep");
        },
      },
    });
  const scripts = () => computer.scripts.map((entry) => entry.script);
  const paused = () => {
    const text = github.variables.get(DEPLOY_PAUSED_VARIABLE);
    return text === undefined ? undefined : JSON.parse(text);
  };
  return {
    deps,
    handler,
    computer,
    github,
    events,
    plan,
    folder,
    missing,
    locked,
    images,
    run,
    scripts,
    paused,
  };
}

describe("opscrew rollback on this computer", () => {
  it("switches back to the previous image under the lock, with no release command, after a promote approval bound to the references", async () => {
    const world = await localWorld();
    const result = await world.run();

    expect(result).toEqual({
      kind: "rolled-back",
      status: "deployed",
      target: { digest: digestOf("previous"), marks: ["previous"] },
      from: { digest: digestOf("running"), marks: ["running"] },
      paused: false,
      how: "local",
    });
    const hash = imageRollbackHash({
      environment: "shop/prod",
      current: RUNNING,
      target: PREVIOUS,
      targetPlanHash: planHash(world.plan),
    });
    const request = world.handler.requests[0] as ApprovalRequest;
    expect(request).toMatchObject({ kind: "promote", planHash: hash });
    expect(request.details).toContain(`Now: ${RUNNING}`);
    expect(request.details).toContain(`Back to: ${PREVIOUS}`);
    expect(request.details).toContain("The release command does not run.");
    // `.env` kept as `.env.previous`, then the start script in its rollback mode, logged in to GHCR.
    expect(world.events).toEqual(["approve:promote", "keep", "login", "switch", "logout"]);
    expect(world.scripts()[0]).toContain("cp .env .env.previous");
    expect(world.scripts()[2]).toMatch(
      new RegExp(`^set -- ${literal(shellQuote(PREVIOUS))} rollback\n`),
    );
    expect(world.locked.every(Boolean)).toBe(true);
    expect(world.computer.requests.some((r) => r.scheme === "https")).toBe(true);
    expect(await readRollback(world.deps.paths)).toEqual({
      digest: PREVIOUS,
      from: { digest: RUNNING },
      at: CLOCK,
      hash,
    });
    expect(world.deps.audit.entries.filter((e) => e.kind === "remote-exec")).toEqual([
      expect.objectContaining({ action: "local rollback started", target: hash }),
      expect.objectContaining({ action: "local rollback finished", target: hash }),
    ]);
    expect(world.deps.reporter.text()).toContain("no build, and no release command ran");
    // The registry login's token reaches only the login's stdin.
    const everything = [
      world.deps.reporter.text(),
      JSON.stringify(world.deps.audit.entries),
      JSON.stringify(world.handler.requests),
      ...world.scripts(),
    ].join("\n");
    expect(everything).not.toContain(world.computer.registryToken);
  });

  it("refuses with no previous version, the same image, or the one it rolled back from, with nothing changed", async () => {
    const world = await localWorld();
    const cases: [() => Promise<void>, string][] = [
      [() => world.images(RUNNING), "has no .env.previous"],
      [() => world.images(RUNNING, RUNNING), "is the image prod runs now"],
      [
        async () => {
          await world.images(PREVIOUS, RUNNING);
          await mkdir(world.deps.paths.stateDir, { recursive: true });
          await writeFile(
            rollbackFile(world.deps.paths),
            JSON.stringify({ digest: PREVIOUS, from: { digest: RUNNING }, at: CLOCK, hash: "h" }),
          );
        },
        "is the one `opscrew rollback` went back from",
      ],
    ];
    for (const [arrange, message] of cases) {
      await arrange();
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(message);
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(error.hint).toContain("opscrew provision");
    }
    expect(world.handler.requests).toEqual([]);
    expect(world.scripts()).toEqual([]);
  });

  it("refuses an app another project runs on this computer, before any change", async () => {
    const world = await localWorld();
    await writeFile(ownerFile(world.deps.paths, world.plan), "another-project\n");
    const error = await failure(world.run());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("from another project");
    expect(world.handler.requests).toEqual([]);
    expect(world.scripts()).toEqual([]);
    expect(await readRollback(world.deps.paths)).toBeUndefined();
  });

  it("refuses when Docker no longer has the previous image (US4 #2)", async () => {
    const world = await localWorld();
    world.missing.add(PREVIOUS);
    const error = await failure(world.run());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `Docker on this computer no longer has ${PREVIOUS}, the version before, so OpsCrew cannot go back to it. Nothing was changed.`,
    );
    expect(world.handler.requests).toEqual([]);
    expect(world.scripts()).toEqual([]);
  });

  it("refuses --to, a mismatched --approve, and is never granted by --yes", async () => {
    const world = await localWorld({ approve: (request) => YES_KINDS.includes(request.kind) });
    const to = await failure(world.run({ to: digestOf("previous") }));
    expect(to.code).toBe("INVALID_INPUT");
    const mismatch = await failure(world.run({ approveHash: "0".repeat(64) }));
    expect(mismatch.code).toBe("PLAN_NOT_APPROVED");
    const refused = await failure(world.run());
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(refused.hint).toMatch(new RegExp(`${COMMAND} --approve [0-9a-f]{64}$`));
    expect(world.scripts()).toEqual([]);
    expect(await readRollback(world.deps.paths)).toBeUndefined();
  });

  it("switches back to the image it ran when the earlier one fails its check, saying what runs", async () => {
    const world = await localWorld();
    world.computer.answer = (input) => ({ status: input.scheme === "https" ? 503 : 308 });
    const script = world.computer.script;
    world.computer.script = (text) => {
      const result = script(text);
      return text.includes("echo restored") ? ok("restored\n") : result;
    };

    const error = await failure(world.run());

    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain(`did not answer at https://shop.localhost:8443/`);
    expect(error.message).toContain(
      `OpsCrew switched it back: prod runs ${digestOf("running").slice(0, 19)} again, the version it ran.`,
    );
    expect(world.events).toEqual([
      "approve:promote",
      "keep",
      "login",
      "switch",
      "logout",
      "switch back",
    ]);
    expect(world.scripts()[4]).toMatch(new RegExp(`^set -- ${literal(shellQuote(PREVIOUS))}\n`));
    expect(await readRollback(world.deps.paths)).toBeUndefined();
    expect(world.deps.audit.entries.map((e) => e.action)).toContain("local rollback failed");
  });

  it("lists the image running and the one before, with no approval and no change", async () => {
    const world = await localWorld();
    expect(await world.run({ list: true })).toEqual({
      kind: "list",
      versions: [
        { digest: digestOf("running"), marks: ["running"] },
        { digest: digestOf("previous"), marks: ["previous"] },
      ],
      leftOut: [],
    });
    expect(world.handler.requests).toEqual([]);
    expect(world.scripts()).toEqual([]);
  });
});

describe("opscrew rollback on this computer with the local runner", () => {
  it("pauses the deploys before the switch, pinned to the image's commit", async () => {
    const world = await localWorld({ runner: true });
    const result = await world.run();
    expect(result).toMatchObject({ kind: "rolled-back", paused: true, how: "local" });
    expect(world.events).toEqual([
      "approve:promote",
      "pause",
      "sleep",
      "keep",
      "login",
      "switch",
      "logout",
    ]);
    expect(world.paused()).toEqual({
      "shop/prod": {
        reason: "rollback",
        since: CLOCK,
        image: digestOf("previous"),
        commit: commitOf("previous"),
      },
    });
    expect((await readRollback(world.deps.paths))?.commit).toBe(commitOf("previous"));
    expect(world.deps.reporter.text()).toContain(
      `prod's deploys are paused: a push to main builds but doesn't deploy. When the fix is pushed, run \`${COMMAND} --resume\``,
    );
  });

  it("stops under the lock when another deploy changed the images since the approval, the pause put back", async () => {
    const world = await localWorld({
      runner: true,
      approve: () => {
        // A deploy of the local runner while the user reviews the rollback.
        writeFileSync(join(world.folder, ".env"), `APP_IMAGE=${digestOf("newer")}\n`);
        return true;
      },
    });
    const error = await failure(world.run());
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toMatch(
      /^The images on this computer are no longer the ones in the rollback you approved \([0-9a-f]{64}\): another deploy changed prod meanwhile\. Nothing was changed\. OpsCrew put prod's deploy pause back as it was\.$/,
    );
    expect(world.events).toEqual(["approve:promote", "pause", "sleep", "unpause"]);
    expect(world.scripts()).toEqual([]);
    expect(world.paused()).toBeUndefined();
    expect(await readRollback(world.deps.paths)).toBeUndefined();
  });

  it("puts the pause back when the switch fails", async () => {
    const world = await localWorld({ runner: true });
    const script = world.computer.script;
    world.computer.script = (text) => {
      const result = script(text);
      if (text.includes("echo restored")) return ok("restored\n");
      return SWITCH.test(text) ? { exitCode: 1, stdout: "", stderr: "" } : result;
    };
    const error = await failure(world.run());
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("The rollback on this computer failed");
    expect(error.message).toMatch(/OpsCrew put prod's deploy pause back as it was\.$/);
    expect(world.events.slice(0, 2)).toEqual(["approve:promote", "pause"]);
    expect(world.events.at(-1)).toBe("unpause");
    expect(world.paused()).toBeUndefined();
  });

  it("refuses while the local runner's deploy runs, before any change (FR-1907)", async () => {
    const world = await localWorld({ runner: true });
    world.github.runs.set(990, {
      repository: "acme/shop",
      headRepository: "acme/shop",
      event: "push",
      headBranch: "main",
      headSha: "9".repeat(40),
      path: world.plan.cicd.workflowPath,
      createdAt: "2026-10-23T11:30:00Z",
      status: "queued",
      conclusion: null,
    });
    const error = await failure(world.run());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "A run of prod's deploy workflow is queued or in progress: https://github.com/acme/shop/actions/runs/990. OpsCrew rolls back only between deploys, so the two never race. Nothing was changed.",
    );
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it("refuses before any change when the branch's workflow is not the one the plan generates", async () => {
    const world = await localWorld({ runner: true });
    const path = world.plan.cicd.workflowPath;
    world.github.onMain.set(path, blobOf("name: an older workflow, without the pause\n"));
    const error = await failure(world.run());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `The deploy workflow on the default branch main (${path}) is not the one prod's plan generates, so its run would not do what this rollback shows. Nothing was changed.`,
    );
    expect(error.hint).toContain("opscrew provision --env prod");
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
    expect(world.scripts()).toEqual([]);
  });

  it("lists the pause with the images", async () => {
    const world = await localWorld({ runner: true });
    const entry = {
      reason: "rollback",
      since: CLOCK,
      image: digestOf("running"),
      commit: "c".repeat(40),
    };
    world.github.variables.set(DEPLOY_PAUSED_VARIABLE, JSON.stringify({ "shop/prod": entry }));
    expect(await world.run({ list: true })).toMatchObject({ kind: "list", paused: entry });
    expect(world.events).toEqual([]);
  });
});

/** `text` as a regular expression that matches it literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
