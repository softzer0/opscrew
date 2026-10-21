import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { generateAgeIdentity, NodeCommandRunner, sha256Hex, sopsEncrypt } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FAKE_SOPS } from "./__fixtures__/fake-sops";
import {
  exposed,
  provisionedFiles,
  readLocal,
  recoveryWorld,
  setFolder,
  VALUES,
  writeLocal,
  writeRepositoryFiles,
} from "./__fixtures__/world";
import { refreshRecoveryCopy } from "./copy";
import { localPath } from "./files";
import { restoreRecoveryCopy } from "./restore";

const PLAN = { app: { name: "shop" } } as const;
const POSIX = process.platform !== "win32";
const PATHS = Object.keys(provisionedFiles());

async function failure(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; hint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; hint?: string };
  }
  throw new Error("expected a failure");
}

/**
 * A copy made on one computer, and a fresh clone of its repository on another: the copy and its
 * rule, nothing of OpsCrew's local files. Both share the fake sops (its "crypto").
 */
async function newComputer(
  options: { runner?: NodeCommandRunner; env?: Record<string, string | undefined> } = {},
) {
  const first = await recoveryWorld(options);
  await writeLocal(first.deps, provisionedFiles());
  const keyFile = join(first.keys, "age-key.txt");
  const made = await refreshRecoveryCopy(first.deps, PLAN, {
    repositoryPrivate: async () => true,
    keyOut: async () => keyFile,
  });
  if (!made.changed) throw new Error(`no copy: ${made.warning}`);
  const second = await recoveryWorld({ ...options, sops: first.sops });
  await writeRepositoryFiles(second.root, made.repositoryFiles);
  return { ...second, keyText: await readFile(keyFile, "utf8") };
}

describe("restoreRecoveryCopy", () => {
  it("rebuilds this computer's files with their modes, and the next refresh changes nothing (FR-1413)", async () => {
    const { deps, keyText, sops } = await newComputer();
    const result = await restoreRecoveryCopy(deps, { identity: keyText });
    expect(result).toEqual({ restored: [...PATHS].sort() });
    expect(await readLocal(deps, PATHS)).toEqual(provisionedFiles());
    if (POSIX) {
      for (const path of PATHS) {
        const mode = (await stat(localPath(deps.paths, path))).mode & 0o777;
        expect([path, mode]).toEqual([path, path === "state/server.json" ? 0o644 : 0o600]);
      }
    }
    // The identity reached sops only in SOPS_AGE_KEY, the copy only on stdin.
    const decrypt = sops.calls.find((call) => call.args[0] === "decrypt");
    const identity = keyText.split("\n")[2] as string;
    expect(decrypt?.env?.SOPS_AGE_KEY).toBe(identity);
    expect(JSON.stringify(decrypt?.args)).not.toContain(identity);
    // .opscrew/ gets its .gitignore, so the restored state is never committed by accident.
    expect(await readFile(join(deps.paths.stateDir, ".gitignore"), "utf8")).toBe("*\n");

    expect(await refreshRecoveryCopy(deps, PLAN)).toEqual({ changed: false });
    // Nothing is written again when it would not change.
    expect(await restoreRecoveryCopy(deps, { identity: keyText })).toEqual({ restored: [] });

    const shown = await exposed(deps, result);
    for (const secret of [
      identity,
      ...Object.values(provisionedFiles()),
      ...Object.values(VALUES),
    ]) {
      expect(shown).not.toContain(secret.trim());
    }
    const redacted = deps.redactor.redact(`${VALUES.db} ${VALUES.redis} ${identity}`);
    for (const secret of [VALUES.db, VALUES.redis, identity]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("a wrong key, or text that is no key, writes nothing", async () => {
    const { deps } = await newComputer();
    const wrong = await failure(
      restoreRecoveryCopy(deps, { identity: generateAgeIdentity().identity }),
    );
    expect(wrong.code).toBe("SECRETS_KEY_REJECTED");
    const notKey = await failure(restoreRecoveryCopy(deps, { identity: "my password" }));
    expect(notKey.code).toBe("INVALID_INPUT");
    expect(await readLocal(deps, PATHS)).toEqual(
      Object.fromEntries(PATHS.map((p) => [p, undefined])),
    );
    await expect(stat(join(deps.paths.stateDir, "recovery.json"))).rejects.toThrow();
  });

  it("a differing local file stops before any write, by path and value name; use-copy and keep-local decide (FR-1417)", async () => {
    const { deps, keyText } = await newComputer();
    const mine = JSON.stringify({
      dbPassword: VALUES.db,
      env: { SECRET_KEY_BASE: "FAKE-a-newer-secret-key-base" },
      services: { redis: { password: VALUES.redis }, valkey: { password: "FAKE-valkey-pass" } },
    });
    await writeLocal(deps, {
      "home/generated_values.json": mine,
      "state/server.json": '{"ipv4":"203.0.113.11"}\n',
      "home/deploy_key.pub": provisionedFiles()["home/deploy_key.pub"] as string,
    });

    const stopped = await restoreRecoveryCopy(deps, { identity: keyText });
    expect(stopped).toEqual({
      restored: [],
      conflicts: {
        paths: ["home/generated_values.json", "state/server.json"],
        values: ["env.SECRET_KEY_BASE", "services.valkey.password"],
      },
    });
    // Nothing written, not even the files that were missing.
    expect((await readLocal(deps, ["home/deploy_key"]))["home/deploy_key"]).toBeUndefined();
    expect(JSON.stringify(stopped)).not.toContain(VALUES.db);
    expect(JSON.stringify(stopped)).not.toContain("FAKE-a-newer-secret-key-base");

    const kept = await restoreRecoveryCopy(deps, { identity: keyText, onConflict: "keep-local" });
    expect(kept.restored).toEqual([
      "home/deploy_key",
      "home/state_passphrase",
      "state/tfstate/prod.tfstate",
    ]);
    expect(
      (await readLocal(deps, ["home/generated_values.json"]))["home/generated_values.json"],
    ).toBe(mine);
    // The kept values now differ from the copy, so the next refresh makes a new copy.
    expect((await refreshRecoveryCopy(deps, PLAN)).changed).toBe(true);

    const fresh = await newComputer();
    await writeLocal(fresh.deps, { "home/generated_values.json": mine });
    const used = await restoreRecoveryCopy(fresh.deps, {
      identity: fresh.keyText,
      onConflict: "use-copy",
    });
    expect(used.restored).toContain("home/generated_values.json");
    expect(await readLocal(fresh.deps, PATHS)).toEqual(provisionedFiles());
  });

  it("refuses a copy with any path outside the list, before writing anything", async () => {
    const { deps, sops } = await recoveryWorld();
    const key = generateAgeIdentity();
    for (const bad of ["home/../escape", "/etc/cron.d/x", "C:/x", "state/plans/p.json"]) {
      const copy = await sopsEncrypt(
        FAKE_SOPS,
        {
          plaintext: JSON.stringify({ files: { "home/deploy_key": "FAKE\n", [bad]: "x\n" } }),
          recipients: [key.recipient],
          filename: "opscrew/secrets.sops.json",
        },
        { exec: sops.runner(deps.runner), redactor: deps.redactor, env: {} },
      );
      await writeRepositoryFiles(deps.paths.root, [
        { path: "opscrew/secrets.sops.json", content: copy, kind: "doc" },
      ]);
      const error = await failure(restoreRecoveryCopy(deps, { identity: key.identity }));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain(bad);
    }
    expect((await readLocal(deps, ["home/deploy_key"]))["home/deploy_key"]).toBeUndefined();
  });

  it("restores from another copy file, such as the folder copy, with the same checks and conflict rules", async () => {
    const first = await recoveryWorld();
    await writeLocal(first.deps, provisionedFiles());
    await setFolder(first.deps, join(first.keys, "copies"));
    const keyFile = join(first.keys, "age-key.txt");
    const made = await refreshRecoveryCopy(first.deps, PLAN, {
      repositoryPrivate: async () => false,
      keyOut: async () => keyFile,
    });
    if (!made.changed || made.folderCopy === undefined) throw new Error("no folder copy");
    const keyText = await readFile(keyFile, "utf8");

    // Another computer: no copy in the repository, only the folder copy.
    const second = await recoveryWorld({ sops: first.sops });
    expect((await failure(restoreRecoveryCopy(second.deps, { identity: keyText }))).code).toBe(
      "PHASE_PRECONDITION",
    );
    const missing = await failure(
      restoreRecoveryCopy(second.deps, { identity: keyText, from: join(second.keys, "none.json") }),
    );
    expect(missing.code).toBe("INVALID_INPUT");
    expect(missing.message).toBe(`There is no recovery copy at ${join(second.keys, "none.json")}.`);

    await writeLocal(second.deps, { "state/server.json": '{"ipv4":"203.0.113.11"}\n' });
    const stopped = await restoreRecoveryCopy(second.deps, {
      identity: keyText,
      from: made.folderCopy,
    });
    expect(stopped).toEqual({
      restored: [],
      conflicts: { paths: ["state/server.json"], values: [] },
    });
    const used = await restoreRecoveryCopy(second.deps, {
      identity: keyText,
      from: made.folderCopy,
      onConflict: "use-copy",
    });
    expect(used.restored).toEqual([...PATHS].sort());
    expect(await readLocal(second.deps, PATHS)).toEqual(provisionedFiles());
    expect(
      (
        await failure(
          restoreRecoveryCopy(second.deps, {
            identity: generateAgeIdentity().identity,
            from: made.folderCopy,
          }),
        )
      ).code,
    ).toBe("SECRETS_KEY_REJECTED");
  });

  it("without a copy in this checkout, says where to get one", async () => {
    const { deps } = await recoveryWorld();
    const error = await failure(
      restoreRecoveryCopy(deps, { identity: generateAgeIdentity().identity }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("no recovery copy (opscrew/secrets.sops.json)");
  });
});

const SOPS = process.env.OPSCREW_SOPS_BIN;
if (!SOPS)
  console.warn("OPSCREW_SOPS_BIN is not set: skipping the recovery copy through real sops.");

describe.skipIf(!SOPS)("the recovery copy through real sops", () => {
  it("makes the copy, restores it on another computer with the key, and refuses another key", async () => {
    const env = { ...process.env, OPSCREW_SOPS_BIN: SOPS };
    const runner = new NodeCommandRunner();
    const { deps, keyText, root } = await newComputer({ runner, env });
    const copy = await readFile(join(root, "opscrew/secrets.sops.json"), "utf8");
    for (const secret of Object.values(VALUES)) expect(copy).not.toContain(secret);
    const parsed = JSON.parse(copy) as { files: Record<string, string>; sops: { version: string } };
    expect(Object.keys(parsed.files).sort()).toEqual([...PATHS].sort());
    expect(parsed.sops.version).toBe("3.13.3");

    const wrong = await failure(
      restoreRecoveryCopy(deps, { identity: generateAgeIdentity().identity }),
    );
    expect(wrong.code).toBe("SECRETS_KEY_REJECTED");
    expect(await readLocal(deps, PATHS)).toEqual(
      Object.fromEntries(PATHS.map((p) => [p, undefined])),
    );

    const result = await restoreRecoveryCopy(deps, { identity: keyText });
    expect(result.restored).toEqual([...PATHS].sort());
    expect(await readLocal(deps, PATHS)).toEqual(provisionedFiles());
    const record = JSON.parse(await readFile(join(deps.paths.stateDir, "recovery.json"), "utf8"));
    expect(record.copySha256).toBe(sha256Hex(copy));
    expect(await refreshRecoveryCopy(deps, PLAN)).toEqual({ changed: false });

    // A changed file is encrypted again to .sops.yaml's recipient, with no key, and opens with it.
    await writeLocal(deps, { "state/server.json": '{"ipv4":"203.0.113.11"}\n' });
    const next = await refreshRecoveryCopy(deps, PLAN);
    if (!next.changed) throw new Error(`no copy: ${next.warning}`);
    await writeRepositoryFiles(root, next.repositoryFiles);
    await rm(localPath(deps.paths, "state/server.json"));
    const again = await restoreRecoveryCopy(deps, { identity: keyText });
    expect(again.restored).toEqual(["state/server.json"]);
  }, 120_000);
});
