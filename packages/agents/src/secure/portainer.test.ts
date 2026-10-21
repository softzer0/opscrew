import { readFile } from "node:fs/promises";
import { findExecutable } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import type { LocalDocker } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import {
  deployImage,
  everythingShown,
  forbiddenIn,
  type PortainerProject,
  portainerPlan,
  portainerProject,
  provisionPortainerProject,
} from "../drift/__fixtures__/portainer-project";
import { readPortainerConnection, recordPortainerConnection } from "../shared";
import { runSecure } from "./run";

async function deployed() {
  const s = await portainerProject();
  await provisionPortainerProject(s);
  await deployImage(s);
  return s;
}

const secure = (s: PortainerProject) =>
  runSecure(s.deps, {
    scanners: [],
    offline: true,
    tcpConnect: async () => {
      throw new Error("secure probes no port of a Portainer host");
    },
    ...(s.services.portainer?.client !== undefined
      ? { portainer: { client: s.services.portainer.client } }
      : {}),
  });

describe.skipIf(!findExecutable("git"))("opscrew secure for the user's Portainer", () => {
  it("with --deep runs only testssl.sh, at Cloudflare's edge, and says why the other two do not run", async () => {
    const s = await deployed();
    const calls: (readonly string[])[] = [];
    const docker: LocalDocker = {
      async run(args) {
        calls.push(args);
        if (args[0] === "version") return { exitCode: 0, stdout: "29.8.2\n", stderr: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: "3.2.4 ",
            scanResult: [{ targetHost: "shop.example.com", protocols: [] }],
          }),
          stderr: "",
        };
      },
    };
    const result = await runSecure(s.deps, {
      scanners: [],
      offline: true,
      tcpConnect: async () => {
        throw new Error("secure probes no port of a Portainer host");
      },
      deep: true,
      docker,
      ...(s.services.portainer?.client !== undefined
        ? { portainer: { client: s.services.portainer.client } }
        : {}),
    });
    const [lynis, sshAudit, testssl] = result.deep ?? [];
    for (const run of [lynis, sshAudit]) {
      expect(run?.results).toEqual([
        expect.objectContaining({
          status: "skip",
          message: expect.stringContaining(
            "OpsCrew reaches your Portainer only through its API, never over SSH",
          ),
        }),
      ]);
    }
    expect(testssl?.results).toEqual([
      expect.objectContaining({ status: "pass", target: "shop.example.com (Cloudflare's edge)" }),
    ]);
    expect(calls.filter((args) => args[0] === "run").map((args) => args.at(-1))).toEqual([
      "shop.example.com:443",
    ]);
    expect(result.report).toContain("### testssl.sh 3.2.4");
  });

  it("without the token or the connection skips the Portainer checks plainly and still writes the report", async () => {
    const s = await portainerProject();
    delete s.deps.env.PORTAINER_API_KEY;
    let result = await secure(s);
    expect(result.hostChecks).toEqual([]);
    let report = await readFile(s.deps.paths.files.securityReport, "utf8");
    expect(report).toContain("## The app's stacks in your Portainer");
    expect(report).toContain("Skipped: PORTAINER_API_KEY is not set");
    expect(report).toContain("## Code scan");
    expect(report).toContain("## Infrastructure policies");
    expect(s.deps.reporter.text()).toContain(
      "Portainer checks skipped: PORTAINER_API_KEY is not set",
    );
    expect(s.fake.calls).toEqual([]);

    s.deps.env.PORTAINER_API_KEY = s.secrets.portainerToken;
    await recordPortainerConnection(s.deps.paths, undefined);
    result = await secure(s);
    expect(result.hostChecks).toEqual([]);
    report = await readFile(s.deps.paths.files.securityReport, "utf8");
    expect(report).toContain("Skipped: OpsCrew does not know how to reach your Portainer");
    expect(s.fake.calls).toEqual([]);
  });

  it("skips the checks for another environment than the plan's, saying so without a change claim", async () => {
    const s = await portainerProject();
    const connection = await readPortainerConnection(s.deps.paths);
    if (connection === undefined) throw new Error("no recorded connection");
    await recordPortainerConnection(s.deps.paths, {
      ...connection,
      environmentId: 4,
      environmentName: "edge",
    });
    const result = await secure(s);
    expect(result.hostChecks).toEqual([]);
    const reason =
      "opscrew/plan.yaml deploys to Portainer environment 3, but the interview on this computer chose environment 4 (edge). Run `opscrew design` again so the plan uses the environment you chose, then run `opscrew provision` again.";
    const report = await readFile(s.deps.paths.files.securityReport, "utf8");
    expect(report).toContain(`Skipped: ${reason}`);
    expect(s.deps.reporter.text()).toContain(`Portainer checks skipped: ${reason}`);
    expect(`${report}\n${s.deps.reporter.text()}`).not.toContain("Nothing was changed.");
    expect(s.fake.calls).toEqual([]);
  });

  it("checks the app and its stacks read-only and says the host and backups stay the user's", async () => {
    const s = await deployed();
    const mutations = s.fake.mutations().length;
    const result = await secure(s);

    expect(result.hostChecks.map((check) => [check.id, check.status])).toEqual([
      ["portainer-connection", "pass"],
      ["stack-app", "pass"],
      ["stack-app-file", "pass"],
      ["stack-updater", "pass"],
      ["stack-updater-file", "pass"],
      ["stack-app-redeploy", "pass"],
      ["registry-entry", "pass"],
      ["service-db-login", "pass"],
    ]);
    expect(result.probes).toEqual([]);
    expect(result.passed).toBe(true);
    expect(s.fake.mutations()).toHaveLength(mutations);

    const report = await readFile(s.deps.paths.files.securityReport, "utf8");
    expect(report).toContain("## The app's stacks in your Portainer");
    expect(report).toContain("OpsCrew does not change the host");
    expect(report).toContain("Backups, including the app's data volumes, are your responsibility");
    expect(report).toContain("OpsCrew does not probe your Portainer host");
    expect(report).not.toContain("## Server hardening");
    expect(s.deps.reporter.text()).toContain("OpsCrew does not change the host");
    const text = `${await everythingShown(s)}\n${report}`;
    for (const secret of forbiddenIn(s)) expect(text).not.toContain(secret);
  });

  it("checks each service's login through the app stack's variables, by name only", async () => {
    const base = portainerPlan();
    const entry = (kind: "mysql" | "valkey", fields = {}) => {
      const spec = serviceSpec(kind);
      return {
        kind,
        version: spec.defaultVersion,
        memoryMb: spec.memory.defaultMb,
        options: {},
        reason: "The app uses it.",
        licence: spec.licence.id,
        ...fields,
      };
    };
    const plan = DeployPlanSchema.parse({
      ...base,
      services: [
        ...base.services,
        entry("mysql"),
        entry("valkey", { name: "cache", options: { mode: "cache" } }),
      ],
    });
    const s = await portainerProject({ plan });
    await provisionPortainerProject(s);
    await deployImage(s);
    let result = await secure(s);
    const byId = () => Object.fromEntries(result.hostChecks.map((check) => [check.id, check]));
    expect(byId()["service-mysql-login"]).toMatchObject({
      status: "pass",
      severity: "high",
      message:
        "MySQL (mysql) requires its login: OPSCREW_SVC_MYSQL_PASSWORD and OPSCREW_SVC_MYSQL_ROOT_PASSWORD are set in the app stack's environment.",
    });
    expect(byId()["service-db-login"]?.status).toBe("pass");
    expect(byId()["service-cache-login"]).toMatchObject({
      status: "pass",
      message:
        "Valkey (cache) requires its login: OPSCREW_SVC_CACHE_PASSWORD is set in the app stack's environment.",
    });

    // A login removed, and one emptied, in Portainer.
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    if (app === undefined) throw new Error("no app stack");
    const password = app.Env.find((pair) => pair.name === "OPSCREW_SVC_MYSQL_PASSWORD")?.value;
    app.Env = app.Env.filter((pair) => pair.name !== "OPSCREW_SVC_MYSQL_ROOT_PASSWORD").map(
      (pair) => (pair.name === "OPSCREW_SVC_MYSQL_PASSWORD" ? { ...pair, value: "" } : pair),
    );
    result = await secure(s);
    expect(byId()["service-mysql-login"]).toMatchObject({
      status: "fail",
      message:
        "The app stack's environment has no value for OPSCREW_SVC_MYSQL_PASSWORD and OPSCREW_SVC_MYSQL_ROOT_PASSWORD, so MySQL (mysql) runs without its login.",
    });
    expect(result.passed).toBe(false);
    const report = await readFile(s.deps.paths.files.securityReport, "utf8");
    expect(`${report}\n${s.deps.reporter.text()}`).not.toContain(password);
  });

  it("fails on a hand-hardened-down stack, a failed deploy, a missing updater and a lost grant", async () => {
    const s = await deployed();
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    if (app === undefined) throw new Error("no app stack");
    app.file = [
      "services:",
      "  app:",
      `    image: ghcr.io/acme/shop@sha256:${"ab".repeat(32)}`,
      "    privileged: true",
      "    ports: ['9999:3000']",
      "    volumes: ['/var/run/docker.sock:/var/run/docker.sock']",
      "",
    ].join("\n");
    app.Status = 4;
    app.DeploymentStatus.push({ Status: 4, Message: "port is already allocated", Time: 1 });
    const updater = s.fake.stacks.findIndex((stack) => stack.Name === "opscrew-shop-updater");
    s.fake.stacks.splice(updater, 1);
    const entry = s.fake.registries[0];
    if (entry !== undefined) entry.RegistryAccesses = {};

    const result = await secure(s);
    const byId = Object.fromEntries(result.hostChecks.map((check) => [check.id, check]));
    expect(byId["stack-app"]?.status).toBe("fail");
    expect(byId["stack-app"]?.message).toContain("port is already allocated");
    expect(byId["stack-app-file"]).toMatchObject({ status: "fail", severity: "critical" });
    expect(byId["stack-app-file"]?.message).toContain("app runs privileged");
    expect(byId["stack-app-file"]?.message).toContain("app mounts the Docker socket");
    expect(byId["stack-app-file"]?.message).toContain(
      "app publishes host port 9999, which this setup does not use",
    );
    expect(byId["stack-updater"]?.status).toBe("fail");
    expect(byId["registry-entry"]?.status).toBe("fail");
    expect(result.passed).toBe(false);
    const report = await readFile(s.deps.paths.files.securityReport, "utf8");
    expect(report).toContain("Portainer stacks: ");
  });
});
