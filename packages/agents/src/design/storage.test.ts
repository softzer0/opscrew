import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, type ImageBuilder } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { portainerPlan, testPlan } from "../testing";
import { sqliteOwnerWarning } from "./storage";

/** The test plan on SQLite, built with `builder` for Node, deployed unless `deployed` is false. */
function onSqlite(builder: ImageBuilder, o: { deployed?: boolean } = {}): DeployPlan {
  const base = testPlan();
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      build: {
        builder,
        chosen: "user",
        reason: "The test chose it.",
        runtime: { language: "node", version: "24" },
        probe: "node",
        ...(builder === "own-dockerfile" ? { workdir: "/app" } : {}),
      },
    },
    storage: { sqlite: { dir: "data" } },
    deploy: { ...base.deploy, strategy: "recreate" },
    deployment: {
      ...base.deployment,
      ...(o.deployed === false ? {} : { firstDeployAt: "2026-10-12T10:00:00.000Z" }),
    },
  });
}

describe("sqliteOwnerWarning", () => {
  it("gives the command that hands the volume to the new builder's user", () => {
    expect(sqliteOwnerWarning(onSqlite("railpack"), onSqlite("buildpacks"))).toBe(
      `The app's image is now built with buildpacks instead of railpack (app.build.builder in opscrew/plan.yaml), but its SQLite volume keeps the owner Docker gave it when it was made (10001:10001), so the new version may not be able to write its database. Before you deploy it, run on the server: \`docker run --rm --user 0 --entrypoint chown -v shop_sqlite:/d ${IMAGES.caddy.ref} -R 1002:1001 /d\`.`,
    );
  });

  it("asks for the image's own user for the user's own Dockerfile", () => {
    const text = sqliteOwnerWarning(onSqlite("generated-dockerfile"), onSqlite("own-dockerfile"));
    expect(text).toContain("(1000:1000)");
    expect(text).toContain("-R <uid>:<gid> /d`.");
    expect(text).toContain("the user your Dockerfile's image runs as (its USER)");
  });

  it("says how to do it in Portainer with a one-off container", () => {
    const portainer = (plan: DeployPlan) =>
      DeployPlanSchema.parse({
        ...plan,
        target: portainerPlan({ web: { mode: "proxy", port: 8080 } }).target,
      });
    const text = sqliteOwnerWarning(
      portainer(onSqlite("railpack")),
      portainer(onSqlite("buildpacks")),
    );
    expect(text).toContain(
      `run a one-off container in Portainer with the image ${IMAGES.caddy.ref}, user 0, entrypoint chown and command -R 1002:1001 /d, with the volume opscrew-shop_sqlite mounted at /d.`,
    );
  });

  it("says nothing when the owner stays, the builder stays, or nothing was deployed", () => {
    // Railpack and OpsCrew's Python image both run as 10001:10001.
    const python = (builder: ImageBuilder) => {
      const plan = onSqlite(builder);
      return DeployPlanSchema.parse({
        ...plan,
        app: {
          ...plan.app,
          build: { ...plan.app.build, runtime: { language: "python", version: "3.14" } },
        },
      });
    };
    expect(sqliteOwnerWarning(python("railpack"), python("generated-dockerfile"))).toBeUndefined();
    expect(sqliteOwnerWarning(onSqlite("railpack"), onSqlite("railpack"))).toBeUndefined();
    expect(
      sqliteOwnerWarning(onSqlite("railpack", { deployed: false }), onSqlite("buildpacks")),
    ).toBeUndefined();
  });
});
