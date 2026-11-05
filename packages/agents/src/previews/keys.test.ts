import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor, resolveProjectPaths } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { ensureDeployKey } from "../shared";
import { ensurePreviewKey } from "./keys";

async function previewPaths() {
  const root = await mkdtemp(join(tmpdir(), "opscrew-preview-key-"));
  return resolveProjectPaths(root, {
    env: { OPSCREW_HOME: join(root, ".home-opscrew") },
    environment: "preview",
  });
}

describe("ensurePreviewKey", () => {
  it("makes the environment's Ed25519 preview key once, apart from its deploy key, and reuses it", async () => {
    const paths = await previewPaths();
    const redactor = new Redactor();
    const key = await ensurePreviewKey(paths, redactor);
    expect(key.created).toBe(true);
    expect(key.publicKeyOpenSsh).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ opscrew-preview@/);
    expect(key.privateKeyOpenSsh).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(paths.files.previewKey).toMatch(/environments[\\/]preview[\\/]preview_key$/);
    expect(await readFile(paths.files.previewKey, "utf8")).toBe(key.privateKeyOpenSsh);
    expect((await readFile(paths.files.previewKeyPub, "utf8")).trim()).toBe(key.publicKeyOpenSsh);
    if (process.platform !== "win32") {
      expect((await stat(paths.files.previewKey)).mode & 0o777).toBe(0o600);
    }
    // Its private half never shows.
    expect(redactor.redact(`key: ${key.privateKeyOpenSsh}`)).not.toContain(
      key.privateKeyOpenSsh.split("\n")[1],
    );

    const again = await ensurePreviewKey(paths, new Redactor());
    expect(again).toEqual({ ...key, created: false });
    const deploy = await ensureDeployKey(paths, new Redactor());
    expect(deploy.publicKeyOpenSsh).not.toBe(key.publicKeyOpenSsh);
  });
});
