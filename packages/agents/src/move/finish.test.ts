import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runProvision } from "../provision/run";
import { moveWorld } from "./__fixtures__/world";

type World = Awaited<ReturnType<typeof moveWorld>>;

/** A world whose move has switched: the app on data, the old copy stopped on the app's server. */
async function switched(): Promise<World> {
  const w = await moveWorld({ step: "switched" });
  w.servers.app.running.delete("db");
  w.servers.app.env = w.env.after;
  w.servers.data.data.set("db", "rows of the shop");
  return w;
}

describe("opscrew provision --finish-move", () => {
  it("deletes the old copy's container and data after the typed name, then clears the move", async () => {
    const w = await switched();
    await runProvision(w.deps, { finishMove: true, services: w.services });

    expect(w.servers.app.deleted).toEqual(["db"]);
    expect(w.servers.app.data.has("db")).toBe(false);
    expect(w.servers.data.data.get("db")).toBe("rows of the shop");
    const plan = await readArtifact("plan", w.deps.paths.files.plan);
    expect(plan.move).toBeUndefined();
    expect(plan.deployment.placement).toEqual({ db: "data" });
    expect(plan.servers?.map((s) => s.name)).toEqual(["data"]);

    const [request] = w.handler.requests;
    expect(request).toMatchObject({
      kind: "remote-exec",
      title: "Delete the old copy of db and its data on the app's server",
      allowDestroy: true,
      confirmPhrase: "db",
    });
    // The app's settings read first; then a fixed command: the container if any, then the folder
    // as root in the pinned Caddy image.
    const [read, deleted] = w.servers.app.calls;
    expect(read).toBe("cat /srv/apps/shop/app.env");
    expect(deleted).toMatch(
      /^ids=\$\(docker ps -aq --filter label=com\.docker\.compose\.project=shop --filter label=com\.docker\.compose\.service=db\) && \{ \[ -z "\$ids" \] \|\| docker rm -f \$ids > \/dev\/null; \} && docker run --rm --network none --user 0:0 --entrypoint rm -v \/srv\/data\/shop:\/d caddy:\S+ -rf \/d\/db$/,
    );
    expect(request?.details).toContain(deleted);
    expect(w.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "remote-exec",
        action: "delete the old copy of db",
        target: "server app",
        decision: "approved",
      }),
    );
  });

  it("is refused without the typed service name, deleting nothing", async () => {
    const w = await switched();
    w.answers.typed = "app";
    const error = await runProvision(w.deps, { finishMove: true, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringMatching(/^The old copy of db on the app's server was not deleted/),
      hint: "Run `opscrew provision --finish-move` again and type db to confirm.",
    });
    expect(w.servers.app.calls).toEqual(["cat /srv/apps/shop/app.env"]);
    expect(w.servers.app.data.get("db")).toBe("rows of the shop");
    const plan = await readArtifact("plan", w.deps.paths.files.plan);
    expect(plan.move?.step).toBe("switched");
  });

  it("is refused while the move has not switched, before asking anything", async () => {
    for (const step of ["started", "deployed"] as const) {
      const w = await moveWorld({ step });
      const error = await runProvision(w.deps, { finishMove: true, services: w.services }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message:
          "The app still uses db on the app's server: its move to server data has not switched yet, so OpsCrew keeps it. Nothing was deleted.",
      });
      expect(w.handler.requests).toEqual([]);
      expect(w.servers.app.calls).toEqual([]);
    }
  });

  it("is refused while the app's settings use the old copy, before asking anything", async () => {
    const w = await switched();
    w.servers.app.env = w.env.before;
    const error = await runProvision(w.deps, { finishMove: true, services: w.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The app's settings (app.env) on the app's server use db's old copy on the app's server, not the one on server data, so OpsCrew keeps the old copy. Nothing was deleted.",
    });
    expect(w.handler.requests).toEqual([]);
    expect(w.servers.app.deleted).toEqual([]);
    expect((await readArtifact("plan", w.deps.paths.files.plan)).move?.step).toBe("switched");
  });

  it("takes a server that runs nothing else out of the plan, for the next provision to delete", async () => {
    const w = await moveWorld({ step: "switched" });
    // The service moved back from data to the app's server: data holds only its old copy.
    const plan = DeployPlanSchema.parse({
      ...w.plan,
      services: w.plan.services.map(({ server: _server, ...service }) => service),
      deployment: { ...w.plan.deployment, placement: { db: "data" } },
      move: { ...w.plan.move, from: "data", to: "app" },
    });
    await writeArtifact("plan", w.deps.paths.files.plan, plan);

    await runProvision(w.deps, { finishMove: true, services: w.services });
    expect(w.servers.data.deleted).toEqual(["db"]);
    const after = await readArtifact("plan", w.deps.paths.files.plan);
    expect(after.servers).toBeUndefined();
    expect(after.network?.members.map((m) => m.name)).toEqual(["app"]);
    expect(after.deployment.placement).toEqual({ db: "app" });
    expect(w.handler.requests[0]?.details).toContain(
      "Server data runs nothing else, so it leaves servers: the next `opscrew provision` deletes it, after you type its name.",
    );
  });
});
