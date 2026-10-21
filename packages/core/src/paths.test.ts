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
  tfstateFile,
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
      cloudflareRecord: path.join(root, ".opscrew", "cloudflare.json"),
      deployKey: path.join(p.projectHomeDir, "deploy_key"),
      deployKeyPub: path.join(p.projectHomeDir, "deploy_key.pub"),
      knownHosts: path.join(p.projectHomeDir, "known_hosts"),
      statePassphrase: path.join(p.projectHomeDir, "state_passphrase"),
      deploySecrets: path.join(p.projectHomeDir, "deploy_secrets.json"),
      shared: {
        architecture: path.join(root, "opscrew", "architecture.json"),
        architectureMd: path.join(root, "opscrew", "ARCHITECTURE.md"),
        scanReportMd: path.join(root, "opscrew", "SECURITY_SCAN.md"),
        scanReportJson: path.join(root, ".opscrew", "scan.json"),
        proxyDir: path.join(root, "opscrew", "proxy"),
        requirementsBase: path.join(root, "opscrew", "requirements.yaml"),
      },
    });
  });

  it("returns only absolute paths, even for a relative root", () => {
    const p = resolveProjectPaths(".", { env: {}, homedir: tmp });
    expect(p.root).toBe(path.resolve("."));
    const { shared, ...own } = p.files;
    const all = [
      p.root,
      p.artefactsDir,
      p.stateDir,
      p.homeDir,
      p.projectHomeDir,
      p.auditDir,
      ...Object.values(own),
      ...Object.values(shared),
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

  it("resolves prod, with or without its name, to today's paths", () => {
    const root = path.join(tmp, "app");
    const today = resolveProjectPaths(root, { env: {}, homedir: tmp });
    expect(today.environment).toBe("prod");
    expect(resolveProjectPaths(root, { env: {}, homedir: tmp, environment: "prod" })).toEqual(
      today,
    );
  });

  it("gives another environment its own artefacts, state and project-home folders", () => {
    const root = path.join(tmp, "app");
    const prod = resolveProjectPaths(root, { env: {}, homedir: tmp });
    const p = resolveProjectPaths(root, { env: {}, homedir: tmp, environment: "staging" });
    const own = (dir: string) => path.join(dir, "environments", "staging");

    expect(p.environment).toBe("staging");
    expect(p.root).toBe(prod.root);
    expect(p.projectId).toBe(prod.projectId);
    expect(p.homeDir).toBe(prod.homeDir);
    expect(p.auditDir).toBe(prod.auditDir);
    expect(p.artefactsDir).toBe(own(prod.artefactsDir));
    expect(p.stateDir).toBe(own(prod.stateDir));
    expect(p.projectHomeDir).toBe(own(prod.projectHomeDir));

    const artefacts = own(path.join(root, "opscrew"));
    const state = own(path.join(root, ".opscrew"));
    const home = own(prod.projectHomeDir);
    expect(p.files).toEqual({
      architecture: path.join(root, "opscrew", "architecture.json"),
      architectureMd: path.join(root, "opscrew", "ARCHITECTURE.md"),
      requirements: path.join(artefacts, "requirements.yaml"),
      plan: path.join(artefacts, "plan.yaml"),
      scanReportMd: path.join(root, "opscrew", "SECURITY_SCAN.md"),
      scanReportJson: path.join(root, ".opscrew", "scan.json"),
      securityReport: path.join(artefacts, "SECURITY_REPORT.md"),
      runbook: path.join(artefacts, "RUNBOOK.md"),
      state: path.join(state, "state.json"),
      approvals: path.join(state, "approvals.jsonl"),
      costs: path.join(state, "costs.jsonl"),
      plansDir: path.join(state, "plans"),
      tfstateDir: path.join(state, "tfstate"),
      cloudflareRecord: path.join(state, "cloudflare.json"),
      deployKey: path.join(home, "deploy_key"),
      deployKeyPub: path.join(home, "deploy_key.pub"),
      knownHosts: path.join(home, "known_hosts"),
      statePassphrase: path.join(home, "state_passphrase"),
      deploySecrets: path.join(home, "deploy_secrets.json"),
      shared: prod.files.shared,
    });
  });

  it("keeps two environments apart and shares prod's common files with both", () => {
    const root = path.join(tmp, "app");
    const prod = resolveProjectPaths(root, { env: {}, homedir: tmp });
    const staging = resolveProjectPaths(root, { env: {}, homedir: tmp, environment: "staging" });
    const preview = resolveProjectPaths(root, { env: {}, homedir: tmp, environment: "preview-2" });

    const { shared: _prodShared, ...prodOwn } = prod.files;
    const { shared: _stagingShared, ...stagingOwn } = staging.files;
    const { shared: _previewShared, ...previewOwn } = preview.files;
    const sharedNames = ["architecture", "architectureMd", "scanReportMd", "scanReportJson"];
    for (const [name, file] of Object.entries(stagingOwn)) {
      const others = [
        prodOwn[name as keyof typeof prodOwn],
        previewOwn[name as keyof typeof previewOwn],
      ];
      if (sharedNames.includes(name)) expect(others, name).toEqual([file, file]);
      else expect(others, name).not.toContain(file);
    }
    expect(staging.files.shared).toEqual(prod.files.shared);
    expect(preview.files.shared).toEqual(prod.files.shared);
  });

  it("refuses a name that is not an environment name", () => {
    const refused = ["Staging", "../prod", "staging/x", "", "a-name-longer-than-16"];
    const reserved = ["con", "prn", "aux", "nul", "com0", "com9", "lpt0", "lpt9"];
    for (const environment of [...refused, ...reserved]) {
      const resolve = () =>
        resolveProjectPaths(path.join(tmp, "app"), { env: {}, homedir: tmp, environment });
      expect(resolve, environment).toThrow(
        expect.objectContaining({
          code: "INVALID_INPUT",
          message: `"${environment}" is not an environment name: it must be 1-16 lower-case letters, digits or hyphens and start with a letter, and not a name Windows reserves (con, nul, com1…).`,
        }),
      );
    }
    for (const environment of ["console", "com10", "nul-1", "lpt"]) {
      const p = resolveProjectPaths(path.join(tmp, "app"), { env: {}, homedir: tmp, environment });
      expect(p.environment).toBe(environment);
    }
  });

  it.runIf(isWindows)("lays out an environment under a Windows drive root", () => {
    const p = resolveProjectPaths("D:\\work\\app", {
      env: {},
      homedir: "C:\\Users\\me",
      environment: "staging",
    });
    expect(p.artefactsDir).toBe("D:\\work\\app\\opscrew\\environments\\staging");
    expect(p.stateDir).toBe("D:\\work\\app\\.opscrew\\environments\\staging");
    expect(p.projectHomeDir).toBe(
      `C:\\Users\\me\\.opscrew\\projects\\${p.projectId}\\environments\\staging`,
    );
    expect(p.files.shared.proxyDir).toBe("D:\\work\\app\\opscrew\\proxy");
    expect(tfstateFile(p)).toBe(
      "D:\\work\\app\\.opscrew\\environments\\staging\\tfstate\\staging.tfstate",
    );
  });

  it.runIf(!isWindows)("lays out an environment under a POSIX root", () => {
    const p = resolveProjectPaths("/srv/app", {
      env: {},
      homedir: "/home/me",
      environment: "staging",
    });
    expect(p.artefactsDir).toBe("/srv/app/opscrew/environments/staging");
    expect(p.stateDir).toBe("/srv/app/.opscrew/environments/staging");
    expect(p.projectHomeDir).toBe(`/home/me/.opscrew/projects/${p.projectId}/environments/staging`);
    expect(p.files.shared.proxyDir).toBe("/srv/app/opscrew/proxy");
    expect(tfstateFile(p)).toBe("/srv/app/.opscrew/environments/staging/tfstate/staging.tfstate");
  });
});

describe("tfstateFile", () => {
  it("is prod.tfstate in today's tfstate folder for prod", () => {
    const root = path.join(tmp, "app");
    const p = resolveProjectPaths(root, { env: {}, homedir: tmp });
    expect(tfstateFile(p)).toBe(path.join(root, ".opscrew", "tfstate", "prod.tfstate"));
  });

  it("is <env>.tfstate in the environment's own tfstate folder", () => {
    const root = path.join(tmp, "app");
    const p = resolveProjectPaths(root, { env: {}, homedir: tmp, environment: "staging" });
    expect(toPosixRelative(root, tfstateFile(p))).toBe(
      ".opscrew/environments/staging/tfstate/staging.tfstate",
    );
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
