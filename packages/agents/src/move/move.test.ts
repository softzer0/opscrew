import { CHECK_PAUSED_VARIABLE, DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { moveWorld } from "./__fixtures__/world";
import { runMove } from "./index";

type World = Awaited<ReturnType<typeof moveWorld>>;

async function planOnDisk(w: World) {
  return readArtifact("plan", w.deps.paths.files.plan);
}

/**
 * What GitHub held when the app's server first ran a command matching `re`: the deploy pause and
 * the status of the deploy runs.
 */
function whenRun(w: World, re: RegExp) {
  const seen: { paused?: string; runs?: string[] } = {};
  const server = w.servers.app;
  const run = server.run.bind(server);
  server.run = async (command, options) => {
    if (re.test(command) && seen.runs === undefined) {
      seen.paused = w.github.variables.get(DEPLOY_PAUSED_VARIABLE);
      seen.runs = w.github.workflowRuns.map((r) => r.status);
    }
    return run(command, options);
  };
  return seen;
}

/** A run of the app's deploy workflow with `status`. */
function deployRun(status: string) {
  return {
    id: 42,
    status,
    conclusion: null,
    htmlUrl: "https://github.com/acme/shop/actions/runs/42",
    headSha: "a".repeat(40),
    createdAt: "2026-10-11T11:55:00Z",
  };
}

/** The pause entries the scheduled check saw, and whether one is left. */
function checkPauses(w: World): string[] {
  return w.deps.audit.entries
    .filter((e) => e.kind === "provider-call" && /scheduled check/.test(e.action))
    .map((e) => e.action);
}

/** The app's server runs the app on the old copy with its old settings, here and in GitHub. */
function backOnOldCopy(w: World) {
  expect(w.servers.app.running.has("app")).toBe(true);
  expect(w.servers.app.env?.replace(/\n+$/, "\n")).toBe(w.env.before);
  expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.before);
  expect(w.servers.app.dump).toBeUndefined();
  expect(w.servers.data.dump).toBeUndefined();
  expect(w.github.variables.get(CHECK_PAUSED_VARIABLE)).toBeUndefined();
  expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();
}

describe("runMove", () => {
  it("waits for the deploy to start the new copy, changing nothing", async () => {
    const w = await moveWorld({ step: "started" });
    const plan = await runMove(w.deps, { plan: w.plan, services: w.services });

    expect(plan.move?.step).toBe("started");
    expect((await planOnDisk(w)).move?.step).toBe("started");
    expect(w.handler.requests).toEqual([]);
    expect(w.deps.reporter.text()).toContain(
      "db moves to server data once the deploy has started its new copy there: merge the pull request with the deployment files, wait for the deploy to succeed, then run `opscrew provision` again.",
    );
  });

  it("moves Postgres with its data in one approved window, and keeps the old copy stopped", async () => {
    const w = await moveWorld({ step: "started" });
    w.servers.data.running.add("db");
    const stopped = whenRun(w, /docker compose stop app$/);
    const plan = await runMove(w.deps, { plan: w.plan, services: w.services });

    // The app's deploys were paused while the app was stopped, and resumed afterwards.
    expect(stopped.paused).toContain('"shop/prod"');
    expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();
    // The data is on data, and the app uses it there.
    expect(w.servers.data.data.get("db")).toBe("rows of the shop");
    expect(w.servers.app.env).toBe(w.env.after);
    expect(w.env.after).toContain(`@${w.dataAddress}:5432/app`);
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.after);
    expect(w.servers.app.running.has("app")).toBe(true);
    // The old copy stays, stopped, with its data.
    expect(w.servers.app.running.has("db")).toBe(false);
    expect(w.servers.app.data.get("db")).toBe("rows of the shop");
    expect(w.servers.app.dump).toBeUndefined();
    expect(w.servers.data.dump).toBeUndefined();

    const size = "rows of the shop".length;
    expect(plan.move).toEqual({
      service: "db",
      from: "app",
      to: "data",
      step: "switched",
      copy: "dump",
      sizeBytes: size,
    });
    expect((await planOnDisk(w)).move).toEqual(plan.move);
    expect(plan.deployment.placement).toEqual({ db: "app" });

    // One approval for the window, listing its steps, which also covers the check's pause.
    expect(w.handler.requests).toHaveLength(1);
    const [window] = w.handler.requests;
    expect(window?.kind).toBe("remote-exec");
    expect(window?.title).toBe(
      "Maintenance window: stop shop and move db from the app's server to server data (its database of 16 bytes, about 3 minutes of downtime)",
    );
    expect(window?.details).toContain(
      "scp -3 deploy@203.0.113.10:/srv/apps/shop/opscrew-move.dump deploy@203.0.113.30:/srv/apps/shop/opscrew-move.dump",
    );
    expect(window?.details).toContain("the GitHub secret OPSCREW_APP_ENV");
    expect(checkPauses(w)).toEqual([
      "pause the scheduled check for shop/prod",
      "resume the scheduled check for shop/prod",
    ]);
    expect(w.github.variables.get(CHECK_PAUSED_VARIABLE)).toBeUndefined();

    // The order on the servers: stop the app, copy, switch, start, stop the old copy.
    const app = w.servers.app.calls.filter((c) => !c.includes("ps --status"));
    expect(app.map((c) => c.replace(/^cd \S+ && /, ""))).toEqual([
      "cat /srv/apps/shop/app.env",
      expect.stringContaining("pg_database_size"),
      "docker compose stop app",
      expect.stringContaining("pg_dump"),
      expect.stringContaining("pg_restore --list"),
      "rm -f /srv/apps/shop/opscrew-move.dump",
      expect.stringContaining("cat > /srv/apps/shop/app.env.opscrew"),
      "docker compose up -d app",
      expect.stringContaining("wget"),
      "cat /srv/apps/shop/app.env",
      "docker compose stop db",
    ]);
    expect(w.deps.reporter.text()).toContain(
      "Then `opscrew provision --finish-move` deletes the old copy's data on the app's server, after you type db.",
    );
    // No password reaches the approval, the audit log or the output.
    const text = `${window?.details}\n${JSON.stringify(w.deps.audit.entries)}\n${w.deps.reporter.text()}`;
    expect(text).not.toContain(w.passwords.db);
  });

  it("starts Valkey empty on its new server, copying nothing", async () => {
    const w = await moveWorld({ service: "cache", step: "deployed" });
    const plan = await runMove(w.deps, { plan: w.plan, services: w.services });

    expect(plan.move?.step).toBe("switched");
    expect(plan.move?.sizeBytes).toBeUndefined();
    expect(w.servers.app.env).toBe(w.env.after);
    expect(w.env.after).toContain(`@${w.dataAddress}:6379`);
    expect(w.servers.app.running.has("cache")).toBe(false);
    expect(w.servers.data.calls.some((c) => /pg_|DROP/.test(c))).toBe(false);
    expect(w.handler.requests[0]?.details).toContain("cache starts empty on server data");
  });

  describe("a failure in the window puts the app back on the old copy", () => {
    const steps: {
      step: string;
      on: "app" | "data" | "scp" | "settings" | "github";
      fail?: RegExp;
    }[] = [
      { step: "stopping the app", on: "app", fail: /docker compose stop app/ },
      { step: "the dump", on: "app", fail: /pg_dump/ },
      { step: "the copy", on: "scp" },
      { step: "checking the copy", on: "data", fail: /pg_restore --list/ },
      { step: "emptying the new database", on: "data", fail: /DROP DATABASE/ },
      { step: "the restore", on: "data", fail: /pg_restore -U app/ },
      { step: "writing the app's settings", on: "settings" },
      { step: "storing the settings in GitHub", on: "github" },
    ];
    it.each(steps)("$step", async ({ on, fail }) => {
      const w = await moveWorld({ step: "deployed" });
      if (on === "scp") w.scp.fail = true;
      else if (on === "settings") {
        // Only the new settings fail to write; putting the old ones back works.
        const server = w.servers.app;
        const run = server.run.bind(server);
        server.run = async (command, options) =>
          options?.input === w.env.after
            ? { exitCode: 1, stdout: "", stderr: "No space left on device" }
            : run(command, options);
      } else if (on === "github") {
        const set = w.github.setActionsSecret.bind(w.github);
        w.github.setActionsSecret = async (owner, repo, name, value) => {
          if (value === w.env.after) throw new Error("GitHub refused the secret");
          await set(owner, repo, name, value);
        };
      } else {
        w.servers[on].fail = fail;
      }

      const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        message: expect.stringMatching(
          /^The maintenance window failed: .+\. The app runs again on the old copy of db on the app's server; the new copy on server data is not used\.$/,
        ),
        hint: expect.stringContaining(
          "Then run `opscrew provision` again: it repeats the maintenance window.",
        ),
      });
      backOnOldCopy(w);
      expect(w.servers.app.data.get("db")).toBe("rows of the shop");
      expect((await planOnDisk(w)).move?.step).toBe("deployed");
      expect(w.deps.audit.entries).toContainEqual(
        expect.objectContaining({ action: "maintenance window", decision: "refused" }),
      );
    });
  });

  it("only goes forward once the app has started on the new copy", async () => {
    const w = await moveWorld({ step: "deployed" });
    w.servers.app.fail = /wget/;
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      message: expect.stringMatching(
        /^The maintenance window failed: .+\. The app's settings use db on server data, where its data was copied, so OpsCrew does not go back to the old copy\.$/,
      ),
      hint: expect.stringContaining("Then run `opscrew provision` again: it finishes the switch."),
    });
    // The settings and the new copy stay; the old copy runs on, untouched.
    expect(w.servers.app.env).toBe(w.env.after);
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.after);
    expect(w.servers.data.data.get("db")).toBe("rows of the shop");
    expect(w.servers.app.running.has("db")).toBe(true);
    expect(w.github.variables.get(CHECK_PAUSED_VARIABLE)).toBeUndefined();
    expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();
    expect((await planOnDisk(w)).move?.step).toBe("deployed");
  });

  it("goes back to the old copy when the app started again during the window", async () => {
    const w = await moveWorld({ step: "deployed" });
    // A deploy (or someone on the server) starts the app while the copy is restored.
    const data = w.servers.data;
    const run = data.run.bind(data);
    data.run = async (command, options) => {
      if (command.includes("pg_restore -U app")) w.servers.app.running.add("app");
      return run(command, options);
    };
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "The maintenance window failed: shop started again on the app's server during the window",
      ),
    });
    expect(w.servers.app.calls.some((c) => c.includes("app.env.opscrew"))).toBe(false);
    backOnOldCopy(w);
  });

  it("records nothing and keeps the old copy running when app.env changed before the switch is recorded", async () => {
    const w = await moveWorld({ step: "deployed" });
    const server = w.servers.app;
    const run = server.run.bind(server);
    server.run = async (command, options) => {
      const result = await run(command, options);
      // Something writes the old settings back while the app comes up.
      if (command.includes("wget")) server.env = w.env.before;
      return result;
    };
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      message:
        "The app answers, but its settings (app.env) on the app's server no longer use db on server data: something wrote them during the window. OpsCrew recorded nothing and keeps the old copy running.",
    });
    expect(w.servers.app.running.has("db")).toBe(true);
    // The secret follows the server's settings again.
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.before);
    expect((await planOnDisk(w)).move?.step).toBe("deployed");
    expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();

    // When even that fails, the error says the secret and the server may disagree.
    const again = await moveWorld({ step: "deployed" });
    const runAgain = again.servers.app.run.bind(again.servers.app);
    again.servers.app.run = async (command, options) => {
      const result = await runAgain(command, options);
      if (command.includes("wget")) again.servers.app.env = again.env.before;
      return result;
    };
    const set = again.github.setActionsSecret.bind(again.github);
    again.github.setActionsSecret = async (owner, repo, name, value) => {
      if (value === again.env.before) throw new Error("GitHub is down");
      await set(owner, repo, name, value);
    };
    const failed = await runMove(again.deps, { plan: again.plan, services: again.services }).catch(
      (e: unknown) => e,
    );
    expect(failed).toMatchObject({
      message: expect.stringContaining(
        "OpsCrew could not store them in the GitHub secret OPSCREW_APP_ENV either (unexpected error), so the secret and the server may disagree.",
      ),
    });
  });

  it("changes nothing at switched when app.env uses the old copy again: both copies may hold writes", async () => {
    const w = await moveWorld({ step: "switched" });
    // The world's app.env uses the old copy, as a deploy of the old settings would leave it.
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "db moved to server data, but the app's settings (app.env) on the app's server use its old copy on the app's server again: both copies may now hold writes the other lacks, so OpsCrew changes nothing.",
      hint: "To keep db on server data, put the app's settings back on it (a deploy writes them from the GitHub secret OPSCREW_APP_ENV, which holds its address), then run `opscrew provision` again.",
    });
    expect(w.servers.app.calls).toEqual(["cat /srv/apps/shop/app.env"]);
    expect(w.servers.data.calls).toEqual([]);
    expect(w.handler.requests).toEqual([]);
    expect((await planOnDisk(w)).move?.step).toBe("switched");
  });

  it("clears a deploy pause an interrupted window left once the app answers on the new copy", async () => {
    const w = await moveWorld({ step: "switched" });
    w.servers.app.env = w.env.after;
    const staging = { "shop/staging": { reason: "move", since: "2026-10-11T10:00:00.000Z" } };
    w.github.variables.set(
      DEPLOY_PAUSED_VARIABLE,
      JSON.stringify({
        ...staging,
        "shop/prod": { reason: "move", since: "2026-10-11T11:00:00Z" },
      }),
    );
    await runMove(w.deps, { plan: w.plan, services: w.services });
    expect(JSON.parse(w.github.variables.get(DEPLOY_PAUSED_VARIABLE) ?? "")).toEqual(staging);
    expect(w.deps.audit.entries.map((e) => e.action)).toContain("resume the deploys of shop/prod");
  });

  describe("a change that fails half way is undone too", () => {
    it("app.env written, then the connection lost", async () => {
      const w = await moveWorld({ step: "deployed" });
      const server = w.servers.app;
      const run = server.run.bind(server);
      server.run = async (command, options) => {
        const result = await run(command, options);
        return command.includes("app.env.opscrew") && options?.input === w.env.after
          ? { exitCode: 255, stdout: "", stderr: "Connection reset" }
          : result;
      };
      await expect(runMove(w.deps, { plan: w.plan, services: w.services })).rejects.toThrow(
        /^The maintenance window failed/,
      );
      backOnOldCopy(w);
    });

    it("the secret stored, then GitHub's answer lost", async () => {
      const w = await moveWorld({ step: "deployed" });
      const set = w.github.setActionsSecret.bind(w.github);
      w.github.setActionsSecret = async (owner, repo, name, value) => {
        await set(owner, repo, name, value);
        if (value === w.env.after) throw new Error("socket hang up");
      };
      await expect(runMove(w.deps, { plan: w.plan, services: w.services })).rejects.toThrow(
        /^The maintenance window failed/,
      );
      backOnOldCopy(w);
    });
  });

  it("keeps the new settings when the secret can't be put back, for the next provision to go on", async () => {
    const w = await moveWorld({ step: "deployed" });
    w.github.setActionsSecret = async () => {
      throw new Error("GitHub is down");
    };
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "OpsCrew could not put the GitHub secret with the app's settings back: unexpected error. The app's settings on its server stay on db's copy on server data",
      ),
      hint: "Run `opscrew provision` again: it finishes the move on the new copy.",
    });
    expect(w.servers.app.env).toBe(w.env.after);
    expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();
    expect((await planOnDisk(w)).move?.step).toBe("deployed");
  });

  describe("the app's deploys during the window", () => {
    it("waits for a deploy that runs before it stops the app", async () => {
      const w = await moveWorld({ step: "deployed" });
      w.github.workflowRuns = [deployRun("in_progress")];
      // The first sleep is the wait before the first look; the run ends during the second.
      let sleeps = 0;
      w.services.sleep = async () => {
        sleeps += 1;
        if (sleeps === 2) w.github.workflowRuns = [deployRun("completed")];
      };
      const stopped = whenRun(w, /docker compose stop app$/);
      const plan = await runMove(w.deps, { plan: w.plan, services: w.services });
      expect(plan.move?.step).toBe("switched");
      expect(stopped.runs).toEqual(["completed"]);
      expect(stopped.paused).toContain('"shop/prod"');
      expect(w.deps.reporter.text()).toContain("Waiting for the running deploy of shop to end");
    });

    it("stops without a change when a deploy still runs after 30 minutes, deploys resumed", async () => {
      const w = await moveWorld({ step: "deployed" });
      w.github.workflowRuns = [deployRun("queued")];
      const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        code: "COMMAND_FAILED",
        message:
          "A deploy of shop (opscrew-deploy.yml) still runs after 30 minutes, so the maintenance window did not start. Nothing was changed on the servers.",
      });
      expect(w.servers.app.running.has("app")).toBe(true);
      expect(w.servers.app.calls.some((c) => c.endsWith("docker compose stop app"))).toBe(false);
      expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();
      expect(w.github.variables.get(CHECK_PAUSED_VARIABLE)).toBeUndefined();
      expect(w.deps.audit.entries.map((e) => e.action)).toEqual(
        expect.arrayContaining([
          "pause the deploys of shop/prod",
          "resume the deploys of shop/prod",
        ]),
      );
    });

    it("keeps other environments' pauses", async () => {
      const w = await moveWorld({ step: "deployed" });
      const staging = { "shop/staging": { reason: "move", since: "2026-10-11T10:00:00.000Z" } };
      w.github.variables.set(DEPLOY_PAUSED_VARIABLE, JSON.stringify(staging));
      await runMove(w.deps, { plan: w.plan, services: w.services });
      expect(JSON.parse(w.github.variables.get(DEPLOY_PAUSED_VARIABLE) ?? "")).toEqual(staging);
    });
  });

  it("finishes the switch of a move recorded as switched whose app does not answer", async () => {
    const w = await moveWorld({ step: "switched" });
    w.servers.data.data.set("db", "rows of the shop");
    w.servers.app.env = w.env.after;
    w.servers.app.running.delete("app");
    const plan = await runMove(w.deps, { plan: w.plan, services: w.services });
    expect(plan.move?.step).toBe("switched");
    expect(w.servers.app.running.has("app")).toBe(true);
    expect(w.servers.app.running.has("db")).toBe(false);
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.after);
    expect(w.servers.data.calls.some((c) => /DROP|pg_restore/.test(c))).toBe(false);
  });

  it("finishes a window that stopped after switching the app's settings, without copying again", async () => {
    const w = await moveWorld({ step: "deployed" });
    // An earlier run copied the data, switched app.env and was stopped before the app started.
    w.servers.data.data.set("db", "rows of the shop");
    w.servers.app.env = w.env.after;
    w.servers.app.running.delete("app");

    const plan = await runMove(w.deps, { plan: w.plan, services: w.services });
    expect(plan.move?.step).toBe("switched");
    expect(w.servers.app.running.has("app")).toBe(true);
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.after);
    expect(w.servers.app.calls.some((c) => c.includes("pg_dump"))).toBe(false);
    expect(w.servers.data.calls.some((c) => c.includes("pg_restore"))).toBe(false);
    expect(w.handler.requests[0]?.title).toBe(
      "Maintenance window: finish moving db to server data and start shop against it",
    );
  });

  describe("a window that stopped after the switch of the settings only goes forward", () => {
    /** An earlier run copied the data, switched app.env and was stopped before the app started. */
    async function interrupted() {
      const w = await moveWorld({ step: "deployed" });
      w.servers.data.data.set("db", "rows of the shop");
      w.servers.app.env = w.env.after;
      w.servers.app.running.delete("app");
      return w;
    }

    it("writes nothing when the window is refused", async () => {
      const w = await interrupted();
      w.answers.approve = false;
      const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
      expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.before);
      expect(w.github.variables.size).toBe(0);
      expect(w.servers.app.env).toBe(w.env.after);
      expect((await planOnDisk(w)).move?.step).toBe("deployed");
    });

    it("keeps the new settings and the new copy when the app does not come up", async () => {
      const w = await interrupted();
      w.servers.app.fail = /wget/;
      const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        message: expect.stringMatching(
          /^The maintenance window failed: .+\. The app's settings use db on server data, where its data was copied, so OpsCrew does not go back to the old copy\.$/,
        ),
        hint: expect.stringContaining(
          "Then run `opscrew provision` again: it finishes the switch.",
        ),
      });
      expect(w.servers.app.env).toBe(w.env.after);
      expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.after);
      expect(w.servers.data.data.get("db")).toBe("rows of the shop");
      expect(w.servers.data.calls.some((c) => /DROP|pg_restore|rm -f/.test(c))).toBe(false);
      expect(w.servers.app.calls.some((c) => c.includes("app.env.opscrew"))).toBe(false);
      expect(w.github.variables.get(CHECK_PAUSED_VARIABLE)).toBeUndefined();
      expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();
      expect((await planOnDisk(w)).move?.step).toBe("deployed");
    });
  });

  it("refuses a copy when app.env doesn't hold the database's address as OpsCrew writes it", async () => {
    const w = await moveWorld({ step: "deployed" });
    w.servers.app.env = "DATABASE_URL=postgresql://someone:else@elsewhere:5432/app\n";
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The app's settings (app.env) on the app's server don't hold db's address as OpsCrew writes it, so OpsCrew can't point the app at its copy on server data. Nothing was changed.",
    });
    expect(w.handler.requests).toEqual([]);
    expect(w.servers.app.calls).toEqual(["cat /srv/apps/shop/app.env"]);
    expect(w.servers.data.calls).toEqual([]);
  });

  it("rewrites Grafana Alloy's masking file with the app's settings, and again when they go back", async () => {
    const w = await moveWorld({ step: "deployed", grafana: true });
    await runMove(w.deps, { plan: w.plan, services: w.services });
    expect(w.servers.app.masks).toEqual([w.env.after]);
    expect(w.handler.requests[0]?.details).toContain(
      "Grafana Alloy's masking file (/srv/apps/shop/mask.re) is rewritten from the new app.env.",
    );

    const failed = await moveWorld({ step: "deployed", grafana: true });
    const set = failed.github.setActionsSecret.bind(failed.github);
    failed.github.setActionsSecret = async (owner, repo, name, value) => {
      if (value === failed.env.after) throw new Error("GitHub refused the secret");
      await set(owner, repo, name, value);
    };
    await runMove(failed.deps, { plan: failed.plan, services: failed.services }).catch(() => {});
    expect(failed.servers.app.masks).toEqual([failed.env.after, failed.env.before]);
  });

  it("keeps the app stopped on its old settings when the masking file can't follow them back", async () => {
    const w = await moveWorld({ step: "deployed", grafana: true });
    const set = w.github.setActionsSecret.bind(w.github);
    w.github.setActionsSecret = async (owner, repo, name, value) => {
      if (value === w.env.after) throw new Error("GitHub refused the secret");
      await set(owner, repo, name, value);
    };
    const server = w.servers.app;
    const run = server.run.bind(server);
    server.run = async (command, options) =>
      command === "bash -s" && server.env === w.env.before
        ? { exitCode: 1, stdout: "", stderr: "No space left on device" }
        : run(command, options);
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "The app's settings are back on the old copy of db on the app's server, but OpsCrew could not rewrite Grafana Alloy's masking file for them",
      ),
      hint: "Run `opscrew provision` again: it starts the app on the old copy and repeats the maintenance window.",
    });
    expect(server.env).toBe(w.env.before);
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(w.env.before);
    expect(server.running.has("app")).toBe(false);
  });

  it("starts the app on the old copy first after a window that stopped before the switch", async () => {
    const w = await moveWorld({ step: "deployed" });
    // An earlier run stopped the app and was interrupted during the copy.
    w.servers.app.running.delete("app");
    w.servers.data.data.set("db", "half a copy");
    w.answers.approve = false;

    // Refused this time: the app runs again on the old copy, and nothing else changed.
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(w.servers.app.running.has("app")).toBe(true);
    expect(w.servers.app.env?.replace(/\n+$/, "\n")).toBe(w.env.before);
    expect(w.deps.reporter.text()).toContain(
      "An earlier run stopped during the maintenance window, before the app's settings were switched. OpsCrew starts the app on the old copy again first",
    );
    expect((await planOnDisk(w)).move?.step).toBe("deployed");

    // Approved at the next run: the window is repeated from a fresh dump.
    w.answers.approve = true;
    const plan = await runMove(w.deps, { plan: await planOnDisk(w), services: w.services });
    expect(plan.move?.step).toBe("switched");
    expect(w.servers.data.data.get("db")).toBe("rows of the shop");
  });

  it("only says what is left once switched", async () => {
    const w = await moveWorld({ step: "switched" });
    w.servers.app.env = w.env.after;
    const plan = await runMove(w.deps, { plan: w.plan, services: w.services });
    expect(plan).toEqual(w.plan);
    // Only the app's settings and the health check, to see that it answers on the new copy.
    expect(w.servers.app.calls).toEqual([
      "cat /srv/apps/shop/app.env",
      expect.stringContaining("wget"),
    ]);
    expect(w.handler.requests).toEqual([]);
    expect(w.deps.reporter.text()).toContain(
      "Run `opscrew provision --finish-move` to delete it, after you type db.",
    );
  });

  it("refuses to copy between servers whose SSH ports differ, before any change", async () => {
    const w = await moveWorld({ step: "deployed", dataPort: 2222 });
    const error = await runMove(w.deps, { plan: w.plan, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("but theirs differ (22 and 2222). Nothing was changed."),
    });
    expect(w.handler.requests).toEqual([]);
    expect(w.servers.app.running.has("app")).toBe(true);
  });
});
