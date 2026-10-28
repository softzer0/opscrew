import { readFile, stat, writeFile } from "node:fs/promises";
import { resolveProjectPaths } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { ensureCheckKey } from "./key";

describe("ensureCheckKey", () => {
  it("generates the Ed25519 key once, at the first app's prod path, whatever environment runs", async () => {
    const staging = await createTestPhaseDeps({ environment: "staging" });
    const first = await ensureCheckKey(staging.paths, staging.redactor);
    const file = resolveProjectPaths(staging.paths.root, { env: staging.env }).files.checkKey;
    expect(file).not.toBe(staging.paths.files.checkKey);
    expect(first.created).toBe(true);
    expect(first.publicKeyOpenSsh).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{48}$/);
    expect(first.privateKeyOpenSsh).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/,
    );
    await expect(readFile(file, "utf8")).resolves.toBe(first.privateKeyOpenSsh);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    // prod reuses it; its private half is masked.
    const prod = await createTestPhaseDeps({ root: staging.paths.root, env: staging.env });
    const again = await ensureCheckKey(prod.paths, prod.redactor);
    expect(again).toEqual({ ...first, created: false });
    const line = first.privateKeyOpenSsh.split("\n")[1] as string;
    expect(prod.redactor.redact(`key: ${first.privateKeyOpenSsh}`)).not.toContain(line);
  });

  it("stops on a damaged key instead of making a new one", async () => {
    const deps = await createTestPhaseDeps();
    await ensureCheckKey(deps.paths, deps.redactor);
    await writeFile(deps.paths.files.checkKey, "not a key\n");
    await expect(ensureCheckKey(deps.paths, deps.redactor)).rejects.toThrow(
      /The scheduled check's key .* is damaged/,
    );
    await expect(readFile(deps.paths.files.checkKey, "utf8")).resolves.toBe("not a key\n");
  });
});
