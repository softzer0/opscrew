import { describe, expect, it } from "vitest";
import { fakeShell, HOST_42, LIST_OUTPUT, previewProject } from "../previews/__fixtures__/plan";
import { figuresOutput, SERVER_IPV4 } from "../testing";
import { componentStatusReport } from "./run";

describe("status --env <preview>", () => {
  it("shows the server's figures and the previews, with no app health check", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell((command) =>
      command.includes("==opscrew-figures:")
        ? { exitCode: 0, stdout: figuresOutput(plan.app.name, { containers: [] }) }
        : command.endsWith("opscrew-preview list")
          ? { exitCode: 0, stdout: LIST_OUTPUT }
          : { exitCode: 1, stdout: "" },
    );
    const report = await componentStatusReport(deps, plan, {
      services: { remote: shell.remote },
    });
    const text = report.lines.join("\n");
    expect(text).toContain("Resources (read now):");
    expect(text).toMatch(/ {2}Server: load .* on 2 CPUs; memory/);
    expect(text).toContain("Previews: 2 of at most 3.");
    expect(text).toContain(`  pr-42: https://${HOST_42}, running`);
    // Only the figures and the list: no component, health or deploy read.
    expect(shell.commands).toHaveLength(2);
    expect(text).not.toMatch(/web process|health|Warning|High/i);
    expect(report.resources?.server).toBeDefined();
    // The server's address stays out of what is said and audited.
    const said = [text, deps.reporter.text(), JSON.stringify(deps.audit.entries)].join("\n");
    expect(said).not.toContain(SERVER_IPV4);
  });

  it("says where it could not read the previews, and still shows the figures", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell((command) =>
      command.includes("==opscrew-figures:")
        ? { exitCode: 0, stdout: figuresOutput(plan.app.name, { containers: [] }) }
        : { exitCode: 127, stdout: "" },
    );
    const report = await componentStatusReport(deps, plan, {
      services: { remote: shell.remote },
    });
    const text = report.lines.join("\n");
    expect(text).toContain("Resources (read now):");
    expect(text).toContain("OpsCrew could not read the previews.");
    expect(text).toContain("opscrew provision --env preview");
  });
});
