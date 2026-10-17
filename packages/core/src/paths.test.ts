import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureStateDir,
  exists,
  projectIdFor,
  readTextIfExists,
  resolveProjectPaths,
  stripBom,
  toPosixRelative,
} from "./paths";

const isWindows = process.platform === "win32";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "opscrew-paths-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function sha12(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

describe("resolveProjectPaths", () => {
  it("resolves every directory and file under the project root and the home directory", () => {
    const root = path.join(tmp, "My App");
    const home = path.join(tmp, "home");
    const p = resolveProjectPaths(root, { env: {}, homedir: home });

    expect(p.root).toBe(root);
    expect(p.projectId).toBe(projectIdFor(root));
    expect(p.artefactsDir).toBe(path.join(root, "opscrew"));
    expect(p.stateDir).toBe(path.join(root, ".opscrew"));
    expect(p.homeDir).toBe(path.join(home, ".opscrew"));
    expect(p.projectHomeDir).toBe(path.join(home, ".opscrew", "projects", p.projectId));
    expect(p.auditDir).toBe(path.join(home, ".opscrew", "audit"));

    expect(p.files).toEqual({
      architecture: path.join(root, "opscrew", "architecture.json"),
      architectureMd: path.join(root, "opscrew", "ARCHITECTURE.md"),
      requirements: path.join(root, "opscrew", "requirements.yaml"),
      plan: path.join(root, "opscrew", "plan.yaml"),
      scanReportMd: path.join(root, "opscrew", "SECURITY_SCAN.md"),
      scanReportJson: path.join(root, ".opscrew", "scan.json"),
      securityReport: path.join(root, "opscrew", "SECURITY_REPORT.md"),
      runbook: path.join(root, "opscrew", "RUNBOOK.md"),
      state: path.join(root, ".opscrew", "state.json"),
      approvals: path.join(root, ".opscrew", "approvals.jsonl"),
      costs: path.join(root, ".opscrew", "costs.jsonl"),
      plansDir: path.join(root, ".opscrew", "plans"),
      tfstateDir: path.join(root, ".opscrew", "tfstate"),
      deployKey: path.join(p.projectHomeDir, "deploy_key"),
      deployKeyPub: path.join(p.projectHomeDir, "deploy_key.pub"),
      knownHosts: path.join(p.projectHomeDir, "known_hosts"),
      statePassphrase: path.join(p.projectHomeDir, "state_passphrase"),
      deploySecrets: path.join(p.projectHomeDir, "deploy_secrets.json"),
    });
  });

  it("returns only absolute paths, even for a relative root", () => {
    const p = resolveProjectPaths(".", { env: {}, homedir: tmp });
    expect(p.root).toBe(path.resolve("."));
    const all = [
      p.root,
      p.artefactsDir,
      p.stateDir,
      p.homeDir,
      p.projectHomeDir,
      p.auditDir,
      ...Object.values(p.files),
    ];
    for (const value of all) expect(path.isAbsolute(value), value).toBe(true);
  });

  it("uses OPSCREW_HOME as the user-level directory when set", () => {
    const override = path.join(tmp, "custom-home");
    const p = resolveProjectPaths(path.join(tmp, "app"), {
      env: { OPSCREW_HOME: override },
      homedir: path.join(tmp, "ignored"),
    });
    expect(p.homeDir).toBe(override);
    expect(p.auditDir).toBe(path.join(override, "audit"));
    expect(p.projectHomeDir).toBe(path.join(override, "projects", p.projectId));
  });

  it("ignores an empty OPSCREW_HOME", () => {
    const p = resolveProjectPaths(path.join(tmp, "app"), {
      env: { OPSCREW_HOME: "" },
      homedir: tmp,
    });
    expect(p.homeDir).toBe(path.join(tmp, ".opscrew"));
  });
});

describe("projectIdFor", () => {
  it("is <slug(basename)>-<12 hex of sha256(normalised root)>", () => {
    const root = path.join(tmp, "My Cool_App!");
    const id = projectIdFor(root);
    expect(id).toMatch(/^my-cool-app-[0-9a-f]{12}$/);
    const normalised = isWindows ? root.replace(/^[A-Z]:/, (d) => d.toLowerCase()) : root;
    expect(id).toBe(`my-cool-app-${sha12(normalised)}`);
  });

  it("is stable regardless of trailing separators and relative input", () => {
    const root = path.join(tmp, "app");
    expect(projectIdFor(`${root}${path.sep}`)).toBe(projectIdFor(root));
    expect(projectIdFor(`${root}${path.sep}${path.sep}`)).toBe(projectIdFor(root));
    expect(projectIdFor(path.relative(process.cwd(), root))).toBe(projectIdFor(root));
  });

  it("differs for different roots with the same basename", () => {
    expect(projectIdFor(path.join(tmp, "a", "app"))).not.toBe(
      projectIdFor(path.join(tmp, "b", "app")),
    );
  });

  it("falls back to 'project' when the basename has no usable characters", () => {
    expect(projectIdFor(path.parse(tmp).root)).toMatch(/^project-[0-9a-f]{12}$/);
  });

  it.runIf(isWindows)("lower-cases the Windows drive letter", () => {
    expect(projectIdFor("D:\\Work\\My App")).toBe(projectIdFor("d:\\Work\\My App\\"));
    expect(projectIdFor("D:\\Work\\My App")).toBe(`my-app-${sha12("d:\\Work\\My App")}`);
  });
});

describe("ensureStateDir", () => {
  it("creates .opscrew/ with a .gitignore containing *", async () => {
    const p = resolveProjectPaths(tmp, { env: {}, homedir: tmp });
    await ensureStateDir(p);
    expect((await stat(p.stateDir)).isDirectory()).toBe(true);
    const ignore = await readFile(path.join(p.stateDir, ".gitignore"), "utf8");
    expect(ignore.trim()).toBe("*");
    // idempotent
    await ensureStateDir(p);
    expect((await readFile(path.join(p.stateDir, ".gitignore"), "utf8")).trim()).toBe("*");
  });

  it("keeps an existing .gitignore", async () => {
    const p = resolveProjectPaths(tmp, { env: {}, homedir: tmp });
    await ensureStateDir(p);
    await writeFile(path.join(p.stateDir, ".gitignore"), "*\n!keep\n");
    await ensureStateDir(p);
    expect(await readFile(path.join(p.stateDir, ".gitignore"), "utf8")).toBe("*\n!keep\n");
  });
});

describe("toPosixRelative", () => {
  it("returns a forward-slash path relative to the root", () => {
    const root = path.join(tmp, "app");
    expect(toPosixRelative(root, path.join(root, "opscrew", "infra", "main.tf"))).toBe(
      "opscrew/infra/main.tf",
    );
    expect(toPosixRelative(root, root)).toBe("");
    expect(toPosixRelative(root, path.join(tmp, "other", "x.txt"))).toBe("../other/x.txt");
  });
});

describe("stripBom", () => {
  it("removes a leading byte order mark only", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(stripBom(`${bom}name: shop`)).toBe("name: shop");
    expect(stripBom(`name: shop${bom}`)).toBe(`name: shop${bom}`);
    expect(stripBom("")).toBe("");
  });
});

describe("readTextIfExists and exists", () => {
  it("read a file's text and tell that it exists", async () => {
    const file = path.join(tmp, "notes.txt");
    await writeFile(file, "grüße\n");
    await expect(readTextIfExists(file)).resolves.toBe("grüße\n");
    await expect(exists(file)).resolves.toBe(true);
    await expect(exists(tmp)).resolves.toBe(true);
  });

  it("give undefined and false for a missing file", async () => {
    const file = path.join(tmp, "missing.txt");
    await expect(readTextIfExists(file)).resolves.toBeUndefined();
    await expect(exists(file)).resolves.toBe(false);
  });

  it("throw any other read error", async () => {
    await expect(readTextIfExists(tmp)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
