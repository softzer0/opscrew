// Feature 025 (T2508): the preview key joins the recovery copy.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { fileMode, isCopyPath, localPath, readLocalFiles } from "./files";

describe("the recovery copy's files", () => {
  it("hold a preview environment's preview key, both halves, private at 0600", async () => {
    const deps = await createTestPhaseDeps({ environment: "preview" });
    expect(isCopyPath("home/preview_key")).toBe(true);
    expect(isCopyPath("home/preview_key.pub")).toBe(true);
    expect(localPath(deps.paths, "home/preview_key")).toBe(deps.paths.files.previewKey);
    expect(localPath(deps.paths, "home/preview_key.pub")).toBe(deps.paths.files.previewKeyPub);
    expect(fileMode("home/preview_key")).toBe(0o600);
    await mkdir(dirname(deps.paths.files.previewKey), { recursive: true });
    await writeFile(deps.paths.files.previewKey, "the private half\n");
    await writeFile(deps.paths.files.previewKeyPub, "ssh-ed25519 AAAA opscrew-preview@x\n");
    const files = await readLocalFiles(deps.paths, deps.redactor);
    expect(Object.keys(files).sort()).toEqual(["home/preview_key", "home/preview_key.pub"]);
  });
});
