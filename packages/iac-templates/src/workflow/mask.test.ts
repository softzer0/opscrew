// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash in expected workflow lines, not JavaScript templates.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, hostListKind } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { GRAFANA_CLOUD, observabilityPlan } from "../addons/__fixtures__/plans";
import { renderRuntimeFiles } from "../runtime";
import { inEnvironment, splitPlan, withMonitoring } from "./__fixtures__/plans";
import { DEPLOY_SECRETS, maskFileScript, renderWorkflow } from "./index";

const grafana = (o: Parameters<typeof testPlan>[0] = {}) =>
  observabilityPlan({ grafanaCloud: GRAFANA_CLOUD }, o);
const lines = (plan: Parameters<typeof renderWorkflow>[0]) =>
  renderWorkflow(plan, testContext()).content.split("\n");

/** The masking script of a rendered workflow: from `mask=` to the line that sets the pattern. */
function maskScript(content: string): string {
  const all = content.split("\n");
  const start = all.findIndex((line) => line.trim() === "parts=");
  const end = all.findIndex((line) => line.includes("mask='[^\\s\\S]'"));
  return all
    .slice(start, end + 1)
    .map((line) => line.trim())
    .join("\n");
}

/** Runs the masking script with `appEnv` as the app's env file, and returns the pattern it built. */
async function maskFor(appEnv: string): Promise<string> {
  const script = maskScript(renderWorkflow(grafana(), testContext()).content);
  // On standard input: Git Bash on Windows splits a multi-line `-c` argument with quotes wrongly.
  const run = await new NodeCommandRunner().run("bash", ["-s"], {
    env: { ...process.env, OPSCREW_APP_ENV: appEnv },
    input: `set -euo pipefail\n${script}\nprintf '%s' "$mask"`,
  });
  expect(run.exitCode, run.stderr).toBe(0);
  return run.stdout;
}

describe("the masking file in the deploy job (Grafana Cloud)", () => {
  it("leaves server workflows without Grafana Cloud byte-identical", () => {
    for (const options of [{}, { provider: "own", domain: "shop.example.com" }] as const) {
      const without = renderWorkflow(testPlan(options), testContext());
      for (const observability of [
        { beszel: { enabled: true, version: "0.21.1" } },
        { grafanaCloud: { ...GRAFANA_CLOUD, enabled: false } },
      ]) {
        expect(renderWorkflow(observabilityPlan(observability, options), testContext())).toEqual(
          without,
        );
      }
    }
  });

  it("writes mask.re in the app's folder, owner-only and in place, right after app.env", () => {
    const all = lines(grafana());
    const appEnv = all.findIndex((line) => line.includes("cat > /srv/apps/shop/app.env"));
    const mask = all.findIndex((line) => line.includes("cat > /srv/apps/shop/mask.re"));
    expect(appEnv).toBeGreaterThan(0);
    expect(mask).toBeGreaterThan(appEnv);
    expect(all[mask]?.trim()).toBe(
      `printf '%s' "$mask" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > /srv/apps/shop/mask.re'`,
    );
    expect(all.slice(appEnv, mask).join("\n")).toContain('done <<< "${OPSCREW_APP_ENV:-}"');
  });

  it("writes it on the server's own runner too", () => {
    const content = renderWorkflow(
      inEnvironment(grafana(), { runner: "server" }),
      testContext(),
    ).content;
    expect(content).toContain(`printf '%s' "$mask" | (umask 077 && cat > "$dir"/mask.re)`);
  });

  it("holds app.env's values of 8 characters or more as one escaped RE2 alternation", async () => {
    const token = fakeSecret("github-token");
    const appEnv = [
      `API_TOKEN=${token}`,
      "SHORT=abc1234",
      "SPACED='a value with (parens) and a.dot'",
      'QUOTED="say \\"hi\\" to C:\\\\temp, cost $$5+tax\\nsecond line"',
      "# a comment=ignored-value",
      "EMPTY=",
      "",
    ].join("\n");
    const mask = await maskFor(appEnv);
    const values = [
      token,
      "a value with (parens) and a.dot",
      'say "hi" to C:\\temp, cost $5+tax',
      "second line",
    ];
    expect(mask.startsWith("(") && mask.endsWith(")")).toBe(true);
    const pattern = new RegExp(mask, "g");
    for (const value of values) {
      expect(`log: ${value} end`.replace(pattern, "<masked>")).toBe("log: <masked> end");
    }
    expect("abc1234 ignored-value".replace(pattern, "<masked>")).toBe("abc1234 ignored-value");
    // Escaped: a value's dot or plus matches only itself.
    expect("a value with (parens) and aXdot").not.toMatch(pattern);
    expect(mask.split("|")).toHaveLength(values.length);
  });

  it("lists longer values first, so a value that begins another never leaves the rest unmasked", async () => {
    const short = "prefix-value";
    const long = `${short}-and-the-rest`;
    const mask = await maskFor(`A_SHORT=${short}\nB_LONG=${long}\n`);
    expect(mask).toBe("(prefix-value-and-the-rest|prefix-value)");
    // JavaScript's alternation, like RE2's, takes the first alternative that matches.
    expect(`log: ${long} end`.replace(new RegExp(mask, "g"), "<masked>")).toBe("log: <masked> end");
  });

  it("leaves the host lists (the app's own hostnames) out, as plan-schema's hostListKind names them", async () => {
    const names = [
      "ALLOWED_HOSTS",
      "DJANGO_ALLOWED_HOSTS",
      "CSRF_TRUSTED_ORIGINS",
      "APP_CSRF_TRUSTED_ORIGINS",
      "_ALLOWED_HOSTS",
      "ALLOWED_HOSTS_EXTRA",
      "SECRET_KEY",
    ];
    const sampleFor = (name: string) => `value-${names.indexOf(name)}-of-${name.toLowerCase()}`;
    const mask = await maskFor(names.map((name) => `${name}=${sampleFor(name)}`).join("\n"));
    for (const name of names) {
      expect(mask.includes(sampleFor(name)), name).toBe(hostListKind(name) === undefined);
    }
    expect(names.filter((name) => hostListKind(name) !== undefined)).toHaveLength(4);
  });

  it("leaves APP_URL (the app's own address, 013 US8) out too, but not a prefixed one", async () => {
    const mask = await maskFor(
      "APP_URL=https://shop.example.com\nOTHER_APP_URL=https://other.example.com\n",
    );
    expect(mask).toBe("(https://other\\.example\\.com)");
  });

  it("holds a pattern that never matches when app.env has no long value", async () => {
    for (const appEnv of ["", "PORT=3000\n", "# only a comment\n"]) {
      const mask = await maskFor(appEnv);
      expect(mask).toBe("[^\\s\\S]");
      expect(new RegExp(mask).test("anything at all\n")).toBe(false);
    }
  });
});

describe("the masking script outside the deploy (a service's move, T1811)", () => {
  it("writes the deploy's mask.re from app.env in the app's folder", async () => {
    const appEnv = [
      `DATABASE_URL=postgresql://app:${fakeSecret("github-token")}@10.200.4.2:5432/app`,
      "SPACED='a value with (parens) and a.dot'",
      "PORT=3000",
    ].join("\n");
    const dir = await mkdtemp(join(tmpdir(), "opscrew-mask-"));
    try {
      await writeFile(join(dir, "app.env"), `${appEnv}\n\n`);
      const script = maskFileScript(grafana()).replaceAll(
        "/srv/apps/shop",
        dir.replace(/\\/g, "/"),
      );
      const run = await new NodeCommandRunner().run("bash", ["-s"], { input: script });
      expect(run.exitCode, run.stderr).toBe(0);
      expect(await readFile(join(dir, "mask.re"), "utf8")).toBe(await maskFor(appEnv));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is empty without Grafana Cloud", () => {
    expect(maskFileScript(testPlan())).toBe("");
  });
});

describe("the masking file on every server (monitoring on)", () => {
  type Step = { name?: string; run?: string };
  const stepRun = (plan: DeployPlan, name: string): string => {
    const doc = parse(renderWorkflow(plan, testContext()).content) as {
      jobs: { deploy: { steps: Step[] } };
    };
    const step = doc.jobs.deploy.steps.find((s) => s.name === name);
    if (step?.run === undefined) throw new Error(`no step ${name}`);
    return step.run;
  };
  const DATA = "Update the services on the server data";
  const BOX = "Update the services on the server box-2";
  const UPLOAD = "Upload runtime files and environment";
  const split = () => withMonitoring(splitPlan());
  const splitGrafana = () =>
    DeployPlanSchema.parse({ ...splitPlan(), observability: { grafanaCloud: GRAFANA_CLOUD } });

  /** Runs a step's masking script with `env`, and returns the pattern it built. */
  async function maskOf(run: string, env: Record<string, string>): Promise<string> {
    const result = await new NodeCommandRunner().run("bash", ["-s"], {
      env: { ...process.env, ...env },
      input: `set -euo pipefail\n${maskScript(run)}\nprintf '%s' "$mask"`,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    return result.stdout;
  }

  it("writes mask.re on the app's server without Grafana Cloud, from app.env as 017 does", () => {
    const plan = withMonitoring(testPlan());
    const run = stepRun(plan, UPLOAD);
    expect(maskScript(run)).toBe(maskScript(renderWorkflow(grafana(), testContext()).content));
    expect(run).toContain(
      `printf '%s' "$mask" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > /srv/apps/shop/mask.re'`,
    );
    expect(maskFileScript(plan)).toBe(maskFileScript(grafana()));
  });

  it("writes mask.re on each extra server, owner-only, after its env files and before its services start", () => {
    for (const [name, last] of [
      [DATA, "docs.env"],
      [BOX, "orders.env"],
    ] as const) {
      const all = stepRun(split(), name).split("\n");
      const envFile = all.findIndex((line) => line.includes(`cat > /srv/apps/shop/${last}'`));
      const mask = all.findIndex((line) => line.includes("cat > /srv/apps/shop/mask.re"));
      const remote = all.findIndex((line) => line.includes("sh -s <<'REMOTE'"));
      expect(envFile).toBeGreaterThan(0);
      expect(mask).toBeGreaterThan(envFile);
      expect(remote).toBeGreaterThan(mask);
      expect(all[mask]).toBe(
        `printf '%s' "$mask" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > /srv/apps/shop/mask.re'`,
      );
    }
  });

  it("builds each extra server's pattern from the env files that server receives", async () => {
    const values = {
      OPSCREW_SERVICE_DB_ENV: `POSTGRES_PASSWORD=${fakeSecret("github-token", "db")}\nPOSTGRES_USER=app\n`,
      OPSCREW_SERVICE_DOCS_ENV: `MONGO_INITDB_ROOT_PASSWORD=${fakeSecret("github-token", "docs")}`,
      OPSCREW_SERVICE_ORDERS_ENV: `MYSQL_PASSWORD=${fakeSecret("github-token", "orders")}\n`,
      OPSCREW_APP_ENV: `SECRET_KEY=${fakeSecret("github-token", "app")}\n`,
    };
    type Name = keyof typeof values;
    const names = Object.keys(values) as Name[];
    const value = (name: Name) => values[name].split("\n")[0]?.split("=")[1] ?? "";
    const expected: [string, readonly Name[]][] = [
      [DATA, ["OPSCREW_SERVICE_DB_ENV", "OPSCREW_SERVICE_DOCS_ENV"]],
      [BOX, ["OPSCREW_SERVICE_ORDERS_ENV"]],
    ];
    for (const [step, has] of expected) {
      const mask = await maskOf(stepRun(split(), step), values);
      expect(mask.startsWith("(") && mask.endsWith(")")).toBe(true);
      for (const name of names) {
        expect(mask.includes(value(name)), `${step}: ${name}`).toBe(has.includes(name));
      }
      expect(mask.split("|")).toHaveLength(has.length);
      expect(stepRun(split(), step)).not.toContain(DEPLOY_SECRETS.appEnv);
    }
    // The workflow names the secrets only; their values reach the server at run time.
    const content = renderWorkflow(split(), testContext()).content;
    for (const name of names) expect(content).not.toContain(value(name));
  });

  it("writes it on the app's server from the server's own runner, and on the extra servers over SSH", () => {
    const content = renderWorkflow(
      inEnvironment(split(), { runner: "server" }),
      testContext(),
    ).content;
    expect(content).toContain(`printf '%s' "$mask" | (umask 077 && cat > "$dir"/mask.re)`);
    expect(content.match(/'umask 077 && cat > \/srv\/apps\/shop\/mask\.re'/g)).toHaveLength(2);
  });

  it("keeps a moving service's old copy's values in its server's mask while it still runs there", async () => {
    // `orders` moves from box-2, where it ran alone, to the app's server; not switched yet.
    const moving = withMonitoring(
      DeployPlanSchema.parse({
        ...splitPlan(),
        services: splitPlan().services.map(({ server, ...service }) =>
          service.name === "orders" ? service : { ...service, server },
        ),
        move: { service: "orders", from: "box-2", to: "app", step: "deployed", copy: "dump" },
      }),
    );
    const doc = parse(renderWorkflow(moving, testContext()).content) as {
      jobs: { deploy: { steps: (Step & { env?: Record<string, string> })[] } };
    };
    const step = doc.jobs.deploy.steps.find((s) => s.name === BOX);
    expect(step?.env).toHaveProperty("OPSCREW_SERVICE_ORDERS_ENV");
    const run = step?.run ?? "";
    // Its env file is no longer written there: only the old copy, which keeps its own, runs.
    expect(run).not.toContain("cat > /srv/apps/shop/orders.env");
    expect(run).toContain("# Grafana Alloy's masking file: orders.env's values as");
    const password = fakeSecret("github-token", "orders");
    const mask = await maskOf(run, { OPSCREW_SERVICE_ORDERS_ENV: `MYSQL_PASSWORD=${password}\n` });
    expect(mask).toBe(`(${password})`);
  });

  it("is never a file in the repository", () => {
    const paths = [
      ...renderRuntimeFiles(split(), testContext()).map((file) => file.path),
      renderWorkflow(split(), testContext()).path,
    ];
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.filter((path) => path.endsWith("mask.re"))).toEqual([]);
  });

  it("leaves every workflow byte-identical without monitoring, Grafana Cloud's included", () => {
    for (const plan of [
      testPlan(),
      splitPlan(),
      grafana(),
      splitGrafana(),
      inEnvironment(splitPlan(), { runner: "server" }),
    ]) {
      expect(renderWorkflow(withMonitoring(plan, { enabled: false }), testContext())).toEqual(
        renderWorkflow(plan, testContext()),
      );
    }
    for (const name of [DATA, BOX]) {
      expect(stepRun(splitGrafana(), name)).not.toContain("mask.re");
    }
  });
});
