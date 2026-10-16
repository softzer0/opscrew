import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor, resolveProjectPaths } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  ensurePortainerPassword,
  portainerPasswordFile,
  portainerPasswordToSend,
} from "../provision/own";
import { ensureStatePassphrase } from "./secret-files";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "opscrew-secret-files-"));
  const paths = resolveProjectPaths(root, { env: { OPSCREW_HOME: join(root, "home") } });
  await mkdir(paths.projectHomeDir, { recursive: true });
  return { paths, redactor: new Redactor() };
}

const DAMAGED = { code: "ARTIFACT_INVALID", message: expect.stringContaining("is damaged") };

describe("secrets kept in the user's OpsCrew folder", () => {
  it("creates the state passphrase once (0600) and reuses it", async () => {
    const { paths } = await project();
    const passphrase = await ensureStatePassphrase(paths);
    expect(passphrase).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await ensureStatePassphrase(paths)).toBe(passphrase);
    if (process.platform !== "win32") {
      expect((await stat(paths.files.statePassphrase)).mode & 0o777).toBe(0o600);
    }
  });

  it("never replaces a short or empty state passphrase: the encrypted state needs it", async () => {
    const { paths } = await project();
    for (const text of ["too-short\n", "\n"]) {
      await writeFile(paths.files.statePassphrase, text);
      await expect(ensureStatePassphrase(paths)).rejects.toMatchObject({
        ...DAMAGED,
        hint: expect.stringContaining("Put the passphrase back"),
      });
      expect(await readFile(paths.files.statePassphrase, "utf8")).toBe(text);
    }
  });

  it("never replaces a short Portainer admin password, whether or not a new one is required", async () => {
    const deps = await project();
    const file = portainerPasswordFile(deps.paths);
    await writeFile(file, "short\n");
    await expect(ensurePortainerPassword(deps)).rejects.toMatchObject(DAMAGED);
    await expect(portainerPasswordToSend(deps, true)).rejects.toMatchObject(DAMAGED);
    await expect(portainerPasswordToSend(deps, false)).rejects.toMatchObject(DAMAGED);
    expect(await readFile(file, "utf8")).toBe("short\n");
  });

  it("makes the Portainer password only when required, and registers it with the redactor", async () => {
    const deps = await project();
    expect(await portainerPasswordToSend(deps, false)).toBeUndefined();
    const password = await ensurePortainerPassword(deps);
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(await portainerPasswordToSend(deps, false)).toBe(password);
    expect(deps.redactor.redact(`login ${password}`)).not.toContain(password);
  });
});
