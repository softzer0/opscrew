// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
// Feature 018: the deploy updates the app's extra servers before the switch, and repairs a port
// published on a private address that came up unpublished (T1807, research R5a).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { inEnvironment, jobYaml, serverPlan, splitPlan } from "./__fixtures__/plans";
import { DEPLOY_SECRETS, deploySecretNamesFor, renderWorkflow, serverDeploySecrets } from "./index";
import { portRepair } from "./servers";

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };

const ctx = testContext();
const content = (plan: DeployPlan) => renderWorkflow(plan, ctx).content;
const steps = (plan: DeployPlan): Step[] =>
  (parse(content(plan)) as { jobs: { deploy: { steps: Step[] } } }).jobs.deploy.steps;
const stepOf = (plan: DeployPlan, name: string) => {
  const found = steps(plan).find((s) => s.id === name || s.name === name);
  if (found === undefined) throw new Error(`no step ${name}`);
  return found;
};

const CONFIGURE = "Configure SSH for the app's other servers";
const DATA = "Update the services on the server data";
const BOX = "Update the services on the server box-2";

/** `plan` as prod with its deploys on `runner`. */
const on = (plan: DeployPlan, runner: "github" | "server" | "host") =>
  inEnvironment(plan, {
    runner,
    ...(runner === "host" ? { runnerHost: { name: "build-box", arch: "amd64" } } : {}),
  });

describe("the extra servers' deploy secrets", () => {
  it("names each server's host and known hosts after its name, upper-cased with - as _", () => {
    expect(serverDeploySecrets("data")).toEqual({
      host: "OPSCREW_SERVER_DATA_HOST",
      knownHosts: "OPSCREW_SERVER_DATA_KNOWN_HOSTS",
    });
    expect(serverDeploySecrets("box-2")).toEqual({
      host: "OPSCREW_SERVER_BOX_2_HOST",
      knownHosts: "OPSCREW_SERVER_BOX_2_KNOWN_HOSTS",
    });
  });

  it("lists them with the app's own, from GitHub's machines", () => {
    expect(deploySecretNamesFor(splitPlan())).toEqual([
      DEPLOY_SECRETS.host,
      DEPLOY_SECRETS.sshKey,
      DEPLOY_SECRETS.knownHosts,
      "OPSCREW_SERVER_DATA_HOST",
      "OPSCREW_SERVER_DATA_KNOWN_HOSTS",
      "OPSCREW_SERVER_BOX_2_HOST",
      "OPSCREW_SERVER_BOX_2_KNOWN_HOSTS",
      DEPLOY_SECRETS.appEnv,
      "OPSCREW_SERVICE_DB_ENV",
      "OPSCREW_SERVICE_DOCS_ENV",
      "OPSCREW_SERVICE_ORDERS_ENV",
      "OPSCREW_SERVICE_CACHE_ENV",
      DEPLOY_SECRETS.originTls,
      DEPLOY_SECRETS.buildEnv,
      DEPLOY_SECRETS.buildSecrets,
    ]);
  });

  it("adds the deploy key for the server's runner, and only known hosts once public SSH is closed", () => {
    const names = (plan: DeployPlan) =>
      deploySecretNamesFor(plan).filter((name) => /SERVER_|SSH|_HOST/.test(name));
    expect(names(on(splitPlan(), "server"))).toEqual([
      DEPLOY_SECRETS.sshKey,
      "OPSCREW_SERVER_DATA_HOST",
      "OPSCREW_SERVER_DATA_KNOWN_HOSTS",
      "OPSCREW_SERVER_BOX_2_HOST",
      "OPSCREW_SERVER_BOX_2_KNOWN_HOSTS",
    ]);
    expect(names(on(splitPlan({ publicSsh: false }), "server"))).toEqual([
      DEPLOY_SECRETS.sshKey,
      "OPSCREW_SERVER_DATA_KNOWN_HOSTS",
      "OPSCREW_SERVER_BOX_2_KNOWN_HOSTS",
    ]);
  });
});

describe("the deploy job with extra servers", () => {
  it("updates each extra server, in plan order, before the app's upload and switch", () => {
    const names = steps(splitPlan()).map((s) => s.id ?? s.name);
    const at = (name: string) => names.indexOf(name);
    expect(at(CONFIGURE)).toBeGreaterThan(-1);
    expect(at(CONFIGURE)).toBeLessThan(at(DATA));
    expect(at(DATA)).toBeLessThan(at(BOX));
    expect(at(BOX)).toBeLessThan(at("Configure SSH with the pinned host key"));
    expect(at(BOX)).toBeLessThan(at("Upload runtime files and environment"));
    expect(at(BOX)).toBeLessThan(at("start"));
  });

  it("writes the deploy key and every server's known hosts into the job's temp folder", () => {
    const step = stepOf(splitPlan(), CONFIGURE);
    expect(step.env).toEqual({
      SSH_KEY: "${{ secrets.OPSCREW_SSH_PRIVATE_KEY }}",
      OPSCREW_SERVER_DATA_KNOWN_HOSTS: "${{ secrets.OPSCREW_SERVER_DATA_KNOWN_HOSTS }}",
      OPSCREW_SERVER_BOX_2_KNOWN_HOSTS: "${{ secrets.OPSCREW_SERVER_BOX_2_KNOWN_HOSTS }}",
    });
    expect(step.run).toContain(
      `printf '%s\\n' "$OPSCREW_SERVER_DATA_KNOWN_HOSTS" "$OPSCREW_SERVER_BOX_2_KNOWN_HOSTS" > "$RUNNER_TEMP/opscrew-servers/known_hosts"`,
    );
  });

  it("uploads a server's Compose file, its services' settings and env files, then starts them and repairs their ports", () => {
    const plan = splitPlan();
    const data = stepOf(plan, DATA);
    expect(data.env).toEqual({
      HOST: "${{ secrets.OPSCREW_SERVER_DATA_HOST }}",
      OPSCREW_SERVICE_DB_ENV: "${{ secrets.OPSCREW_SERVICE_DB_ENV }}",
      OPSCREW_SERVICE_DOCS_ENV: "${{ secrets.OPSCREW_SERVICE_DOCS_ENV }}",
    });
    const run = data.run ?? "";
    expect(run).toContain(
      `scp "\${ssh_opts[@]}" opscrew/runtime/servers/data/compose.yaml "deploy@\${HOST}:/srv/apps/shop/compose.yaml"`,
    );
    expect(run).toContain("cat > /srv/apps/shop/db.env");
    expect(run).toContain("cat > /srv/apps/shop/docs.env");
    expect(run).not.toContain("orders.env");
    expect(run).toContain("docker compose pull\n");
    expect(run).toContain("docker compose up -d --wait --remove-orphans\n");
    expect(run).toContain("if ! published db 5432 10.200.4.2:5432; then");
    expect(run).toContain("if ! published docs 27017 10.200.4.2:27017; then");
    expect(run).toContain("docker compose up -d --force-recreate --no-deps --wait db");
    // MongoDB's replica set is set up where MongoDB runs, and a failure names that server.
    expect(run).toContain("docker compose exec -T docs");
    expect(run).toContain(
      "::error::The one-time setup of the docs service failed, so the new version was not started and the previous version keeps serving. The step'\\''s output stays on the server data in '\"$APPS_DIR\"'/shop/init.log (it can quote a key, so it is not printed here): fix the cause and push again.",
    );

    const box = stepOf(plan, BOX).run ?? "";
    expect(box).toContain(
      `scp -r "\${ssh_opts[@]}" opscrew/runtime/services/orders "deploy@\${HOST}:/srv/apps/shop/services/"`,
    );
    expect(box).toContain("if ! published orders 3306 10.200.4.3:3306; then");
  });

  it("connects to an extra own server on its SSH port, and refuses a port that isn't one", () => {
    const plan = splitPlan();
    const withPorts = (serverSshPorts: Record<string, number>) => {
      const rendered = parse(renderWorkflow(plan, { ...ctx, serverSshPorts }).content) as {
        jobs: { deploy: { steps: Step[] } };
      };
      const run = (name: string) =>
        rendered.jobs.deploy.steps.find((step) => step.name === name)?.run ?? "";
      return { data: run(DATA), box: run(BOX) };
    };
    const { data, box } = withPorts({ "box-2": 2222, data: 22 });
    expect(box).toContain("-o ConnectTimeout=20 -o Port=2222)");
    expect(data).toContain("-o ConnectTimeout=20)");
    expect(() => withPorts({ "box-2": 70000 })).toThrow(/not a whole number between 1 and 65535/);
  });

  it("leaves the extra servers' services and their env files off the app's server", () => {
    const plan = splitPlan();
    const upload = stepOf(plan, "Upload runtime files and environment");
    expect(Object.keys(upload.env ?? {})).toContain("OPSCREW_SERVICE_CACHE_ENV");
    expect(Object.keys(upload.env ?? {})).not.toContain("OPSCREW_SERVICE_DB_ENV");
    const start = stepOf(plan, "start").run ?? "";
    expect(start).toContain("docker compose up -d --no-deps --wait cache\n");
    expect(start).not.toContain("exec -T docs");
  });

  it("repairs the port of a service published on the app server's private address before the switch", () => {
    const start = stepOf(splitPlan(), "start").run ?? "";
    const repair = start.indexOf("if ! published cache 6379 10.200.4.1:6379; then");
    expect(repair).toBeGreaterThan(start.indexOf("docker compose up -d --no-deps --wait cache"));
    expect(repair).toBeLessThan(start.indexOf("kamal-proxy deploy"));
  });

  it("renders the deploy job as committed", () => {
    expect(jobYaml(content(splitPlan()), "deploy")).toMatchSnapshot();
  });
});

describe("an extra server a moving service leaves (T1811)", () => {
  /** `orders` moving from box-2, where it ran alone, to the app's server, at `step`. */
  const moving = (step: "deployed" | "switched") =>
    DeployPlanSchema.parse({
      ...splitPlan(),
      services: splitPlan().services.map(({ server, ...service }) =>
        service.name === "orders" ? service : { ...service, server },
      ),
      move: { service: "orders", from: "box-2", to: "app", step, copy: "dump" },
    });

  it("updates it while its old copy runs there, until the switch", () => {
    expect(steps(moving("deployed")).map((s) => s.name)).toContain(BOX);
  });

  it("skips the deploy job while the move's window pauses the app's deploys", () => {
    const deploy = (plan: DeployPlan) =>
      (parse(content(plan)) as { jobs: { deploy: { if?: string } } }).jobs.deploy;
    for (const step of ["deployed", "switched"] as const) {
      expect(deploy(moving(step)).if).toBe(
        `\${{ !contains(vars.OPSCREW_DEPLOY_PAUSED, '"shop/prod"') }}`,
      );
    }
    expect(deploy(inEnvironment(moving("deployed"), { name: "staging" })).if).toContain(
      `'"shop/staging"'`,
    );
    // Without a move the deploy job is as before.
    expect(deploy(splitPlan()).if).toBeUndefined();
    expect(content(splitPlan())).not.toContain("OPSCREW_DEPLOY_PAUSED");
  });

  it("skips it once it has nothing to run, instead of starting an empty project", () => {
    const plan = moving("switched");
    expect(steps(plan).map((s) => s.name)).not.toContain(BOX);
    expect(steps(plan).map((s) => s.name)).toContain(DATA);
    expect(Object.keys(stepOf(plan, CONFIGURE).env ?? {})).not.toContain(
      "OPSCREW_SERVER_BOX_2_KNOWN_HOSTS",
    );
  });
});

describe("with public SSH closed", () => {
  it("refuses to render for GitHub's machines and a runner machine, with the reason", () => {
    for (const runner of ["github", "host"] as const) {
      const render = () => content(on(splitPlan({ publicSsh: false }), runner));
      expect(render).toThrow(OpsCrewError);
      expect(render).toThrow(/Public SSH is closed on the app's servers/);
    }
  });

  it("reaches the extra servers at their private addresses, from the server's runner", () => {
    const plan = on(splitPlan({ publicSsh: false }), "server");
    expect(stepOf(plan, DATA).env?.HOST).toBe("10.200.4.2");
    expect(stepOf(plan, BOX).env?.HOST).toBe("10.200.4.3");
    const names = steps(plan).map((s) => s.name);
    expect(names).toContain("Copy the runtime files and environment into the app's folder");
    expect(names).not.toContain("Configure SSH with the pinned host key");
  });
});

describe("a plan without servers and network", () => {
  it("has no extra server steps and no port repair", () => {
    const text = content(serverPlan());
    expect(text).not.toContain(CONFIGURE);
    expect(text).not.toContain("published()");
    expect(text).not.toContain("SERVER_");
  });
});

describe.skipIf(spawnSync("sh", ["-c", "exit 0"]).status !== 0)("the published-port repair", () => {
  let work = "";
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-repair-")).replaceAll("\\", "/");
    mkdirSync(join(work, "bin"));
    // `docker compose port <service> <port>` prints what $WORK/port-<service> holds (fails when
    // unpublished); a forced recreate publishes $WORK/want-<service>, unless BROKEN is set.
    writeFileSync(
      join(work, "bin", "docker"),
      [
        "#!/bin/sh",
        'echo "docker $*" >> "$WORK/docker.log"',
        'if [ "$1 $2" = "compose port" ]; then cat "$WORK/port-$3" 2> /dev/null || exit 1; exit 0; fi',
        'if [ "$4" = "--force-recreate" ] && [ -z "${BROKEN:-}" ]; then',
        '  for last; do :; done; cp "$WORK/want-$last" "$WORK/port-$last"',
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  /** Runs the repair of the server `data`, with db's port published as `published` (if any). */
  function repair(published: string | undefined, env: Record<string, string> = {}) {
    const plan = DeployPlanSchema.parse({
      ...splitPlan(),
      services: splitPlan().services.filter((s) => s.name !== "docs"),
    });
    writeFileSync(join(work, "want-db"), "10.200.4.2:5432\n");
    if (published !== undefined) writeFileSync(join(work, "port-db"), `${published}\n`);
    const script = join(work, "repair.sh");
    writeFileSync(
      script,
      [
        'export PATH="$(cd "$WORK/bin" && pwd):$PATH"',
        "set -eu",
        ...portRepair(plan, "data"),
        "echo done",
      ].join("\n"),
    );
    const result = spawnSync("sh", [script], {
      env: { ...process.env, WORK: work, ...env },
      encoding: "utf8",
    });
    let log = "";
    try {
      log = readFileSync(join(work, "docker.log"), "utf8");
    } catch {
      // No docker call.
    }
    return { status: result.status, output: `${result.stdout}${result.stderr}`, log };
  }

  it("leaves a service alone whose port is published on the private address", () => {
    const { status, output, log } = repair("10.200.4.2:5432");
    expect(status).toBe(0);
    expect(output.trim()).toBe("done");
    expect(log).not.toContain("--force-recreate");
  });

  it("recreates a service that came up without its port, then checks again", () => {
    const { status, output, log } = repair(undefined);
    expect(status).toBe(0);
    expect(output).toContain(
      "::warning::The db service on the server data was running without its port 10.200.4.2:5432",
    );
    expect(log).toContain("docker compose up -d --force-recreate --no-deps --wait db");
    expect(output.trim().endsWith("done")).toBe(true);
  });

  it("recreates a service published on another address", () => {
    const { status, log } = repair("0.0.0.0:5432");
    expect(status).toBe(0);
    expect(log).toContain("--force-recreate");
  });

  it("stops the deploy when the port is still missing after the recreate", () => {
    const { status, output } = repair(undefined, { BROKEN: "1" });
    expect(status).toBe(1);
    expect(output).toContain(
      "::error::The db service on the server data is still not published on 10.200.4.2:5432 after OpsCrew recreated it, so the deploy stopped before the app changed.",
    );
    expect(output).not.toContain("done");
  });
});
