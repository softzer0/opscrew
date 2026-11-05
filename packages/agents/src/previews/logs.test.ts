import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeShell, previewProject } from "./__fixtures__/plan";
import { previewLogs } from "./logs";

describe("previewLogs", () => {
  it("reads a preview's lines over the deploy key, read-only, redacted", async () => {
    const { deps, plan } = await previewProject();
    const token = fakeSecret("github-token");
    deps.redactor.addName(token, "test-token");
    const shell = fakeShell(() => ({
      exitCode: 0,
      stdout: `app-1  | listening on 3000\napp-1  | token ${token}\nopscrew-preview: listed 42\n`,
    }));
    const lines = await previewLogs(deps, plan, "42", { services: { remote: shell.remote } });
    expect(shell.commands).toEqual(["/srv/apps/shop-preview/bin/opscrew-preview logs 42"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("app-1  | listening on 3000");
    expect(lines.join("\n")).not.toContain(token);
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({ kind: "remote-exec", decision: "allow", detail: "pr-42" }),
    );
  });

  it("masks the preview values of .env.<env> in the lines", async () => {
    const { deps, plan, root } = await previewProject();
    const key = fakeSecret("generic-password", "preview-value");
    await writeFile(join(root, ".env.preview"), `# test keys only\nSTRIPE_SECRET_KEY="${key}"\n`);
    const shell = fakeShell(() => ({
      exitCode: 0,
      stdout: `app-1  | using ${key}\nopscrew-preview: listed 42\n`,
    }));
    const lines = await previewLogs(deps, plan, "42", { services: { remote: shell.remote } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^app-1 {2}\| using /);
    expect(lines.join("\n")).not.toContain(key);
  });

  it("says plainly when the server has no such preview", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 0, stdout: "opscrew-preview: removed 42\n" }));
    await expect(
      previewLogs(deps, plan, "42", { services: { remote: shell.remote } }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "There is no preview pr-42 on the preview server, so it has no lines.",
      hint: "`opscrew preview list --env preview` shows the previews there.",
    });
  });

  it("refuses a number the command would refuse, before connecting", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 0, stdout: "" }));
    await expect(
      previewLogs(deps, plan, "42; rm -rf /", { services: { remote: shell.remote } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(shell.commands).toEqual([]);
  });

  it("says what the command refused", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 2, stdout: "opscrew-preview: refused number\n" }));
    await expect(
      previewLogs(deps, plan, "42", { services: { remote: shell.remote } }),
    ).rejects.toThrow('answered "refused number" (exit code 2)');
  });
});
