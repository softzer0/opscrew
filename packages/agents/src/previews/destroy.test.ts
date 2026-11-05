import { describe, expect, it } from "vitest";
import { fakeShell, previewProject } from "./__fixtures__/plan";
import { destroyPreview } from "./destroy";

describe("destroyPreview", () => {
  it("removes a preview after the typed pr-<n>, audited as remote-exec", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 0, stdout: "opscrew-preview: removed 42\n" }));
    await destroyPreview(deps, plan, "42", { services: { remote: shell.remote } });
    expect(shell.commands).toEqual(["/srv/apps/shop-preview/bin/opscrew-preview down 42"]);
    const [request] = (deps.approvalHandler as unknown as { requests: unknown[] }).requests;
    expect(request).toMatchObject({
      kind: "remote-exec",
      allowDestroy: true,
      confirmPhrase: "pr-42",
      details: expect.stringContaining("Preview pr-42 is removed as if its pull request closed"),
    });
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "remote-exec",
        action: "remove a preview",
        decision: "approved",
        detail: "pr-42",
      }),
    );
    expect(deps.reporter.text()).toContain("Removed preview pr-42 with its data.");
  });

  it("changes nothing when the name is not confirmed", async () => {
    const { deps, plan } = await previewProject({ answer: [false] });
    const shell = fakeShell(() => ({ exitCode: 0, stdout: "opscrew-preview: removed 42\n" }));
    const error = await destroyPreview(deps, plan, "42", {
      services: { remote: shell.remote },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("Nothing was changed."),
      hint: expect.stringContaining("--confirm pr-42"),
    });
    expect(shell.commands).toEqual([]);
  });

  it("says when the preview's lock was held too long", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 6, stdout: "opscrew-preview: busy 600\n" }));
    await expect(
      destroyPreview(deps, plan, "42", { services: { remote: shell.remote } }),
    ).rejects.toThrow("busy for 600 seconds");
  });
});
