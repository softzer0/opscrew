// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash syntax, not JavaScript templates.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderWorkflow } from "./index";

type Step = { name?: string; run?: string };

function sshRuns(content: string): string[] {
  const steps: Step[] = parse(content).jobs.deploy.steps;
  return steps.map((s) => s.run ?? "").filter((run) => run.includes("ssh_opts"));
}

const ownPublic = testPlan({ provider: "own", access: "public" });

describe("renderWorkflow honours the server's SSH port", () => {
  it("passes a port other than 22 to every ssh and scp call (deploy and rollback)", () => {
    const content = renderWorkflow(ownPublic, testContext({ sshPort: 2222 })).content;
    const runs = sshRuns(content);
    expect(runs).toHaveLength(3); // upload, start, roll back
    for (const run of runs) {
      expect(run).toMatch(/ssh_opts=\([^)]* -o Port=2222\)/);
      for (const line of run.split("\n")) {
        if (/\b(ssh|scp) /.test(line)) expect(line).toContain('"${ssh_opts[@]}"');
      }
    }
    expect(runs[0]).toMatch(/scp -r "\$\{ssh_opts\[@\]\}"/);
    expect(runs[2]).toMatch(/ssh "\$\{ssh_opts\[@\]\}"/);
  });

  it("leaves port 22 and an unset port byte-identical", () => {
    const unset = renderWorkflow(ownPublic, testContext()).content;
    expect(renderWorkflow(ownPublic, testContext({ sshPort: 22 })).content).toBe(unset);
    expect(unset).not.toContain("Port=");
    const hetzner = testPlan();
    expect(renderWorkflow(hetzner, testContext({ sshPort: 22 })).content).toBe(
      renderWorkflow(hetzner, testContext()).content,
    );
  });

  it("does not add the port in tunnel mode (the tunnel routes to sshd's port)", () => {
    const tunnelPlan = testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });
    const ctx = testContext();
    const withPort = renderWorkflow(tunnelPlan, { ...ctx, sshPort: 2222 }).content;
    expect(withPort).toBe(renderWorkflow(tunnelPlan, ctx).content);
    expect(withPort).not.toContain("Port=");
  });

  it.each([0, 65536, 22.5, Number.NaN, -1])("rejects SSH port %s at render", (sshPort) => {
    expect(() => renderWorkflow(ownPublic, testContext({ sshPort }))).toThrow(
      /between 1 and 65535/,
    );
  });
});
