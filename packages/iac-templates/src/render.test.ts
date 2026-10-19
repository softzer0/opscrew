import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { withServices } from "./catalog/__fixtures__/plans";
import { renderDeployment } from "./render";
import { renderRuntimeFiles } from "./runtime";
import type { RenderContext } from "./types";

const ctx: RenderContext = {
  opscrewVersion: "0.1.0",
  github: { owner: "acme", repo: "shop" },
  deploySshPublicKey: "ssh-ed25519 AAAA opscrew-deploy",
};

describe("renderDeployment", () => {
  it("writes the services' settings files and the crontab next to compose.yaml", () => {
    const base = withServices([{ kind: "mysql" }, { kind: "rabbitmq" }]);
    const plan = DeployPlanSchema.parse({
      ...base,
      processes: {
        workers: [],
        cron: [{ name: "cleanup", schedule: "0 3 * * *", command: "node cleanup.js" }],
      },
    });
    const paths = renderDeployment(plan, ctx).map((file) => file.path);
    const runtime = renderRuntimeFiles(plan).map((file) => file.path);
    expect(runtime).toEqual([
      "opscrew/runtime/services/mysql/my.cnf",
      "opscrew/runtime/services/rabbitmq/rabbitmq.conf",
      "opscrew/runtime/crontab",
    ]);
    const compose = paths.indexOf("opscrew/runtime/compose.yaml");
    expect(paths.slice(compose + 1, compose + 1 + runtime.length)).toEqual(runtime);
  });
});
