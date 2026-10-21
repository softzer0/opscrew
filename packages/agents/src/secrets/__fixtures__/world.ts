import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApprovalHandler, CommandRunner, FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import type { RenderedFile } from "@opscrew/iac-templates";
import { createTestPhaseDeps, ScriptedRunner, type TestPhaseDeps } from "../../testing";
import { localPath } from "../files";
import { FAKE_SOPS, FakeSops } from "./fake-sops";

/** The generated values of the test app, each a fake secret. */
export const VALUES = {
  db: fakeSecret("generic-password", "recovery-db"),
  secretKeyBase: fakeSecret("generic-password", "recovery-skb"),
  redis: fakeSecret("generic-password", "recovery-redis"),
};

/** What provision leaves on a computer, by the copy's paths. */
export function provisionedFiles(): Record<string, string> {
  return {
    "home/generated_values.json": `${JSON.stringify({
      dbPassword: VALUES.db,
      env: { SECRET_KEY_BASE: VALUES.secretKeyBase },
      services: { redis: { password: VALUES.redis } },
    })}\n`,
    "home/deploy_key": `${fakeSecret("private-key-pem", "recovery-deploy-key")}\n`,
    "home/deploy_key.pub": "ssh-ed25519 FAKE-PUBLIC-KEY opscrew-deploy\n",
    "home/state_passphrase": `${fakeSecret("generic-password", "recovery-passphrase")}\n`,
    "state/tfstate/prod.tfstate": '{"version":4,"serial":3}\n',
    "state/server.json": '{"ipv4":"203.0.113.10"}\n',
  };
}

export interface WorldOptions {
  root?: string;
  /** OpsCrew's folder (`OPSCREW_HOME`); `<root>/.home-opscrew` by default. */
  home?: string;
  interactive?: boolean;
  approvalHandler?: ApprovalHandler;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  sops?: FakeSops;
  runner?: CommandRunner;
}

/**
 * A project for the recovery copy: phase deps whose `OPSCREW_SOPS_BIN` is {@link FAKE_SOPS}
 * (answered by `sops`), and a folder outside the project for key files.
 */
export async function recoveryWorld(options: WorldOptions = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "opscrew-recovery-")));
  const keys = await mkdtemp(join(tmpdir(), "opscrew-recovery-keys-"));
  const sops = options.sops ?? new FakeSops();
  const deps: TestPhaseDeps = await createTestPhaseDeps({
    root,
    env: {
      OPSCREW_SOPS_BIN: FAKE_SOPS,
      ...options.env,
      OPSCREW_HOME: options.home ?? join(root, ".home-opscrew"),
    },
    runner: options.runner ?? sops.runner(new ScriptedRunner()),
    interactive: options.interactive ?? false,
    ...(options.approvalHandler !== undefined ? { approvalHandler: options.approvalHandler } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  return { root, keys, sops, deps };
}

/** Writes files on this computer by the copy's paths. */
export async function writeLocal(deps: TestPhaseDeps, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    const file = localPath(deps.paths, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** Reads this computer's files by the copy's paths (`undefined` for a missing one). */
export async function readLocal(deps: TestPhaseDeps, paths: readonly string[]) {
  const out: Record<string, string | undefined> = {};
  for (const path of paths) {
    out[path] = await readFile(localPath(deps.paths, path), "utf8").catch(() => undefined);
  }
  return out;
}

/** Writes the files a refresh returned into the repository, as the publish step does. */
export async function writeRepositoryFiles(root: string, files: readonly RenderedFile[]) {
  for (const file of files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.content);
  }
}

/** Sets the folder the copy is also written to (`.opscrew/secrets.json`). */
export async function setFolder(deps: TestPhaseDeps, folder: string) {
  await mkdir(deps.paths.stateDir, { recursive: true });
  await writeFile(join(deps.paths.stateDir, "secrets.json"), JSON.stringify({ folder }));
}

/** Everything a run showed or kept that is not encrypted: output, audit, approvals, records. */
export async function exposed(deps: TestPhaseDeps, ...results: unknown[]): Promise<string> {
  const record = await readFile(join(deps.paths.stateDir, "recovery.json"), "utf8").catch(() => "");
  const requests = "requests" in deps.approvalHandler ? deps.approvalHandler.requests : [];
  return [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify(requests),
    JSON.stringify(results),
    record,
  ].join("\n");
}
