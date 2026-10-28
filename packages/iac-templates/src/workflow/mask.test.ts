// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash in expected workflow lines, not JavaScript templates.
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
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
  const start = all.findIndex((line) => line.trim() === "mask=");
  const end = all.findIndex((line) => line.includes("mask='[^\\s\\S]'"));
  return all
    .slice(start, end + 1)
    .map((line) => line.trim())
    .join("\n");
}

/** Runs the masking script with `appEnv` as the app's env file, and returns the pattern it built. */
async function maskFor(appEnv: string): Promise<string> {
  const script = maskScript(renderWorkflow(grafana(), testContext()).content);
  const run = await new NodeCommandRunner().run(
    "bash",
    ["-c", `set -euo pipefail\n${script}\nprintf '%s' "$mask"`],
    { env: { ...process.env, OPSCREW_APP_ENV: appEnv } },
  );
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

  it("holds a pattern that never matches when app.env has no long value", async () => {
    for (const appEnv of ["", "PORT=3000\n", "# only a comment\n"]) {
      const mask = await maskFor(appEnv);
      expect(mask).toBe("[^\\s\\S]");
      expect(new RegExp(mask).test("anything at all\n")).toBe(false);
    }
  });
});
