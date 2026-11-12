// Feature 025 (T2508): the preview key joins the recovery copy; feature 027 (T2711): the hosting record.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { hostingRecordFile, updateHostingRecord } from "../hosting/record";
import { createTestPhaseDeps } from "../testing";
import { fileMode, isCopyPath, localPath, readLocalFiles, registerGeneratedValues } from "./files";

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

  it("hold the hosting account's record, which lists what OpsCrew made there (027)", async () => {
    const deps = await createTestPhaseDeps();
    expect(isCopyPath("state/hosting.json")).toBe(true);
    expect(localPath(deps.paths, "state/hosting.json")).toBe(hostingRecordFile(deps.paths));
    await updateHostingRecord(deps.paths, (current) => ({
      ...current,
      objects: [{ kind: "hostname", key: "notes.example.com" }],
    }));
    const files = await readLocalFiles(deps.paths, deps.redactor);
    expect(Object.keys(files)).toEqual(["state/hosting.json"]);
  });

  it("register each value a previous-value variable holds on its own, beside the whole", async () => {
    const deps = await createTestPhaseDeps();
    const [key, earlier, auth, current] = [1, 2, 3, 4].map(() => randomBytes(32).toString("hex"));
    const env = {
      APP_PREVIOUS_KEYS: `${key},${earlier}`,
      BETTER_AUTH_SECRETS: `2:${current},1:${auth}`,
    };
    registerGeneratedValues(deps.redactor, {
      "home/generated_values.json": `${JSON.stringify({ env })}\n`,
    });
    for (const value of [earlier, current, ...Object.values(env)]) {
      expect(deps.redactor.redact(`x ${value} y`)).not.toContain(value);
    }
  });
});
