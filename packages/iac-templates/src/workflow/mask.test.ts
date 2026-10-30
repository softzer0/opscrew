// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash in expected workflow lines, not JavaScript templates.
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { hostListKind } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { GRAFANA_CLOUD, observabilityPlan } from "../addons/__fixtures__/plans";
import { inEnvironment } from "./__fixtures__/plans";
import { renderWorkflow } from "./index";

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

  it("holds a pattern that never matches when app.env has no long value", async () => {
    for (const appEnv of ["", "PORT=3000\n", "# only a comment\n"]) {
      const mask = await maskFor(appEnv);
      expect(mask).toBe("[^\\s\\S]");
      expect(new RegExp(mask).test("anything at all\n")).toBe(false);
    }
  });
});
