import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ageRecipientOf, generateAgeIdentity, isAgeRecipient, sha256Hex } from "@opscrew/core";
import type { RenderedFile } from "@opscrew/iac-templates";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ScriptedApprovalHandler, testPlan } from "../testing";
import { FAKE_SOPS, type FakeSops } from "./__fixtures__/fake-sops";
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
import {
  type RefreshRecoveryResult,
  recoveryStatus,
  refreshRecoveryCopy,
  rotateRecoveryKey,
} from "./copy";
import { isCopyPath, localPath, readLocalFiles } from "./files";
import { setRecoveryFolder } from "./store";

const PLAN = { app: { name: "shop" } } as const;
const POSIX = process.platform !== "win32";

/** The changed result, failing the test otherwise. */
function changed(result: RefreshRecoveryResult) {
  if (!result.changed) throw new Error(`expected a change, got ${JSON.stringify(result)}`);
  return result;
}

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

/** The plaintext sops got on stdin for its `n`th encrypt. */
function encrypted(sops: FakeSops, n = 0): Record<string, string> {
  const call = sops.calls.filter((c) => c.args[0] === "encrypt")[n];
  return (JSON.parse(call?.input ?? "{}") as { files: Record<string, string> }).files;
}

/** A provisioned project whose first copy is made (key written, files in the repository). */
async function withFirstCopy(options: { backup?: string; folder?: boolean } = {}) {
  const world = await recoveryWorld();
  await writeLocal(world.deps, provisionedFiles());
  if (options.folder === true) await setFolder(world.deps, join(world.keys, "copies"));
  const keyFile = join(world.keys, "age-key.txt");
  const result = changed(
    await refreshRecoveryCopy(world.deps, PLAN, {
      repositoryPrivate: async () => true,
      keyOut: async () => keyFile,
      ...(options.backup !== undefined ? { backup: async () => options.backup } : {}),
    }),
  );
  await writeRepositoryFiles(world.root, result.repositoryFiles);
  const identity = (await readFile(keyFile, "utf8")).split("\n")[2] as string;
  return { ...world, keyFile, identity, first: result };
}

describe("the copy's files", () => {
  it("are exactly plan.md's list, under home/ and state/, and a missing file is absent", async () => {
    const { deps } = await recoveryWorld();
    const every: Record<string, string> = {
      ...provisionedFiles(),
      "home/known_hosts": "203.0.113.10 ssh-ed25519 FAKE-HOST-KEY\n",
      "home/deploy_secrets.json": '{"host":"203.0.113.10"}\n',
      "home/portainer-env.key": "RkFLRS12YWx1ZS1rZXktZm9yLXRlc3RzLW9ubHktMDA=\n",
      "home/portainer-webhook": "00000000-0000-4000-8000-000000000000\n",
      "home/portainer_password": "FAKE-portainer-password\n",
      "home/check_key": "FAKE-check-key\n",
      "home/beszel_secrets.json": '{"password":"FAKE-beszel-password"}\n',
      "home/grafana_cloud_token": "FAKE-grafana-cloud-token\n",
      "state/tfstate/storage.tfstate": '{"version":4}\n',
      "state/cloudflare.json": "{}\n",
    };
    await writeLocal(deps, {
      ...every,
      // Not OpsCrew's to copy: phase outcomes, history, saved plans, backups and anything else.
      "state/state.json": '{"schemaVersion":1,"phases":{}}\n',
      "home/costs.jsonl": "{}\n",
      "state/approvals.jsonl": "{}\n",
      "state/plans/plan-1.json": "{}\n",
      "state/tfstate/prod.tfstate.backup": "{}\n",
      "state/scan.json": "{}\n",
    });
    const files = await readLocalFiles(deps.paths, deps.redactor);
    expect(Object.keys(files).sort()).toEqual(Object.keys(every).sort());
    expect(files["state/tfstate/prod.tfstate"]).toBe(every["state/tfstate/prod.tfstate"]);
    // The check's key and the add-ons' secrets are copied from where OpsCrew keeps them.
    const { checkKey, beszelSecrets, grafanaCloudToken } = deps.paths.files;
    expect([
      localPath(deps.paths, "home/check_key"),
      localPath(deps.paths, "home/beszel_secrets.json"),
      localPath(deps.paths, "home/grafana_cloud_token"),
    ]).toEqual([checkKey, beszelSecrets, grafanaCloudToken]);

    await rm(join(deps.paths.projectHomeDir, "known_hosts"));
    expect(Object.keys(await readLocalFiles(deps.paths, deps.redactor))).not.toContain(
      "home/known_hosts",
    );
  });

  it("accept only the list's paths: no other name, no .., no absolute path", () => {
    for (const path of [
      "home/generated_values.json",
      "home/portainer_password",
      "home/check_key",
      "home/beszel_secrets.json",
      "home/grafana_cloud_token",
      "state/server.json",
      "state/cloudflare.json",
      "state/tfstate/prod.tfstate",
    ]) {
      expect(isCopyPath(path)).toBe(true);
    }
    for (const path of [
      "state/state.json",
      "home/../deploy_key",
      "home/other",
      "home/sub/deploy_key",
      "state/plans/plan-1.json",
      "state/tfstate/../../x.tfstate",
      "state/tfstate/a/b.tfstate",
      "state/tfstate/prod.tfstate.backup",
      "state\\server.json",
      "/etc/passwd",
      "C:/Users/x/deploy_key",
      "opscrew/plan.yaml",
    ]) {
      expect(isCopyPath(path)).toBe(false);
    }
  });
});

describe("refreshRecoveryCopy", () => {
  it("the first time writes the key once (0600) to the named file and returns the copy, .sops.yaml and .gitattributes", async () => {
    const backup = generateAgeIdentity().recipient;
    const { deps, sops, keyFile, identity, first, root } = await withFirstCopy({
      backup,
      folder: true,
    });

    expect(first.firstKey).toEqual({ path: keyFile });
    const keyText = await readFile(keyFile, "utf8");
    expect(keyText).toMatch(/^# created: 2026-10-11T12:00:00.000Z\n# public key: age1/);
    const recipient = ageRecipientOf(identity);
    expect(keyText).toContain(`# public key: ${recipient}\n`);
    if (POSIX) expect((await stat(keyFile)).mode & 0o777).toBe(0o600);

    expect(first.repositoryFiles.map((file) => file.path)).toEqual([
      "opscrew/secrets.sops.json",
      "opscrew/.sops.yaml",
      ".gitattributes",
    ]);
    const config = parse(await readFile(join(root, "opscrew/.sops.yaml"), "utf8"));
    expect(config).toEqual({
      creation_rules: [{ path_regex: "secrets\\.sops\\.json$", age: `${recipient},${backup}` }],
    });
    expect(await readFile(join(root, ".gitattributes"), "utf8")).toBe(
      "opscrew/secrets.sops.json text eol=lf\nopscrew/.sops.yaml text eol=lf\n",
    );

    // The plaintext went only on stdin, to the two recipients.
    expect(sops.calls).toHaveLength(1);
    const [call] = sops.calls;
    expect(call?.args.slice(-2)).toEqual(["--age", `${recipient},${backup}`]);
    expect(encrypted(sops)).toEqual(provisionedFiles());
    expect(JSON.stringify(call?.args)).not.toContain(VALUES.db);

    // The folder copy is the repository's copy, written at once.
    const copy = await readFile(join(root, "opscrew/secrets.sops.json"), "utf8");
    expect(first.folderCopy).toBe(join(dirname(keyFile), "copies", "shop.sops.json"));
    expect(await readFile(first.folderCopy as string, "utf8")).toBe(copy);

    // The record holds hashes and times only.
    const record = JSON.parse(await readFile(join(deps.paths.stateDir, "recovery.json"), "utf8"));
    const hashes = Object.fromEntries(
      Object.entries(provisionedFiles()).map(([path, text]) => [path, sha256Hex(text)]),
    );
    expect(record).toEqual({
      hashes,
      folderHashes: hashes,
      copySha256: sha256Hex(copy),
      copiedAt: "2026-10-11T12:00:00.000Z",
      repositoryCopyAt: "2026-10-11T12:00:00.000Z",
    });

    // The key and the files' contents are nowhere but in the key file and on stdin.
    const shown = `${await exposed(deps, first)}\n${first.repositoryFiles.map((f) => f.content).join("\n")}`;
    for (const secret of [
      identity,
      ...Object.values(provisionedFiles()),
      ...Object.values(VALUES),
    ]) {
      expect(shown).not.toContain(secret.trim());
    }
    expect(deps.redactor.redact(`key ${identity}`)).not.toContain(identity);
  });

  it("compares hashes: nothing changed, nothing encrypted; a changed file goes to .sops.yaml's recipients without a key", async () => {
    const { deps, sops, identity, root } = await withFirstCopy();
    let asked = 0;
    const options = {
      keyOut: async () => {
        asked++;
        return "/never";
      },
    };
    expect(await refreshRecoveryCopy(deps, PLAN, options)).toEqual({ changed: false });
    expect(sops.calls).toHaveLength(1);

    await writeLocal(deps, { "state/tfstate/prod.tfstate": '{"version":4,"serial":4}\n' });
    const next = changed(await refreshRecoveryCopy(deps, PLAN, options));
    expect(asked).toBe(0);
    expect(next.firstKey).toBeUndefined();
    expect(next.repositoryFiles.map((file) => file.path)).toEqual(["opscrew/secrets.sops.json"]);
    expect(sops.calls[1]?.args.slice(-2)).toEqual(["--age", ageRecipientOf(identity)]);
    expect(encrypted(sops, 1)["state/tfstate/prod.tfstate"]).toBe('{"version":4,"serial":4}\n');
    // No identity reaches sops when it encrypts.
    expect(sops.calls.every((call) => call.env?.SOPS_AGE_KEY === undefined)).toBe(true);

    await writeRepositoryFiles(root, next.repositoryFiles);
    expect(await refreshRecoveryCopy(deps, PLAN, options)).toEqual({ changed: false });
  });

  it("refuses a key file inside the repository or OpsCrew's folder, a relative one, an existing one, and a backup that is not a recipient", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "opscrew-recovery-home-"));
    const { deps, keys, sops } = await recoveryWorld({ home: elsewhere });
    await writeLocal(deps, provisionedFiles());
    const existing = join(keys, "taken.txt");
    await writeFile(existing, "mine\n");
    const cases: [string, string | undefined, RegExp][] = [
      [join(deps.paths.root, "age-key.txt"), undefined, /inside the repository/],
      // A folder whose name starts with two dots is still inside the repository.
      [join(deps.paths.root, "..keys", "age-key.txt"), undefined, /inside the repository/],
      [join(deps.paths.homeDir, "age-key.txt"), undefined, /inside OpsCrew's folder/],
      ["age-key.txt", undefined, /needs a full path/],
      [existing, undefined, /^A file already exists at .*Nothing was written\.$/],
      [join(keys, "new.txt"), "age1-not-a-recipient", /not an age recipient/],
    ];
    for (const [file, backup, message] of cases) {
      const error = await failure(
        refreshRecoveryCopy(deps, PLAN, {
          repositoryPrivate: async () => true,
          keyOut: async () => file,
          ...(backup !== undefined ? { backup: async () => backup } : {}),
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(message);
    }
    expect(await readFile(existing, "utf8")).toBe("mine\n");
    await expect(stat(join(deps.paths.stateDir, "recovery.json"))).rejects.toThrow();
    await expect(stat(join(keys, "new.txt"))).rejects.toThrow();
    // Every refusal comes before anything is encrypted.
    expect(sops.calls).toEqual([]);
  });

  it("an existing key file with a folder set: refused up front, the folder copy and the record as they were", async () => {
    const { deps, keys, sops } = await recoveryWorld();
    await writeLocal(deps, provisionedFiles());
    await setFolder(deps, join(keys, "copies"));
    const existing = join(keys, "taken.txt");
    await writeFile(existing, "mine\n");
    const error = await failure(
      refreshRecoveryCopy(deps, PLAN, {
        repositoryPrivate: async () => true,
        keyOut: async () => existing,
      }),
    );
    expect(error.message).toMatch(/^A file already exists at /);
    expect(sops.calls).toEqual([]);
    await expect(stat(join(keys, "copies", "shop.sops.json"))).rejects.toThrow();
    await expect(stat(join(deps.paths.stateDir, "recovery.json"))).rejects.toThrow();
    expect(await readFile(existing, "utf8")).toBe("mine\n");
  });

  it("a run without a key never asks the public-repository question", async () => {
    const handler = new ScriptedApprovalHandler(() => true);
    const { deps } = await recoveryWorld({ interactive: true, approvalHandler: handler });
    await writeLocal(deps, provisionedFiles());
    const result = await refreshRecoveryCopy(deps, PLAN, { repositoryPrivate: async () => false });
    expect(result).toEqual({
      changed: false,
      warning: expect.stringContaining("needs a file to write your new age key to"),
    });
    expect(handler.requests).toEqual([]);
  });

  it("without a file for the key makes no key and no copy, and says how to name one", async () => {
    const { deps, sops } = await recoveryWorld();
    await writeLocal(deps, provisionedFiles());
    const result = await refreshRecoveryCopy(deps, PLAN, { repositoryPrivate: async () => true });
    expect(result).toEqual({
      changed: false,
      warning: expect.stringContaining("needs a file to write your new age key to"),
    });
    expect(sops.calls).toEqual([]);
    await expect(stat(join(deps.paths.stateDir, "recovery.json"))).rejects.toThrow();
  });

  it("the user's own key: the first copy is encrypted to it, with no key file, and says to which (FR-1412)", async () => {
    const { deps, keys, sops } = await recoveryWorld();
    await writeLocal(deps, provisionedFiles());
    const mine = generateAgeIdentity();
    const backup = generateAgeIdentity().recipient;
    let asked = 0;
    const result = changed(
      await refreshRecoveryCopy(deps, PLAN, {
        repositoryPrivate: async () => true,
        recipient: async () => ` ${mine.recipient}\n`,
        keyOut: async () => {
          asked++;
          return join(keys, "age-key.txt");
        },
        backup: async () => backup,
      }),
    );
    expect(result.recipient).toBe(mine.recipient);
    expect(result.firstKey).toBeUndefined();
    expect(asked).toBe(0);
    await expect(stat(join(keys, "age-key.txt"))).rejects.toThrow();
    expect(sops.calls[0]?.args.slice(-2)).toEqual(["--age", `${mine.recipient},${backup}`]);
    const rule = result.repositoryFiles.find((file) => file.path === "opscrew/.sops.yaml");
    expect(parse(rule?.content ?? "").creation_rules[0].age).toBe(`${mine.recipient},${backup}`);

    const wrong = await recoveryWorld();
    await writeLocal(wrong.deps, provisionedFiles());
    const error = await failure(
      refreshRecoveryCopy(wrong.deps, PLAN, {
        repositoryPrivate: async () => true,
        recipient: async () => mine.identity,
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("The age key is not an age recipient.");
    expect(error.message + (error.hint ?? "")).not.toContain(mine.identity);
    expect(wrong.sops.calls).toEqual([]);
  });

  it("stops when the repository's copy is not the one this computer wrote (FR-1417)", async () => {
    const { deps, root, sops } = await withFirstCopy();
    await writeFile(
      join(root, "opscrew/secrets.sops.json"),
      '{"files":{},"sops":{"mac":"other"}}\n',
    );
    await writeLocal(deps, { "state/server.json": '{"ipv4":"203.0.113.11"}\n' });
    const error = await failure(refreshRecoveryCopy(deps, PLAN));
    expect(error.code).toBe("SECRETS_COPY_CHANGED_ELSEWHERE");
    expect(error.hint).toContain("opscrew secrets restore");
    expect(sops.calls).toHaveLength(1);

    // A fresh clone with a copy and nothing restored: the same stop.
    const fresh = await recoveryWorld();
    await writeRepositoryFiles(fresh.root, [
      { path: "opscrew/secrets.sops.json", content: "{}\n", kind: "doc" },
    ]);
    await writeLocal(fresh.deps, provisionedFiles());
    expect((await failure(refreshRecoveryCopy(fresh.deps, PLAN))).code).toBe(
      "SECRETS_COPY_CHANGED_ELSEWHERE",
    );
  });

  it("without sops: a warning, the local files as they were, nothing recorded or written (FR-1416)", async () => {
    const fetches: string[] = [];
    const { deps, keys } = await recoveryWorld({
      env: { OPSCREW_SOPS_BIN: undefined },
      fetch: async (input) => {
        fetches.push(String(input));
        throw new Error("network is down");
      },
    });
    await writeLocal(deps, provisionedFiles());
    const result = await refreshRecoveryCopy(deps, PLAN, {
      repositoryPrivate: async () => true,
      keyOut: async () => join(keys, "age-key.txt"),
    });
    expect(result.changed).toBe(false);
    expect(result.warning).toMatch(
      /^OpsCrew could not get sops, which encrypts the recovery copy of this app's secrets, so the copy was not updated; the secrets on this computer stay as they are\. Could not download sops 3\.13\.3 from https:\/\/github\.com\/getsops\/sops\/releases\//,
    );
    expect(result.warning).toContain("OPSCREW_SOPS_BIN");
    expect(fetches).toHaveLength(1);
    expect(await readLocal(deps, Object.keys(provisionedFiles()))).toEqual(provisionedFiles());
    await expect(stat(join(keys, "age-key.txt"))).rejects.toThrow();
    await expect(stat(join(deps.paths.stateDir, "recovery.json"))).rejects.toThrow();
  });

  it("a public repository: an interactive run asks once, warns what is readable, and records the answer", async () => {
    const handler = new ScriptedApprovalHandler([true]);
    const { deps, keys, sops, root } = await recoveryWorld({
      interactive: true,
      approvalHandler: handler,
    });
    await writeLocal(deps, provisionedFiles());
    const options = {
      repositoryPrivate: async () => false,
      keyOut: async () => join(keys, "age-key.txt"),
    };
    const result = changed(await refreshRecoveryCopy(deps, PLAN, options));
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]).toMatchObject({ kind: "repo-write" });
    expect(handler.requests[0]?.title).toContain("public repository");
    expect(handler.requests[0]?.details).toContain(
      "Anyone can keep a copy of the encrypted file and try to open it later, and the names of the files it holds are readable, though not their contents.",
    );
    expect(result.repositoryFiles.map((file) => file.path)).toContain("opscrew/secrets.sops.json");
    const record = JSON.parse(await readFile(join(deps.paths.stateDir, "recovery.json"), "utf8"));
    expect(record.publicConfirmed).toBe(true);
    await writeRepositoryFiles(root, result.repositoryFiles);

    await writeLocal(deps, { "state/server.json": '{"ipv4":"203.0.113.11"}\n' });
    changed(await refreshRecoveryCopy(deps, PLAN, options));
    expect(handler.requests).toHaveLength(1);
    expect(sops.calls).toHaveLength(2);

    // A "no": only the folder copy and the creation rule, and OpsCrew does not ask again.
    const declined = new ScriptedApprovalHandler([false]);
    const no = await recoveryWorld({ interactive: true, approvalHandler: declined });
    await writeLocal(no.deps, provisionedFiles());
    await setFolder(no.deps, join(no.keys, "copies"));
    const noOptions = { ...options, keyOut: async () => join(no.keys, "age-key.txt") };
    const first = changed(await refreshRecoveryCopy(no.deps, PLAN, noOptions));
    expect(first.repositoryFiles.map((file) => file.path)).toEqual([
      "opscrew/.sops.yaml",
      ".gitattributes",
    ]);
    expect(first.folderCopy).toBe(join(no.keys, "copies", "shop.sops.json"));
    expect(first.warning).toContain("you chose not to commit");
    expect(first.warning).toContain("copy that file to opscrew/secrets.sops.json and commit it");
    await writeRepositoryFiles(no.root, first.repositoryFiles);
    // Nothing changed since the folder copy: nothing is asked, encrypted or written again.
    expect(await refreshRecoveryCopy(no.deps, PLAN, noOptions)).toEqual({ changed: false });
    expect(declined.requests).toHaveLength(1);
    expect(no.sops.calls).toHaveLength(1);
  });

  it("a public repository, non-interactive: only the folder copy and how to commit it; without a folder, nothing", async () => {
    const { deps, keys, sops, root } = await recoveryWorld();
    await writeLocal(deps, provisionedFiles());
    const options = {
      repositoryPrivate: async () => false,
      keyOut: async () => join(keys, "age-key.txt"),
    };
    const none = await refreshRecoveryCopy(deps, PLAN, options);
    expect(none.changed).toBe(false);
    expect(none.warning).toContain("No folder is set for the copy either, so OpsCrew made none.");
    expect(sops.calls).toEqual([]);
    await expect(stat(join(keys, "age-key.txt"))).rejects.toThrow();

    await setFolder(deps, join(keys, "copies"));
    const result = changed(await refreshRecoveryCopy(deps, PLAN, options));
    expect(result.repositoryFiles.map((file) => file.path)).not.toContain(
      "opscrew/secrets.sops.json",
    );
    expect(result.folderCopy).toBe(join(keys, "copies", "shop.sops.json"));
    expect(result.warning).toBe(
      `The repository is public, so OpsCrew does not commit the encrypted recovery copy of this app's secrets without asking. Anyone can keep a copy of the encrypted file and try to open it later, and the names of the files it holds are readable, though not their contents. It wrote the copy only to ${result.folderCopy}. To commit it, run \`opscrew provision\` in a terminal, which asks first, or copy that file to opscrew/secrets.sops.json and commit it.`,
    );
    await expect(stat(join(root, "opscrew/secrets.sops.json"))).rejects.toThrow();
    const record = JSON.parse(await readFile(join(deps.paths.stateDir, "recovery.json"), "utf8"));
    // The repository's copy is still behind: no hashes are recorded for it, only the folder's.
    expect(record.hashes).toBeUndefined();
    expect(Object.keys(record.folderHashes).sort()).toEqual(Object.keys(provisionedFiles()).sort());
    expect(record.publicConfirmed).toBeUndefined();
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    expect((await recoveryStatus(deps)).behind).toBe(true);

    // The uncommitted copy is not encrypted again while nothing changed; a change is.
    await writeRepositoryFiles(root, result.repositoryFiles);
    const folderCopy = await readFile(result.folderCopy as string, "utf8");
    expect(await refreshRecoveryCopy(deps, PLAN, options)).toEqual({ changed: false });
    expect(sops.calls).toHaveLength(1);
    expect(await readFile(result.folderCopy as string, "utf8")).toBe(folderCopy);
    await writeLocal(deps, { "state/server.json": '{"ipv4":"203.0.113.11"}\n' });
    expect(changed(await refreshRecoveryCopy(deps, PLAN, options)).folderCopy).toBe(
      result.folderCopy,
    );
    expect(sops.calls).toHaveLength(2);
  });

  it("registers every generated value by itself after reading the files", async () => {
    const { deps } = await recoveryWorld();
    await writeLocal(deps, provisionedFiles());
    await refreshRecoveryCopy(deps, PLAN);
    const shown = deps.redactor.redact(
      `db=${VALUES.db} key=${VALUES.secretKeyBase} redis=${VALUES.redis}`,
    );
    for (const value of Object.values(VALUES)) expect(shown).not.toContain(value);
  });

  it("keeps the key it made when .sops.yaml is not in this checkout (an unmerged pull request)", async () => {
    const { deps, root, sops } = await withFirstCopy();
    await rm(join(root, "opscrew"), { recursive: true });
    await writeLocal(deps, { "state/server.json": '{"ipv4":"203.0.113.11"}\n' });
    const result = await refreshRecoveryCopy(deps, PLAN, { keyOut: async () => "/never" });
    expect(result).toEqual({
      changed: false,
      warning: expect.stringContaining("opscrew/.sops.yaml, which names the keys that open it"),
    });
    expect(sops.calls).toHaveLength(1);
  });
});

describe("rotateRecoveryKey", () => {
  it("makes a new key, keeps, replaces or drops the backup, and the old key no longer opens the copy", async () => {
    const backup = generateAgeIdentity();
    const { deps, keys, sops, identity, root } = await withFirstCopy({
      backup: backup.recipient,
      folder: true,
    });
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const kept = await rotateRecoveryKey(deps, { keyOut: join(keys, "rotated.txt") });
    expect(kept.handover).toEqual({ path: join(keys, "rotated.txt") });
    expect(kept.files.map((file) => file.path)).toEqual([
      "opscrew/secrets.sops.json",
      "opscrew/.sops.yaml",
    ]);
    const newIdentity = (await readFile(join(keys, "rotated.txt"), "utf8")).split(
      "\n",
    )[2] as string;
    const config = parse(kept.files[1]?.content ?? "");
    expect(config.creation_rules[0].age).toBe(`${ageRecipientOf(newIdentity)},${backup.recipient}`);
    expect(encrypted(sops, 1)).toEqual(provisionedFiles());
    expect(kept.message).toContain(
      "Older commits of opscrew/secrets.sops.json can still be opened with the old key. If the old key may have leaked, change the secrets themselves too",
    );
    expect(kept.message).toContain(
      `OpsCrew wrote your new age key to ${join(keys, "rotated.txt")}.`,
    );
    expect(await readFile(join(keys, "copies", "shop.sops.json"), "utf8")).toBe(
      kept.files[0]?.content,
    );

    // The old key cannot open the new copy; the new one and the backup can.
    const copy = kept.files[0]?.content ?? "";
    const decrypt = (key: string) =>
      sops
        .runner({ run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) })
        .run(FAKE_SOPS, ["decrypt"], { input: copy, env: { SOPS_AGE_KEY: key } });
    expect((await decrypt(identity)).exitCode).toBe(128);
    expect((await decrypt(newIdentity)).exitCode).toBe(0);
    expect((await decrypt(backup.identity)).exitCode).toBe(0);

    await writeRepositoryFiles(root, kept.files);
    const other = generateAgeIdentity().recipient;
    const replaced = await rotateRecoveryKey(deps, {
      keyOut: join(keys, "replaced.txt"),
      backup: other,
    });
    expect(parse(replaced.files[1]?.content ?? "").creation_rules[0].age).toMatch(
      new RegExp(`,${other}$`),
    );
    await writeRepositoryFiles(root, replaced.files);
    const dropped = await rotateRecoveryKey(deps, {
      keyOut: join(keys, "dropped.txt"),
      backup: null,
    });
    const recipients = parse(dropped.files[1]?.content ?? "").creation_rules[0].age.split(",");
    expect(recipients).toHaveLength(1);
    expect(isAgeRecipient(recipients[0])).toBe(true);
    expect(dropped.message).not.toContain("and the backup key");

    const shown = await exposed(deps, kept, replaced, dropped);
    for (const secret of [identity, newIdentity, ...Object.values(VALUES)]) {
      expect(shown).not.toContain(secret);
    }
  });

  it("a public repository without a committed copy: the first copy's rule, so only the folder copy, and why", async () => {
    const { deps, keys, sops, root } = await recoveryWorld();
    await writeLocal(deps, provisionedFiles());
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const options = { repositoryPrivate: async () => false };

    // No folder either: refused before a key is made.
    const nowhere = await failure(
      rotateRecoveryKey(deps, { ...options, keyOut: join(keys, "rotated.txt") }),
    );
    expect(nowhere.code).toBe("PHASE_PRECONDITION");
    expect(nowhere.message).toContain(
      "No folder is set for the copy either, so OpsCrew made none. Set one with `opscrew secrets folder <path>`, or run `opscrew secrets rotate` in a terminal to be asked.",
    );
    await expect(stat(join(keys, "rotated.txt"))).rejects.toThrow();
    expect(sops.calls).toEqual([]);

    await setFolder(deps, join(keys, "copies"));
    const rotated = await rotateRecoveryKey(deps, {
      ...options,
      keyOut: join(keys, "rotated.txt"),
    });
    expect(rotated.files.map((file) => file.path)).toEqual([
      "opscrew/.sops.yaml",
      ".gitattributes",
    ]);
    expect(rotated.message).toContain(
      "The repository is public, so OpsCrew does not commit the encrypted recovery copy of this app's secrets without asking. Anyone can keep a copy of the encrypted file",
    );
    expect(rotated.message).toContain(
      `It wrote the copy only to ${join(keys, "copies", "shop.sops.json")}.`,
    );
    expect(rotated.message).toContain("Merge the pull request with opscrew/.sops.yaml");
    expect(await readFile(join(keys, "copies", "shop.sops.json"), "utf8")).toContain("sops");
    await expect(stat(join(root, "opscrew/secrets.sops.json"))).rejects.toThrow();

    // Interactive: asked first, like the first copy.
    const handler = new ScriptedApprovalHandler([true]);
    const asked = await recoveryWorld({ interactive: true, approvalHandler: handler });
    await writeLocal(asked.deps, provisionedFiles());
    const yes = await rotateRecoveryKey(asked.deps, {
      ...options,
      keyOut: join(asked.keys, "rotated.txt"),
    });
    expect(handler.requests.map((request) => request.kind)).toEqual(["repo-write"]);
    expect(yes.files.map((file) => file.path)).toContain("opscrew/secrets.sops.json");
  });

  it("an existing key file with a folder set: refused up front, the folder copy and the record as they were", async () => {
    const { deps, keys, sops } = await withFirstCopy({ folder: true });
    const folderCopy = join(keys, "copies", "shop.sops.json");
    const before = {
      folder: await readFile(folderCopy, "utf8"),
      record: await readFile(join(deps.paths.stateDir, "recovery.json"), "utf8"),
    };
    const existing = join(keys, "taken.txt");
    await writeFile(existing, "mine\n");
    const error = await failure(rotateRecoveryKey(deps, { keyOut: existing }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toMatch(/^A file already exists at /);
    expect(sops.calls).toHaveLength(1);
    expect({
      folder: await readFile(folderCopy, "utf8"),
      record: await readFile(join(deps.paths.stateDir, "recovery.json"), "utf8"),
    }).toEqual(before);
    expect(await readFile(existing, "utf8")).toBe("mine\n");
  });

  it("recovers a damaged .sops.yaml when the backup is dropped or given; keeping it needs the file", async () => {
    const { deps, keys, root } = await withFirstCopy({ backup: generateAgeIdentity().recipient });
    await writeFile(join(root, "opscrew/.sops.yaml"), "creation_rules: [broken\n");
    const kept = await failure(rotateRecoveryKey(deps, { keyOut: join(keys, "kept.txt") }));
    expect(kept.code).toBe("ARTIFACT_INVALID");
    await expect(stat(join(keys, "kept.txt"))).rejects.toThrow();

    const dropped = await rotateRecoveryKey(deps, {
      keyOut: join(keys, "dropped.txt"),
      backup: null,
    });
    expect(parse(dropped.files[1]?.content ?? "").creation_rules[0].age.split(",")).toHaveLength(1);
    await writeFile(join(root, "opscrew/.sops.yaml"), "not: [yaml\n");
    await writeRepositoryFiles(root, [dropped.files[0] as RenderedFile]);
    const other = generateAgeIdentity().recipient;
    const given = await rotateRecoveryKey(deps, { keyOut: join(keys, "given.txt"), backup: other });
    expect(parse(given.files[1]?.content ?? "").creation_rules[0].age).toMatch(
      new RegExp(`,${other}$`),
    );
  });

  it("refuses another computer's copy, and a key file inside the repository", async () => {
    const { deps, root, keys } = await withFirstCopy();
    expect((await failure(rotateRecoveryKey(deps, { keyOut: join(root, "key.txt") }))).code).toBe(
      "INVALID_INPUT",
    );
    await writeFile(join(root, "opscrew/secrets.sops.json"), "{}\n");
    expect(
      (await failure(rotateRecoveryKey(deps, { keyOut: join(keys, "rotated.txt") }))).code,
    ).toBe("SECRETS_COPY_CHANGED_ELSEWHERE");
    await expect(stat(join(keys, "rotated.txt"))).rejects.toThrow();
  });
});

describe("setRecoveryFolder", () => {
  it("writes and clears .opscrew/secrets.json, and refuses a folder inside the repository", async () => {
    const { deps, keys } = await recoveryWorld();
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const file = join(deps.paths.stateDir, "secrets.json");
    await setRecoveryFolder(deps, join(keys, "copies"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ folder: join(keys, "copies") });
    expect(await readFile(join(deps.paths.stateDir, ".gitignore"), "utf8")).toBe("*\n");
    expect((await recoveryStatus(deps)).folder).toBe(join(keys, "copies"));

    for (const [folder, message] of [
      [join(deps.paths.root, "backups"), /inside the repository/],
      [deps.paths.root, /inside the repository/],
      ["backups", /needs a full path/],
    ] as const) {
      const error = await failure(setRecoveryFolder(deps, folder));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(message);
    }
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ folder: join(keys, "copies") });

    await setRecoveryFolder(deps, undefined);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    expect((await recoveryStatus(deps)).folder).toBeUndefined();
  });
});

describe("recoveryStatus", () => {
  it("shows the copy's last update, its recipients, whether it is behind, and the folder", async () => {
    const before = await recoveryWorld();
    await writeLocal(before.deps, provisionedFiles());
    expect(await recoveryStatus(before.deps)).toEqual({
      exists: false,
      recipients: 0,
      behind: true,
    });

    const { deps, keys, root } = await withFirstCopy({
      backup: generateAgeIdentity().recipient,
      folder: true,
    });
    expect(await recoveryStatus(deps)).toEqual({
      exists: true,
      lastModified: "2026-10-21T10:00:00Z",
      recipients: 2,
      behind: false,
      folder: join(keys, "copies"),
    });

    await writeLocal(deps, { "home/deploy_secrets.json": '{"host":"203.0.113.10"}\n' });
    expect((await recoveryStatus(deps)).behind).toBe(true);

    // Without the repository's copy, the folder copy's metadata.
    await rm(join(root, "opscrew/secrets.sops.json"));
    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    expect(await recoveryStatus(deps)).toMatchObject({ exists: true, recipients: 2 });
  });
});
